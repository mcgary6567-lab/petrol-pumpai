import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-supplier-receive-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server;
let base = "";
let db: typeof import("../src/db.js");
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, msg: string) => { assert.equal(r.status, 200, `${msg}: ${JSON.stringify(r.data)}`); return r.data; };
const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 0.05, `${msg ?? ""} ${a} ≈ ${b}`);
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const photo = async (who: string) => ok(await call(who, "POST", "/api/ai/read-photo", { kind: "proof", image: PNG }), "photo").photo_id as number;
const day = (n: number) => new Date(Date.now() + 5 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);
const books = async () => { const b = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.equal(b.ok, true, JSON.stringify(b.checks.filter((c: any) => !c.ok))); };

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "cashier"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => server?.close());

const sup = async (id: number) => ok(await call("cashier", "GET", "/api/cashier/parties?kind=supplier"), "parties").supplier.find((s: any) => s.id === id);
const bankBal = async (id: number) => ok(await call("cashier", "GET", "/api/bank/accounts"), "acc").accounts.find((a: any) => a.id === id).balance;

test("cashier receives money from a supplier: cash, bank, cheque — payable goes up, voucher, void undoes it, books stay 0", async () => {
  const s0 = ok(await call("cashier", "GET", "/api/cashier/parties?kind=supplier"), "p").supplier[0];
  void db;

  // cash
  const r = ok(await call("cashier", "POST", "/api/cashier/receive", { party_type: "supplier", party_id: s0.id, amount: 7000, method: "Cash", notify: false }), "cash in");
  assert.match(r.voucher.no, /^RV-/);
  assert.equal(r.voucher.party_type, "supplier");
  assert.match(r.voucher.src, /^stx:/);
  near(r.balance_after, s0.balance + 7000, "we owe more after money came back");
  near((await sup(s0.id)).balance, s0.balance + 7000);
  await books();

  // bank: the account goes up
  const acc = ok(await call("cashier", "GET", "/api/bank/accounts"), "acc").accounts[0];
  const b0 = acc.balance;
  assert.equal((await call("cashier", "POST", "/api/cashier/receive", { party_type: "supplier", party_id: s0.id, amount: 3000, method: "Bank transfer", notify: false })).status, 400, "account needed");
  const rb = ok(await call("cashier", "POST", "/api/cashier/receive", { party_type: "supplier", party_id: s0.id, amount: 3000, method: "Bank transfer", account_id: acc.id, notify: false }), "bank in");
  near(await bankBal(acc.id), b0 + 3000, "bank up");
  await books();

  // void the bank one: bank and payable back
  ok(await call("admin", "POST", `/api/cashier/vouchers/${rb.voucher.id}/void`, { reason: "galat entry" }), "void");
  near(await bankBal(acc.id), b0, "bank back");
  near((await sup(s0.id)).balance, s0.balance + 7000, "payable back");

  // edit amount keeps it a receipt (not a payment)
  ok(await call("admin", "POST", `/api/cashier/vouchers/${r.voucher.id}/edit`, { amount: 6000, method: "Cash", reason: "amount theek" }), "edit");
  near((await sup(s0.id)).balance, s0.balance + 6000, "edited receipt");
  await books();

  // cheque: register first, payable moves when it clears
  const rc = ok(await call("cashier", "POST", "/api/cashier/receive", { party_type: "supplier", party_id: s0.id, amount: 4000, method: "Cheque", photo_ids: [await photo("cashier")], cheque: { bank: "UBL", cheque_no: "77001", cheque_date: day(0) }, notify: false }), "cheque");
  assert.ok(rc.cheque_pending);
  near((await sup(s0.id)).balance, s0.balance + 6000, "not until it clears");
  const q = ok(await call("cashier", "GET", "/api/cashier/cheques"), "reg").cheques.find((x: any) => x.src === "c" && x.cheque_no === "77001");
  const b1 = await bankBal(acc.id);
  ok(await call("cashier", "POST", `/api/cashier/cheques/${q.id}/deposit`, { account_id: acc.id }), "deposit");
  ok(await call("cashier", "POST", `/api/cashier/cheques/${q.id}/clear`, {}), "clear");
  near((await sup(s0.id)).balance, s0.balance + 10000, "cleared → payable up");
  near(await bankBal(acc.id), b1 + 4000, "bank up on clear");
  await books();
});
