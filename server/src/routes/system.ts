/**
 * Keeping the system safe: nightly database backups (download, restore on next start),
 * push notifications to phones, and the list of hardware integrations waiting for equipment.
 */
import { Router } from "express";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { db, get, getSetting, setSetting, closeDb } from "../db.js";
import { execFile } from "node:child_process";
import { h, parse, tid, requirePerm } from "../auth.js";
import { AppError, audit, createAlert } from "../services.js";
import { sendToPhone } from "../whatsapp/cloud.js";
import { config } from "../config.js";
import { vapidPublicKey, saveSubscription, removeSubscription, subscriptionCount, pushToUser } from "../push.js";
import { PROVIDERS, cloudStatus, cloudPush, cloudPushAll, cloudConfigured, parseServiceAccount, gdriveCheck, gdriveCfg, dropboxCfg, saveCloud, dropboxAuthUrl, dropboxConnect, dropboxCheck, googleAuthUrl, googleConnect, googleConfigured, type Provider } from "../backupCloud.js";
import { randomBytes, pbkdf2Sync, createCipheriv } from "node:crypto";

export const system = Router();

/* ================= Backups ================= */
export const backupDir = () => process.env.BACKUP_DIR ?? path.join(path.dirname(config.dbPath), "backups");
const KEEP = 14;
const NAME = /^pumpai-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$/;

/** A consistent copy of the whole database (VACUUM INTO), keeping the last 14. */
export function makeBackup(): { name: string; bytes: number } {
  fs.mkdirSync(backupDir(), { recursive: true });
  const name = `pumpai-${new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 19).replace(/:/g, "-")}.db`;
  const file = path.join(backupDir(), name);
  if (fs.existsSync(file)) fs.rmSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = listBackups();
  for (const old of all.slice(KEEP)) fs.rmSync(path.join(backupDir(), old.name), { force: true });
  copyOffsite(file);
  void cloudPushAll(file); // Google Drive / Dropbox, set up in Settings → Backups
  return { name, bytes: fs.statSync(file).size };
}

/**
 * A backup on the same server is lost with the server: BACKUP_COPY_CMD copies each new one elsewhere,
 * e.g. `rclone copy "$BACKUP_FILE" gdrive:pumpai` or `aws s3 cp "$BACKUP_FILE" s3://my-bucket/`. The result shows in Settings → Backups.
 */
