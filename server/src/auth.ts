import type { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { z, ZodError } from "zod";
import { config, waLive } from "./config.js";
import { all, get, run, getSetting, type Row } from "./db.js";
import { AppError, createAlert } from "./services.js";
/** Set by serverStatus.ts at start-up: records 500s in the platform's error log (late-bound to avoid an import cycle). */
export let onServerError: ((message: string, extra: { stack?: string | null; method?: string; path?: string; status?: number }) => void) | null = null;
export const setServerErrorHook = (fn: typeof onServerError) => { onServerError = fn; };

/**
 * Roles:
 *  - admin     (CEO / owner): full system access, users, settings, credit limits, wholesale rates
 *  - manager   : runs daily operations, CRM, WhatsApp, stock, prices, automations, expenses
 *  - salesman  : POS sales, own shifts and customer lookup at their assigned station only
 *  - wholesale : wholesale officer — only the wholesale supply module (supplies, returns, payments, statements)
 *  - cashier   : the cash counter — money received and paid, cheques, banks, cash from the salesmen, day book
 */
export const ROLES = ["admin", "manager", "salesman", "wholesale", "cashier", "staff"] as const;
export type Role = (typeof ROLES)[number];
export interface AuthUser { id: number; tenant_id: number; name: string; email: string; role: Role; station_id: number | null }

const ALL: Role[] = ["admin", "manager", "salesman"];
const WHOLESALE: Role[] = ["admin", "wholesale"];
const MGMT: Role[] = ["admin", "manager"];
const ADMIN: Role[] = ["admin"];
const CASHIER: Role[] = ["admin", "cashier"];

/** Single source of truth for access control; sent to the dashboard via /api/me. */
export const PERMISSIONS = {
  "dashboard.view": MGMT,
  "ai.ask": MGMT,
  "sales.create": ALL,
  "sales.view": ALL, // salesman: own station only
  "shifts.manage": ALL, // salesman: own shifts at own station only
  "shifts.view_all": MGMT,
  "shifts.expenses": ALL, // record expenses paid from the shift's cash (tea, generator fuel...)
  "customers.view": ALL, // salesman only reads khata accounts via the POS picker (/pos/khata-accounts)
  "customers.create": MGMT, // salesman cannot add customers — only pick existing khata accounts at the POS
  "customers.edit": MGMT,
  "credit.set_limit": ADMIN,
  "khata.manage": MGMT,
  "khata.clear_pending": ["admin", "manager", "cashier"], // clear a card-pending fuel hold and bill it to the khata (owner / manager / cashier)
  "whatsapp.inbox": MGMT,
  "orders.manage": MGMT,
  "complaints.manage": MGMT,
  "campaigns.manage": MGMT,
  "stock.manage": MGMT,
  "prices.view": ALL,
  "prices.update": MGMT,
  "alerts.view": MGMT,
  "automations.manage": MGMT,
  "stations.manage": ADMIN,
  "settings.manage": ADMIN,
  "users.manage": ADMIN,
  "staff.manage": MGMT, // staff advances, salary, cash shortages
  "wholesale.view": WHOLESALE,
  "wholesale.manage": WHOLESALE, // add clients, supplies, returns, payments
  "wholesale.rates": ADMIN, // set each client's per-litre rates, credit limits
  "wholesale.void": ADMIN, // cancel a wrong entry (stock is reversed)
  "carriage.view": WHOLESALE, // carriage / kiraya (bypass on our depot ID), run with thekedars
  "carriage.manage": WHOLESALE, // add thekedars, bill kiraya, record fuel money, take payments
  "carriage.void": ADMIN, // cancel a wrong carriage / fuel entry
  "expenses.view": MGMT,
  "expenses.create": MGMT,
  "expenses.approve": ADMIN, // approve manager expenses above the approval limit
  "reports.view": MGMT,
  "suppliers.manage": MGMT, // supplier accounts, fuel purchase cost, payments to suppliers
  "audit.view": ADMIN, // who changed what (prices, undo, deletes, edits, sign-ins)
  "investors.manage": ADMIN, // CEO-only: investors, their capital, fuel deals bought with it and the profit split
  "other_entries.manage": ADMIN, // CEO-only: record other income / expense / discount and see its report
  "cashier.void": ADMIN, // CEO-only: void a wrong cash receive/pay voucher and reverse the money it moved
  "entries.edit": ADMIN, // CEO-only: EDIT any entry made by cashier / manager / wholesale officer (voucher, sale, khata, supplier, wholesale, rent, delivery, shop, carriage) — reverses and re-posts it everywhere
  "opening.manage": ADMIN, // CEO-only: go-live opening balances (purana hisaab) for khata, parties, banks, staff, stock
  "corrections.manage": ADMIN, // CEO-only: void a wrong sale / manual khata entry / stock delivery and reverse everything it moved
  "photos.delete": ADMIN, // only the CEO can delete an uploaded photo; everyone else may only view
  "bank.view": CASHIER, // how much is in each bank account, statements
  "bank.manage": CASHIER, // add bank accounts, cash withdrawals, transfers, bank charges / profit
  "cashier.desk": CASHIER, // the cashier desk: what to collect, pay, deposit and clear today
  "cash.book": ["admin", "manager", "cashier"], // office cash book: count the cash, bank deposits
  "cash.receive": CASHIER, // take payments from khata customers, wholesale clients and others (receipt no.)
  "cash.pay": CASHIER, // pay suppliers, expenses, staff advances and others
  "cheques.manage": CASHIER, // cheque register: cheques received and issued — deposit, clear, bounce
  "shifts.handover": ["admin", "manager", "cashier"], // take the cash from a salesman when the shift closes
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

/*
 * Each pump can change what a role may do (Users & Roles → tick / untick). Changes are kept in
 * role_permissions and laid over the defaults above. The admin (owner) always has everything,
 * so nobody can lock the owner out.
 */
const overrides = new Map<number, Map<string, boolean>>(); // tenant → "perm|role" → allowed
function tenantOverrides(t: number) {
  let m = overrides.get(t);
  if (!m) {
    m = new Map(all("SELECT perm, role, allowed FROM role_permissions WHERE tenant_id=?", t).map((r) => [`${r.perm}|${r.role}`, Boolean(r.allowed)]));
    overrides.set(t, m);
  }
  return m;
}
export const forgetRoleOverrides = (t: number) => overrides.delete(t);

/*
 * Paid add-on modules (SaaS). "Wholesale & carriage" covers wholesale supply, carriage/kiraya and depot
 * bypass. It is OFF by default — most pumps do not do wholesale — so the whole module (menu, pages and API)
 * disappears for that pump. The platform super-admin turns it on for a pump that pays for it. The flag is a
 * per-tenant setting; cached here because allowed() is a hot path.
 */
const WHOLESALE_MODULE_PERMS = (p: string) => p.startsWith("wholesale.") || p.startsWith("carriage.");
const INVESTOR_MODULE_PERMS = (p: string) => p.startsWith("investors.");
const moduleOn = new Map<string, boolean>(); // "<module>:<tenant>" → on
function moduleFlag(key: "module_wholesale" | "module_investors", t: number) {
  const k = `${key}:${t}`;
  let v = moduleOn.get(k);
  if (v === undefined) { v = getSetting(t, key, "0") === "1"; moduleOn.set(k, v); }
  return v;
}
const wholesaleModuleOn = (t: number) => moduleFlag("module_wholesale", t);
/** "Investors" is a paid add-on too: off by default (most pumps run on the owner's money), on from the install wizard / Go-live. */
const investorsModuleOn = (t: number) => moduleFlag("module_investors", t);
export const forgetModules = (t: number) => { moduleOn.delete(`module_wholesale:${t}`); moduleOn.delete(`module_investors:${t}`); };
export const modulesOf = (t: number) => ({ wholesale: wholesaleModuleOn(t), investors: investorsModuleOn(t) });

export function allowed(tenantId: number, role: Role, perm: Permission): boolean {
  // paid module gate: with "Wholesale & carriage" off, nobody at this pump — not even the owner — has these
  if (WHOLESALE_MODULE_PERMS(perm) && !wholesaleModuleOn(tenantId)) return false;
  if (INVESTOR_MODULE_PERMS(perm) && !investorsModuleOn(tenantId)) return false;
  if (role === "admin") return true;
  const o = tenantOverrides(tenantId).get(`${perm}|${role}`);
  return o ?? (PERMISSIONS[perm] as readonly Role[]).includes(role);
}
/** Who may do what at this pump: every permission → the roles allowed. */
export const permissionMatrix = (tenantId: number) =>
  Object.fromEntries((Object.keys(PERMISSIONS) as Permission[]).map((p) => [p, ROLES.filter((r) => allowed(tenantId, r, p))])) as Record<Permission, Role[]>;

export const can = (user: AuthUser | undefined, perm: Permission) => Boolean(user && allowed(user.tenant_id, user.role, perm));
export const permissionsOf = (role: Role, tenantId: number) => (Object.keys(PERMISSIONS) as Permission[]).filter((p) => allowed(tenantId, role, p));

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { user?: AuthUser } }
}

