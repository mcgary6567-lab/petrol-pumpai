/**
 * SaaS mode — one cloud server, many pumps. (Only active when SAAS_MODE=1.)
 *
 *  • Public sign-up: anyone installs the app, creates their own pump (tenant) and starts a free trial.
 *  • Activation: the pump pays once (cash) → the platform owner hands them an activation code, or flips them
 *    to "active" from the platform panel. A locked pump (trial expired / suspended) can only see the activate
 *    screen until then.
 *  • Platform admin (you): a super-admin above all pumps — list every pump, activate / suspend, make codes.
 *
 * Data is already isolated per tenant everywhere (every row carries tenant_id and the JWT pins the user to one
 * tenant), so SaaS mode only adds the sign-up, the lifecycle gate, and the platform panel — nothing in the pump
 * app changes.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { all, get, run, now, setSetting, tx, db } from "../db.js";
import { h, parse, tid, forgetModules } from "../auth.js";
import { AppError, audit, normalizePhone } from "../services.js";
import { setupBody, provisionTenant } from "./setup.js";
import { mountBackupRoutes, makeBackup, listBackups } from "./system.js";
import fs from "node:fs";
import { serverStatus, serverLogs, clearServerLogs } from "../serverStatus.js";
import { catalogPlatform } from "./catalog.js";

export const saasPublic = Router();  // no login (sign-up, platform login + panel)
export const saasAuthed = Router();  // after requireAuth (the pump owner's own account)

const trialEnd = () => new Date(Date.now() + config.trialDays * 86_400_000).toISOString();

/** A pump's lifecycle state: locked when the trial has run out or it was suspended. */
export function tenantState(t: number) {
  const row = get("SELECT status, trial_ends_at, plan, paid_until FROM tenants WHERE id=?", t);
  const status = (row?.status as string) ?? "active";
  const ends = (row?.trial_ends_at as string) ?? null;
  const plan = (row?.plan as string | null) ?? null;
  const paidUntil = (row?.paid_until as string | null) ?? null;
  const trialExpired = status === "trial" && ends != null && Date.parse(ends) < Date.now();
  // a monthly / yearly plan ends after its paid-until day (lifetime and pre-plan pumps never expire)
  const planExpired = status === "active" && plan !== "lifetime" && paidUntil != null && Date.parse(paidUntil) + 86_400_000 < Date.now();
  const until = status === "trial" ? ends : paidUntil;
  const daysLeft = until ? Math.max(0, Math.ceil((Date.parse(until) - Date.now()) / 86_400_000)) : 0;
  return { status, trial_ends_at: ends, plan, paid_until: paidUntil, days_left: daysLeft, lifetime: plan === "lifetime", locked: status === "suspended" || trialExpired || planExpired, plan_expired: planExpired };
}

/* ================= Public sign-up ================= */
saasPublic.post("/signup", h((req) => {
  if (!config.saas) throw new AppError(404, "Sign-up is off on this server");
  const b = parse(setupBody, req.body);
  if (get("SELECT 1 FROM users WHERE email=?", b.admin.email.toLowerCase())) throw new AppError(400, "Ye email pehle se registered hai — sign in karein.");
  return provisionTenant(b, { status: "trial", trialEndsAt: trialEnd() });
}));

/* ================= The pump owner's own account ================= */
saasAuthed.get("/account/status", h((req) => {
  const t = get("SELECT name, status, activated_at FROM tenants WHERE id=?", tid(req))!;
  return { saas: config.saas, name: t.name, ...tenantState(tid(req)), sales_phone: config.salesPhone, trial_days: config.trialDays };
}));
saasAuthed.post("/account/activate", h((req) => {
  if (req.user!.role !== "admin") throw new AppError(403, "Sirf owner activate kar sakta hai");
  const { code } = parse(z.object({ code: z.string().trim().min(4).max(40) }), req.body);
  const c = get("SELECT * FROM activation_codes WHERE code=?", code.toUpperCase());
  if (!c) throw new AppError(400, "Ye activation code ghalat hai");
  if (c.used_by_tenant) throw new AppError(400, "Ye code pehle hi istemaal ho chuka hai");
  run("UPDATE tenants SET status='active', activated_at=?, activated_by=?, plan=? WHERE id=?", now(), `code:${code.toUpperCase()}`, c.plan ?? null, tid(req));
  run("UPDATE activation_codes SET used_by_tenant=?, used_at=? WHERE id=?", tid(req), now(), c.id);
  return { ok: true, status: "active" };
}));

