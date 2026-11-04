/** Back-dated entries with a clock: POS and wholesale take "YYYY-MM-DDTHH:MM", book at that minute (PK), remember when
 *  they were typed, and bill at the rate in force THEN (board price for POS, the client's rate-card history for wholesale). */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-bdtime-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server; let base = ""; let db: typeof import("../src/db.js");
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`); return r.data; };
const near = (a: number, b: number, m?: string) => assert.ok(Math.abs(a - b) < 0.05, `${m ?? ""} ${a} ≈ ${b}`);
const books = async () => { const b = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.equal(b.ok, true, JSON.stringify(b.checks.filter((c: any) => !c.ok))); };
const pkDay = (ms: number) => new Date(ms + 5 * 3600_000).toISOString().slice(0, 10);

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "salesman", "wholesale"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("POS back-dated to a minute: dated there (PK), typed-at kept, priced at that minute's board rate; salesman cannot; future refused", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const st = db.get("SELECT id FROM stations WHERE tenant_id=? ORDER BY id LIMIT 1", t)!.id as number;
  // a day before the demo pump's own shifts (a late sale on a closed shift whose meter already covers it is absorbed, not re-booked)
  const day = pkDay(Date.now() - 45 * 86_400_000);
  // the board price that day: one rate from midnight, a new one from 10:00
  const was = db.get("SELECT price FROM prices WHERE tenant_id=? AND product='HSD' ORDER BY effective_from DESC, id DESC LIMIT 1", t)!.price as number;
  db.run("INSERT INTO prices (tenant_id,product,price,effective_from,created_by) VALUES (?,?,?,?,?)", t, "HSD", was, new Date(`${day}T00:00:00+05:00`).toISOString(), "test");
  db.run("INSERT INTO prices (tenant_id,product,price,effective_from,created_by) VALUES (?,?,?,?,?)", t, "HSD", was + 7, new Date(`${day}T10:00:00+05:00`).toISOString(), "test");
  // khata slips: a late cash sale on a closed shift is absorbed by that shift's meter (by design), a khata slip is re-booked as a row
  const cust = db.get("SELECT id FROM customers WHERE tenant_id=? AND credit_limit - balance > 100000 ORDER BY credit_limit - balance DESC LIMIT 1", t)!.id;
  const early = ok(await call("manager", "POST", "/api/sales", { station_id: st, product: "HSD", litres: 10, payment_method: "khata", customer_id: cust, entry_date: `${day}T09:30` }), "early");
  const late = ok(await call("manager", "POST", "/api/sales", { station_id: st, product: "HSD", litres: 10, payment_method: "khata", customer_id: cust, entry_date: `${day}T11:15` }), "late");
  const row = db.get("SELECT entered_at, created_at, rate FROM sales WHERE id=?", early.id)!, rowL = db.get("SELECT rate FROM sales WHERE id=?", late.id)!;
  assert.equal(row.created_at, new Date(`${day}T09:30:00+05:00`).toISOString(), "booked at the chosen minute");
  near(Number(rowL.rate) - Number(row.rate), 7, "the later minute takes the newer board price");
  assert.ok(row.entered_at && Date.parse(row.entered_at as string) > Date.now() - 60_000, "entered_at = now");
  const sm = await call("salesman", "POST", "/api/sales", { station_id: st, product: "HSD", litres: 5, payment_method: "khata", customer_id: cust, entry_date: `${day}T09:30` });
  if (sm.status === 200) assert.equal(String(db.get("SELECT created_at FROM sales WHERE id=?", sm.data.id)!.created_at).slice(0, 10), new Date().toISOString().slice(0, 10), "salesman: entry_date ignored, books today");
  const fut = await call("manager", "POST", "/api/sales", { station_id: st, product: "HSD", litres: 5, payment_method: "khata", customer_id: cust, entry_date: `${pkDay(Date.now() + 2 * 86_400_000)}T09:30` });
  assert.equal(fut.status, 400);
  // tidy the test price so the rest of the suite sees today's board rate unchanged
  await books();
});

test("wholesale supply back-dated: billed at the client's rate card AS OF that moment (history), booked at that minute", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const st = db.get("SELECT id FROM stations WHERE tenant_id=? ORDER BY id LIMIT 1", t)!.id as number;
  const c = ok(await call("admin", "POST", "/api/wholesale/clients", { name: "Rate History Client", phone: "03001239001", type: "business", credit_limit: 9_000_000 }), "client");
  ok(await call("admin", "PUT", `/api/wholesale/clients/${c.id}/rates`, { rates: { HSD: 250 } }), "rate 250");
  // pretend the 250 card was set 10 days ago, then changed to 258 two days ago
  db.run("UPDATE wholesale_rate_history SET created_at=? WHERE client_id=? AND product='HSD'", new Date(Date.now() - 10 * 86_400_000).toISOString(), c.id);
  ok(await call("admin", "PUT", `/api/wholesale/clients/${c.id}/rates`, { rates: { HSD: 258 } }), "rate 258");
  db.run("UPDATE wholesale_rate_history SET created_at=? WHERE client_id=? AND product='HSD' AND new_rate=258", new Date(Date.now() - 2 * 86_400_000).toISOString(), c.id);
  const day5 = pkDay(Date.now() - 5 * 86_400_000), day1 = pkDay(Date.now() - 1 * 86_400_000);
  const s5 = ok(await call("wholesale", "POST", `/api/wholesale/clients/${c.id}/supply`, { station_id: st, product: "HSD", litres: 100, txn_date: `${day5}T14:20` }), "supply 5 days ago");
  const s1 = ok(await call("wholesale", "POST", `/api/wholesale/clients/${c.id}/supply`, { station_id: st, product: "HSD", litres: 100, txn_date: `${day1}T08:05` }), "supply yesterday");
  const now0 = ok(await call("wholesale", "POST", `/api/wholesale/clients/${c.id}/supply`, { station_id: st, product: "HSD", litres: 100 }), "supply now");
  near(Number(s5.rate), 250, "5 days ago: the old card"); near(Number(s1.rate), 258, "yesterday: the new card"); near(Number(now0.rate), 258, "today: current card");
  assert.equal(s5.txn_date, new Date(`${day5}T14:20:00+05:00`).toISOString(), "booked at the chosen minute (PK)");
  assert.ok(Date.parse(s5.created_at) > Date.now() - 60_000, "created_at = when it was typed");
  await books();
});