export type SessionMeta = { ua?: string | null; ip?: string | null; how?: string };

const pkToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const ownerPhone = (tenantId: number) =>
  (get("SELECT value FROM settings WHERE tenant_id=? AND key='owner_phone'", tenantId)?.value as string | undefined)
  || (get("SELECT owner_phone FROM tenants WHERE id=?", tenantId)?.owner_phone as string | undefined) || null;
/** Best-effort security alert: an in-app alert for the owner, plus a WhatsApp if a number is given. Never throws. */
function securityNotify(tenantId: number, title: string, body: string, phone: string | null, dedupe: string) {
  try { createAlert(tenantId, { type: "security", severity: "warning", title, body, dedupe_key: dedupe }); } catch { /* alerts are best-effort */ }
  if (phone) import("./whatsapp/cloud.js").then((m) => m.sendToPhone(phone, `🔐 ${title}\n${body}`)).catch(() => { /* delivery is best-effort */ });
}
/** Does an IP fall inside an allow-list entry (exact IP, or an IPv4 CIDR like 1.2.3.0/24)? */
function ipMatch(ip: string, entry: string): boolean {
  const norm = (s: string) => s.replace(/^::ffff:/, "").trim();
  const a = norm(ip), e = norm(entry);
  if (!e) return false;
  if (!e.includes("/")) return a === e;
  const [net, bitsStr] = e.split("/"); const bits = Number(bitsStr);
  const toInt = (s: string) => { const p = s.split("."); if (p.length !== 4) return null; let n = 0; for (const o of p) { const v = Number(o); if (!(v >= 0 && v <= 255)) return null; n = (n << 8) | v; } return n >>> 0; };
  const ai = toInt(a), ni = toInt(net);
  if (ai == null || ni == null || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ai & mask) === (ni & mask);
}
/** Optional IP allow-list: if the owner set one, admin/manager sign-in is refused from any other IP (staff unaffected). */
function enforceIpAllowed(u: { id: number; tenant_id: number; name: string; role: string }, ip?: string | null) {
  const raw = get("SELECT value FROM settings WHERE tenant_id=? AND key='login_allowed_ips'", u.tenant_id)?.value as string | undefined;
  if (!raw || !raw.trim() || !["admin", "manager"].includes(u.role) || !ip) return; // off / not restricted / unknown IP → allow
  const list = raw.split(/[,\s]+/).filter(Boolean);
  if (!list.some((c) => ipMatch(ip, c))) {
    securityNotify(u.tenant_id, `IP allow-list ne login roka — ${u.name}`,
      `IP ${ip} allow-list mein nahi. Agar yeh aap the to Settings → Safety mein apni IP add karein.`, ownerPhone(u.tenant_id), `ipblock-${u.id}-${ip}-${pkToday()}`);
    throw new AppError(403, "Yeh network/IP allow-list mein nahi hai. Owner ko Settings → Safety mein yeh IP add karni hogi.");
  }
}
/** A money-sensitive account (admin/manager) signing in from a device/IP never seen before → tell the account holder. */
function noteNewDevice(u: { id: number; tenant_id: number; name: string; role: string }, meta: SessionMeta) {
  if (!meta.ip || !["admin", "manager"].includes(u.role) || meta.how === "PIN") return; // need an IP to judge; PIN = shared tablet
  const prior = get("SELECT COUNT(*) n FROM sessions WHERE user_id=?", u.id)?.n as number ?? 0;
  if (prior === 0) return; // first-ever login is not a new-device event
  const known = get("SELECT 1 FROM sessions WHERE user_id=? AND ip=? LIMIT 1", u.id, meta.ip ?? null);
  if (known) return;
  const dev = meta.ua ? String(meta.ua).slice(0, 80) : "unknown device";
  const phone = get("SELECT phone FROM users WHERE id=?", u.id)?.phone as string | undefined;
  securityNotify(u.tenant_id, `Naye device se login — ${u.name}`,
    `Device: ${dev}\nIP: ${meta.ip ?? "?"}\nWaqt: ${new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" })}\nAgar yeh aap nahi the to foran apna password badlein aur doosre devices sign-out karein.`,
    phone ?? null, `newdev-${u.id}-${meta.ip ?? "?"}-${pkToday()}`);
}
/** A signed 7-day session. Each token carries a session id, so the owner can see every signed-in device and sign one out. */
export function signToken(u: AuthUser, meta: SessionMeta = {}) {
  const tv = get("SELECT token_version v FROM users WHERE id=?", u.id)?.v ?? 0;
  const sid = crypto.randomUUID();
  const ts = new Date().toISOString();
  enforceIpAllowed(u as { id: number; tenant_id: number; name: string; role: string }, meta.ip); // throws 403 if the IP is blocked
  try { noteNewDevice(u as { id: number; tenant_id: number; name: string; role: string; phone?: string | null }, meta); } catch { /* never block sign-in on the alert */ }
  run("INSERT INTO sessions (tenant_id,user_id,sid,user_agent,ip,how,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?)", u.tenant_id, u.id, sid, (meta.ua ?? "").slice(0, 300) || null, meta.ip ?? null, meta.how ?? null, ts, ts);
  return jwt.sign({ sub: u.id, tv, sid }, config.jwtSecret, { expiresIn: "7d" });
}
/** Sign one device out: its token is refused from the next request on. */
export function revokeSession(tenantId: number, sessionId: number, by: string) {
  return run("UPDATE sessions SET revoked_at=?, revoked_by=? WHERE id=? AND tenant_id=? AND revoked_at IS NULL", new Date().toISOString(), by, sessionId, tenantId).changes;
}
const seenAt = new Map<string, number>();
function touchSession(sid: string): boolean {
  const s = get("SELECT id, tenant_id, revoked_at, last_seen_at FROM sessions WHERE sid=?", sid);
  if (!s || s.revoked_at) return false;
  // idle timeout: no request for N hours signs the device out (0 = off; default 12). Protects a forgotten open session.
  const idleH = Number(get("SELECT value FROM settings WHERE tenant_id=? AND key='session_idle_hours'", s.tenant_id)?.value ?? "12") || 0;
  if (idleH > 0 && s.last_seen_at && Date.now() - Date.parse(s.last_seen_at) > idleH * 3600_000) {
    run("UPDATE sessions SET revoked_at=?, revoked_by='idle timeout' WHERE id=? AND revoked_at IS NULL", new Date().toISOString(), s.id);
    seenAt.delete(sid);
    return false;
  }
  const last = seenAt.get(sid) ?? 0;
  if (Date.now() - last > 60_000) { seenAt.set(sid, Date.now()); run("UPDATE sessions SET last_seen_at=? WHERE id=?", new Date().toISOString(), s.id); }
  return true;
}
/** A short-lived, read-only token for links the browser opens by itself (photos, downloads, the live feed). */
export function mediaToken(userId: number) {
  const tv = get("SELECT token_version v FROM users WHERE id=?", userId)?.v ?? 0;
  return jwt.sign({ sub: userId, tv, media: 1 }, config.jwtSecret, { expiresIn: "12h" });
}
/** Sign this person out everywhere (password / PIN change, disabled, "sign out all"). */
export const revokeSessions = (userId: number) => { run("UPDATE sessions SET revoked_at=COALESCE(revoked_at,?), revoked_by=COALESCE(revoked_by,'sign out all') WHERE user_id=? AND revoked_at IS NULL", new Date().toISOString(), userId); return run("UPDATE users SET token_version = token_version + 1 WHERE id=?", userId); };

