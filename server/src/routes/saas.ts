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
import { all, get, run, now, setSetting } from "../db.js";
import { h, parse, tid, forgetModules } from "../auth.js";
import { AppError } from "../services.js";
import { setupBody, provisionTenant } from "./setup.js";
import { mountBackupRoutes } from "./system.js";

export const saasPublic = Router();  // no login (sign-up, platform login + panel)
export const saasAuthed = Router();  // after requireAuth (the pump owner's own account)

const trialEnd = () => new Date(Date.now() + config.trialDays * 86_400_000).toISOString();

/** A pump's lifecycle state: locked when the trial has run out or it was suspended. */
export function tenantState(t: number) {
  const row = get("SELECT status, trial_ends_at FROM tenants WHERE id=?", t);
  const status = (row?.status as string) ?? "active";
  const ends = (row?.trial_ends_at as string) ?? null;
  const expired = status === "trial" && ends != null && Date.parse(ends) < Date.now();
  const daysLeft = ends ? Math.max(0, Math.ceil((Date.parse(ends) - Date.now()) / 86_400_000)) : 0;
  return { status, trial_ends_at: ends, days_left: daysLeft, locked: status === "suspended" || expired };
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
  ({ tenants: all(`SELECT t.id, t.name, t.slug, t.owner_name, t.owner_phone, t.status, t.trial_ends_at, t.activated_at, t.plan, t.created_at,
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
