/** Platform (super admin): reset a pump's CEO email / phone / password / PIN; delete a pump outright (backup first, other pumps untouched). */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-platform-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.NODE_ENV = "test";
process.env.SAAS_MODE = "1";
process.env.PUBLIC_URL = "http://localhost:9999";
process.env.PLATFORM_ADMIN_EMAIL = "owner@petrolpumpai.pk";
process.env.PLATFORM_ADMIN_PASSWORD = "platform-pass-123";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server; let base = ""; let db: typeof import("../src/db.js");
async function call(token: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`); return r.data; };
const signup = (name: string, email: string) => ({ business: { name, owner_name: "Owner " + name, owner_phone: "03001112233" }, admin: { name: "CEO " + name, email, password: "ceo-pass-123", pin: "1234" },
  stations: [{ name: name + " Station", tanks: [{ name: "T1", product: "HSD", capacity_l: 20000, current_l: 5000, nozzles: 2 }] }], prices: { HSD: 390, PMG: 380 }, modules: { wholesale: true } });

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("CEO login reset: email, phone, password and PIN change; old password dead, old sessions out; other pump's CEO untouched", async () => {
  const p = ok(await call("", "POST", "/api/platform/login", { email: "owner@petrolpumpai.pk", password: "platform-pass-123" }), "platform login").token;
  const a = ok(await call("", "POST", "/api/signup", signup("Pump A", "ceo-a@test.pk")), "signup A");
  const bb = ok(await call("", "POST", "/api/signup", signup("Pump B", "ceo-b@test.pk")), "signup B");
  const ta = a.user.tenant_id, tb = bb.user.tenant_id;
  const oldTok = a.token;
  ok(await call(oldTok, "GET", "/api/me"), "A's CEO signed in");
  const admins = ok(await call(p, "GET", `/api/platform/tenants/${ta}/admins`), "admins").admins;
  assert.equal(admins.length, 1); assert.equal(admins[0].email, "ceo-a@test.pk"); assert.equal(admins[0].has_pin, true);
  // another pump's email is refused
  assert.equal((await call(p, "POST", `/api/platform/tenants/${ta}/admin-reset`, { user_id: admins[0].id, email: "ceo-b@test.pk" })).status, 400, "email in use");
  // a tenant CEO cannot call the platform route
  assert.equal((await call(oldTok, "POST", `/api/platform/tenants/${ta}/admin-reset`, { user_id: admins[0].id, password: "hacked-pass-123" })).status, 401);
  const r = ok(await call(p, "POST", `/api/platform/tenants/${ta}/admin-reset`, { user_id: admins[0].id, email: "new-ceo-a@test.pk", phone: "03219998877", password: "fresh-pass-123", pin: "4321" }), "reset");
  assert.equal(r.user.email, "new-ceo-a@test.pk");
  assert.equal((await call(oldTok, "GET", "/api/me")).status, 401, "old session signed out");
  assert.equal((await call("", "POST", "/api/auth/login", { email: "ceo-a@test.pk", password: "ceo-pass-123" })).status, 401, "old email/password dead");
  assert.equal((await call("", "POST", "/api/auth/login", { email: "new-ceo-a@test.pk", password: "ceo-pass-123" })).status, 401, "old password dead");
  const fresh = ok(await call("", "POST", "/api/auth/login", { email: "new-ceo-a@test.pk", password: "fresh-pass-123" }), "new login works");
  assert.equal(fresh.user.tenant_id, ta);
  const byPhone = ok(await call("", "POST", "/api/auth/login", { email: "03219998877", password: "fresh-pass-123" }), "phone login works");
  assert.equal(byPhone.user.id, admins[0].id);
  // B untouched
  ok(await call("", "POST", "/api/auth/login", { email: "ceo-b@test.pk", password: "ceo-pass-123" }), "B's CEO still signs in");
  assert.ok(db.get("SELECT 1 x FROM audit_log WHERE tenant_id=? AND action='platform_admin_reset'", ta), "audited");
  assert.equal(tb > 0, true);
});

test("delete pump: exact name required; backup made; every row of that pump gone; the other pump and the platform still work", async () => {
  const p = ok(await call("", "POST", "/api/platform/login", { email: "owner@petrolpumpai.pk", password: "platform-pass-123" }), "platform login").token;
  const tenants = ok(await call(p, "GET", "/api/platform/tenants"), "tenants").tenants;
  const A = tenants.find((t: any) => t.name === "Pump A"), B = tenants.find((t: any) => t.name === "Pump B");
  assert.ok(A && B);
  // some data on A: a sale, a customer with khata, an expense
  const ceo = ok(await call("", "POST", "/api/auth/login", { email: "new-ceo-a@test.pk", password: "fresh-pass-123" }), "A login").token;
  const st = ok(await call(ceo, "GET", "/api/stations"), "stations")[0].id;
  ok(await call(ceo, "POST", "/api/sales", { station_id: st, product: "HSD", litres: 10, payment_method: "cash" }), "sale");
  const cust = ok(await call(ceo, "POST", "/api/customers", { name: "Khata A", phone: "03005550001", type: "fleet", credit_limit: 50000 }), "customer");
  ok(await call(ceo, "POST", "/api/sales", { station_id: st, product: "HSD", litres: 5, payment_method: "khata", customer_id: cust.id ?? cust.customer?.id }), "khata sale");
  ok(await call(ceo, "POST", "/api/expenses", { category: "Tea & food", amount: 100, method: "cash", station_id: st }), "expense");
  const countA = (tbl: string, col = "tenant_id") => (db.get(`SELECT COUNT(*) n FROM ${tbl} WHERE ${col}=?`, A.id) as any).n as number;
  assert.ok(countA("users") >= 1 && countA("expenses") >= 1 && countA("customers") >= 1);
  const salesA = (db.get("SELECT COUNT(*) n FROM sales WHERE station_id IN (SELECT id FROM stations WHERE tenant_id=?)", A.id) as any).n;
  assert.ok(salesA >= 2, "sales on A");
  const usersB = (db.get("SELECT COUNT(*) n FROM users WHERE tenant_id=?", B.id) as any).n;
  const salesBefore = (db.get("SELECT COUNT(*) n FROM sales") as any).n;

  assert.equal((await call(p, "DELETE", `/api/platform/tenants/${A.id}`, { confirm: "pump" })).status, 400, "wrong name refused");
  assert.equal((await call(ceo, "DELETE", `/api/platform/tenants/${A.id}`, { confirm: "Pump A" })).status, 401, "not for a tenant user");
  const r = ok(await call(p, "DELETE", `/api/platform/tenants/${A.id}`, { confirm: "Pump A" }), "delete");
  assert.ok(r.backup?.name && fs.existsSync(path.join(process.env.BACKUP_DIR!, r.backup.name)), "backup file exists");
  assert.ok(r.rows > 10, "rows removed");
  // gone everywhere
  assert.equal(db.get("SELECT 1 x FROM tenants WHERE id=?", A.id), undefined);
  for (const tbl of ["users", "stations", "customers", "expenses", "settings", "expense_categories"]) assert.equal(countA(tbl), 0, `${tbl} emptied`);
  assert.equal((db.get("SELECT COUNT(*) n FROM sales WHERE station_id IN (SELECT id FROM stations WHERE tenant_id=?)", A.id) as any).n, 0);
  assert.equal((db.get("SELECT COUNT(*) n FROM sales") as any).n, salesBefore - salesA, "only A's sales went");
  // no orphans left behind for A's stations / tanks / customers
  assert.equal((db.get("SELECT COUNT(*) n FROM tanks WHERE station_id NOT IN (SELECT id FROM stations)") as any).n, 0, "no orphan tanks");
  assert.equal((db.get("SELECT COUNT(*) n FROM nozzles WHERE station_id NOT IN (SELECT id FROM stations)") as any).n, 0, "no orphan nozzles");
  assert.equal((db.get("SELECT COUNT(*) n FROM khata_ledger WHERE customer_id NOT IN (SELECT id FROM customers)") as any).n, 0, "no orphan khata rows");
  assert.equal((db.get("SELECT COUNT(*) n FROM meter_readings WHERE shift_id NOT IN (SELECT id FROM shifts)") as any).n, 0, "no orphan readings");
  // A's CEO is out; B works; the freed email can sign up again
  assert.equal((await call(ceo, "GET", "/api/me")).status, 401);
  assert.equal((db.get("SELECT COUNT(*) n FROM users WHERE tenant_id=?", B.id) as any).n, usersB);
  ok(await call("", "POST", "/api/auth/login", { email: "ceo-b@test.pk", password: "ceo-pass-123" }), "B still signs in");
  ok(await call("", "POST", "/api/signup", signup("Pump A again", "new-ceo-a@test.pk")), "email free again");
  assert.ok(!ok(await call(p, "GET", "/api/platform/tenants"), "tenants").tenants.some((t: any) => t.id === A.id));
});

test("plans: lifetime never expires; monthly / yearly end after paid_until (pump locked); back to trial; overview sums the fleet", async () => {
  const p = ok(await call("", "POST", "/api/platform/login", { email: "owner@petrolpumpai.pk", password: "platform-pass-123" }), "platform login").token;
  const a = ok(await call("", "POST", "/api/signup", signup("Plan Pump A", "ceo-plan-a@test.pk")), "signup A");
  const bb = ok(await call("", "POST", "/api/signup", signup("Plan Pump B", "ceo-plan-b@test.pk")), "signup B");
  const tidA = db.get("SELECT tenant_id FROM users WHERE email='ceo-plan-a@test.pk'").tenant_id, tidB = db.get("SELECT tenant_id FROM users WHERE email='ceo-plan-b@test.pk'").tenant_id;
  // lifetime
  const life = ok(await call(p, "POST", `/api/platform/tenants/${tidA}/plan`, { plan: "lifetime", note: "paid cash" }), "lifetime");
  assert.equal(life.tenant.status, "active"); assert.equal(life.tenant.plan, "lifetime"); assert.equal(life.tenant.paid_until, null); assert.equal(life.state.locked, false); assert.equal(life.state.lifetime, true);
  assert.equal((await call(a.token, "GET", "/api/me")).status, 200, "lifetime pump works");
  // monthly: default a month from today
  const mo = ok(await call(p, "POST", `/api/platform/tenants/${tidB}/plan`, { plan: "monthly" }), "monthly");
  assert.equal(mo.tenant.plan, "monthly"); assert.ok(mo.tenant.paid_until > new Date().toISOString().slice(0, 10), "paid_until in the future");
  assert.equal(mo.state.locked, false);
  // expired yearly → locked
  ok(await call(p, "POST", `/api/platform/tenants/${tidB}/plan`, { plan: "yearly", paid_until: "2020-01-31" }), "expired yearly");
  const meB = await call(bb.token, "GET", "/api/customers");
  assert.equal(meB.status, 402, `expired plan locks the pump: ${JSON.stringify(meB.data)}`);
  // extend → open again
  const ext = ok(await call(p, "POST", `/api/platform/tenants/${tidB}/plan`, { plan: "yearly" }), "extend");
  assert.equal(ext.state.locked, false); assert.ok(ext.tenant.paid_until > new Date().toISOString().slice(0, 10));
  // back to trial
  const tr = ok(await call(p, "POST", `/api/platform/tenants/${tidB}/plan`, { plan: "trial" }), "trial");
  assert.equal(tr.tenant.status, "trial"); assert.equal(tr.tenant.plan, null);
  assert.ok(db.get("SELECT id FROM audit_log WHERE action='platform_plan' AND tenant_id=?", tidA), "audited");
  // overview
  const ov = ok(await call(p, "GET", "/api/platform/overview"), "overview");
  assert.ok(ov.kpis.pumps >= 2); assert.ok(ov.kpis.lifetime >= 1); assert.equal(ov.months.length, 6);
  const rowA = ov.tenants.find((t: any) => t.id === tidA);
  assert.equal(rowA.lifetime, true); assert.equal(rowA.locked, false); assert.ok(rowA.users >= 1); assert.ok(rowA.stations >= 1);
  assert.ok(typeof ov.kpis.sales_30d === "number" && typeof ov.kpis.db_bytes === "number");
  assert.equal((await call("", "GET", "/api/platform/overview")).status, 401, "platform login required");
});

test("server tab: status document, request metrics, error log capture and clear", async () => {
  const p = ok(await call("", "POST", "/api/platform/login", { email: "owner@petrolpumpai.pk", password: "platform-pass-123" }), "platform login").token;
  assert.equal((await call("", "GET", "/api/platform/server")).status, 401);
  const s = ok(await call(p, "GET", "/api/platform/server"), "server");
  assert.ok(s.machine.node.startsWith("v")); assert.ok(s.cpu.cores >= 1); assert.ok(s.memory.total > 0);
  assert.ok(s.disk.db_bytes > 0, "db size"); assert.ok(Array.isArray(s.checks) && s.checks.length >= 6);
  assert.ok(s.requests.total_since_start > 0, "requests counted"); assert.ok(Array.isArray(s.requests.per_minute));
  assert.equal(s.fly.configured, false, "no Fly token in tests");
  assert.ok(s.db.tenants >= 1);
  // a 500 lands in the error log
  const { logServerError } = await import("../src/serverStatus.js");
  logServerError("error", "test boom", { stack: "Error: test boom\n at x", method: "GET", path: "/api/x", status: 500 });
  const logs = ok(await call(p, "GET", "/api/platform/server/logs?level=error"), "logs").logs;
  assert.ok(logs.some((l: any) => l.message === "test boom" && l.stack?.includes("at x")));
  const after = ok(await call(p, "GET", "/api/platform/server"), "server2");
  assert.ok(after.errors.last_24h >= 1);
  ok(await call(p, "POST", "/api/platform/server/logs/clear", {}), "clear");
  assert.equal(ok(await call(p, "GET", "/api/platform/server/logs"), "logs2").logs.length, 0);
});