/** A device token links a pump tablet to the business so staff can sign in by tapping their name + PIN. */
// linked tablets carry the pump's device "epoch": the owner can unlink every tablet at once by moving it on
const deviceEpoch = (tenantId: number) => Number(get("SELECT value FROM settings WHERE tenant_id=? AND key='device_epoch'", tenantId)?.value ?? 0);
export const deviceToken = (tenantId: number) => jwt.sign({ dev: tenantId, ep: deviceEpoch(tenantId) }, config.jwtSecret, { expiresIn: "365d" });
export const unlinkDevices = (tenantId: number) => run(
  "INSERT INTO settings (tenant_id,key,value) VALUES (?,'device_epoch',?) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value", tenantId, String(deviceEpoch(tenantId) + 1));
function deviceTenant(token: string | undefined): number {
  try {
    const p = jwt.verify(token ?? "", config.jwtSecret) as { dev?: number; ep?: number };
    if (typeof p.dev === "number" && (p.ep ?? 0) === deviceEpoch(p.dev)) return p.dev;
  } catch { /* fall through */ }
  throw new AppError(401, "This device is not linked. Sign in once with email and password.");
}
/** The owner signs in with a password; PIN sign-in is for staff on a shared tablet (setting "pin_admin" allows it). */
const pinAllowed = (u: { role: string; tenant_id: number }) => u.role !== "admin" || get("SELECT value FROM settings WHERE tenant_id=? AND key='pin_admin'", u.tenant_id)?.value === "1";

