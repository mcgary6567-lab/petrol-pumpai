/** Parties admin (CEO): delete a party made by mistake (only when unused); merge a duplicate into the real one with every entry and balance following. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-parties-"));
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
const near = (a: number, b: number, m?: string) => assert.ok(Math.abs(a - b) < 0.6, `${m ?? ""} ${a} ≈ ${b}`);
const books = async () => { const c = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.deepEqual(c.checks.filter((r: any) => !r.ok && !r.advisory).map((r: any) => r.label), [], "books tally"); };
before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "cashier", "wholesale"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("customer: unused duplicate deletes; one with entries refuses delete; merge moves khata, payments and balance to the kept one", async () => {
  const real = ok(await call("admin", "POST", "/api/customers", { name: "Malik Transport", phone: "03007770001", type: "fleet", credit_limit: 500000 }), "real");
  const dup = ok(await call("admin", "POST", "/api/customers", { name: "Malik Transport (dup)", phone: "03007770002", type: "fleet", credit_limit: 500000 }), "dup");
  const blank = ok(await call("admin", "POST", "/api/customers", { name: "Typo Customer", phone: "03007770003", type: "retail" }), "blank");
  // entries on both
  ok(await call("admin", "POST", `/api/customers/${real.id}/khata`, { type: "debit", amount: 10000, note: "diesel", notify: false }), "khata real");
  ok(await call("admin", "POST", `/api/customers/${dup.id}/khata`, { type: "debit", amount: 25000, note: "diesel", notify: false }), "khata dup");
  ok(await call("cashier", "POST", "/api/cashier/receive", { party_type: "khata", party_id: dup.id, amount: 5000, method: "Cash", notify: false }), "cash on dup");
  const cash0 = ok(await call("admin", "GET", "/api/owner/overview"), "ov").money.office_cash;
  // manager cannot, CEO can
  assert.equal((await call("manager", "DELETE", `/api/parties/customer/${blank.id}`)).status, 403);
  const uBlank = ok(await call("admin", "GET", `/api/parties/customer/${blank.id}/usage`), "usage blank");
  assert.equal(uBlank.deletable, true); assert.equal(uBlank.total, 0);
  ok(await call("admin", "DELETE", `/api/parties/customer/${blank.id}`), "delete blank");
  assert.equal((await call("admin", "GET", `/api/customers/${blank.id}`)).status, 404, "gone");
  const uDup = ok(await call("admin", "GET", `/api/parties/customer/${dup.id}/usage`), "usage dup");
  assert.equal(uDup.deletable, false); assert.ok(uDup.total >= 3, `khata lines + voucher: ${JSON.stringify(uDup.entries)}`);
  const refused = await call("admin", "DELETE", `/api/parties/customer/${dup.id}`);
  assert.equal(refused.status, 400); assert.match(refused.data.error, /merge/i);
  // merge dup → real
  const found = ok(await call("admin", "GET", `/api/parties/customer/search?q=malik&not=${dup.id}`), "search");
  assert.ok(found.some((x: any) => x.id === real.id) && !found.some((x: any) => x.id === dup.id));
  assert.equal((await call("admin", "POST", `/api/parties/customer/${dup.id}/merge`, { into: dup.id })).status, 400, "self");
  const m = ok(await call("admin", "POST", `/api/parties/customer/${dup.id}/merge`, { into: real.id }), "merge");
  assert.ok(m.total >= 3, JSON.stringify(m.moved));
  const kept = ok(await call("admin", "GET", `/api/customers/${real.id}`), "kept");
  near(kept.balance, 10000 + 25000 - 5000, "balance adds up");
  assert.equal((await call("admin", "GET", `/api/customers/${dup.id}`)).status, 404, "duplicate row gone");
  assert.equal(db.get("SELECT COUNT(*) n FROM khata_ledger WHERE customer_id=?", dup.id).n, 0, "no orphan khata lines");
  assert.equal(db.get("SELECT COUNT(*) n FROM cashier_vouchers WHERE party_type='khata' AND party_id=?", dup.id).n, 0, "voucher moved");
  assert.equal(db.get("SELECT party_name FROM cashier_vouchers WHERE party_type='khata' AND party_id=? ORDER BY id DESC LIMIT 1", real.id).party_name, "Malik Transport");
  near(ok(await call("admin", "GET", "/api/owner/overview"), "ov").money.office_cash, cash0, "cash untouched");
  assert.ok(db.get("SELECT id FROM audit_log WHERE action='customer_merge' AND ref=?", `customer:${real.id}`), "audited");
  await books();
});

test("wholesale client: merge keeps the real client's rate, fills missing fuels from the duplicate, due adds up", async () => {
  const real = ok(await call("admin", "POST", "/api/wholesale/clients", { name: "Khan Filling Station", phone: "03007770011", rates: { HSD: 270 } }), "real");
  const dup = ok(await call("admin", "POST", "/api/wholesale/clients", { name: "Khan F/S", phone: "03007770012", rates: { HSD: 275, PMG: 290 }, opening_balance: 40000 }), "dup");
  const st = ok(await call("admin", "GET", "/api/stations"), "stations")[0];
  db.run("UPDATE tanks SET current_l = current_l + 5000 WHERE station_id=? AND product='HSD'", st.id);
  ok(await call("wholesale", "POST", "/api/wholesale/trips", { station_id: st.id, product: "HSD", vehicle_no: "DUP-1", drops: [{ client_id: dup.id, litres: 1000, override_limit: true }] }), "trip on dup");
  const dueDup = ok(await call("wholesale", "GET", `/api/wholesale/clients/${dup.id}`), "dup").summary.due;
  const dueReal = ok(await call("wholesale", "GET", `/api/wholesale/clients/${real.id}`), "real").summary.due;
  near(dueDup, 40000 + 275000, "dup due");
  assert.equal((await call("admin", "DELETE", `/api/parties/client/${dup.id}`)).status, 400, "has entries");
  const m = ok(await call("admin", "POST", `/api/parties/client/${dup.id}/merge`, { into: real.id }), "merge");
  assert.ok(m.moved.some((x: any) => x.table === "wholesale_txns"), JSON.stringify(m.moved));
  const kept = ok(await call("wholesale", "GET", `/api/wholesale/clients/${real.id}`), "kept");
  near(kept.summary.due, dueReal + dueDup, "due adds up");
  const rates = Object.fromEntries(db.all("SELECT product, rate FROM wholesale_rates WHERE client_id=?", real.id).map((r: any) => [r.product, r.rate]));
  assert.equal(rates.HSD, 270, "kept client's own rate wins"); assert.equal(rates.PMG, 290, "missing fuel filled from the duplicate");
  assert.equal(db.get("SELECT COUNT(*) n FROM wholesale_rates WHERE client_id=?", dup.id).n, 0);
  assert.equal((await call("wholesale", "GET", `/api/wholesale/clients/${dup.id}`)).status, 404);
  await books();
});

test("supplier and thekedar: unused ones delete; an opening balance or entries block delete; merge adds the opening", async () => {
  const s1 = ok(await call("admin", "POST", "/api/suppliers", { name: "Typo Depot" }), "s1");
  ok(await call("admin", "DELETE", `/api/parties/supplier/${s1.id}`), "delete unused supplier");
  const s2 = ok(await call("admin", "POST", "/api/suppliers", { name: "PSO Dup", opening_balance: 1000 }), "s2");
  assert.equal((await call("admin", "DELETE", `/api/parties/supplier/${s2.id}`)).status, 400, "opening blocks");
  const s3 = ok(await call("admin", "POST", "/api/suppliers", { name: "PSO Real" }), "s3");
  ok(await call("admin", "POST", `/api/parties/supplier/${s2.id}/merge`, { into: s3.id }), "merge suppliers");
  near(ok(await call("admin", "GET", "/api/suppliers"), "sup").find((x: any) => x.id === s3.id).total_owed, 1000, "opening carried");
  const k1 = ok(await call("wholesale", "POST", "/api/carriage/thekedars", { name: "Bashir Dup", phone: "03007770021" }), "k1");
  const k2 = ok(await call("wholesale", "POST", "/api/carriage/thekedars", { name: "Bashir Real", phone: "03007770022" }), "k2");
  ok(await call("wholesale", "POST", `/api/carriage/thekedars/${k1.id}/carriage`, { supplier_id: s3.id, amount: 5000, lines: [{ product: "HSD", litres: 1000 }], notify: false }), "carriage on dup");
  assert.equal((await call("admin", "DELETE", `/api/parties/thekedar/${k1.id}`)).status, 400);
  const m = ok(await call("admin", "POST", `/api/parties/thekedar/${k1.id}/merge`, { into: k2.id }), "merge thekedar");
  assert.ok(m.moved.some((x: any) => x.table === "carriage_txns"));
  assert.equal(db.get("SELECT COUNT(*) n FROM carriage_txns WHERE thekedar_id=?", k1.id).n, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM thekedars WHERE id=?", k1.id).n, 0);
  await books();
});
