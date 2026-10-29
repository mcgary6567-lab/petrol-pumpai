/** ERP supply voucher: several fuel lines + kiraya post as one, the preview matches what posts, stock and dues stay in step,
 *  the party ledger carries ageing / unpaid bills and the books stay at 0 farq. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-wsv-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server; let base = "";
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`); return r.data; };

before(async () => {
  const { app } = await import("../src/index.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "wholesale"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let client: any, st: any;
test("preview: lines, credit check, balanced posting — nothing saved", async () => {
  client = ok(await call("admin", "POST", "/api/wholesale/clients", { name: "Voucher Test Traders", phone: "03001237777" }), "client");
  ok(await call("admin", "PUT", `/api/wholesale/clients/${client.id}/rates`, { rates: { HSD: 250, PMG: 240 } }), "rates");
  ok(await call("admin", "PATCH", `/api/wholesale/clients/${client.id}`, { credit_limit: 200000 }), "limit");
  st = ok(await call("admin", "GET", "/api/stations"), "stations")[0];
  const body = { station_id: st.id, lines: [{ product: "HSD", litres: 400 }, { product: "PMG", litres: 100 }], carriage: 3000, ref: "B-77", note: "test" };
  const p = ok(await call("wholesale", "POST", `/api/wholesale/clients/${client.id}/voucher/preview`, body), "preview");
  assert.equal(p.fuel, 400 * 250 + 100 * 240);
  assert.equal(p.total, 124000 + 3000);
  assert.equal(p.balanced, true);
  assert.equal(p.dr, p.cr);
  assert.equal(p.credit.after, 127000);
  assert.deepEqual(p.issues, []);
  assert.equal(p.lines[0].stock_after, p.lines[0].stock_before - 400);
  // nothing posted yet
  const s = ok(await call("wholesale", "GET", `/api/wholesale/clients/${client.id}/statement`), "stmt");
  assert.equal(s.closing_balance, 0);
  // officer cannot change the rate; over-limit is an issue, not a crash
  const bad = ok(await call("wholesale", "POST", `/api/wholesale/clients/${client.id}/voucher/preview`, { ...body, lines: [{ product: "HSD", litres: 1200, rate: 200 }] }), "bad preview");
  assert.ok(bad.issues.some((i: string) => /admin/.test(i)), "rate issue");
  assert.ok(bad.issues.some((i: string) => /Credit limit/.test(i)), "limit issue");
});

test("post: one voucher = supplies + kiraya, stock out, due up, ledger / unpaid / books tally", async () => {
  const tank = (await call("admin", "GET", "/api/stations")).data[0].tanks.find((t: any) => t.product === "HSD");
  const before = tank.current_l;
  const body = { station_id: st.id, lines: [{ product: "HSD", litres: 400 }, { product: "PMG", litres: 100 }], carriage: 3000, ref: "B-77", note: "test" };
  // a voucher with a bad line saves nothing
  assert.equal((await call("wholesale", "POST", `/api/wholesale/clients/${client.id}/voucher`, { ...body, lines: [...body.lines, { product: "HSD", litres: 9_999_999 }] })).status, 400);
  const r = ok(await call("wholesale", "POST", `/api/wholesale/clients/${client.id}/voucher`, body), "post");
  assert.equal(r.ids.length, 3);
  assert.equal(r.total, 127000);
  assert.equal(r.due_after, 127000);
  assert.match(r.voucher_no, /^WS-\d+$/);
  const after = (await call("admin", "GET", "/api/stations")).data[0].tanks.find((t: any) => t.id === tank.id).current_l;
  assert.equal(Math.round(before - after), 400);
  const s = ok(await call("wholesale", "GET", `/api/wholesale/clients/${client.id}/statement`), "stmt");
  assert.equal(s.closing_balance, 127000);
  assert.equal(s.lines.filter((l: any) => l.ref === "B-77").length, 3);
  assert.equal(s.unpaid.bills.reduce((a: number, b: any) => a + b.unpaid, 0), 127000);
  // a payment clears the oldest first; unpaid follows the due
  ok(await call("wholesale", "POST", `/api/wholesale/clients/${client.id}/payment`, { amount: 27000, method: "cash" }), "pay");
  const s2 = ok(await call("wholesale", "GET", `/api/wholesale/clients/${client.id}/statement`), "stmt2");
  assert.equal(s2.due_now, 100000);
  assert.equal(Math.round(s2.unpaid.bills.reduce((a: number, b: any) => a + b.unpaid, 0)), 100000);
  const d = ok(await call("wholesale", "GET", "/api/wholesale/dashboard"), "dash");
  assert.equal(d.monthly.length, 6);
  assert.ok(d.monthly[5].supplied >= 124000, "this month supplied");
  const bk = ok(await call("admin", "GET", "/api/books/check"), "books");
  assert.equal(bk.ok, true, JSON.stringify(bk).slice(0, 600));
  // void the kiraya line: due drops, books still tally
  ok(await call("admin", "POST", `/api/wholesale/txns/${r.ids[2]}/void`, { reason: "test void" }), "void");
  assert.equal(ok(await call("wholesale", "GET", `/api/wholesale/clients/${client.id}/statement`), "s3").due_now, 97000);
  assert.equal(ok(await call("admin", "GET", "/api/books/check"), "books2").ok, true);
});

test("invoices: a voucher is one bill (fuel + kiraya), status follows payments FIFO; detail posts balanced", async () => {
  const c = ok(await call("admin", "POST", "/api/wholesale/clients", { name: "Invoice Test Co", phone: "03001238888" }), "client");
  ok(await call("admin", "PUT", `/api/wholesale/clients/${c.id}/rates`, { rates: { HSD: 250 } }), "rates");
  const v1 = ok(await call("wholesale", "POST", `/api/wholesale/clients/${c.id}/voucher`, { station_id: st.id, lines: [{ product: "HSD", litres: 100 }], carriage: 1000 }), "v1");
  const v2 = ok(await call("wholesale", "POST", `/api/wholesale/clients/${c.id}/voucher`, { station_id: st.id, lines: [{ product: "HSD", litres: 200 }] }), "v2");
  let inv = ok(await call("wholesale", "GET", `/api/wholesale/invoices?client=${c.id}`), "list");
  assert.equal(inv.invoices.length, 2, "two bills, the kiraya rides on the first");
  const b1 = inv.invoices.find((i: any) => i.no === v1.voucher_no);
  assert.equal(b1.amount, 26000); assert.equal(b1.lines, 2); assert.equal(b1.status, "unpaid");
  // pay 30,000: the older bill (26,000) clears first, the newer one is partly paid
  ok(await call("wholesale", "POST", `/api/wholesale/clients/${c.id}/payment`, { amount: 30000, method: "cash" }), "pay");
  inv = ok(await call("wholesale", "GET", `/api/wholesale/invoices?client=${c.id}`), "list2");
  assert.equal(inv.invoices.find((i: any) => i.no === v1.voucher_no).status, "paid");
  const b2 = inv.invoices.find((i: any) => i.no === v2.voucher_no);
  assert.equal(b2.status, "partly"); assert.equal(b2.unpaid, 46000);
  assert.equal(inv.totals.unpaid, 46000);
  assert.equal(ok(await call("wholesale", "GET", `/api/wholesale/invoices?client=${c.id}&status=paid`), "paid").invoices.length, 1);
  const d = ok(await call("wholesale", "GET", `/api/wholesale/invoices/${v1.voucher_no}`), "detail");
  assert.equal(d.lines.length, 2);
  assert.equal(d.posting.reduce((a: number, p: any) => a + p.dr, 0), d.posting.reduce((a: number, p: any) => a + p.cr, 0));
  assert.equal((await call("wholesale", "GET", "/api/wholesale/invoices/WS-999999")).status, 404);
  // board and 360 read the same numbers
  const pipe = ok(await call("wholesale", "GET", "/api/wholesale/pipeline"), "pipeline");
  assert.deepEqual(pipe.columns.map((x: any) => x.key), ["requests", "orders", "unpaid", "overdue", "paid"]);
  assert.ok(pipe.columns[2].items.some((i: any) => i.no === v2.voucher_no && i.unpaid === 46000), "unpaid bill on the board");
  assert.ok(pipe.columns[4].items.some((p: any) => p.client_id === c.id && p.amount === 30000), "payment on the board");
  const x = ok(await call("wholesale", "GET", `/api/wholesale/clients/${c.id}/360`), "360");
  assert.equal(x.counts.invoices, 2); assert.equal(x.counts.payments, 1); assert.equal(x.due, 46000);
  assert.ok(x.activity.length >= 4 && x.activity.some((e: any) => e.kind === "payment"));
  assert.equal(ok(await call("admin", "GET", "/api/books/check"), "books").ok, true);
});

test("hardening: an impossible calendar date is a 400, not a 500; roles and limits hold", async () => {
  assert.equal((await call("wholesale", "GET", "/api/wholesale/invoices?from=2026-13-45")).status, 400, "bad month");
  assert.equal((await call("wholesale", "GET", "/api/wholesale/invoices?from=2026-02-30")).status, 400, "30 Feb");
  assert.equal((await call("wholesale", "GET", `/api/wholesale/clients/${client.id}/statement?from=2026-00-10`)).status, 400, "statement bad date");
  assert.equal((await call("wholesale", "GET", "/api/wholesale/invoices?from=2026-02-28")).status, 200, "real date ok");
  assert.equal((await call("wholesale", "GET", "/api/wholesale/invoices?from=&to=")).status, 200, "cleared date boxes = no filter");
  assert.equal((await call("wholesale", "GET", `/api/wholesale/clients/${client.id}/statement?from=&to=&page=1`)).status, 200, "statement, cleared dates");
  assert.equal((await call("wholesale", "GET", "/api/wholesale/invoices/WS-1'%20OR%201=1--")).status, 400, "invoice no shape");
  assert.equal((await call("wholesale", "POST", `/api/wholesale/clients/${client.id}/voucher/preview`, { station_id: st.id, lines: [{ product: "HSD", litres: -5 }] })).status, 400, "negative litres");
  assert.equal((await call("wholesale", "POST", `/api/wholesale/clients/${client.id}/voucher/preview`, { station_id: st.id, lines: Array(7).fill({ product: "HSD", litres: 1 }) })).status, 400, "7 lines");
  assert.equal((await call("wholesale", "GET", "/api/wholesale/requests")).status, 403, "officer cannot see portal requests");
});

test("idempotency: the same voucher POST with one key posts once and replays the first answer", async () => {
  const key = `e2e-${Date.now()}`;
  const body = { station_id: st.id, lines: [{ product: "HSD", litres: 10 }], note: "idem" };
  const post = async () => { const res = await fetch(`${base}/api/wholesale/clients/${client.id}/voucher`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokens.wholesale}`, "x-idempotency-key": key }, body: JSON.stringify(body) }); return { status: res.status, data: (await res.json()) as any }; };
  const n0 = ok(await call("wholesale", "GET", `/api/wholesale/clients/${client.id}/statement`), "s0").lines.length;
  const a = ok(await post(), "first");
  const b = ok(await post(), "retry");
  assert.equal(b.voucher_no, a.voucher_no, "same voucher number");
  assert.equal(b.replayed, true);
  const n1 = ok(await call("wholesale", "GET", `/api/wholesale/clients/${client.id}/statement`), "s1").lines.length;
  assert.equal(n1 - n0, 1, "posted exactly once");
  // a different key posts again
  const res = await fetch(`${base}/api/wholesale/clients/${client.id}/voucher`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokens.wholesale}`, "x-idempotency-key": `${key}-b` }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  assert.equal(ok(await call("wholesale", "GET", `/api/wholesale/clients/${client.id}/statement`), "s2").lines.length - n0, 2);
});

test("statement paging: 10 a page, running balance intact, period totals and months ride along, search filters", async () => {
  const full = ok(await call("wholesale", "GET", `/api/wholesale/clients/${client.id}/statement`), "full");
  const p1 = ok(await call("wholesale", "GET", `/api/wholesale/clients/${client.id}/statement?page=1&size=5`), "p1");
  assert.equal(p1.lines.length, Math.min(5, full.lines.filter((l: any) => !l.voided).length));
  assert.equal(p1.total, full.lines.filter((l: any) => !l.voided).length);
  assert.equal(p1.pages, Math.ceil(p1.total / 5));
  assert.deepEqual(p1.lines.map((l: any) => l.id), full.lines.filter((l: any) => !l.voided).slice(0, 5).map((l: any) => l.id), "same order and balances as the full statement");
  assert.equal(p1.closing_balance, full.closing_balance);
  assert.equal(p1.period.debit, Math.round(full.lines.filter((l: any) => !l.voided).reduce((a: number, l: any) => a + l.debit, 0) * 100) / 100);
  assert.ok(Array.isArray(p1.months) && p1.months.length >= 1);
  const last = ok(await call("wholesale", "GET", `/api/wholesale/clients/${client.id}/statement?page=99&size=5`), "last");
  assert.equal(last.page, last.pages, "page past the end clamps to the last page");
  const q = ok(await call("wholesale", "GET", `/api/wholesale/clients/${client.id}/statement?page=1&q=payment`), "q");
  assert.ok(q.lines.length >= 1 && q.lines.every((l: any) => l.type === "payment"));
  const v = ok(await call("wholesale", "GET", `/api/wholesale/clients/${client.id}/statement?page=1&voided=true&size=100`), "voided");
  assert.ok(v.lines.some((l: any) => l.voided), "voided lines come back when asked");
});