/** Staff who can sign in with a PIN on this device. */
export function pinUsers(device: string | undefined) {
  const t = deviceTenant(device);
  return all(`SELECT u.id, u.name, u.role, u.tenant_id, s.name station_name FROM users u LEFT JOIN stations s ON s.id=u.station_id
    WHERE u.tenant_id=? AND u.active=1 AND u.pin_hash IS NOT NULL
    ORDER BY CASE u.role WHEN 'salesman' THEN 0 WHEN 'manager' THEN 1 WHEN 'wholesale' THEN 2 WHEN 'cashier' THEN 3 ELSE 4 END, u.name`, t)
    .filter(pinAllowed).map(({ tenant_id: _t, ...u }) => u);
}

const PIN_TRIES = 5, PIN_LOCK_MIN = 10;
/** Sign-ins and wrong passwords / PINs go in the audit log — with the device and IP when the login route passes them. */
function auditLogin(u: { id: number; tenant_id: number; name: string }, ok: boolean, how: string, meta: SessionMeta = {}) {
  const data = meta.ip || meta.ua ? JSON.stringify({ ip: meta.ip ?? null, device: meta.ua ? String(meta.ua).slice(0, 200) : null }) : null;
  run("INSERT INTO audit_log (tenant_id,user_id,user_name,action,ref,data,created_at) VALUES (?,?,?,?,?,?,?)",
    u.tenant_id, u.id, u.name, `login:${ok ? `Signed in (${how})` : `Wrong ${how}`}`, how, data, new Date().toISOString());
}

