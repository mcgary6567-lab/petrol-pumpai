import express from "express";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { config, aiEnabled, aiProvider, aiModelName, waLive, APP_VERSION } from "./config.js";
import { migrate, get, run, closeDb } from "./db.js";
import bcrypt from "bcryptjs";
import { AppError } from "./services.js";
import { requireAuth, cancelPinGuard, errorHandler, authenticate, issueSession, twoFaRequired, create2fa, verify2fa, pinLogin, pinUsers, h, parse, permissionsOf, modulesOf, mediaToken, signToken, revokeSessions } from "./auth.js";
import { sendToPhone } from "./whatsapp/cloud.js";
import { securityHeaders, rateLimit } from "./security.js";
import { privacyPage, termsPage } from "./legal.js";
import { sellPage } from "./sell.js";
import { operations } from "./routes/operations.js";
import { crm } from "./routes/crm.js";
import { waWebhook, inbox } from "./routes/whatsapp.js";
import { insightsRouter } from "./routes/insights.js";
import { managerDesk } from "./routes/managerDesk.js";
import { banks } from "./routes/banks.js";
import { wholesaleDesk } from "./routes/wholesaleDesk.js";
import { wholesaleVoice } from "./routes/wholesaleVoice.js";
import { khataVoice } from "./routes/khataVoice.js";
import { cashier } from "./routes/cashier.js";
import { search } from "./routes/search.js";
import { live, announceWrites } from "./routes/live.js";
import { salesHistory } from "./routes/salesHistory.js";
import { owner } from "./routes/owner.js";
import { dayfeed } from "./routes/dayfeed.js";
import { users } from "./routes/users.js";
import { wholesale } from "./routes/wholesale.js";
import { carriage } from "./routes/carriage.js";
import { bypass } from "./routes/bypass.js";
import { dipCharts } from "./routes/dipCharts.js";
import { pinPortalAdmin, pinPortalPublic, pinLink } from "./routes/pinPortal.js";
import { expenses } from "./routes/expenses.js";
import { suppliers } from "./routes/suppliers.js";
import { reports } from "./routes/reports.js";
import { notifications } from "./routes/notifications.js";
import { pos } from "./routes/pos.js";
import { capture } from "./routes/capture.js";
import { renderBill } from "./billing.js";
import { staffRouter } from "./routes/staff.js";
import { backoffice, renderDay } from "./routes/backoffice.js";
import { shop } from "./routes/shop.js";
import { compliance, attendPublic } from "./routes/compliance.js";
import { analysis } from "./routes/analysis.js";
import { care, portalFromOldToken } from "./routes/customerCare.js";
import { system, cloudPublic } from "./routes/system.js";
import { renderReceipt } from "./billing.js";
import { prepaid } from "./routes/prepaid.js";
import { approvals } from "./routes/approvals.js";
import { feedback } from "./routes/feedback.js";
import { board, boardData, renderBoard } from "./routes/board.js";
import { register } from "./routes/register.js";
import { recurring } from "./routes/recurring.js";
import { property } from "./routes/property.js";
import { claims } from "./routes/claims.js";
import { tax } from "./routes/tax.js";
import { bankrec } from "./routes/bankrec.js";
import { ledger } from "./routes/ledger.js";
import { otherEntries } from "./routes/otherEntries.js";
import { investors } from "./routes/investors.js";
import { books } from "./routes/books.js";
import { corrections } from "./routes/corrections.js";
import { fullEdit } from "./routes/fullEdit.js";
import { parties } from "./routes/parties.js";
import { requestMetrics, installProcessLogging } from "./serverStatus.js";
import { payRequests } from "./routes/payRequests.js";
import { catalogTenant } from "./routes/catalog.js";
import { opening } from "./routes/opening.js";
import { golive } from "./routes/golive.js";
import { io } from "./routes/io.js";
import { docs } from "./routes/docs.js";
import { docFromToken } from "./docs.js";
import { paymentInbox } from "./routes/paymentInbox.js";
import { people, slipPdf } from "./routes/people.js";
import { setupPublic, business, applyStoredConfig, pumpUrl } from "./routes/setup.js";
import { saasPublic, saasAuthed, tenantGate, seedPlatformAdmin, tenantState } from "./routes/saas.js";
import { auditTrail, auditRouter } from "./routes/auditTrail.js";
import { machines } from "./routes/machines.js";
import { lookupsRouter } from "./routes/lookups.js";
import { productsRouter, refreshProducts } from "./products.js";
import { getSetting } from "./db.js";
import { startScheduler } from "./automation/scheduler.js";
import { seed } from "./seed.js";

