/** Old pump, investors already on board: opening balance (capital + unpaid profit, no cash move) and the
 *  "Investors" module switch — off by default for a new pump, on for the demo, CEO flips it from Go-live. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-invopen-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server; let base = ""; let db: typeof import("../src/db.js"); let auth: typeof import("../src/auth.js");
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`); return r.data; };
const near = (a: number, b: number, m?: string) => assert.ok(Math.abs(a - b) < 0.05, `${m ?? ""} ${a} ≈ ${b}`);
const books = async () => { const b = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.equal(b.ok, true, JSON.stringify(b.checks.filter((c: any) => !c.ok))); };
const cashNow = async () => ok(await call("admin", "GET", "/api/cash"), "cash").cash_in_hand as number;

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js"); auth = await import("../src/auth.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let inv: any;
test("opening balance: capital + unpaid profit credited as of a past day, no cash moves, books tally", async () => {
  inv = ok(await call("admin", "POST", "/api/investors", { name: "Purana Investor", our_pct: 60 }), "add");
  const cash0 = await cashNow();
  assert.equal((await call("admin", "POST", `/api/investors/${inv.id}/opening`, { as_of: "2025-01-01", capital: 0, profit_due: 0 })).status, 400, "zero refused");
  assert.equal((await call("admin", "POST", `/api/investors/${inv.id}/opening`, { as_of: "2099-01-01", capital: 1 })).status, 400, "future date refused");
  assert.equal((await call("manager", "POST", `/api/investors/${inv.id}/opening`, { as_of: "2025-01-01", capital: 1 })).status, 403, "CEO only");
  const r = ok(await call("admin", "POST", `/api/investors/${inv.id}/opening`, { as_of: "2025-01-01", capital: 500_000, profit_due: 20_000, note: "purana register" }), "opening");
  near(r.balance, 520_000);
  assert.equal(r.ids.length, 2);
  near(await cashNow(), cash0, "cash untouched");
  const st = ok(await call("admin", "GET", `/api/investors/${inv.id}?from=2025-01-01&to=2025-01-31`), "statement");
  near(st.investor.balance, 520_000); near(st.investor.capital_in, 500_000); near(st.investor.free, 520_000);
  assert.equal(st.lines.filter((l: any) => l.method === "Opening").length, 2, "two opening lines dated as-of");
  assert.ok(st.lines.every((l: any) => l.created_at.startsWith("2025-01-01")), "dated the as-of day");
  assert.equal((await call("admin", "POST", `/api/investors/${inv.id}/opening`, { as_of: "2025-01-01", capital: 1 })).status, 400, "only once");
  await books();
  // it shows in the books as go-live opening equity vs Investors payable
  const ov = ok(await call("admin", "GET", "/api/owner/overview"), "overview");
  assert.ok(ov.we_owe.investors >= 520_000 - 0.05, `we owe includes opening: ${ov.we_owe.investors}`);
});

test("after opening: a back-dated deal uses the capital, a payout clears the old profit; void the opening profit row works", async () => {
  const d = ok(await call("admin", "POST", `/api/investors/${inv.id}/deals`, { product: "HSD", litres: 1000, cost_rate: 250, deal_date: "2025-01-05" }), "back-dated deal");
  assert.equal(d.deal_date, "2025-01-05");
  const p = ok(await call("admin", "POST", `/api/investors/${inv.id}/money`, { dir: "out", amount: 20_000, method: "Cash", purpose: "profit" }), "pay old profit");
  near(p.balance, 500_000);
  await books();
  const st = ok(await call("admin", "GET", `/api/investors/${inv.id}`), "st");
  const op = st.lines.find((l: any) => l.method === "Opening" && l.type === "profit");
  ok(await call("admin", "POST", `/api/investor-txns/${op.id}/void`, { reason: "ghalat raqam" }), "void opening profit");
  near(ok(await call("admin", "GET", `/api/investors/${inv.id}`), "st2").investor.balance, 480_000);
  await books();
});

test("module switch: off → investors API 403 and /me says so; Go-live toggle turns it on; new tenants default off", async () => {
  db.setSetting(1, "module_investors", "0"); auth.forgetModules(1);
  assert.equal((await call("admin", "GET", "/api/investors")).status, 403, "investors 403 when off");
  const me = ok(await call("admin", "GET", "/api/me"), "me");
  assert.equal(me.modules.investors, false); assert.ok(!me.permissions.includes("investors.manage"));
  const gl = ok(await call("admin", "GET", "/api/golive"), "golive");
  const item = gl.items.find((x: any) => x.key === "investors");
  assert.ok(item && item.on === false, "checklist row shows OFF");
  ok(await call("admin", "POST", "/api/golive/investors", { on: true }), "toggle on");
  assert.equal(ok(await call("admin", "GET", "/api/me"), "me2").modules.investors, true);
  ok(await call("admin", "GET", "/api/investors"), "investors back");
  await books();
});

test("manual profit: fixed % on capital and a cash figure; loss; period once; void; books tally; portal shows it", async () => {
  db.setSetting(1, "module_investors", "1"); auth.forgetModules(1);
  const i2 = ok(await call("admin", "POST", "/api/investors", { name: "Fixed Return Sb", profit_mode: "fixed", profit_pct: 2.5 }), "add fixed");
  assert.equal(i2.profit_mode, "fixed"); assert.equal(i2.profit_pct, 2.5);
  ok(await call("admin", "POST", `/api/investors/${i2.id}/money`, { dir: "in", amount: 1_000_000, method: "Cash" }), "capital");
  const cash0 = await cashNow();
  // % of capital (default base) — 2.5% of 10 lakh = 25,000
  const p1 = ok(await call("admin", "POST", `/api/investors/${i2.id}/profit`, { mode: "percent", pct: 2.5, period: "2026-09" }), "pct profit");
  near(p1.amount, 25_000); near(p1.balance, 1_025_000);
  assert.equal((await call("admin", "POST", `/api/investors/${i2.id}/profit`, { mode: "percent", pct: 2.5, period: "2026-09" })).status, 400, "same month twice refused");
  // cash figure, custom base ignored in amount mode
  const p2 = ok(await call("admin", "POST", `/api/investors/${i2.id}/profit`, { mode: "amount", amount: 12_000, period: "2026-10", date: "2026-10-05", note: "tay shuda" }), "amount profit");
  near(p2.amount, 12_000); near(p2.balance, 1_037_000);
  // % of a custom base (e.g. the pump's month profit)
  const p3 = ok(await call("admin", "POST", `/api/investors/${i2.id}/profit`, { mode: "percent", pct: 10, base: 300_000 }), "pct of base");
  near(p3.amount, 30_000);
  // loss share
  const l = ok(await call("admin", "POST", `/api/investors/${i2.id}/profit`, { kind: "loss", mode: "amount", amount: 7_000 }), "loss");
  near(l.balance, 1_060_000);
  assert.equal((await call("admin", "POST", `/api/investors/${i2.id}/profit`, { kind: "loss", mode: "amount", amount: 9_000_000 })).status, 400, "loss over balance");
  assert.equal((await call("admin", "POST", `/api/investors/${i2.id}/profit`, { mode: "percent", pct: 0 })).status, 400, "zero pct");
  assert.equal((await call("manager", "POST", `/api/investors/${i2.id}/profit`, { mode: "amount", amount: 1 })).status, 403, "CEO only");
  near(await cashNow(), cash0, "no cash moved");
  await books();
  const st = ok(await call("admin", "GET", `/api/investors/${i2.id}`), "st");
  near(st.investor.profit_share, 67_000); near(st.investor.loss_share, 7_000); near(st.investor.capital_net, 1_000_000);
  const manual = st.lines.filter((x: any) => x.method === "Manual");
  assert.equal(manual.length, 4);
  assert.ok(manual.some((x: any) => /\[2026-09\] · 2\.5% of Rs 10,00,000/.test(x.note)), "note carries period + basis: " + manual.map((x: any) => x.note).join(" | "));
  // the P&L carries the expense: investor profit share
  const pl = ok(await call("admin", "GET", "/api/owner/overview"), "ov");
  assert.ok(pl.we_owe.investors >= 1_060_000 - 0.05);
  // void the loss and one profit
  ok(await call("admin", "POST", `/api/investor-txns/${l.id}/void`, { reason: "ghalat entry" }), "void loss");
  ok(await call("admin", "POST", `/api/investor-txns/${p3.id}/void`, { reason: "double" }), "void profit");
  near(ok(await call("admin", "GET", `/api/investors/${i2.id}`), "st2").investor.balance, 1_037_000);
  await books();
  // switch the investor back to deal mode: pct cleared
  const ed = ok(await call("admin", "PATCH", `/api/investors/${i2.id}`, { name: "Fixed Return Sb", our_pct: 60, profit_mode: "deal" }), "edit");
  assert.equal(ed.profit_mode, "deal"); assert.equal(ed.profit_pct, null);
});

test("payment method + reference: capital by Raast with a TID lands on the statement, the bank book and the portal; cash has no ref", async () => {
  db.setSetting(1, "module_investors", "1"); auth.forgetModules(1);
  const i3 = ok(await call("admin", "POST", "/api/investors", { name: "Method Test Sb" }), "add");
  const acc = ok(await call("admin", "POST", "/api/bank/accounts", { bank: "Meezan Bank", account_no: "0101 9988", opening_balance: 0 }), "bank").id;
  const r = ok(await call("admin", "POST", `/api/investors/${i3.id}/money`, { dir: "in", amount: 250_000, method: "Raast", account_id: acc, ref: "RST-77881", note: "pehli qist" }), "raast in");
  const c = ok(await call("admin", "POST", `/api/investors/${i3.id}/money`, { dir: "in", amount: 50_000, method: "Cash" }), "cash in");
  const st = ok(await call("admin", "GET", `/api/investors/${i3.id}`), "st");
  const a = st.lines.find((x: any) => x.id === r.id), b = st.lines.find((x: any) => x.id === c.id);
  assert.equal(a.method, "Raast"); assert.equal(a.ref, "RST-77881"); assert.equal(a.acc_bank, "Meezan Bank"); assert.equal(a.account_id, acc);
  assert.equal(b.method, "Cash"); assert.equal(b.ref, null); assert.equal(b.acc_bank, null);
  // the bank statement carries the ref
  const bank = ok(await call("admin", "GET", `/api/bank/accounts/${acc}/statement`), "bank statement");
  assert.ok(bank.lines.some((l: any) => /RST-77881/.test(String(l.text ?? "") + String(l.note ?? ""))), "bank book shows the ref: " + JSON.stringify(bank.lines.slice(0, 3)));
  // portal
  const portal = ok(await call("admin", "GET", `/api/investors/${i3.id}/portal`), "portal");
  const page = await (await fetch(base + new URL(portal.url).pathname, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `pin=${portal.pin}` })).text();
  assert.match(page, /Raast/); assert.match(page, /#RST-77881/);
  await books();
});

test("cheques: investor's cheque waits in the register (no credit), clears into the khata + bank; our cheque to them reduces free money, is debited when the bank pays; bounce reverses nothing", async () => {
  db.setSetting(1, "module_investors", "1"); auth.forgetModules(1);
  const i4 = ok(await call("admin", "POST", "/api/investors", { name: "Cheque Wala Sb" }), "add");
  const acc = ok(await call("admin", "POST", "/api/bank/accounts", { bank: "Habib Bank (HBL)", account_no: "0101 5544", opening_balance: 0 }), "bank").id;
  const bankBal = async () => ok(await call("admin", "GET", `/api/bank/accounts/${acc}/statement`), "bank st").closing as number;
  // received by cheque: nothing moves yet
  assert.equal((await call("admin", "POST", `/api/investors/${i4.id}/money`, { dir: "in", amount: 300_000, method: "Cheque" })).status, 400, "cheque details needed");
  const r = ok(await call("admin", "POST", `/api/investors/${i4.id}/money`, { dir: "in", amount: 300_000, method: "Cheque", cheque: { bank: "Meezan Bank", cheque_no: "771122", cheque_date: "2026-10-01" }, note: "pehli raqam" }), "cheque in");
  assert.equal(r.pending, true); assert.ok(r.cheque_id); near(r.balance, 0);
  let st = ok(await call("admin", "GET", `/api/investors/${i4.id}`), "st");
  near(st.investor.balance, 0); assert.equal(st.lines.length, 0);
  assert.equal(st.cheques.length, 1); assert.equal(st.cheques[0].status, "in_hand"); assert.equal(st.cheques[0].direction, "in");
  near(await bankBal(), 0);
  // it shows in the cashier's register under the investor's name
  const reg = ok(await call("admin", "GET", "/api/cashier/cheques"), "register");
  const q = reg.cheques.find((x: any) => x.id === r.cheque_id && x.src === "c");
  assert.ok(q && q.party_type === "investor" && q.party_name === "Cheque Wala Sb", "in register");
  await books();
  // deposit + clear → credited to the investor, money in the bank, method Cheque with the cheque no. as ref
  ok(await call("admin", "POST", `/api/cashier/cheques/${r.cheque_id}/deposit`, { account_id: acc }), "deposit");
  ok(await call("admin", "POST", `/api/cashier/cheques/${r.cheque_id}/clear`, { account_id: acc }), "clear");
  st = ok(await call("admin", "GET", `/api/investors/${i4.id}`), "st2");
  near(st.investor.balance, 300_000); near(st.investor.capital_in, 300_000);
  assert.equal(st.cheques.length, 0);
  const line = st.lines[0];
  assert.equal(line.type, "capital_in"); assert.equal(line.method, "Cheque"); assert.equal(line.ref, "771122"); assert.equal(line.account_id, acc);
  near(await bankBal(), 300_000);
  await books();
  // a second cheque bounces: still nothing on the khata
  const r2 = ok(await call("admin", "POST", `/api/investors/${i4.id}/money`, { dir: "in", amount: 50_000, method: "Cheque", cheque: { bank: "Meezan Bank", cheque_no: "771123", cheque_date: "2026-10-02" } }), "cheque 2");
  ok(await call("admin", "POST", `/api/cashier/cheques/${r2.cheque_id}/bounce`, { reason: "insufficient funds" }), "bounce");
  st = ok(await call("admin", "GET", `/api/investors/${i4.id}`), "st3");
  near(st.investor.balance, 300_000); assert.equal(st.cheques.find((x: any) => x.id === r2.cheque_id)?.status, "bounced");
  await books();
  // our cheque to the investor (capital back): issued → promised money, free drops; the bank pays → debit
  assert.equal((await call("admin", "POST", `/api/investors/${i4.id}/money`, { dir: "out", amount: 100_000, method: "Cheque", purpose: "capital", cheque: { bank: "x", cheque_no: "000451", cheque_date: "2026-10-20" } })).status, 400, "our account needed");
  const o = ok(await call("admin", "POST", `/api/investors/${i4.id}/money`, { dir: "out", amount: 100_000, method: "Cheque", purpose: "capital", account_id: acc, cheque: { bank: "Habib Bank (HBL)", cheque_no: "000451", cheque_date: "2026-10-20" } }), "cheque out");
  assert.equal(o.pending, true);
  st = ok(await call("admin", "GET", `/api/investors/${i4.id}`), "st4");
  near(st.investor.balance, 300_000); near(st.investor.cheques_issued, 100_000); near(st.investor.free, 200_000);
  assert.equal((await call("admin", "POST", `/api/investors/${i4.id}/money`, { dir: "out", amount: 250_000, method: "Cash" })).status, 400, "promised cheque counts against free money");
  near(await bankBal(), 300_000);
  ok(await call("admin", "POST", `/api/cashier/cheques/${o.cheque_id}/clear`, {}), "bank paid our cheque");
  st = ok(await call("admin", "GET", `/api/investors/${i4.id}`), "st5");
  near(st.investor.balance, 200_000); near(st.investor.cheques_issued, 0); near(st.investor.free, 200_000); near(st.investor.paid_out, 100_000);
  const pay = st.lines.find((x: any) => x.type === "payout");
  assert.equal(pay.method, "Cheque"); assert.equal(pay.purpose, "capital"); assert.equal(pay.ref, "000451");
  near(await bankBal(), 200_000);
  await books();
  // void the cleared payout: bank row goes, balance back
  ok(await call("admin", "POST", `/api/investor-txns/${pay.id}/void`, { reason: "ghalat cheque" }), "void");
  near(ok(await call("admin", "GET", `/api/investors/${i4.id}`), "st6").investor.balance, 300_000);
  near(await bankBal(), 300_000);
  await books();
});