export function pinLogin(device: string | undefined, userId: number, pin: string, meta: SessionMeta = {}) {
  const u = get("SELECT * FROM users WHERE id=? AND tenant_id=?", userId, deviceTenant(device));
  if (!u || !u.pin_hash || !pinAllowed(u)) throw new AppError(401, "PIN login is not set up for this person");
  if (!u.active) throw new AppError(403, "This account is disabled. Contact your admin.");
  if (u.pin_locked_until && Date.parse(u.pin_locked_until) > Date.now())
    throw new AppError(429, `Too many wrong PINs. Try again after ${Math.ceil((Date.parse(u.pin_locked_until) - Date.now()) / 60000)} minutes, or ask the admin to reset your PIN.`);
  if (!bcrypt.compareSync(pin, u.pin_hash)) {
    const fails = u.pin_fails + 1;
    run("UPDATE users SET pin_fails=?, pin_locked_until=? WHERE id=?", fails >= PIN_TRIES ? 0 : fails,
      fails >= PIN_TRIES ? new Date(Date.now() + PIN_LOCK_MIN * 60000).toISOString() : null, u.id);
    auditLogin(u, false, fails >= PIN_TRIES ? "PIN — locked for 10 minutes" : "PIN", meta);
    if (fails >= PIN_TRIES) securityNotify(u.tenant_id, `PIN lock — baar-baar ghalat PIN — ${u.name}`,
      `${PIN_TRIES} ghalat PIN; ${PIN_LOCK_MIN} minute ke liye lock. Tablet par koi ghalat PIN daal raha hai — dekh lein.`,
      ownerPhone(u.tenant_id), `pinlock-${u.id}-${pkToday()}`);
    throw new AppError(401, fails >= PIN_TRIES ? `Wrong PIN. Locked for ${PIN_LOCK_MIN} minutes — forgot it? Ask the admin to reset it.` : `Wrong PIN (${PIN_TRIES - fails} tries left)`);
  }
  run("UPDATE users SET pin_fails=0, pin_locked_until=NULL WHERE id=?", u.id);
  auditLogin(u, true, "PIN", meta);
  const user: AuthUser = { id: u.id, tenant_id: u.tenant_id, name: u.name, email: u.email, role: u.role, station_id: u.station_id };
  return { token: signToken(user, { ...meta, how: "PIN" }), user, permissions: permissionsOf(user.role, user.tenant_id), modules: modulesOf(user.tenant_id) };
}