migrate();
applyStoredConfig();
seedPlatformAdmin(); // SaaS mode: keep the platform owner (super-admin) in sync with the env
refreshProducts(); // load the admin's fuel products into config.PRODUCTS / PRODUCT_META
if (!get("SELECT id FROM tenants LIMIT 1")) {
  if (config.demoData) {
    console.log("[db] empty database — loading demo data");
    seed();
  } else console.log("[setup] new installation — open the app in a browser to run the setup wizard");
}

export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // the real visitor's address comes from nginx / Caddy in front
app.use(securityHeaders);
app.use(requestMetrics); // per-minute traffic / latency / errors for the platform's Server tab
installProcessLogging();
// the web app is served from the same address, so no cross-site access is needed (the demo on Vercel too)
// small bodies for the doors anyone can reach; photos and logos only after sign-in (or in the one-time setup)
const rawBody = (req: any, _res: unknown, buf: Buffer) => { req.rawBody = buf; };
app.use(/^\/(api\/auth|webhooks|w\/|k\/|i\/)/, express.json({ limit: "256kb", verify: rawBody }));
// an old PumpAI backup (.db) uploaded whole for the master shop catalog — raw bytes, platform login checked by the route
app.use("/api/platform/catalog/from-backup", express.raw({ type: () => true, limit: "400mb" }));
app.use(express.json({ limit: "8mb", verify: rawBody }));
app.use("/api/auth", rateLimit("auth", 30, 10 * 60_000));
app.use("/api/setup", rateLimit("setup", 20, 10 * 60_000));
// the PIN page and its PIN tries; slip photos on the page (behind the PIN cookie) are not counted
app.use(/^\/(w|k|i)\/[^/]+\/?$/, rateLimit("portal", 60, 10 * 60_000));
// SaaS public doors: stop tenant-spam sign-ups, platform-login guessing and activation-code brute force
app.use("/api/signup", rateLimit("signup", 10, 10 * 60_000));
app.use("/api/platform/login", rateLimit("platform-login", 20, 10 * 60_000));
app.use("/api/account/activate", rateLimit("activate", 15, 10 * 60_000));

app.get("/api/health", (_req, res) => {
  let db = true;
  try { get("SELECT 1 x"); } catch { db = false; }
  res.status(db ? 200 : 503).json({ ok: db, db, version: APP_VERSION, ai: aiProvider() === "none" ? "rules" : aiProvider(), whatsapp: waLive() ? "live" : "simulated" });
});
app.use("/api/attend", rateLimit("attend", 40, 10 * 60_000)); // QR self check-in: stop code guessing
app.use("/api", attendPublic); // non-login workers' QR + 4-digit self check-in (no login)
app.use("/api", cloudPublic); // Google Drive OAuth callback (browser redirect, no auth header — guarded by state nonce)
app.use("/api", setupPublic); // setup wizard + branding (no login)
app.use("/api", saasPublic); // SaaS mode: public sign-up + platform owner panel (no login)
// business logo (login page, receipts, bills, TV board, app icon)
/**
 * The pump's own app icon: its logo on a square PNG (192 / 512 for the manifest, 180 for iOS). ?pump=<slug> or ?v=<logo id>;
 * &maskable=1 pads the logo into the safe zone on the brand colour so Android's round / squircle masks never cut it.
 * Rendered once per (logo, size, shape) and kept in memory; a pump without a logo (or an image Jimp can't read) gets the generic icon.
 */
