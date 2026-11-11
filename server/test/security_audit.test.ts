/** Security audit regressions: no pump reads another pump through POS or the audit log; the platform email cannot be taken; link token is download-only; PIN lock grows; push endpoints are real push services. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-secaudit-"));
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


test("another pump's station, the platform email, the audit log and the platform link token", async () => {
  const a = ok(await call("", "POST", "/api/signup", signup("Sec A", "sec-a@test.pk")), "signup A");
  const b = ok(await call("", "POST", "/api/signup", signup("Sec B", "sec-b@test.pk")), "signup B");
  const stB = db.get("SELECT id FROM stations WHERE tenant_id=?", b.user.tenant_id)!.id;
  const stA = db.get("SELECT id FROM stations WHERE tenant_id=?", a.user.tenant_id)!.id;
  // POS: own station fine, the other pump's station is "not found"
  ok(await call(a.token, "GET", `/api/pos/today?station_id=${stA}`), "own station");
  assert.equal((await call(a.token, "GET", `/api/pos/today?station_id=${stB}`)).status, 404, "pos/today across pumps");
  assert.equal((await call(a.token, "GET", `/api/pos/entries?station_id=${stB}`)).status, 404, "pos/entries across pumps");
  // the platform owner's email cannot be signed up or taken by a rename
  assert.equal((await call("", "POST", "/api/signup", signup("Evil", "owner@petrolpumpai.pk"))).status, 400, "signup with platform email");
  assert.equal((await call("", "POST", "/api/signup", signup("Evil", "Owner@PetrolPumpAI.pk"))).status, 400, "case does not matter");
  assert.equal((await call(a.token, "PATCH", `/api/users/${a.user.id}`, { email: "owner@petrolpumpai.pk" })).status, 400, "rename to platform email");
  assert.equal((await call(a.token, "PUT", "/api/integrations", { public_url: "https://evil.example" })).status, 403, "pump admin cannot change install-wide settings");
  // audit log: deleting another pump's row deletes nothing, says so, and copies nothing into A's log
  const rec = ok(await call(b.token, "POST", "/api/recurring-expenses", { category: "Rent", amount: 54321, paid_to: "Secret Landlord", method: "cash", day_of_month: 5 }), "B recurring");
  assert.equal((await call(a.token, "DELETE", `/api/recurring-expenses/${rec.id}`)).status, 404, "foreign delete is 404");
  assert.ok(db.get("SELECT 1 x FROM recurring_expenses WHERE id=?", rec.id), "B's row still there");
  const leaked = db.all("SELECT data FROM audit_log WHERE tenant_id=?", a.user.tenant_id).some((r: any) => String(r.data ?? "").includes("Secret Landlord"));
  assert.equal(leaked, false, "nothing of B in A's audit log");
  ok(await call(b.token, "DELETE", `/api/recurring-expenses/${rec.id}`), "owner deletes its own");
  // platform: the session token is refused in a link; the download token opens only the download
  const p = ok(await call("", "POST", "/api/platform/login", { email: "owner@petrolpumpai.pk", password: "platform-pass-123" }), "platform login").token;
  const dl = ok(await call(p, "GET", "/api/platform/download-token"), "download token").token;
  assert.equal((await fetch(`${base}/api/platform/backups/nope.db?token=${p}`)).status, 401, "session token in a URL is refused");
  assert.notEqual((await fetch(`${base}/api/platform/backups/nope.db?token=${dl}`)).status, 401, "download token passes the gate");
  assert.equal((await call(dl, "GET", "/api/platform/tenants")).status, 401, "download token opens nothing else");
  // push: only real push services
  assert.equal((await call(a.token, "POST", "/api/push/subscribe", { endpoint: "https://internal.example/hook", keys: { p256dh: "x", auth: "y" } })).status, 400, "arbitrary host refused");
  assert.equal((await call(a.token, "POST", "/api/push/subscribe", { endpoint: "http://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "x", auth: "y" } })).status, 400, "http refused");
});

test("PIN lock grows with every repeat lock in a day", async () => {
  const a = ok(await call("", "POST", "/api/signup", signup("Pin Pump", "pin-a@test.pk")), "signup");
  const dev = (await import("../src/auth.js")).deviceToken(a.user.tenant_id);
  const tryPin = (pin: string) => fetch(base + "/api/auth/pin", { method: "POST", headers: { "content-type": "application/json", "x-device": dev }, body: JSON.stringify({ user_id: a.user.id, pin }) });
  const lockedMin = () => Math.round((Date.parse(db.get("SELECT pin_locked_until v FROM users WHERE id=?", a.user.id)!.v) - Date.now()) / 60000);
  db.run("UPDATE settings SET value='1' WHERE tenant_id=? AND key='pin_admin'", a.user.tenant_id); db.run("INSERT OR IGNORE INTO settings (tenant_id,key,value) VALUES (?,'pin_admin','1')", a.user.tenant_id);
  for (let i = 0; i < 5; i++) await tryPin("0000");
  assert.equal(lockedMin(), 10, "first lock 10 minutes");
  db.run("UPDATE users SET pin_locked_until=NULL WHERE id=?", a.user.id);
  for (let i = 0; i < 5; i++) await tryPin("0000");
  assert.equal(lockedMin(), 30, "second lock 30 minutes");
  db.run("UPDATE users SET pin_locked_until=NULL WHERE id=?", a.user.id);
  for (let i = 0; i < 5; i++) await tryPin("0000");
  assert.equal(lockedMin(), 90, "third lock 90 minutes");
});