const PW_TRIES = 8, PW_LOCK_MIN = 15;
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);
/** Check email + password (with lockout). Returns the user row on success; throws on failure. Does NOT issue a session. */
export function authenticate(login: string, password: string, tenantScope?: number): Row {
  const id = login.toLowerCase().trim();
  let u: Row | undefined;
  if (id.includes("@")) u = get("SELECT * FROM users WHERE email=?", id);
  else {
    // a phone number: within the pump the link named, else across all pumps — ambiguous means "use your pump's own link"
    const digits = id.replace(/\D/g, "");
    const phone = digits.startsWith("0") ? "92" + digits.slice(1) : digits.startsWith("92") ? digits : digits ? "92" + digits : "";
    const rows = phone ? all(`SELECT * FROM users WHERE phone=? AND active=1 ${tenantScope ? "AND tenant_id=?" : ""} ORDER BY id`, ...(tenantScope ? [phone, tenantScope] : [phone])) : [];
    if (rows.length > 1) throw new AppError(400, "Is number par aik se zyada pumps ke accounts hain — apne pump ka apna link istemal karein, ya email se sign in karein");
    u = rows[0];
  }
  if (u?.pw_locked_until && Date.parse(u.pw_locked_until) > Date.now())
    throw new AppError(429, `Too many wrong passwords. Try again after ${Math.ceil((Date.parse(u.pw_locked_until) - Date.now()) / 60000)} minutes.`);
  // the same work is done whether or not the email exists, so the answer time doesn't give it away
  const good = bcrypt.compareSync(password, u?.password_hash ?? DUMMY_HASH);
  if (!u || !good) {
    if (u) {
      const fails = (u.pw_fails ?? 0) + 1;
      run("UPDATE users SET pw_fails=?, pw_locked_until=? WHERE id=?", fails >= PW_TRIES ? 0 : fails, fails >= PW_TRIES ? new Date(Date.now() + PW_LOCK_MIN * 60000).toISOString() : null, u.id);
      auditLogin(u, false, fails >= PW_TRIES ? "password — locked for 15 minutes" : "password");
      if (fails >= PW_TRIES) securityNotify(u.tenant_id, `Account lock — baar-baar ghalat password — ${u.name}`,
        `${PW_TRIES} ghalat koshishein; account ${PW_LOCK_MIN} minute ke liye lock ho gaya. Agar yeh aap nahi the to kisi ne tod-phod ki koshish ki — password mazboot rakhein.`,
        ownerPhone(u.tenant_id), `lock-${u.id}-${pkToday()}`);
    }
    throw new AppError(401, "Invalid email or password");
  }
  if (!u.active) throw new AppError(403, "This account is disabled. Contact your admin.");
  run("UPDATE users SET pw_fails=0, pw_locked_until=NULL WHERE id=?", u.id);
  return u;
}
/** Issue a signed session for an already-authenticated user row. */
export function issueSession(u: Row, how = "password", meta: SessionMeta = {}) {
  auditLogin(u, true, how, meta);
  const user: AuthUser = { id: u.id, tenant_id: u.tenant_id, name: u.name, email: u.email, role: u.role, station_id: u.station_id };
  // only the owner / a manager links a shared tablet for PIN sign-in
  const links = ["admin", "manager"].includes(u.role);
  return { token: signToken(user, { ...meta, how }), user, permissions: permissionsOf(user.role, user.tenant_id), modules: modulesOf(user.tenant_id), ...(links ? { device_token: deviceToken(u.tenant_id) } : {}) };
}
export function login(email: string, password: string, meta: SessionMeta = {}) {
  return issueSession(authenticate(email, password), "password", meta);
}

/**
 * Two-factor login for the owner. On by default for admins — but only when it is actually usable, so nobody is
 * ever locked out: the admin must have a phone AND WhatsApp OTP delivery must be live. The owner can still turn it
 * off explicitly (setting '0'); an unset setting defaults ON when deliverable.
 */
