/** Advance / overpayment refunds: a party overpaid us (or we overpaid a supplier) and the extra is handed back
 *  later in cash. The party balance returns toward zero and the whole-system books stay at 0 farq. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-refund-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server;
let base = "";
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, msg: string) => { assert.equal(r.status, 200, `${msg}: ${JSON.stringify(r.data)}`); return r.data; };
const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 0.05, `${msg ?? ""} ${a} ≈ ${b}`);

before(async () => {
  const { app } = await import("../src/index.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  tokens.admin = (await call("", "POST", "/api/auth/login", { email: "admin@pumpai.pk", password: "demo1234" })).data.token;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const tally = async (msg: string) => { const { tallyBooks } = await import("./helpers/tally.js"); await tallyBooks(msg); assert.equal(ok(await call("admin", "GET", "/api/books/check"), `books ${msg}`).ok, true, `books not ok: ${msg}`); };

test("khata customer: overpay makes an advance, cash refund returns it, books tally", async () => {
  const c = ok(await call("admin", "GET", "/api/customers"), "customers").find((x: any) => x.credit_limit > 0) ?? ok(await call("admin", "GET", "/api/customers"), "c2")[0];
  const b0 = Number(ok(await call("admin", "GET", `/api/customers/${c.id}`), "cust").balance);
  // customer pays Rs 5,000 — more than due → advance (balance goes down / negative)
  const afterPay = ok(await call("admin", "POST", `/api/customers/${c.id}/khata`, { type: "credit", amount: 5000, method: "Cash", notify: false }), "pay");
  near(Number(afterPay.balance), b0 - 5000, "advance created");
  await tally("after khata overpay");
  // we hand the Rs 5,000 back in cash
  const afterRef = ok(await call("admin", "POST", `/api/customers/${c.id}/khata`, { type: "refund", amount: 5000, method: "Cash" }), "refund");
  near(Number(afterRef.balance), b0, "advance returned — balance back to start");
  await tally("after khata refund");
});

test("wholesale client: overpay makes an advance, cash refund returns it, books tally", async () => {
  const pay = ok(await call("admin", "POST", "/api/wholesale/clients/1/payment", { amount: 6000, method: "cash" }), "wpay");
  const due1 = Number(pay.due_after);
  await tally("after wholesale overpay");
  const ref = ok(await call("admin", "POST", "/api/wholesale/clients/1/refund", { amount: 6000, method: "cash", note: "Extra wapas" }), "wrefund");
  near(Number(ref.due_after), due1 + 6000, "wholesale refund reverses the payment (due back up)");
  await tally("after wholesale refund");
});

test("supplier: we overpay, then take the overpayment back in cash, books tally", async () => {
  const s = ok(await call("admin", "GET", "/api/suppliers"), "sups")[0];
  const owed0 = Number(s.owed);
  // pay the supplier Rs 7,000 more than owed → negative payable (they owe us)
  ok(await call("admin", "POST", `/api/suppliers/${s.id}/payment`, { amount: owed0 + 7000, method: "cash" }), "spay");
  const owed1 = Number(ok(await call("admin", "GET", "/api/suppliers"), "sup2").find((x: any) => x.id === s.id).owed);
  near(owed1, -7000, "supplier overpaid → they owe us 7,000");
  await tally("after supplier overpay");
  // supplier returns the Rs 7,000 in cash
  const ref = ok(await call("admin", "POST", `/api/suppliers/${s.id}/refund`, { amount: 7000, method: "Cash", note: "Wapas liya" }), "srefund");
  near(Number(ref.owed), 0, "supplier square again");
  await tally("after supplier refund");
});
