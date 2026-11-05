/** Khata special rates for many customers in one go (+/- delta, or one card for all), logged so a back-dated khata
 *  entry bills at the card of its own moment. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-kbulk-"));
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
const pkMinute = (iso: string) => new Date(Date.parse(iso) + 5 * 3600_000).toISOString().slice(0, 16);

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "salesman", "wholesale", "cashier"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });


test("bulk khata rates: delta moves fixed and pump − X cards, set gives one card to all, CEO only, history prices back-dated fills", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const st = db.get("SELECT id FROM stations WHERE tenant_id=? ORDER BY id LIMIT 1", t)!.id as number;
  const board = Number(db.get("SELECT price FROM prices WHERE tenant_id=? AND product='HSD' ORDER BY effective_from DESC, id DESC LIMIT 1", t)!.price);
  const cs = db.all("SELECT id FROM customers WHERE tenant_id=? AND active=1 AND credit_limit - balance > 100000 ORDER BY id LIMIT 3", t).map((r) => r.id as number);
  const [a, b2, c3] = cs;
  ok(await call("admin", "POST", `/api/customers/${a}/khata-rates`, { rates: { HSD: { mode: "fixed", value: board - 5 } } }), "fixed card");
  ok(await call("admin", "POST", `/api/customers/${b2}/khata-rates`, { rates: { HSD: { mode: "minus", value: 4 } } }), "minus card");
  ok(await call("admin", "POST", `/api/customers/${c3}/khata-rates`, { rates: { HSD: null } }), "no card");
  // back-date the logged cards 10 days so the next change is clearly later
  db.run("UPDATE khata_rate_history SET created_at=? WHERE customer_id IN (?,?)", new Date(Date.now() - 10 * 86_400_000).toISOString(), a, b2);
  assert.equal((await call("manager", "POST", "/api/customers/khata-rates/bulk", { mode: "delta", deltas: { HSD: 2 } })).status, 403, "manager cannot");
  const r = ok(await call("admin", "POST", "/api/customers/khata-rates/bulk", { mode: "delta", deltas: { HSD: 2 }, notify: false }), "delta +2");
  const card = (id: number) => JSON.parse(String(db.get("SELECT khata_rates FROM customers WHERE id=?", id)!.khata_rates ?? "{}")).HSD;
  near(card(a).value, board - 3, "fixed +2"); assert.equal(card(a).mode, "fixed");
  near(card(b2).value, 2, "pump − 4 → pump − 2"); assert.equal(card(b2).mode, "minus");
  assert.equal(card(c3), undefined, "no card stays on the pump rate");
  assert.ok(r.customers >= 2);
  // a back-dated khata fill 5 days ago bills at the OLD card (board − 5 for the fixed customer), today's at the new one
  const day = new Date(Date.now() + 5 * 3600_000 - 5 * 86_400_000).toISOString().slice(0, 10);
  const old = ok(await call("admin", "POST", "/api/sales", { station_id: st, product: "HSD", litres: 10, payment_method: "khata", customer_id: a, entry_date: `${day}T10:00` }), "back-dated fill");
  const oldBoard = Number(db.get("SELECT price FROM prices WHERE tenant_id=? AND product='HSD' AND effective_from<=? ORDER BY effective_from DESC, id DESC LIMIT 1", t, new Date(`${day}T10:00:00+05:00`).toISOString())!.price);
  near(Number(db.get("SELECT rate FROM sales WHERE id=?", old.id)!.rate), Math.min(oldBoard, board - 5), "old card then");
  // set mode, all khata customers: pump − 1 for everyone in scope
  ok(await call("admin", "POST", "/api/customers/khata-rates/bulk", { mode: "set", scope: "all", cards: { HSD: { mode: "minus", value: 1 } }, customer_ids: [a, b2, c3], notify: false }), "set all");
  for (const id of [a, b2, c3]) { assert.equal(card(id).mode, "minus"); near(card(id).value, 1); }
  // delta that drops pump − X to 0 clears the card
  ok(await call("admin", "POST", "/api/customers/khata-rates/bulk", { mode: "delta", deltas: { HSD: 1 }, customer_ids: [c3], notify: false }), "to zero");
  assert.equal(card(c3), undefined, "back on the pump rate");
  assert.ok(Number(db.get("SELECT COUNT(*) n FROM khata_rate_history WHERE customer_id=?", c3)!.n) >= 2, "changes logged");
  const books = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.equal(books.ok, true);
});
