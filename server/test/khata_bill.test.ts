/** Wholesale entries are findable and reversible: IDs for every entry, own-tank unload vouchers, clear full-tank refusal, cascade reversal. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-kbill-"));
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

test("khata purchase bill: only what the customer bought (no payments, refunds or opening), totals per item, vehicle filter, a PDF that opens", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const c = db.get("SELECT c.id FROM customers c WHERE c.tenant_id=? AND EXISTS (SELECT 1 FROM khata_ledger k WHERE k.customer_id=c.id AND k.type='credit') AND EXISTS (SELECT 1 FROM khata_ledger k WHERE k.customer_id=c.id AND k.type='debit' AND k.vehicle_no IS NOT NULL) ORDER BY c.id LIMIT 1", t)!.id as number;
  const { khataStatement } = await import("../src/routes/crm.js");
  const { purchaseLines, purchaseTotals } = await import("../src/docs.js");
  const s = khataStatement(t, c);
  const rows = purchaseLines(s.lines);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((l: any) => l.type === "debit" && !/^(refund:|xfer:|open:)/i.test(String(l.ref ?? ""))), "no payment / refund / opening line");
  for (let i = 1; i < rows.length; i++) assert.ok(String(rows[i - 1].created_at) >= String(rows[i].created_at), "newest first");
  const tot = purchaseTotals(rows);
  near(tot.reduce((a: number, x: any) => a + x.amount, 0), round2(rows.reduce((a: number, l: any) => a + l.amount, 0)));
  near(tot.reduce((a: number, x: any) => a + x.amount, 0), s.totals.billed, "bill total = what was billed");
  const veh = rows.find((l: any) => l.vehicle_no)!.vehicle_no;
  assert.ok(purchaseLines(s.lines, veh).every((l: any) => l.vehicle_no === veh));
  for (const qs of ["", `?vehicle=${encodeURIComponent(veh)}`, "?from=2026-01-01&to=2026-12-31"]) {
    const res = await fetch(`${base}/api/docs/khata_bill/${c}/pdf${qs}`, { headers: { authorization: `Bearer ${tokens.admin}` } });
    assert.equal(res.status, 200, qs); assert.equal(res.headers.get("content-type"), "application/pdf");
    const buf = Buffer.from(await res.arrayBuffer()); assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
  }
  assert.equal((await fetch(`${base}/api/docs/khata_bill/${c}/pdf`, { headers: { authorization: `Bearer ${tokens.salesman}` } })).status, 403, "a salesman cannot");
});
