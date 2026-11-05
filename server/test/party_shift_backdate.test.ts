/** 1) khata ↔ wholesale payment shift for one person linked on both sides; 2) a manager's back-dated POS entry on a
 *  CLOSED shift lands on that shift (salesman's list + cash expected follow); 3) a client's back-dated payment straight
 *  to our depot puts the supplier leg on the same date. Books stay at 0 farq throughout. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-pshift-"));
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

test("khata ↔ wholesale: link once, shift a payment across and back; cash untouched; unlinked / salesman refused", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const cust = db.get("SELECT id, balance FROM customers WHERE tenant_id=? ORDER BY id LIMIT 1", t)!;
  const c = ok(await call("admin", "POST", "/api/wholesale/clients", { name: "Shah Transport Multan", phone: "03001239311", type: "business", credit_limit: 9_000_000 }), "client");
  const pay = ok(await call("manager", "POST", `/api/customers/${cust.id}/khata`, { type: "credit", amount: 7000, method: "Cash", notify: false }), "khata payment");
  const k = db.get("SELECT id FROM khata_ledger WHERE customer_id=? ORDER BY id DESC LIMIT 1", cust.id)!;
  void pay;
  // not linked yet → refused with a clear message
  const nl = await call("manager", "POST", `/api/party-shift/khata/${k.id}/to-wholesale`, {});
  assert.equal(nl.status, 400); assert.match(nl.data.error, /juda nahi/);
  assert.equal((await call("salesman", "POST", "/api/party-shift/link", { client_id: c.id, customer_id: cust.id })).status, 403, "salesman cannot link");
  ok(await call("manager", "POST", "/api/party-shift/link", { client_id: c.id, customer_id: cust.id }), "link");
  const link = ok(await call("manager", "GET", `/api/party-shift/link?customer_id=${cust.id}`), "link read");
  assert.equal(link.client.id, c.id);
  const mv = ok(await call("manager", "GET", `/api/party-shift/movable?side=khata&ids=${k.id}`), "movable");
  assert.equal(mv.movable[k.id], null, "the payment can move");

  const balBefore = Number(db.get("SELECT balance FROM customers WHERE id=?", cust.id)!.balance);
  const dueBefore = ok(await call("admin", "GET", `/api/wholesale/clients/${c.id}`), "client").due ?? null;
  const kAt = db.get("SELECT created_at FROM khata_ledger WHERE id=?", k.id)!.created_at;
  const r = ok(await call("manager", "POST", `/api/party-shift/khata/${k.id}/to-wholesale`, { reason: "galat khate mein" }), "to wholesale");
  near(r.khata_balance_after, balBefore + 7000, "khata due back up by the payment");
  const w = db.get("SELECT * FROM wholesale_txns WHERE id=?", r.wtx_id)!;
  assert.equal(w.type, "payment"); near(Number(w.amount), 7000); assert.equal(String(w.method).toLowerCase(), "cash");
  assert.equal(w.txn_date, kAt, "same date and minute as the khata payment"); assert.equal(w.created_at, kAt);
  assert.match(String(w.note), /Khata se shift/);
  assert.equal(db.get("SELECT 1 x FROM khata_ledger WHERE id=?", k.id), undefined, "gone from the khata");
  if (dueBefore != null) near(r.client.due_after, dueBefore - 7000, "client due down by it");
  await books();

  // and back: wholesale → khata
  const back = ok(await call("manager", "POST", `/api/party-shift/wholesale/${r.wtx_id}/to-khata`, {}), "to khata");
  near(back.customer.balance_after, balBefore, "khata balance as before the first shift");
  assert.equal(db.get("SELECT voided FROM wholesale_txns WHERE id=?", r.wtx_id)!.voided, 1);
  const nk = db.get("SELECT * FROM khata_ledger WHERE id=?", back.khata_id)!;
  assert.equal(nk.created_at, kAt); assert.match(String(nk.note), /Wholesale se shift/);
  // a voided row cannot move again; a sale's khata debit is not a payment
  assert.equal((await call("manager", "POST", `/api/party-shift/wholesale/${r.wtx_id}/to-khata`, {})).status, 400);
  ok(await call("manager", "POST", `/api/customers/${cust.id}/khata`, { type: "debit", amount: 100, note: "charge" }), "charge");
  const deb = db.get("SELECT id FROM khata_ledger WHERE customer_id=? AND type='debit' ORDER BY id DESC LIMIT 1", cust.id)!;
  assert.equal((await call("manager", "POST", `/api/party-shift/khata/${deb.id}/to-wholesale`, {})).status, 400, "a charge is not a payment");
  await books();
});

test("manager back-dates a khata slip into a CLOSED shift: booked on that shift (salesman sees it), meter cash freed, cash expected down", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const smName = db.get("SELECT name FROM users WHERE email='salesman@pumpai.pk'")!.name;
  let sh = db.get(`SELECT sh.* FROM shifts sh JOIN stations s ON s.id=sh.station_id WHERE s.tenant_id=? AND sh.status='closed' AND sh.attendant=?
    ORDER BY sh.id DESC LIMIT 1`, t, smName);
  assert.ok(sh, "a closed shift of the demo salesman");
  // at close the meters booked litres the POS never saw as one CASH row (the demo has none): add one, and the bag it implies
  const rate = Number(db.get("SELECT rate FROM sales WHERE shift_id=? AND product='HSD' ORDER BY id DESC LIMIT 1", sh!.id)?.rate ?? 280);
  db.run("INSERT INTO sales (station_id,shift_id,product,litres,rate,amount,payment_method,source,at_close,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    sh!.station_id, sh!.id, "HSD", 100, rate, 100 * rate, "cash", "meter", 1, sh!.closed_at);
  db.run("UPDATE shifts SET cash_expected=cash_expected+?, cash_actual=cash_actual+? WHERE id=?", 100 * rate, 100 * rate, sh!.id);
  sh = db.get("SELECT * FROM shifts WHERE id=?", sh!.id)!;
  const mid = new Date((Date.parse(sh!.opened_at as string) + Date.parse(sh!.closed_at as string)) / 2).toISOString();
  const at = pkMinute(mid);
  const where = ok(await call("manager", "GET", `/api/sales/shift-at?station_id=${sh!.station_id}&at=${at}`), "shift-at");
  assert.equal(where.match.id, sh!.id); assert.equal(where.match.attendant, smName);
  const cust = db.get("SELECT id FROM customers WHERE tenant_id=? AND credit_limit - balance > 100000 ORDER BY credit_limit - balance DESC LIMIT 1", t)!.id;
  const expBefore = Number(sh!.cash_expected);
  const s = ok(await call("admin", "POST", "/api/sales", { station_id: sh!.station_id, product: "HSD", litres: 20, payment_method: "khata", customer_id: cust, entry_date: at }), "back-dated slip");
  assert.equal(s.shift_id, sh!.id, "on the shift open at that minute");
  const row = db.get("SELECT * FROM sales WHERE id=?", s.id)!;
  assert.ok(row.entered_at, "typed-at kept for the 'Baad mein darj' badge");
  near(Number(db.get("SELECT cash_expected FROM shifts WHERE id=?", sh!.id)!.cash_expected), expBefore - s.moved_from_meter_cash, "cash expected down by the meter cash freed");
  assert.ok(s.moved_from_meter_cash > 0);
  // the salesman's own list shows it
  const day = at.slice(0, 10);
  const hist = ok(await call("salesman", "GET", `/api/sales/history?from=${day}&to=${day}&limit=1000`), "salesman history");
  assert.ok(hist.rows.some((x: any) => x.id === s.id), "in the salesman's list");
  // a back-dated CASH entry is booked too (moved out of the meter cash, so the bag does not change)
  const exp2 = Number(db.get("SELECT cash_expected FROM shifts WHERE id=?", sh!.id)!.cash_expected);
  const cash = ok(await call("admin", "POST", "/api/sales", { station_id: sh!.station_id, product: "HSD", litres: 5, payment_method: "cash", entry_date: at }), "back-dated cash");
  assert.equal(cash.shift_id, sh!.id); assert.ok(cash.id, "a real row, not absorbed");
  near(Number(db.get("SELECT cash_expected FROM shifts WHERE id=?", sh!.id)!.cash_expected), exp2, "cash covered by the meter: bag unchanged");
  // picking another shift of a different day is refused
  const other = db.get("SELECT id FROM shifts WHERE station_id=? AND opened_at < ? ORDER BY id LIMIT 1", sh!.station_id, new Date(Date.parse(sh!.opened_at as string) - 3 * 86_400_000).toISOString());
  if (other) assert.equal((await call("admin", "POST", "/api/sales", { station_id: sh!.station_id, product: "HSD", litres: 5, payment_method: "khata", customer_id: cust, entry_date: at, shift_id: other.id })).status, 400);
  await books();
});

test("client pays our depot, entered back-dated at the cashier: the supplier leg carries the same date", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const c = ok(await call("admin", "POST", "/api/wholesale/clients", { name: "Green Fields Okara", phone: "03001239312", type: "business", credit_limit: 9_000_000 }), "client");
  const sup = db.get("SELECT id FROM suppliers WHERE tenant_id=? ORDER BY id LIMIT 1", t)!.id;
  const day = new Date(Date.now() + 5 * 3600_000 - 3 * 86_400_000).toISOString().slice(0, 10);
  const r = ok(await call("admin", "POST", "/api/cashier/receive", { party_type: "wholesale", party_id: c.id, amount: 50000, method: "Paid to depot", supplier_id: sup, entry_date: day, notify: false }), "depot receive");
  const wtx = String(r.voucher.src).split(":")[1];
  const w = db.get("SELECT txn_date FROM wholesale_txns WHERE id=?", wtx)!;
  const s = db.get("SELECT txn_date FROM supplier_txns WHERE ref=? AND method='Paid to depot'", `wtx:${wtx}`)!;
  assert.equal(w.txn_date.slice(0, 10), day);
  assert.equal(s.txn_date, w.txn_date, "supplier side on the client's date");
  await books();
});
