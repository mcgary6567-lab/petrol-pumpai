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