const iconCache = new Map<string, Buffer>();
app.get("/branding/icon-:size.png", async (req, res) => {
  const size = Math.min(1024, Math.max(32, Number(req.params.size) || 192));
  const maskable = req.query.maskable === "1";
  const slug = String(req.query.pump ?? "").trim().toLowerCase();
  const t = slug ? get("SELECT id FROM tenants WHERE slug=?", slug) : null;
  const v = Number(req.query.v) || (t ? Number(getSetting(t.id, "logo_photo_id")) : 0);
  const tenantId = t?.id ?? (v ? get("SELECT tenant_id FROM photos WHERE id=? AND kind='logo'", v)?.tenant_id : null);
  const color = tenantId ? (getSetting(tenantId, "brand_color", "") || "#059669") : "#059669";
  const fallback = () => res.redirect(302, size > 256 ? "/icon-512.png" : size > 150 ? "/icon-192.png" : "/icon-192.png");
  const p = v ? get("SELECT mime, data FROM photos WHERE id=? AND kind='logo'", v) : null;
  if (!p) return fallback();
  const key = `${v}:${size}:${maskable ? "m" : "a"}:${color}`;
  try {
    let png = iconCache.get(key);
    if (!png) {
      const { Jimp } = await import("jimp");
      const logo = await Jimp.read(Buffer.from(p.data as Uint8Array));
      // "any": logo on white with a little air; "maskable": logo inside the 80% safe zone on the brand colour
      const pad = maskable ? 0.2 : 0.08;
      const inner = Math.round(size * (1 - 2 * pad));
      logo.contain({ w: inner, h: inner });
      const bg = maskable ? parseInt(color.replace("#", "").padEnd(6, "0").slice(0, 6) + "ff", 16) : 0xffffffff;
      const canvas = new Jimp({ width: size, height: size, color: bg });
      canvas.composite(logo, Math.round((size - logo.bitmap.width) / 2), Math.round((size - logo.bitmap.height) / 2));
      png = await canvas.getBuffer("image/png");
      if (iconCache.size > 200) iconCache.clear();
      iconCache.set(key, png);
    }
    res.setHeader("content-type", "image/png");
    res.setHeader("cache-control", "public, max-age=86400");
    res.send(png);
  } catch (e) {
    console.error("[icon]", (e as Error).message);
    fallback();
  }
});
app.get("/branding/logo", (req, res) => {
  // ?v=<photo id> → that pump's logo (SaaS: every pump has its own); no id → the first pump's (single-pump install)
  const v = Number(req.query.v) || 0;
  const t = v ? null : get("SELECT id FROM tenants ORDER BY id LIMIT 1");
  const id = v || (t ? Number(getSetting(t.id, "logo_photo_id")) : 0);
  const p = id ? get("SELECT mime, data FROM photos WHERE id=? AND kind='logo'", id) : null;
  if (!p) return res.status(404).end();
  res.setHeader("content-type", p.mime);
  res.setHeader("cache-control", "public, max-age=3600");
  res.end(Buffer.from(p.data as Uint8Array));
});
// install-as-app manifest with this pump's own name and logo
app.get("/manifest.webmanifest", (req, res) => {
  // ?pump=<slug> → that pump's own app (name, logo, colour, opens on its own sign-in link); SaaS without a slug stays generic,
  // the single-pump install uses its one pump
  const slug = String(req.query.pump ?? "").trim().toLowerCase();
  const t = slug ? get("SELECT * FROM tenants WHERE slug=?", slug) : config.saas ? null : get("SELECT * FROM tenants ORDER BY id LIMIT 1");
  const logo = t && getSetting(t.id, "logo_photo_id");
  const home = t?.slug ? `/p/${t.slug}` : "/";
  const color = (t && getSetting(t.id, "brand_color")) || "#064e3b";
  // PNG icons (192 + 512 + maskable) make the app installable on every Android/Chrome; the pump's own logo is added first when set
  const pngIcons = [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ];
  res.type("application/manifest+json").send(JSON.stringify({
    id: home, name: t?.name ? `${t.name}` : "Petrol PumpAI", short_name: t?.name?.slice(0, 12) ?? "PumpAI",
    description: t?.name ? `${t.name} — AI Pump Management System` : "AI Pump Management System — sales, khata, stock and accounts, works offline.",
    start_url: home, scope: "/", display: "standalone", orientation: "portrait",
    background_color: "#ffffff", theme_color: color,
    // the pump's logo rendered as real square PNGs (any + maskable), so the installed app carries the pump's own icon
    icons: logo ? [
      { src: `/branding/icon-192.png?v=${logo}`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `/branding/icon-512.png?v=${logo}`, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: `/branding/icon-512.png?v=${logo}&maskable=1`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ] : pngIcons,
  }));
});
app.post("/api/auth/login", h(async (req) => {
  // `email` may also be a phone number (staff rarely have email); `pump` = the slug from the pump's own link, so a phone
  // shared by two pumps' staff still resolves to the right one
  const b = parse(z.object({ email: z.string().trim().min(3).max(120), password: z.string().min(1), pump: z.string().trim().max(60).optional() }), req.body);
  const scope = b.pump ? (get("SELECT id FROM tenants WHERE slug=?", b.pump.toLowerCase())?.id as number | undefined) : undefined;
  const u = authenticate(b.email, b.password, scope);
  // owner two-factor: password is right, now send a one-time code on WhatsApp and ask for it
  if (twoFaRequired(u)) {
    const code = create2fa(u.id);
    const masked = String(u.phone).replace(/.(?=.{3})/g, "•");
    try { await sendToPhone(u.phone, `PumpAI login code: ${code}\n10 minute mein expire ho jayega. Agar aap ne login nahi kiya to apna password badlein.`); } catch { /* shown on screen fallback below */ }
    return { twofa: true, user_id: u.id, phone_hint: masked };
  }
  return issueSession(u, "password", { ua: req.headers["user-agent"], ip: req.ip });
}));
app.post("/api/auth/verify-2fa", h((req) => {
  const b = parse(z.object({ user_id: z.number().int(), code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") }), req.body);
  return verify2fa(b.user_id, b.code, { ua: req.headers["user-agent"], ip: req.ip });
}));
app.get("/api/auth/pin-users", h((req) => pinUsers(req.headers["x-device"] as string | undefined)));
app.post("/api/auth/pin", h((req) => {
  const b = parse(z.object({ user_id: z.number(), pin: z.string().regex(/^\d{4}$/, "PIN is 4 digits") }), req.body);
  return pinLogin(req.headers["x-device"] as string | undefined, b.user_id, b.pin, { ua: req.headers["user-agent"], ip: req.ip });
}));
// signed monthly bill / statement link sent on WhatsApp (no login needed)
app.get("/bill/:token", (req, res) => {
  const html = renderBill(req.params.token);
  res.status(html ? 200 : 404).type("html").send(html ?? "<p style='font-family:sans-serif'>This bill link is not valid or has expired.</p>");
});
app.get("/day/:token", (req, res) => {
  const html = renderDay(req.params.token);
  res.status(html ? 200 : 404).type("html").send(html ?? "<p style='font-family:sans-serif'>This report link is not valid.</p>");
});
app.get("/privacy", (_req, res) => res.type("html").send(privacyPage()));
app.get("/terms", (_req, res) => res.type("html").send(termsPage()));
// public sales / landing page (SaaS) — pump owners read it and sign up
if (config.saas) {
  app.get(["/sell", "/landing"], (_req, res) => res.type("html").send(sellPage()));
}
// Digital Asset Links — proves this website owns the Android app (Play Store TWA). Empty until the
// app's package + signing fingerprint(s) are set (ANDROID_PACKAGE, ANDROID_CERT_FINGERPRINTS).
app.get("/.well-known/assetlinks.json", (_req, res) => {
  const { package: pkg, fingerprints } = config.android;
  const links = pkg && fingerprints.length
    ? [{ relation: ["delegate_permission/common.handle_all_urls"],
         target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: fingerprints } }]
    : [];
  res.type("application/json").send(JSON.stringify(links, null, 2));
});
// digital receipt for walk-in customers (QR on the POS)
app.get("/r/:token", (req, res) => {
  // ?print=1 auto-opens the printer; ?w=58 / ?w=80 lays it out for a small thermal roll
  const width = Number(req.query.w);
  const html = renderReceipt(req.params.token, { print: req.query.print === "1", width: width === 58 || width === 80 ? width : undefined });
  res.status(html ? 200 : 404).type("html").send(html ?? "<p style='font-family:sans-serif'>Receipt not found.</p>");
});
// wholesale client's own khata (short link + PIN)
app.use(pinPortalPublic);
// khata customer's own page (private link)
app.get("/portal/:token", (req, res) => {
  // links sent before PINs: open the PIN page for the same customer
  const c = portalFromOldToken(req.params.token);
  c ? res.redirect(302, new URL(pinLink("k", c)).pathname) : res.status(404).type("html").send("<p style='font-family:sans-serif'>This link is no longer valid. Ask the pump for a new one.</p>");
});
// TV rate board at the pump (signed link, refreshes by itself)
app.get("/board/:token", (req, res) => {
  const html = renderBoard(req.params.token);
  res.status(html ? 200 : 404).type("html").send(html ?? "<p style='font-family:sans-serif'>This board link is not valid.</p>");
});
app.get("/board/:token/data", (req, res) => {
  const d = boardData(req.params.token);
  res.setHeader("cache-control", "no-store");
  d ? res.json(d) : res.status(404).json({ error: "Not found" });
});
// salary slip PDF (signed link sent to the staff member on WhatsApp)
app.get("/slip/:token", (req, res) => {
  const pdf = slipPdf(req.params.token);
  if (!pdf) return res.status(404).type("html").send("<p style='font-family:sans-serif'>This salary slip link is not valid.</p>");
  res.setHeader("content-type", "application/pdf");
  res.setHeader("content-disposition", "inline; filename=salary-slip.pdf");
  res.end(pdf);
});
// any document (voucher, statement, shift report, receipt) by its signed link — what WhatsApp carries
app.get("/doc/:token", (req, res) => {
  const d = docFromToken(req.params.token);
  if (!d) return res.status(404).type("html").send("<p style='font-family:sans-serif'>This document link is not valid.</p>");
  if (!d.pdf) return res.redirect(d.link!);
  res.setHeader("content-type", "application/pdf");
  res.setHeader("content-disposition", `inline; filename="${d.filename}"`);
  res.end(d.pdf);
});
app.use("/webhooks/whatsapp", waWebhook);

const api = express.Router();
// API data is live and per-user — never let a browser or proxy cache a reply (reports must reflect the newest entry)
api.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate"); next(); });
api.use(requireAuth);
api.use(announceWrites); // every successful write is announced on /live so open screens refresh by themselves
api.use(cancelPinGuard); // cancelling (void / undo / delete) an entry needs the person's own PIN
api.use(tenantGate); // SaaS mode: a locked pump (trial over / suspended) can only reach its account + activate
api.use(saasAuthed); // the pump owner's own account: status + activate by code
api.use(auditTrail); // every change is written to the audit log
api.get("/me", h((req) => ({
  user: { ...req.user, station_name: req.user!.station_id ? get("SELECT name FROM stations WHERE id=?", req.user!.station_id)?.name : null },
  // the signed-in pump's own identity: name, brand colour and logo (SaaS: never another pump's)
  tenant: { ...get("SELECT id, name FROM tenants WHERE id=?", req.user!.tenant_id)!, color: getSetting(req.user!.tenant_id, "brand_color") || null,
    logo_url: getSetting(req.user!.tenant_id, "logo_photo_id") ? `/branding/logo?v=${getSetting(req.user!.tenant_id, "logo_photo_id")}` : null,
    slug: get("SELECT slug FROM tenants WHERE id=?", req.user!.tenant_id)?.slug ?? null, pump_url: pumpUrl(req.user!.tenant_id) },
  permissions: permissionsOf(req.user!.role, req.user!.tenant_id),
  // paid add-on modules this pump has (Wholesale & carriage is off by default)
  modules: modulesOf(req.user!.tenant_id),
  // SaaS mode: whether this pump is locked (trial over / suspended) so the app can show the activate screen
  account: config.saas ? { saas: true, ...tenantState(req.user!.tenant_id) } : { saas: false },
  // for links the browser opens itself (photos, downloads, live feed): short-lived and read-only
  media_token: mediaToken(req.user!.id),
})));
/** Set or change your own 4-digit PIN (your password proves it is you) — used for PIN sign-in and to confirm a cancel. */
api.post("/me/pin", rateLimit("pin-set", 10, 10 * 60_000), h((req) => {
  const b = parse(z.object({ password: z.string().min(1, "Apna password daalein"), pin: z.string().regex(/^\d{4}$/, "PIN 4 digits ka ho") }), req.body);
  if (/^(\d)\1{3}$/.test(b.pin) || b.pin === "1234") throw new AppError(400, "Itna aasaan PIN nahi (0000, 1111, 1234) — koi aur chunein");
  const u = get("SELECT * FROM users WHERE id=?", req.user!.id)!;
  if (!bcrypt.compareSync(b.password, u.password_hash)) throw new AppError(400, "Password sahi nahi");
  run("UPDATE users SET pin_hash=?, pin_fails=0, pin_locked_until=NULL WHERE id=?", bcrypt.hashSync(b.pin, 10), u.id);
  return { ok: true };
}));
/** Change your own password (the old one is needed); every other session is signed out. */
api.post("/me/password", rateLimit("pw-change", 10, 10 * 60_000), h((req) => {
  const b = parse(z.object({ old_password: z.string().min(1), new_password: z.string().min(8, "Use at least 8 characters").max(72) }), req.body);
  const u = get("SELECT * FROM users WHERE id=?", req.user!.id)!;
  if (!bcrypt.compareSync(b.old_password, u.password_hash)) throw new AppError(400, "The current password is not correct");
  run("UPDATE users SET password_hash=? WHERE id=?", bcrypt.hashSync(b.new_password, 10), u.id);
  revokeSessions(u.id);
  return { token: signToken(req.user!, { ua: req.headers["user-agent"], ip: req.ip, how: "password change" }) };
}));
api.use(operations);
api.use(crm);
api.use("/whatsapp", inbox);
api.use(insightsRouter);
api.use(managerDesk);
api.use(banks);
api.use(wholesaleDesk);
api.use(wholesaleVoice);
api.use(khataVoice);
api.use(cashier);
api.use(search);
api.use(live);
api.use(salesHistory);
api.use(owner);
api.use(dayfeed);
api.use(users);
api.use(wholesale);
api.use(carriage);
api.use(bypass);
api.use(dipCharts);
api.use(pinPortalAdmin);
api.use(expenses);
api.use(suppliers);
api.use(reports);
api.use(notifications);
api.use(pos);
api.use(capture);
api.use(staffRouter);
api.use(backoffice);
api.use(shop);
api.use(compliance);
api.use(analysis);
api.use(care);
api.use(system);
api.use(prepaid);
api.use(approvals);
api.use(feedback);
api.use(board);
api.use(register);
api.use(recurring);
api.use(property);
api.use(claims);
api.use(tax);
api.use(bankrec);
api.use(ledger);
api.use(otherEntries);
api.use(investors);
api.use(books);
api.use(corrections);
api.use(fullEdit);
api.use(parties);
api.use(payRequests);
api.use(catalogTenant);
api.use(opening);
api.use(golive);
api.use(io);
api.use(docs);
api.use(paymentInbox);
api.use(people);
api.use(business);
api.use(auditRouter);
api.use(machines);
api.use(lookupsRouter);
api.use(productsRouter);
app.use("/api", api);

// Serve the built dashboard in production
const webDist = path.resolve(process.env.WEB_DIST ?? "../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|webhooks).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}
app.use(errorHandler);

// on Vercel the app runs as a serverless function (api/index.mjs): no listen, no background scheduler
if (process.env.NODE_ENV !== "test" && !process.env.VERCEL) {
  const server = app.listen(config.port, () => {
    console.log(`PumpAI API on http://localhost:${config.port}  (AI: ${aiEnabled() ? aiModelName() : "rule engine"}, WhatsApp: ${waLive() ? "live" : "simulated"})`);
    if (!get("SELECT id FROM tenants LIMIT 1") && config.setupToken) console.log(`[setup] SETUP CODE: ${config.setupToken}  (the owner types it in the setup wizard)`);
    startScheduler();
  });
  // a clean stop writes everything into pumpai.db (a copy of that one file is then a full backup)
  const stop = (sig: string) => {
    console.log(`[server] ${sig} — closing`);
    server.close();
    closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}