export const twoFaRequired = (u: Row) => {
  if (u.role !== "admin" || !u.phone) return false;
  const set = get("SELECT value FROM settings WHERE tenant_id=? AND key='admin_2fa'", u.tenant_id)?.value as string | undefined;
  if (set === "1") return true;   // explicitly on — honoured even before WhatsApp is live
  if (set === "0") return false;  // explicitly off
  return waLive();                // unset → default-on, but only once OTP can actually be delivered (no lock-out)
};
const OTP_MIN = 10, OTP_TRIES = 5;
/** Make and store a 6-digit one-time code for this user; returns the plain code to send on WhatsApp. */
export function create2fa(userId: number): string {
  const code = String(crypto.randomInt(100000, 1000000));
  run("INSERT INTO login_otps (user_id,code_hash,expires_at,attempts,created_at) VALUES (?,?,?,0,?) ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, created_at=excluded.created_at",
    userId, bcrypt.hashSync(code, 8), new Date(Date.now() + OTP_MIN * 60000).toISOString(), new Date().toISOString());
  return code;
}
/** Verify a login OTP and issue the session. Throws on wrong / expired / too many tries. */
export function verify2fa(userId: number, code: string, meta: SessionMeta = {}) {
  const u = get("SELECT * FROM users WHERE id=? AND active=1", userId);
  const o = get("SELECT * FROM login_otps WHERE user_id=?", userId);
  if (!u || !o) throw new AppError(401, "Sign in again");
  if (Date.parse(o.expires_at) < Date.now()) { run("DELETE FROM login_otps WHERE user_id=?", userId); throw new AppError(401, "Code expired — sign in again"); }
  if (o.attempts >= OTP_TRIES) { run("DELETE FROM login_otps WHERE user_id=?", userId); throw new AppError(429, "Too many wrong codes — sign in again"); }
  if (!bcrypt.compareSync(code, o.code_hash)) {
    run("UPDATE login_otps SET attempts=attempts+1 WHERE user_id=?", userId);
    auditLogin(u, false, "2FA code", meta);
    throw new AppError(401, `Wrong code (${OTP_TRIES - o.attempts - 1} tries left)`);
  }
  run("DELETE FROM login_otps WHERE user_id=?", userId);
  return issueSession(u, "password + code", meta);
}

/** The only endpoints a URL (media) token may open: files the browser fetches itself — photos, CSV/PDF downloads,
 *  payment notices, and the live/event streams. Everything else needs a real session in the Authorization header. */
const MEDIA_TOKEN_OK = /(\.csv$|\/notice$|\/pdf$|^\/photos\/|^\/backups\/|^\/(live|events)$)/;
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  const inUrl = !h?.startsWith("Bearer ");
  const token = inUrl ? (req.query.token as string | undefined) : h!.slice(7);
  if (!token) return next(new AppError(401, "Not signed in"));
  try {
    const p = jwt.verify(token, config.jwtSecret) as unknown as { sub: number; tv?: number; media?: number; sid?: string };
    if (typeof p.sub !== "number") return next(new AppError(401, "Not signed in"));
    // a token in a link (photo, download, live feed) must be a short read-only media token, never a full session
    if (inUrl && (!p.media || req.method !== "GET")) return next(new AppError(401, "Not signed in"));
    if (!inUrl && p.media) return next(new AppError(401, "Not signed in"));
    // a media token rides in URLs the browser opens itself (img src, download href, EventSource), so it can leak via
    // referrer headers / proxy logs / a shared link. Scope it to exactly the file/stream endpoints that need it — never
    // the bulk-data JSON endpoints — so a leaked media URL can't read the whole tenant. (req.path here is sub-of /api.)
    if (inUrl && !MEDIA_TOKEN_OK.test(req.path)) return next(new AppError(403, "This link can only open files, not data"));
    const u = get("SELECT id, tenant_id, name, email, role, station_id, active, token_version FROM users WHERE id=?", p.sub);
    if (!u || !u.active) return next(new AppError(401, "User not found or disabled"));
    if ((p.tv ?? 0) !== (u.token_version ?? 0)) return next(new AppError(401, "Signed out — please sign in again"));
    // a device the owner signed out (tokens from before this feature carry no sid and keep working until they expire)
    if (p.sid && !touchSession(p.sid)) return next(new AppError(401, "Is device ko sign out kar diya gaya — dobara sign in karein"));
    delete u.active; delete u.token_version;
    req.user = u as AuthUser;
    next();
  } catch {
    next(new AppError(401, "Session expired"));
  }
}

export const requirePerm = (perm: Permission): RequestHandler => (req, _res, next) =>
  can(req.user, perm) ? next() : next(new AppError(403, "You don't have permission for this"));

/** Allow if the user has any of the permissions. */
export const requireAny = (...perms: Permission[]): RequestHandler => (req, _res, next) =>
  perms.some((p) => can(req.user, p)) ? next() : next(new AppError(403, "You don't have permission for this"));

