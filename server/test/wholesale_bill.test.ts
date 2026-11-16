/** Wholesale entries are findable and reversible: IDs for every entry, own-tank unload vouchers, clear full-tank refusal, cascade reversal. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-wbill-"));
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
const round2 = (n: number) => Math.round(n * 100) / 100;
const books = async () => { const b = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.equal(b.ok, true, JSON.stringify(b.checks.filter((c: any) => !c.ok))); };
const cashNow = async () => ok(await call("admin", "GET", "/api/cash"), "cash").cash_in_hand as number;
const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000 + 5 * 3600_000).toISOString().slice(0, 10);

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "salesman", "wholesale"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("wholesale purchase bill: supplies (a return as minus) and kiraya only — no payments or balance — totals per item, a PDF that opens", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const c = db.get("SELECT client_id id FROM wholesale_txns w JOIN wholesale_clients c ON c.id=w.client_id WHERE c.tenant_id=? AND w.type='return' AND w.voided=0 LIMIT 1", t)?.id
    ?? db.get("SELECT id FROM wholesale_clients WHERE tenant_id=? ORDER BY id LIMIT 1", t)!.id;
  const { statement } = await import("../src/routes/wholesale.js");
  const { wholesalePurchaseRows, wholesalePurchaseTotals } = await import("../src/docs.js");
  const s = statement(t, c);
  const rows = wholesalePurchaseRows(s.lines);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((l: any) => ["supply", "return", "carriage"].includes(l.type) && !l.voided), "no payment / adjustment / void");
  for (const r of rows.filter((l: any) => l.type === "return")) assert.ok(r.bill_amount < 0 && r.bill_litres <= 0, "a return goes in as minus");
  for (let i = 1; i < rows.length; i++) assert.ok(String(rows[i - 1].txn_date) >= String(rows[i].txn_date), "newest first");
  const tot = wholesalePurchaseTotals(rows);
  const want = s.lines.filter((l: any) => !l.voided && ["supply", "carriage"].includes(l.type)).reduce((a: number, l: any) => a + l.debit, 0)
    - s.lines.filter((l: any) => !l.voided && l.type === "return").reduce((a: number, l: any) => a + l.credit, 0);
  near(tot.reduce((a: number, x: any) => a + x.amount, 0), want, "bill = supplied + kiraya − returned");
  for (const qs of ["", "?from=2026-01-01&to=2026-12-31"]) {
    const res = await fetch(`${base}/api/docs/wholesale_bill/${c}/pdf${qs}`, { headers: { authorization: `Bearer ${tokens.wholesale}` } });
    assert.equal(res.status, 200, qs); assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  }
  assert.equal((await fetch(`${base}/api/docs/wholesale_bill/${c}/pdf`, { headers: { authorization: `Bearer ${tokens.salesman}` } })).status, 403);
});
