/** (5) Payments above the owner's limit wait for the CEO; (6) every signed-in device is listed and can be signed out one at a time. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-payappr-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";
let server: Server; let base = ""; let db: typeof import("../src/db.js");
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...headers, ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`); return r.data; };
const near = (a: number, b: number, m?: string) => assert.ok(Math.abs(a - b) < 0.6, `${m ?? ""} ${a} ≈ ${b}`);
const cashNow = async () => ok(await call("admin", "GET", "/api/owner/overview"), "overview").money.office_cash as number;
const owedOf = async (id: number) => ok(await call("admin", "GET", "/api/suppliers"), "suppliers").find((x: any) => x.id === id).total_owed as number;
before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "cashier"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" }, { "user-agent": `Mozilla/5.0 (Linux; Android 13) Chrome/120 ${who}` })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("payment limit: cashier's big supplier payment is held, nothing moves; CEO approves → booked in the cashier's name; reject moves nothing; small ones go straight through", async () => {
  const sup = ok(await call("admin", "POST", "/api/suppliers", { name: "Limit Test Depot", opening_balance: 500000 }), "supplier");
  assert.equal((await call("cashier", "PUT", "/api/payment-requests/limit", { limit: 50000 })).status, 403, "only the CEO sets the limit");
  ok(await call("admin", "PUT", "/api/payment-requests/limit", { limit: 50000 }), "set limit");
  const owed0 = await owedOf(sup.id), cash0 = await cashNow();

  // 80,000 cash by the cashier → held
  const held = ok(await call("cashier", "POST", "/api/cashier/pay", { party_type: "supplier", party_id: sup.id, amount: 80000, method: "Cash", notify: false }), "big pay");
  assert.equal(held.pending, true); assert.ok(held.request_id);
  near(await owedOf(sup.id), owed0, "owed unchanged while pending"); near(await cashNow(), cash0, "cash unchanged while pending");
  assert.equal(db.get("SELECT COUNT(*) n FROM approvals WHERE kind='payment' AND ref_id=? AND status='pending'", held.request_id).n, 1, "WhatsApp approval raised");
  // the cashier sees their own request, cannot decide
  const mine = ok(await call("cashier", "GET", "/api/payment-requests"), "mine");
  assert.equal(mine.can_decide, false); assert.ok(mine.pending.some((r: any) => r.id === held.request_id));
  assert.equal((await call("cashier", "POST", `/api/payment-requests/${held.request_id}/decide`, { approve: true })).status, 403);
  assert.equal((await call("manager", "POST", `/api/payment-requests/${held.request_id}/decide`, { approve: true })).status, 403, "manager cannot approve either");

  // CEO approves → booked as the cashier
  const dec = ok(await call("admin", "POST", `/api/payment-requests/${held.request_id}/decide`, { approve: true }), "approve");
  assert.equal(dec.status, "approved");
  near(await owedOf(sup.id), owed0 - 80000, "owed down after approval"); near(await cashNow(), cash0 - 80000, "cash out after approval");
  const v = db.get("SELECT created_by, amount FROM cashier_vouchers WHERE tenant_id=1 AND party_type='supplier' AND party_id=? ORDER BY id DESC LIMIT 1", sup.id);
  const cashierName = db.get("SELECT name FROM users WHERE email='cashier@pumpai.pk'").name, adminName = db.get("SELECT name FROM users WHERE email='admin@pumpai.pk'").name;
  assert.equal(v.created_by, cashierName, "booked in the cashier's name"); near(v.amount, 80000);
  assert.equal(db.get("SELECT status FROM approvals WHERE kind='payment' AND ref_id=?", held.request_id).status, "approved");

  // supplier page route is gated too; reject moves nothing
  const held2 = ok(await call("cashier", "POST", `/api/suppliers/${sup.id}/payment`, { amount: 60000, method: "Cash" }), "supplier page pay");
  assert.equal(held2.pending, true);
  ok(await call("admin", "POST", `/api/payment-requests/${held2.request_id}/decide`, { approve: false }), "reject");
  near(await owedOf(sup.id), owed0 - 80000, "reject: owed unchanged");
  assert.equal((await call("admin", "POST", `/api/payment-requests/${held2.request_id}/decide`, { approve: true })).status, 400, "already decided");

  // at / under the limit → immediate; the CEO is never held
  const small = ok(await call("cashier", "POST", "/api/cashier/pay", { party_type: "supplier", party_id: sup.id, amount: 50000, method: "Cash", notify: false }), "small pay");
  assert.ok(small.voucher, "booked at once"); near(await owedOf(sup.id), owed0 - 130000);
  const ceo = ok(await call("admin", "POST", "/api/cashier/pay", { party_type: "supplier", party_id: sup.id, amount: 70000, method: "Cash", notify: false }), "ceo pay");
  assert.ok(ceo.voucher, "CEO not held");
  // limit off → nothing held
  ok(await call("admin", "PUT", "/api/payment-requests/limit", { limit: 0 }), "limit off");
  assert.ok(ok(await call("cashier", "POST", "/api/cashier/pay", { party_type: "supplier", party_id: sup.id, amount: 90000, method: "Cash", notify: false }), "no limit").voucher);
  const c = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.deepEqual(c.checks.filter((r: any) => !r.ok && !r.advisory).map((r: any) => r.label), []);
});

test("sessions: every login is a device row; the CEO lists them with device names; signing one out refuses that token only", async () => {
  const second = (await call("", "POST", "/api/auth/login", { email: "cashier@pumpai.pk", password: "demo1234" }, { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1" })).data.token;
  tokens.cashier2 = second;
  assert.equal((await call("cashier", "GET", "/api/security/sessions")).status, 403, "staff cannot list devices");
  const cashierName = db.get("SELECT name FROM users WHERE email='cashier@pumpai.pk'").name, adminName = db.get("SELECT name FROM users WHERE email='admin@pumpai.pk'").name;
  const list = ok(await call("admin", "GET", "/api/security/sessions"), "sessions").sessions as any[];
  const mine = list.filter((s) => s.name === cashierName);
  assert.ok(mine.length >= 2, `two cashier devices: ${JSON.stringify(mine)}`);
  const iphone = mine.find((s) => /iPhone/.test(s.device));
  assert.ok(iphone, "device label from user-agent"); assert.match(iphone.device, /Safari/);
  assert.ok(list.some((s) => s.current && s.name === adminName), "the admin's own session is marked current");
  assert.equal((await call("cashier2", "GET", "/api/me")).status, 200, "iphone works before");
  ok(await call("admin", "DELETE", `/api/security/sessions/${iphone.id}`), "sign out iphone");
  assert.equal((await call("cashier2", "GET", "/api/me")).status, 401, "iphone token refused after sign-out");
  assert.equal((await call("cashier", "GET", "/api/me")).status, 200, "the cashier's other device still works");
  assert.ok(!ok(await call("admin", "GET", "/api/security/sessions"), "after").sessions.some((s: any) => s.id === iphone.id), "gone from the list");
  assert.ok(db.get("SELECT id FROM audit_log WHERE action='session_revoke'"), "audited");
  // "sign out all" closes every device row too
  ok(await call("admin", "POST", `/api/users/${db.get("SELECT id FROM users WHERE email='cashier@pumpai.pk'").id}/sign-out`, {}), "sign out all");
  assert.equal((await call("cashier", "GET", "/api/me")).status, 401);
});