/** Allow only these roles (e.g. CEO / owner = "admin"). */
export const requireRole = (...roles: Role[]): RequestHandler => (req, _res, next) =>
  req.user && roles.includes(req.user.role) ? next() : next(new AppError(403, "Only the owner can do this"));

/** Salesmen are locked to their assigned station; returns the station they may act on. */
export function scopedStation(req: Request, requested?: number | null): number | null {
  const u = req.user!;
  if (u.role !== "salesman") return requested ?? null;
  if (!u.station_id) throw new AppError(403, "No station assigned to your account. Ask your admin.");
  if (requested && requested !== u.station_id) throw new AppError(403, "You can only work on your own station");
  return u.station_id;
}

/** Wrap async handlers so thrown errors reach the error middleware. */
export const h = (fn: (req: Request, res: Response) => unknown): RequestHandler => async (req, res, next) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    next(e);
  }
};

export const parse = <T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> => schema.parse(data);

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) return res.status(400).json({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "The request was not valid JSON" });
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "Too much data in one go (photo too large?)" });
  console.error(err);
  try { onServerError?.(err?.message ?? String(err), { stack: err?.stack, method: _req.method, path: _req.originalUrl, status: 500 }); } catch { /* never mask the response */ }
  res.status(500).json({ error: "Internal server error" });
}

export const tid = (req: Request) => req.user!.tenant_id;

/* ---------------- PIN before cancelling (mansookh) an entry ---------------- */
/** A request that cancels an entry: any …/void or …/undo, a coupon void, deleting an expense or a CEO other-entry. */
export function isCancelRequest(method: string, path: string): boolean {
  if (method === "POST" && /\/(void|undo)$/.test(path)) return true;
  if (method === "DELETE" && (/^\/(expenses|other-entries|investors)\/\d+$/.test(path) || /^\/shifts\/\d+\/expenses\/\d+$/.test(path))) return true;
  return false;
}
/**
 * Every cancel needs the person's own 4-digit PIN (header x-action-pin) — a second check that it is really them, so a
 * left-open screen can't wipe entries. Wrong PINs count toward the same lock as PIN sign-in. On by default; the CEO can turn
 * it off in Settings (setting void_pin = "0"). 428 + code tells the app to ask for the PIN (or to set one first).
 */
export const cancelPinGuard: RequestHandler = (req, res, next) => {
  if (!req.user || !isCancelRequest(req.method, req.path)) return next();
  if (getSetting(req.user.tenant_id, "void_pin", process.env.NODE_ENV === "test" ? "0" : "1") === "0") return next();
  const u = get("SELECT id, tenant_id, name, pin_hash, pin_fails, pin_locked_until FROM users WHERE id=?", req.user.id);
  if (!u) return next();
  if (!u.pin_hash) { res.status(428).json({ error: "Mansookh karne ke liye apna 4-digit PIN chahiye — pehle PIN banayein.", code: "pin_not_set" }); return; }
  const pin = String(req.headers["x-action-pin"] ?? "");
  if (!pin) { res.status(428).json({ error: "Mansookh karne ke liye apna PIN daalein.", code: "pin_required" }); return; }
  if (u.pin_locked_until && Date.parse(u.pin_locked_until) > Date.now()) {
    res.status(429).json({ error: `Baar-baar ghalat PIN — ${Math.ceil((Date.parse(u.pin_locked_until) - Date.now()) / 60000)} minute baad koshish karein, ya admin PIN reset kare.` }); return;
  }
  if (!bcrypt.compareSync(pin, u.pin_hash)) {
    const fails = u.pin_fails + 1, locked = fails >= PIN_TRIES;
    run("UPDATE users SET pin_fails=?, pin_locked_until=? WHERE id=?", locked ? 0 : fails, locked ? new Date(Date.now() + PIN_LOCK_MIN * 60000).toISOString() : null, u.id);
    if (locked) securityNotify(u.tenant_id, `PIN lock — mansookh ke waqt ghalat PIN — ${u.name}`, `${PIN_TRIES} ghalat PIN entry mansookh karte waqt; ${PIN_LOCK_MIN} minute ke liye lock.`, ownerPhone(u.tenant_id), `voidpin-${u.id}-${pkToday()}`);
    res.status(428).json({ error: locked ? `Ghalat PIN — ${PIN_LOCK_MIN} minute ke liye lock.` : `Ghalat PIN (${PIN_TRIES - fails} koshishein baqi)`, code: "pin_wrong" }); return;
  }
  run("UPDATE users SET pin_fails=0, pin_locked_until=NULL WHERE id=?", u.id);
  next();
};
