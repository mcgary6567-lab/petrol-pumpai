/** Investors: capital in, fuel deals with it, profit / loss split (60/40), payouts — and the books stay at 0 farq. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-investor-"));
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
const tankL = async (product: string) => ok(await call("admin", "GET", "/api/stations"), "stations")[0].tanks.find((t: any) => t.product === product).current_l as number;

before(async () => {
  const { app } = await import("../src/index.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "salesman"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });


const books = async () => { const b = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.equal(b.ok, true, JSON.stringify(b.failed) + JSON.stringify(b.checks.filter((c: any) => !c.ok))); };
const cashNow = async () => ok(await call("admin", "GET", "/api/cash"), "cash").cash_in_hand as number;
let inv: any, deal: any;

test("investor profile: add, edit, CEO-only, delete only without history", async () => {
  assert.equal((await call("manager", "POST", "/api/investors", { name: "Haji Rasheed" })).status, 403, "manager blocked");
  inv = ok(await call("admin", "POST", "/api/investors", { name: "Haji Rasheed", phone: "03001234567", cnic: "12345-1234567-1", our_pct: 60 }), "add");
  assert.equal((await call("admin", "POST", "/api/investors", { name: "haji rasheed" })).status, 400, "duplicate name");
  const ed = ok(await call("admin", "PATCH", `/api/investors/${inv.id}`, { name: "Haji Rasheed Khan", phone: "03001234567", our_pct: 60, city: "Lahore" }), "edit");
  assert.equal(ed.name, "Haji Rasheed Khan");
  const tmp = ok(await call("admin", "POST", "/api/investors", { name: "Temp Investor" }), "tmp");
  ok(await call("admin", "DELETE", `/api/investors/${tmp.id}`), "delete empty");
});

test("capital in (cash): investor credited, office cash up, books tally", async () => {
  const c0 = await cashNow();
  ok(await call("admin", "POST", `/api/investors/${inv.id}/money`, { dir: "in", amount: 1_000_000, method: "Cash", note: "pehli raqam" }), "capital");
  near(await cashNow() - c0, 1_000_000, "cash in hand");
  const st = ok(await call("admin", "GET", `/api/investors/${inv.id}`), "statement");
  near(st.investor.balance, 1_000_000); near(st.lines[0].credit, 1_000_000); near(st.investor.free, 1_000_000);
  await books();
  // now it can't be deleted any more — only closed, and not while money is owed
  assert.equal((await call("admin", "DELETE", `/api/investors/${inv.id}`)).status, 400);
  assert.equal((await call("admin", "POST", `/api/investors/${inv.id}/inactive`)).status, 400);
});

test("deal capped at the investor's free money; profit split 60/40, investor share paid right away; books tally", async () => {
  assert.equal((await call("admin", "POST", `/api/investors/${inv.id}/deals`, { product: "HSD", litres: 5000, cost_rate: 255 })).status, 400, "1,275,000 > 1,000,000");
  deal = ok(await call("admin", "POST", `/api/investors/${inv.id}/deals`, { product: "HSD", litres: 3000, cost_rate: 255, ref: "BILTY-7" }), "deal");
  near(deal.cost_amount, 765_000);
  let st = ok(await call("admin", "GET", `/api/investors/${inv.id}`), "st");
  near(st.investor.in_deals, 765_000); near(st.investor.free, 235_000);
  // can't pay out money that is in a deal
  assert.equal((await call("admin", "POST", `/api/investors/${inv.id}/money`, { dir: "out", amount: 500_000, method: "Cash" })).status, 400);
  const sug = ok(await call("admin", "GET", `/api/investor-deals/${deal.id}/suggest`), "suggest");
  assert.ok(sug.sale_rate > 0);
  const c0 = await cashNow();
  // sold 2990 L @ 275 = 822,250; cost 765,000; expenses 5,000 + 4,000 + 1,250 = 10,250 → profit 47,000 → investor 18,800, ours 28,200
  const cl = ok(await call("admin", "POST", `/api/investor-deals/${deal.id}/close`, { sold_litres: 2990, sale_rate: 275, exp_carriage: 5000, exp_overhead: 4000, exp_other: 1250, pay_now: { method: "Cash" } }), "close");
  near(cl.profit, 47_000); near(cl.investor_share, 18_800); near(cl.our_share, 28_200); assert.equal(cl.paid, true);
  near(c0 - await cashNow(), 18_800, "profit share paid in cash");
  st = ok(await call("admin", "GET", `/api/investors/${inv.id}`), "st2");
  near(st.investor.balance, 1_000_000, "capital still owed; profit credited then paid");
  near(st.investor.profit_share, 18_800); near(st.investor.paid_out, 18_800); near(st.investor.in_deals, 0);
  assert.equal(st.lines.length, 3);
  assert.equal(st.lines[1].type, "profit"); near(st.lines[1].credit, 18_800);
  assert.equal(st.lines[2].type, "payout"); near(st.lines[2].debit, 18_800);
  assert.equal((await call("admin", "POST", `/api/investor-deals/${deal.id}/close`, { sold_litres: 1, sale_rate: 1 })).status, 400, "closed once");
  // the investor's share is an expense on our P&L (our profit = our 60%)
  const pl = ok(await call("admin", "GET", `/api/analysis/pl?month=${new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 7)}`), "pl").pl;
  near(pl.expenses.by_category.find((x: any) => x.category === "Investor profit share")?.amount ?? 0, 18_800, "investor share on P&L");
  await books();
});

test("loss is shared too: investor carries 40% of a deal's loss", async () => {
  const d = ok(await call("admin", "POST", `/api/investors/${inv.id}/deals`, { product: "PMG", litres: 1000, cost_rate: 260 }), "deal2");
  // 1000 L sold @ 250 = 250,000 vs cost 260,000 → loss 10,000 → investor −4,000
  const cl = ok(await call("admin", "POST", `/api/investor-deals/${d.id}/close`, { sold_litres: 1000, sale_rate: 250 }), "close loss");
  near(cl.profit, -10_000); near(cl.investor_share, -4_000);
  const st = ok(await call("admin", "GET", `/api/investors/${inv.id}`), "st");
  near(st.investor.balance, 996_000); near(st.investor.loss_share, 4_000);
  await books();
  // cancel that deal: the loss share comes back
  ok(await call("admin", "POST", `/api/investor-deals/${d.id}/void`, { reason: "galat rate" }), "void deal");
  near(ok(await call("admin", "GET", `/api/investors/${inv.id}`), "st").investor.balance, 1_000_000);
  await books();
});

test("investor's own page: link + 6-digit PIN shows balance, deals and Credit / Debit entries", async () => {
  const p = ok(await call("admin", "GET", `/api/investors/${inv.id}/portal`), "portal");
  assert.match(p.url, /\/i\/\d+-\d+-/); assert.match(p.pin, /^\d{6}$/);
  const path = new URL(p.url).pathname;
  const form = await fetch(base + path); assert.equal(form.status, 200); assert.match(await form.text(), /PIN/);
  const bad = await fetch(base + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "pin=000000" });
  assert.equal(bad.status, p.pin === "000000" ? 200 : 401);
  const good = await fetch(base + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `pin=${p.pin}` });
  const html = await good.text();
  assert.equal(good.status, 200); assert.match(html, /Haji Rasheed Khan/); assert.match(html, /Pump ke zimme/); assert.match(html, /Deal|deal/);
  assert.equal((await call("manager", "GET", `/api/investors/${inv.id}/portal`)).status, 403);
});

test("payout by bank, cancel a payout; dashboard card + we-owe; close the investor when settled", async () => {
  const acc = ok(await call("admin", "POST", "/api/bank/accounts", { bank: "Meezan Bank", account_no: "0101 2233", opening_balance: 0 }), "bank").id;
  const p = ok(await call("admin", "POST", `/api/investors/${inv.id}/money`, { dir: "out", amount: 400_000, method: "Bank transfer", account_id: acc, purpose: "capital" }), "payout bank");
  near(p.balance, 600_000);
  await books();
  ok(await call("admin", "POST", `/api/investor-txns/${p.id}/void`, { reason: "double entry" }), "void payout");
  near(ok(await call("admin", "GET", `/api/investors/${inv.id}`), "st").investor.balance, 1_000_000);
  await books();
  const ov = ok(await call("admin", "GET", "/api/owner/overview"), "overview");
  near(ov.we_owe.investors, 1_000_000); assert.ok(ov.investors); near(ov.investors.our_share, 28_200); near(ov.investors.investor_share, 18_800);
  assert.equal((await call("manager", "GET", "/api/investors-summary")).status, 403);
  ok(await call("admin", "POST", `/api/investors/${inv.id}/money`, { dir: "out", amount: 1_000_000, method: "Cash", purpose: "capital" }), "return all capital");
  ok(await call("admin", "POST", `/api/investors/${inv.id}/inactive`), "close investor");
  await books();
});