/**
 * The lifecycle gate (applied to the whole authed API in SaaS mode): a locked pump can still sign in, read its
 * account status and activate — everything else is blocked with 402 until it is active or on trial.
 */
const GATE_ALLOW = [/^\/account\//, /^\/business$/, /^\/branding/, /^\/auth\//, /^\/me$/];
export function tenantGate(req: Request, _res: Response, next: NextFunction) {
  if (!config.saas || !req.user) return next();
  if (GATE_ALLOW.some((re) => re.test(req.path))) return next();
  if (tenantState(req.user.tenant_id).locked)
    return next(new AppError(402, "Aap ka trial khatam ho gaya hai — pump activate karwayein."));
  next();
}

/* ================= Platform owner (super-admin above all pumps) ================= */
/** Seed the platform owner from env on boot (idempotent; keeps the password in sync). */
export function seedPlatformAdmin() {
  if (!config.saas || !config.platformEmail || !config.platformPassword) return;
  const hash = bcrypt.hashSync(config.platformPassword, 10);
  const a = get("SELECT id FROM platform_admins WHERE email=?", config.platformEmail);
  if (a) run("UPDATE platform_admins SET password_hash=? WHERE id=?", hash, a.id);
  else run("INSERT INTO platform_admins (email,password_hash,name,created_at) VALUES (?,?,?,?)", config.platformEmail, hash, "Platform owner", now());
}
const platformToken = (id: number) => jwt.sign({ padmin: id }, config.jwtSecret, { expiresIn: "7d" });
function requirePlatform(req: Request, _res: Response, next: NextFunction) {
  const hdr = req.headers.authorization;
  // a backup download opens in the browser itself, so a GET may carry the platform token as ?token=
  const token = hdr?.startsWith("Bearer ") ? hdr.slice(7) : req.method === "GET" && typeof req.query.token === "string" ? req.query.token : "";
  try {
    const p = jwt.verify(token, config.jwtSecret) as { padmin?: number };
    const a = p.padmin ? get("SELECT id, email, name FROM platform_admins WHERE id=?", p.padmin) : null;
    if (!a) throw new Error();
    (req as Request & { padmin?: { id: number; email: string } }).padmin = a as { id: number; email: string };
    next();
  } catch { next(new AppError(401, "Platform admin login chahiye")); }
}

saasPublic.post("/platform/login", h((req) => {
  const b = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
  const a = get("SELECT * FROM platform_admins WHERE email=?", b.email.toLowerCase());
  if (!a || !bcrypt.compareSync(b.password, a.password_hash)) throw new AppError(401, "Email ya password ghalat");
  return { token: platformToken(a.id), admin: { email: a.email, name: a.name } };
}));

// the protected platform panel — mounted at /platform, so requirePlatform only guards these routes
const platform = Router();
platform.use(requirePlatform);
platform.get("/tenants", h(() =>
  ({ tenants: all(`SELECT t.id, t.name, t.slug, t.owner_name, t.owner_phone, t.status, t.trial_ends_at, t.activated_at, t.plan, t.paid_until, t.note, t.created_at,
       (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id) users,
       (SELECT email FROM users u WHERE u.tenant_id=t.id AND u.role='admin' ORDER BY u.id LIMIT 1) admin_email,
       (SELECT value FROM settings s WHERE s.tenant_id=t.id AND s.key='module_wholesale')='1' module_wholesale
     FROM tenants t ORDER BY t.id DESC`).map((r) => ({ ...r, module_wholesale: Boolean(r.module_wholesale), pump_url: r.slug ? `${config.publicUrl}/p/${r.slug}` : null })) })));
// turn a paid add-on module on/off for one pump (extra payment taken offline) — only the super-admin can do this
platform.post("/tenants/:id/module", h((req) => {
  const id = Number(req.params.id);
  const b = parse(z.object({ module: z.enum(["wholesale"]), on: z.boolean() }), req.body);
  if (!get("SELECT id FROM tenants WHERE id=?", id)) throw new AppError(404, "Pump nahi mila");
  setSetting(id, `module_${b.module}`, b.on ? "1" : "0");
  forgetModules(id);
  return { ok: true, module: b.module, on: b.on };
}));
/* ---- the pump's CEO logins: see them, reset email / phone / password / PIN (owner lost access, phone changed, left the pump) ---- */
const PLATFORM_USER = { id: 0, name: "Platform (super admin)" };
platform.get("/tenants/:id/admins", h((req) => {
  const id = Number(req.params.id);
  const t = get("SELECT id, name FROM tenants WHERE id=?", id);
  if (!t) throw new AppError(404, "Pump nahi mila");
  return { tenant: t, admins: all("SELECT id, name, email, phone, active, pin_hash IS NOT NULL has_pin, created_at FROM users WHERE tenant_id=? AND role='admin' ORDER BY id", id).map((u) => ({ ...u, has_pin: Boolean(u.has_pin), active: Boolean(u.active) })) };
}));
platform.post("/tenants/:id/admin-reset", h((req) => {
  const id = Number(req.params.id);
  const b = parse(z.object({
    user_id: z.number().int().positive(),
    email: z.string().trim().email().optional(), phone: z.string().trim().min(10).max(16).optional(),
    password: z.string().min(8, "Password kam az kam 8 harf").max(80).optional(), pin: z.string().regex(/^\d{4}$/, "PIN 4 hindse").optional(),
    name: z.string().trim().min(2).max(80).optional(),
  }), req.body);
  const u = get("SELECT * FROM users WHERE id=? AND tenant_id=? AND role='admin'", b.user_id, id);
  if (!u) throw new AppError(404, "Is pump ka CEO user nahi mila");
  if (!b.email && !b.phone && !b.password && !b.pin && !b.name) throw new AppError(400, "Kuch to badlein: email, phone, password ya PIN");
  const email = b.email?.toLowerCase();
  if (email && email !== u.email && get("SELECT 1 x FROM users WHERE email=? AND id<>?", email, u.id)) throw new AppError(400, "Ye email kisi aur user par pehle se hai");
  const phone = b.phone ? normalizePhone(b.phone) : undefined;
  tx(() => {
    if (b.name) run("UPDATE users SET name=? WHERE id=?", b.name, u.id);
    if (email) run("UPDATE users SET email=? WHERE id=?", email, u.id);
    if (phone) run("UPDATE users SET phone=? WHERE id=?", phone, u.id);
    if (b.password) run("UPDATE users SET password_hash=?, pw_fails=0, pw_locked_until=NULL WHERE id=?", bcrypt.hashSync(b.password, 10), u.id);
    if (b.pin) run("UPDATE users SET pin_hash=?, pin_fails=0, pin_locked_until=NULL WHERE id=?", bcrypt.hashSync(b.pin, 10), u.id);
    // a credential change signs the person out everywhere (token_version is checked on every request); also unlocks the account
    run("UPDATE users SET active=1, token_version=COALESCE(token_version,0)+1 WHERE id=?", u.id);
  });
  audit(id, PLATFORM_USER, "platform_admin_reset", `user:${u.id}`, { name: b.name ?? undefined, email: email ?? undefined, phone: phone ?? undefined, password: Boolean(b.password), pin: Boolean(b.pin) });
  return { ok: true, user: get("SELECT id, name, email, phone, active, pin_hash IS NOT NULL has_pin FROM users WHERE id=?", u.id) };
}));

/**
 * Delete a pump outright: a whole-database backup is taken first (Settings → Backups / platform backups keep it), then every row
 * of that tenant goes — the 85 tenant_id tables plus the child tables that hang off its stations, tanks, shifts, customers, users,
 * clients, items and charts. The platform admin must type the pump's exact name. Nothing of another pump is touched.
 */
platform.delete("/tenants/:id", h((req) => {
  const id = Number(req.params.id);
  const b = parse(z.object({ confirm: z.string().trim().min(1) }), req.body ?? {});
  const t = get("SELECT * FROM tenants WHERE id=?", id);
  if (!t) throw new AppError(404, "Pump nahi mila");
  if (b.confirm.trim().toLowerCase() !== String(t.name).trim().toLowerCase()) throw new AppError(400, `Pump ka naam bilkul waisa likhein: "${t.name}"`);
  const backup = makeBackup();
  const counts: Record<string, number> = {};
  const del = (sql: string, ...args: (string | number)[]) => { const r = run(sql, ...args); const tbl = sql.match(/FROM (\w+)/i)?.[1] ?? sql; if (r.changes) counts[tbl] = (counts[tbl] ?? 0) + Number(r.changes); };
  tx(() => {
    // foreign keys are checked at commit, when every row of the pump is already gone (parents go before children otherwise)
    db.exec("PRAGMA defer_foreign_keys=ON");
    // child tables without tenant_id, by their owners (owners still exist at this point)
    const ST = "SELECT id FROM stations WHERE tenant_id=?", TK = `SELECT id FROM tanks WHERE station_id IN (${ST})`, SH = `SELECT id FROM shifts WHERE station_id IN (${ST})`;
    const CU = "SELECT id FROM customers WHERE tenant_id=?", US = "SELECT id FROM users WHERE tenant_id=?", CL = "SELECT id FROM wholesale_clients WHERE tenant_id=?";
    del(`DELETE FROM meter_readings WHERE shift_id IN (${SH})`, id);
    del(`DELETE FROM shift_dips WHERE shift_id IN (${SH})`, id);
    del(`DELETE FROM sales WHERE station_id IN (${ST})`, id);
    del(`DELETE FROM vehicles WHERE customer_id IN (${CU})`, id);
    del(`DELETE FROM khata_ledger WHERE customer_id IN (${CU})`, id);
    del(`DELETE FROM deliveries WHERE tank_id IN (${TK})`, id);
    del(`DELETE FROM dip_readings WHERE tank_id IN (${TK})`, id);
    del(`DELETE FROM tank_charts WHERE tank_id IN (${TK})`, id);
    del(`DELETE FROM nozzles WHERE station_id IN (${ST})`, id);
    del(`DELETE FROM tanks WHERE station_id IN (${ST})`, id);
    del(`DELETE FROM shifts WHERE station_id IN (${ST})`, id);
    del(`DELETE FROM wholesale_rates WHERE client_id IN (${CL})`, id);
    del(`DELETE FROM wholesale_rate_history WHERE client_id IN (${CL})`, id);
    del(`DELETE FROM login_otps WHERE user_id IN (${US})`, id);
    if (get("SELECT 1 x FROM sqlite_master WHERE name='conversations'")) del("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE tenant_id=?)", id);
    del("DELETE FROM dip_chart_rows WHERE chart_id IN (SELECT id FROM dip_charts WHERE tenant_id=?)", id);
    del("DELETE FROM shop_sale_lines WHERE sale_id IN (SELECT id FROM shop_sales WHERE tenant_id=?)", id);
    del("DELETE FROM shop_moves WHERE item_id IN (SELECT id FROM shop_items WHERE tenant_id=?)", id);
    // every table that carries tenant_id (the tenant row itself last)
    const tables = all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'tenants'").map((r) => r.name as string);
    for (const name of tables) {
      const cols = (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name);
      if (cols.includes("tenant_id")) del(`DELETE FROM ${name} WHERE tenant_id=?`, id);
    }
    run("UPDATE activation_codes SET used_by_tenant=NULL WHERE used_by_tenant=?", id); // the code stays spent-marked by used_at; the pump is gone
    del("DELETE FROM tenants WHERE id=?", id);
  });
  forgetModules(id);
  console.log(`[platform] pump #${id} "${t.name}" deleted (backup ${backup.name}); rows:`, counts);
  return { ok: true, deleted: { id, name: t.name, slug: t.slug }, backup, rows: Object.values(counts).reduce((a, n) => a + n, 0), tables: counts };
}));

/** Make a test pump (every role, one entry of every kind, expected vs actual) on this very server — for the owner to check the arithmetic. */
platform.post("/test-pump", h(async (req) => {
  const { runTestPump } = await import("../testPump.js");
  // call back into this very server on whichever port it is actually listening (tests use a random one)
  return runTestPump(`http://127.0.0.1:${req.socket.localPort ?? config.port}`, { publicUrl: config.publicUrl });
}));
/** Give a pump its plan: lifetime (never expires), yearly / monthly (access till paid_until), or back to trial. */
platform.post("/tenants/:id/plan", h((req) => {
  const id = Number(req.params.id);
  const b = parse(z.object({ plan: z.enum(["lifetime", "yearly", "monthly", "trial"]), paid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(), note: z.string().max(200).optional().nullable() }), req.body);
  const t = get("SELECT * FROM tenants WHERE id=?", id);
  if (!t) throw new AppError(404, "Pump nahi mila");
  const by = `platform:${(req as Request & { padmin?: { email: string } }).padmin?.email ?? ""}`;
  if (b.plan === "trial") {
    run("UPDATE tenants SET status='trial', plan=NULL, paid_until=NULL, trial_ends_at=?, note=COALESCE(?, note) WHERE id=?", trialEnd(), b.note ?? null, id);
  } else {
    let until: string | null = null;
    if (b.plan !== "lifetime") {
      // default: a month / a year from today (or from the current paid-until when extending a plan still running)
      const base = t.paid_until && Date.parse(t.paid_until) > Date.now() ? new Date(t.paid_until) : new Date();
      if (b.paid_until) until = b.paid_until;
      else { const d = new Date(base); if (b.plan === "monthly") d.setMonth(d.getMonth() + 1); else d.setFullYear(d.getFullYear() + 1); until = d.toISOString().slice(0, 10); }
    }
    run("UPDATE tenants SET status='active', plan=?, paid_until=?, activated_at=COALESCE(activated_at, ?), activated_by=?, note=COALESCE(?, note) WHERE id=?", b.plan, until, now(), by, b.note ?? null, id);
  }
  audit(id, { id: 0, name: by }, "platform_plan", `tenant:${id}`, { plan: b.plan, paid_until: b.paid_until ?? null, was: { status: t.status, plan: t.plan, paid_until: t.paid_until } });
  return { ok: true, tenant: get("SELECT id, name, status, plan, paid_until, trial_ends_at FROM tenants WHERE id=?", id), state: tenantState(id) };
}));

/** The platform dashboard: fleet-wide numbers, what needs attention, sign-ups by month, and every pump with its activity. */
platform.get("/overview", h(() => {
  const todayPk = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  const todayUtc = new Date(`${todayPk}T00:00:00+05:00`).toISOString();
  const d30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const d3 = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const tenants = all(`SELECT t.id, t.name, t.slug, t.owner_name, t.owner_phone, t.status, t.trial_ends_at, t.activated_at, t.plan, t.paid_until, t.note, t.created_at,
       (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id AND u.active=1) users,
       (SELECT COUNT(*) FROM stations s WHERE s.tenant_id=t.id) stations,
       (SELECT email FROM users u WHERE u.tenant_id=t.id AND u.role='admin' ORDER BY u.id LIMIT 1) admin_email,
       (SELECT value FROM settings s WHERE s.tenant_id=t.id AND s.key='module_wholesale')='1' module_wholesale,
       (SELECT MAX(created_at) FROM audit_log a WHERE a.tenant_id=t.id) last_activity,
       (SELECT COALESCE(SUM(sa.amount),0) FROM sales sa JOIN stations s ON s.id=sa.station_id WHERE s.tenant_id=t.id AND sa.created_at>=?) sales_30d,
       (SELECT COALESCE(SUM(sa.amount),0) FROM sales sa JOIN stations s ON s.id=sa.station_id WHERE s.tenant_id=t.id AND sa.created_at>=?) sales_today,
       (SELECT COALESCE(SUM(sa.litres),0) FROM sales sa JOIN stations s ON s.id=sa.station_id WHERE s.tenant_id=t.id AND sa.created_at>=?) litres_today,
       (SELECT COUNT(*) FROM sessions se WHERE se.tenant_id=t.id AND se.revoked_at IS NULL AND se.last_seen_at>=?) online
     FROM tenants t ORDER BY t.id DESC`, d30, todayUtc, todayUtc, new Date(Date.now() - 15 * 60_000).toISOString())
    .map((r) => ({ ...r, module_wholesale: Boolean(r.module_wholesale), pump_url: r.slug ? `${config.publicUrl}/p/${r.slug}` : null, ...pick(tenantState(r.id), ["days_left", "locked", "lifetime", "plan_expired"]) }));
  const byStatus = (s: string) => tenants.filter((t) => t.status === s).length;
  const attention: { kind: string; tenant_id: number; name: string; text: string }[] = [];
  for (const t of tenants) {
    if (t.status === "trial" && t.days_left <= 3) attention.push({ kind: t.locked ? "trial_over" : "trial_ending", tenant_id: t.id, name: t.name, text: t.locked ? "Trial khatam — pump locked hai" : `Trial ${t.days_left} din me khatam` });
    if (t.plan_expired) attention.push({ kind: "plan_expired", tenant_id: t.id, name: t.name, text: `${t.plan} plan ${t.paid_until} ko khatam — pump locked` });
    else if (t.status === "active" && t.paid_until && !t.lifetime && t.days_left <= 7) attention.push({ kind: "plan_ending", tenant_id: t.id, name: t.name, text: `${t.plan} plan ${t.days_left} din me khatam (${t.paid_until})` });
    if (t.status === "active" && t.last_activity && t.last_activity < d3 && !/^test-pump/.test(t.slug ?? "")) attention.push({ kind: "silent", tenant_id: t.id, name: t.name, text: `3+ din se koi activity nahi` });
  }
  const months: { month: string; signups: number }[] = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); const m = d.toISOString().slice(0, 7); months.push({ month: m, signups: tenants.filter((t) => String(t.created_at).startsWith(m)).length }); }
  const backups = listBackups();
  let dbBytes = 0; try { dbBytes = fs.statSync(config.dbPath).size; } catch { /* in-memory / missing */ }
  return {
    now: now(),
    kpis: {
      pumps: tenants.length, active: byStatus("active"), trial: byStatus("trial"), suspended: byStatus("suspended"),
      lifetime: tenants.filter((t) => t.lifetime).length, locked: tenants.filter((t) => t.locked).length,
      users: tenants.reduce((a, t) => a + Number(t.users), 0), online: tenants.reduce((a, t) => a + Number(t.online), 0),
      new_this_month: months[months.length - 1].signups,
      sales_today: tenants.reduce((a, t) => a + Number(t.sales_today), 0), litres_today: tenants.reduce((a, t) => a + Number(t.litres_today), 0),
      sales_30d: tenants.reduce((a, t) => a + Number(t.sales_30d), 0),
      db_bytes: dbBytes, backups: backups.length, last_backup: backups[0]?.name ?? null,
    },
    attention, months, tenants,
    codes_unused: get("SELECT COUNT(*) n FROM activation_codes WHERE used_by_tenant IS NULL")!.n,
  };
}));
platform.use(catalogPlatform);
/* ---- Server tab: the machine, volume, traffic, health and error log — no need to open Fly.io ---- */
platform.get("/server", h(() => serverStatus()));
platform.get("/server/logs", h((req) => ({ logs: serverLogs(String(req.query.level ?? "all"), Math.min(500, Number(req.query.limit ?? 200))) })));
platform.post("/server/logs/clear", h(() => ({ ok: true, cleared: clearServerLogs() })));
const pick = <T extends Record<string, unknown>>(o: T, keys: (keyof T)[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

platform.post("/tenants/:id/:action", h((req) => {
  const id = Number(req.params.id), action = req.params.action;
  if (!get("SELECT id FROM tenants WHERE id=?", id)) throw new AppError(404, "Pump nahi mila");
  if (action === "activate") run("UPDATE tenants SET status='active', activated_at=?, activated_by=? WHERE id=?", now(), "platform", id);
  else if (action === "suspend") run("UPDATE tenants SET status='suspended' WHERE id=?", id);
  else if (action === "trial") run("UPDATE tenants SET status='trial', trial_ends_at=? WHERE id=?", trialEnd(), id);
  else throw new AppError(400, "Unknown action");
  return { ok: true, status: get("SELECT status FROM tenants WHERE id=?", id)!.status };
}));
platform.get("/codes", h(() => ({ codes: all("SELECT * FROM activation_codes ORDER BY id DESC LIMIT 200") })));
// whole-database backups (every pump in one file) + Google Drive / Dropbox copies — platform owner only in SaaS
mountBackupRoutes(platform, (_req, _res, next) => next(), (req) => ({ t: 0, user: { id: 0, name: `platform:${(req as Request & { padmin?: { email: string } }).padmin?.email ?? ""}` } }));
platform.post("/codes", h((req) => {
  const b = parse(z.object({ count: z.number().int().min(1).max(50).default(1), plan: z.string().max(40).optional(), note: z.string().max(120).optional() }), req.body);
  const made: string[] = [];
  for (let i = 0; i < b.count; i++) {
    let code = "", tries = 0;
    do { code = `PPAI-${Array.from({ length: 2 }, () => Math.random().toString(36).slice(2, 6).toUpperCase()).join("-")}`; tries++; }
    while (get("SELECT 1 FROM activation_codes WHERE code=?", code) && tries < 10);
    run("INSERT INTO activation_codes (code,plan,note,created_by,created_at) VALUES (?,?,?,?,?)",
      code, b.plan ?? null, b.note ?? null, (req as Request & { padmin?: { email: string } }).padmin?.email ?? null, now());
    made.push(code);
  }
  return { codes: made };
}));
saasPublic.use("/platform", platform);
