/** Expenses statement: any date range, grouped by category with running totals, subtotals and the grand total;
 *  category / cash-bank filters, the previous period, pending kept aside, and the CSV. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-exst-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server; let base = ""; let tok = ""; let db: typeof import("../src/db.js");
async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: any = text; try { data = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, data };
}
before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  tok = (await (await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@pumpai.pk", password: "demo1234" }) })).json() as any).token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("statement groups by category with running totals and the grand total; filters and CSV agree", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  // a quiet window far in the past so the demo data does not mix in
  db.run("DELETE FROM expenses WHERE tenant_id=? AND substr(expense_date,1,10) BETWEEN '2024-02-01' AND '2024-02-28'", t);
  const add = (category: string, amount: number, day: string, method = "cash", status = "approved") =>
    db.run("INSERT INTO expenses (tenant_id,category,amount,paid_to,method,note,status,created_by,expense_date,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      t, category, amount, `${category} wala`, method, "test", status, "Admin", day, new Date().toISOString());
  add("Gosht", 2400, "2024-02-11"); add("Gosht", 3100, "2024-02-13"); add("Bijli", 15000, "2024-02-12", "bank");
  add("Gosht", 999, "2024-02-14", "cash", "pending"); add("Bijli", 500, "2024-02-05"); // pending; previous period
  const r = await call("GET", "/api/expenses/statement?from=2024-02-10&to=2024-02-16");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = r.data;
  assert.equal(s.days, 7); assert.equal(s.total, 20500); assert.equal(s.n, 3);
  assert.deepEqual(s.categories.map((g: any) => g.category), ["Bijli", "Gosht"], "biggest first");
  const gosht = s.categories.find((g: any) => g.category === "Gosht");
  assert.equal(gosht.total, 5500); assert.deepEqual(gosht.lines.map((l: any) => l.running), [2400, 5500], "running total inside the category");
  assert.match(gosht.lines[0].voucher, /^EX-\d{5}$/);
  assert.equal(s.cash, 5500); assert.equal(s.bank, 15000);
  assert.equal(s.pending.n, 1); assert.equal(s.pending.amount, 999);
  assert.equal(s.previous.from, "2024-02-03"); assert.equal(s.previous.to, "2024-02-09"); assert.equal(s.previous.total, 500);
  // filters
  const g = (await call("GET", "/api/expenses/statement?from=2024-02-10&to=2024-02-16&categories=Gosht")).data;
  assert.equal(g.total, 5500); assert.equal(g.categories.length, 1);
  const bank = (await call("GET", "/api/expenses/statement?from=2024-02-10&to=2024-02-16&pay=bank")).data;
  assert.equal(bank.total, 15000);
  const oneDay = (await call("GET", "/api/expenses/statement?from=2024-02-13&to=2024-02-13")).data;
  assert.equal(oneDay.total, 3100);
  assert.equal((await call("GET", "/api/expenses/statement?from=2024-02-16&to=2024-02-10")).status, 400, "from after to");
  // CSV carries the subtotals and the grand total
  const csv = (await call("GET", `/api/expenses/statement.csv?from=2024-02-10&to=2024-02-16&token=${tok}`)).data as string;
  assert.match(csv, /Gosht — total/); assert.match(csv, /KUL KHARCHA/); assert.match(csv, /20500/);
});

test("CEO's other expenses join the statement as their own group (not party-khata ones, not voided); a manager does not see them", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const oe = (amount: number, at: string, extra: { to_party?: number; voided?: number; method?: string } = {}) =>
    db.run("INSERT INTO other_entries (tenant_id,kind,party_type,party_name,reason,amount,method,voided,to_party,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      t, "expense", "other", "Mistri", "Generator repair", amount, extra.method ?? "cash", extra.voided ?? 0, extra.to_party ?? 0, "Admin", at);
  oe(7000, "2024-02-12T07:00:00.000Z"); oe(3000, "2024-02-15T19:30:00.000Z", { method: "Bank transfer" }); // 15 Feb 19:30Z = 16 Feb PK
  oe(9999, "2024-02-12T07:00:00.000Z", { to_party: 1 }); oe(8888, "2024-02-12T07:00:00.000Z", { voided: 1 });
  const s = (await call("GET", "/api/expenses/statement?from=2024-02-10&to=2024-02-16")).data;
  assert.equal(s.can_see_other, true);
  assert.equal(s.parts.expenses.total, 20500); assert.equal(s.parts.other.total, 10000); assert.equal(s.total, 30500);
  const other = s.categories.find((g: any) => g.source === "other");
  assert.equal(other.n, 2); assert.deepEqual(other.lines.map((l: any) => l.running), [7000, 10000]);
  assert.equal(other.lines[1].day, "2024-02-16", "dated by the Pakistan day");
  assert.match(other.lines[0].voucher, /^OE-\d{5}$/); assert.match(other.lines[0].note, /Generator repair/);
  assert.equal(s.cash, 5500 + 7000); assert.equal(s.bank, 15000 + 3000);
  // only the other group, or only normal categories
  const onlyOther = (await call("GET", "/api/expenses/statement?from=2024-02-10&to=2024-02-16&categories=__other__")).data;
  assert.equal(onlyOther.total, 10000); assert.equal(onlyOther.parts.expenses.n, 0);
  const onlyGosht = (await call("GET", "/api/expenses/statement?from=2024-02-10&to=2024-02-16&categories=Gosht")).data;
  assert.equal(onlyGosht.total, 5500);
  // a station filter leaves the pump-wide other expenses out
  const st = db.get("SELECT id FROM stations WHERE tenant_id=? LIMIT 1", t)!.id;
  assert.equal((await call("GET", `/api/expenses/statement?from=2024-02-10&to=2024-02-16&station_id=${st}`)).data.parts.other.n, 0);
  // the manager's statement has no CEO-only lines
  const mtok = (await (await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "manager@pumpai.pk", password: "demo1234" }) })).json() as any).token;
  const ms = await (await fetch(`${base}/api/expenses/statement?from=2024-02-10&to=2024-02-16`, { headers: { authorization: `Bearer ${mtok}` } })).json() as any;
  assert.equal(ms.can_see_other, false); assert.equal(ms.total, 20500); assert.equal(ms.parts.other.n, 0);
  const csv = (await call("GET", `/api/expenses/statement.csv?from=2024-02-10&to=2024-02-16&token=${tok}`)).data as string;
  assert.match(csv, /Other kharche \(CEO\)/); assert.match(csv, /30500/);
});