function copyOffsite(file: string) {
  const cmd = process.env.BACKUP_COPY_CMD;
  if (!cmd) return;
  execFile("sh", ["-c", cmd], { env: { ...process.env, BACKUP_FILE: file }, timeout: 15 * 60_000 }, (err, _out, errOut) => {
    setSetting(0, "offsite_last", JSON.stringify({ at: new Date().toISOString(), ok: !err, message: err ? String(errOut || err.message).slice(0, 300) : null }));
    if (err) console.error("[backup] off-site copy failed:", err.message);
  });
}
export function listBackups() {
  if (!fs.existsSync(backupDir())) return [];
  return fs.readdirSync(backupDir()).filter((f) => NAME.test(f)).map((f) => ({ name: f, bytes: fs.statSync(path.join(backupDir(), f)).size }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * Backup routes, mounted twice: on the pump's own API (single-pump install, Settings → Backups) and on the SaaS platform panel.
 * In SaaS mode the database holds EVERY pump, so a pump admin must never download / restore / re-route it — those routes 403 there.
 */
type Actor = (req: import("express").Request) => { t: number; user: { id: number; name: string } };
export function mountBackupRoutes(r: Router, guard: import("express").RequestHandler, actor: Actor) {
  r.get("/backups", guard, h(() => ({ dir: backupDir(), backups: listBackups(), restore_pending: fs.existsSync(`${config.dbPath}.restore`), can_restart: process.env.SUPERVISED === "1",
    offsite: { configured: Boolean(process.env.BACKUP_COPY_CMD), last: (() => { try { return JSON.parse(getSetting(0, "offsite_last", "null")); } catch { return null; } })() },
    cloud: cloudStatus() })));
  
  /* ---- cloud copies (Google Drive / Dropbox) ---- */
  const provider = (p: string): Provider => { if (!(PROVIDERS as readonly string[]).includes(p)) throw new AppError(400, "Unknown provider"); return p as Provider; };
  /** Google Drive: paste the service-account key JSON + the shared folder's ID; checked live before it is saved. */
  r.put("/backups/cloud/gdrive", guard, h(async (req) => {
    const b = parse(z.object({ json: z.string().min(20).max(20_000), folder_id: z.string().trim().min(5).max(300) }), req.body);
    let key: { client_email: string; private_key: string };
    try { key = parseServiceAccount(b.json); } catch (e: any) { throw new AppError(400, e.message); }
    const cfg = { ...key, folder_id: b.folder_id.replace(/^.*\/folders\//, "").split(/[?#]/)[0] };
    let check: { folder: string };
    try { check = await gdriveCheck(cfg); } catch (e: any) { throw new AppError(400, `Google Drive: ${e.message}. Share the folder with ${key.client_email} (Editor) and check the folder ID.`); }
    saveCloud("gdrive", cfg);
    audit(actor(req).t, actor(req).user, "backup_cloud_connected", "gdrive", { email: key.client_email, folder: check.folder });
    return { ok: true, folder: check.folder, email: key.client_email, cloud: cloudStatus() };
  }));
  /** Google Drive one-click: the owner's browser opens this URL, signs in, and Google sends the code to our callback. */
  r.get("/backups/cloud/gdrive/auth-url", guard, h(() => {
    if (!googleConfigured()) throw new AppError(400, "Google Drive one-click is not set up by the platform yet. (Super-admin: Settings → Integrations)");
    const nonce = randomBytes(16).toString("hex");
    setSetting(0, "oauth_state_gdrive", JSON.stringify({ nonce, at: Date.now() }));
    return { url: googleAuthUrl(`${config.publicUrl}/api/cloud/google/callback`, nonce) };
  }));
  /** Dropbox one-click step 1: open this to approve offline access and get a one-time code (uses the platform app key). */
  r.get("/backups/cloud/dropbox/auth-url", guard, h((req) => {
    const k = (config.oauth.dropboxAppKey || String(req.query.app_key ?? "")).trim();
    if (k.length < 5) throw new AppError(400, "Dropbox one-click is not set up by the platform yet. (Super-admin: Settings → Integrations)");
    return { url: dropboxAuthUrl(k) };
  }));
  /** Dropbox one-click step 2: the code → refresh token. App key/secret come from the platform (owner needn't enter them). */
  r.post("/backups/cloud/dropbox/connect", guard, h(async (req) => {
    const b = parse(z.object({ app_key: z.string().trim().max(100).optional(), app_secret: z.string().trim().max(100).optional(), code: z.string().trim().min(5).max(200) }), req.body);
    const appKey = (config.oauth.dropboxAppKey || b.app_key || "").trim();
    const appSecret = (config.oauth.dropboxAppSecret || b.app_secret || "").trim();
    if (!appKey || !appSecret) throw new AppError(400, "Dropbox app key/secret missing — platform owner sets it once in Settings → Integrations");
    let cfg;
    try { cfg = await dropboxConnect(appKey, appSecret, b.code); } catch (e: any) { throw new AppError(400, e.message); }
    saveCloud("dropbox", cfg);
    audit(actor(req).t, actor(req).user, "backup_cloud_connected", "dropbox", { account: cfg.account });
    return { ok: true, account: cfg.account, cloud: cloudStatus() };
  }));
  /** Re-check a connected provider (token still good, folder still reachable). */
  r.post("/backups/cloud/:provider/check", guard, h(async (req) => {
    const p = provider(req.params.provider);
    if (!cloudConfigured(p)) throw new AppError(400, "Not connected");
    try {
      const g = gdriveCfg(), d = dropboxCfg();
      return { ok: true, ...(p === "gdrive" ? await gdriveCheck(g!) : await dropboxCheck(d!)) };
    } catch (e: any) { throw new AppError(400, e.message); }
  }));
  /** Upload the newest backup to one provider now (also what the nightly backup does by itself). */
  r.post("/backups/cloud/:provider/push", guard, h(async (req) => {
    const p = provider(req.params.provider);
    if (!cloudConfigured(p)) throw new AppError(400, "Not connected");
    const latest = listBackups()[0] ?? (() => { const b = makeBackup(); return { name: b.name }; })();
    const r = await cloudPush(p, path.join(backupDir(), latest.name));
    if (!r.ok) throw new AppError(502, r.message ?? "Upload failed");
    return { ok: true, result: r, cloud: cloudStatus() };
  }));
  r.delete("/backups/cloud/:provider", guard, h((req) => {
    const p = provider(req.params.provider);
    saveCloud(p, null);
    setSetting(0, `cloud_last_${p}`, "null");
    audit(actor(req).t, actor(req).user, "backup_cloud_disconnected", p, {});
    return { ok: true, cloud: cloudStatus() };
  }));
  r.post("/backups", guard, h(() => makeBackup()));
  r.get("/backups/:name", guard, (req, res, next) => {
    try {
      if (!NAME.test(req.params.name)) throw new AppError(400, "Bad backup name");
      const file = path.join(backupDir(), req.params.name);
      if (!fs.existsSync(file)) throw new AppError(404, "Backup not found");
      res.download(file);
    } catch (e) { next(e); }
  });
  /**
   * Encrypted download for safe off-site storage: AES-256-CBC with a password-derived key (PBKDF2), in OpenSSL's
   * "Salted__" format so it can always be decrypted anywhere with:
   *   openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -in FILE.db.enc -out backup.db -k 'YOUR-PASSWORD'
   * A leaked Drive / phone copy is then useless without the password.
   */
  r.get("/backups/:name/enc", guard, (req, res, next) => {
    try {
      if (!NAME.test(req.params.name)) throw new AppError(400, "Bad backup name");
      const pass = String(req.query.pass ?? "");
      if (pass.length < 8) throw new AppError(400, "Backup password kam az kam 8 characters ka hona chahiye");
      const file = path.join(backupDir(), req.params.name);
      if (!fs.existsSync(file)) throw new AppError(404, "Backup not found");
      const data = fs.readFileSync(file);
      const salt = randomBytes(8);
      const keyIv = pbkdf2Sync(pass, salt, 10000, 48, "sha256"); // 32-byte key + 16-byte IV, matching `openssl -pbkdf2`
      const cipher = createCipheriv("aes-256-cbc", keyIv.subarray(0, 32), keyIv.subarray(32, 48));
      const enc = Buffer.concat([Buffer.from("Salted__", "latin1"), salt, cipher.update(data), cipher.final()]);
      const { t, user } = actor(req);
      audit(t, user, "Encrypted backup downloaded", req.params.name, { bytes: enc.length });
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${req.params.name}.enc"`);
      res.setHeader("X-Decrypt-Hint", "openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -in FILE.enc -out backup.db -k 'YOUR-PASSWORD'");
      res.end(enc);
    } catch (e) { next(e); }
  });
  /** Restore is staged and swapped in at the next start, so the running database is never overwritten. */
  r.post("/backups/:name/restore", guard, h((req) => {
    if (!NAME.test(req.params.name)) throw new AppError(400, "Bad backup name");
    const file = path.join(backupDir(), req.params.name);
    if (!fs.existsSync(file)) throw new AppError(404, "Backup not found");
    makeBackup(); // safety copy of today's data first
    fs.copyFileSync(file, `${config.dbPath}.restore`);
    // restoring the whole database is a high-impact action — alert the owner in case it was not them
    try {
      const { t, user } = actor(req);
      createAlert(t, { type: "security", severity: "critical", title: "Database RESTORE stage kiya gaya", body: `${user.name} ne backup "${req.params.name}" se restore shuru kiya. App restart par apply hoga. Agar yeh aap ne nahi kiya to foran dekh lein.`, dedupe_key: `restore-${t}-${Date.now()}` });
      const owner = (getSetting(t, "owner_phone", "") || (get("SELECT owner_phone FROM tenants WHERE id=?", t)?.owner_phone as string | undefined)) as string | undefined;
      if (owner) sendToPhone(owner, `🔐 Database RESTORE stage kiya gaya by ${user.name} (backup: ${req.params.name}). Agar yeh aap ne nahi kiya to foran raabta karein.`).catch(() => { /* best-effort */ });
    } catch { /* alerting must never block a restore */ }
    return { ok: true, message: "Restart the app to finish the restore. The current data is kept as a backup." };
  }));
  r.delete("/backups/restore", guard, h(() => { fs.rmSync(`${config.dbPath}.restore`, { force: true }); return { ok: true }; }));
}

const tenantBackupGuard: import("express").RequestHandler = (req, res, next) => {
  if (config.saas) return next(new AppError(403, "SaaS par backups platform owner ke paas hain (Platform panel)"));
  requirePerm("settings.manage")(req, res, next);
};
mountBackupRoutes(system, tenantBackupGuard, (req) => ({ t: tid(req), user: req.user! }));

/** Under systemd / Docker the app comes straight back after exiting — used to finish a restore from the browser. */
system.post("/system/restart", requirePerm("settings.manage"), h((req) => {
  if (config.saas) throw new AppError(403, "SaaS par restart platform owner karta hai");
  if (process.env.SUPERVISED !== "1") throw new AppError(400, "Restart the app from the server (it is not running as a service)");
  audit(tid(req), req.user!, "app_restart", "system", {});
  setTimeout(() => { closeDb(); process.exit(0); }, 600);
  return { ok: true, message: "Restarting — the app is back in a few seconds" };
}));

/* ================= Push notifications ================= */
system.get("/push/key", h((req) => ({ key: vapidPublicKey(), subscribed: subscriptionCount(req.user!.id) })));
system.post("/push/subscribe", h((req) => {
  const b = parse(z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }), req.body);
  vapidPublicKey();
  saveSubscription(tid(req), req.user!.id, b);
  return { ok: true, subscribed: subscriptionCount(req.user!.id) };
}));
system.post("/push/unsubscribe", h((req) => {
  removeSubscription(req.user!.id, parse(z.object({ endpoint: z.string() }), req.body).endpoint);
  return { ok: true };
}));
system.post("/push/test", h(async (req) => ({ sent: await pushToUser(req.user!.id, { title: "PumpAI alerts are on ✅", body: "You will get important alerts on this device." }) })));

/* ================= Hardware (pending) & safety settings ================= */
export const HARDWARE = [
  { key: "atg", name: "Automatic tank gauge (ATG) probes", gives: "Live tank litres, water level and temperature — no manual dips; instant leak and theft alerts." },
  { key: "fcc", name: "Dispenser / forecourt controller", gives: "Every nozzle sale and totalizer straight into the POS — salesmen do not type sales or meter readings." },
  { key: "cctv", name: "CCTV with number-plate reading (ANPR)", gives: "Photo of the vehicle on every sale; khata and fleet vehicles recognised automatically." },
  { key: "gps", name: "Tanker GPS tracking", gives: "Where the tanker is, stops on the way, expected arrival — stops fuel being taken out in transit." },
  { key: "meters", name: "Generator and electricity meters", gives: "Generator hours and fuel use, electricity units — expense checks and maintenance reminders." },
];
system.get("/hardware", requirePerm("settings.manage"), h((req) => HARDWARE.map((x) => ({ ...x, status: getSetting(tid(req), `hw_${x.key}`, "pending") }))));
/** The owner marks where each piece of forecourt hardware stands: pending → planned → installed → live. */
const HW_STATUS = ["pending", "planned", "installed", "live"] as const;
system.put("/hardware/:key", requirePerm("settings.manage"), h((req) => {
  if (!HARDWARE.some((x) => x.key === req.params.key)) throw new AppError(404, "Unknown hardware");
  const b = parse(z.object({ status: z.enum(HW_STATUS) }), req.body);
  setSetting(tid(req), `hw_${req.params.key}`, b.status);
  return { ok: true, status: b.status };
}));
system.get("/safety", requirePerm("settings.manage"), h((req) => ({ price_approval: getSetting(tid(req), "price_approval", "0") === "1" })));
system.put("/safety", requirePerm("settings.manage"), h((req) => {
  const b = parse(z.object({ price_approval: z.boolean() }), req.body);
  setSetting(tid(req), "price_approval", b.price_approval ? "1" : "0");
  return { price_approval: b.price_approval };
}));

/**
 * Public Google Drive OAuth callback (the browser is redirected here by Google, so no app auth header).
 * Protected by the one-time state nonce we stored when the owner clicked "Connect Google Drive".
 */
export const cloudPublic = Router();
cloudPublic.get("/cloud/google/callback", async (req, res) => {
  const page = (title: string, body: string) => res.send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui,sans-serif;text-align:center;padding:40px;color:#0f172a"><h2>${title}</h2><p style="color:#475569">${body}</p><p><a href="/settings">Settings → Backups</a></p></body>`);
  try {
    const code = String(req.query.code ?? ""), state = String(req.query.state ?? "");
    if (!code) return page("Connect cancelled", "Google Drive connect cancel ho gaya.");
    let saved: { nonce: string; at: number } | null = null;
    try { saved = JSON.parse(getSetting(0, "oauth_state_gdrive", "null")); } catch { saved = null; }
    if (!saved || saved.nonce !== state || Date.now() - saved.at > 10 * 60_000) return page("Link purana ho gaya", "Dobara 'Connect Google Drive' dabayein.");
    setSetting(0, "oauth_state_gdrive", "null");
    const cfg = await googleConnect(code, `${config.publicUrl}/api/cloud/google/callback`);
    saveCloud("gdrive", cfg);
    return page("✓ Google Drive connect ho gaya", `Account: ${cfg.email ?? "—"}. Ab har raat ka backup khud-ba-khud yahan jayega. Yeh tab band kar dein.`);
  } catch (e: any) { return page("Nahi ho saka", String(e?.message ?? e).slice(0, 200)); }
});
