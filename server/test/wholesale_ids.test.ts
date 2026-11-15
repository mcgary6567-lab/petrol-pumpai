/** Wholesale entries are findable and reversible: IDs for every entry, own-tank unload vouchers, clear full-tank refusal, cascade reversal. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-wsids-"));
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

test("every wholesale entry has an ID: a stand-alone tank unload gets its own voucher, a full tank refuses clearly, find-by-ID opens anything, the officer can reverse a bill with every drop made from it", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const st = db.get("SELECT id FROM stations WHERE tenant_id=? ORDER BY id LIMIT 1", t)!.id as number;
  const S = ok(await call("wholesale", "GET", "/api/bypass/suppliers"), "suppliers").filter((x: any) => !x.client_id)[0];
  const clients = ok(await call("admin", "GET", "/api/wholesale/clients"), "clients");
  const W = (clients.clients ?? clients).find((c: any) => c.rates?.HSD);
  const tank = db.get("SELECT tk.* FROM tanks tk WHERE tk.station_id=? AND tk.product='HSD' LIMIT 1", st)!;
  db.run("UPDATE tanks SET current_l = capacity_l - 1000 WHERE id=?", tank.id); // room for exactly 1,000 L
  const due0 = ok(await call("admin", "GET", `/api/wholesale/clients/${W.id}/statement`), "stmt").closing_balance as number;
  const owed0 = ok(await call("wholesale", "GET", `/api/bypass/suppliers/${S.id}/statement`), "st").closing_balance as number;
  const stock0 = ok(await call("wholesale", "GET", "/api/bypass/stock"), "stock").by_product.find((x: any) => x.product === "HSD")?.litres ?? 0;
  // the supplier's bill: 5,000 L bought, nothing delivered yet (held on the tanker)
  const buy = ok(await call("wholesale", "POST", "/api/bypass/deliveries", { station_id: st, vehicle_no: "TST-501", purchases: [{ supplier_id: S.id, product: "HSD", litres: 5_000, cost_rate: 250 }], drops: [] }), "buy");
  // 1) a full tank: refused in plain words, and NOTHING is written (no half entry, no vanished entry)
  const dropsBefore = db.get("SELECT COUNT(*) n FROM bypass_drops")!.n, vouchersBefore = db.get("SELECT COUNT(*) n FROM bypass_deliveries")!.n;
  const full = await call("wholesale", "POST", "/api/bypass/to-tank", { product: "HSD", litres: 1_500, tank_id: tank.id, tanker_no: "TST-501" });
  assert.equal(full.status, 400); assert.match(full.data.error, /sirf 1,000 L ki jagah/);
  assert.equal(db.get("SELECT COUNT(*) n FROM bypass_drops")!.n, dropsBefore); assert.equal(db.get("SELECT COUNT(*) n FROM bypass_deliveries")!.n, vouchersBefore);
  // 2) what fits goes in, under its OWN voucher number
  const un = ok(await call("wholesale", "POST", "/api/bypass/to-tank", { product: "HSD", litres: 1_000, tank_id: tank.id, tanker_no: "TST-501", note: "bacha hua" }), "unload");
  assert.ok(un.voucher_id > buy.id); assert.equal(un.voucher_no, `BYP-${un.voucher_id}`);
  near(un.unit_cost, 250, "costed from that tanker's lot");
  const list = ok(await call("wholesale", "GET", "/api/bypass/deliveries"), "list");
  const row = list.find((d: any) => d.id === un.voucher_id);
  assert.ok(row, "the unload is in the vouchers list"); assert.equal(row.kind, "unload"); near(row.to_tank_litres, 1_000);
  const v = ok(await call("wholesale", "GET", `/api/bypass/deliveries/${un.voucher_id}`), "voucher");
  assert.equal(v.unloads.length, 1); near(v.unloads[0].litres, 1_000); assert.equal(v.kind, "unload");
  // 3) held fuel sold later under another voucher
  const sale = ok(await call("wholesale", "POST", "/api/bypass/deliveries", { station_id: st, vehicle_no: "TST-501", drops: [{ client_id: W.id, product: "HSD", litres: 1_500, override_limit: true }] }), "later sale");
  // 4) find by ID: voucher, unload, client supply (by its WS number), supplier bill line, a bare number, a mansookh one
  const find = async (q: string) => ok(await call("wholesale", "GET", `/api/vouchers/find?q=${encodeURIComponent(q)}`), `find ${q}`).results as any[];
  assert.equal((await find(`BYP-${buy.id}`))[0].open.id, buy.id);
  assert.equal((await find(`byp ${un.voucher_id}`))[0].kind, "Tank unload");
  const wtx = db.get("SELECT wtx_id FROM bypass_drops WHERE delivery_id=? AND voided=0", sale.id)!.wtx_id as number;
  const ws = await find(`WS-${wtx}`); assert.equal(ws[0].open.type, "wtx"); assert.equal(ws[0].open.client_id, W.id);
  const bp = db.get("SELECT id FROM bypass_purchases WHERE delivery_id=?", buy.id)!.id as number;
  assert.equal((await find(`BP-${bp}`))[0].open.id, buy.id, "a bill line opens its voucher");
  assert.ok((await find(String(buy.id))).some((r) => r.no === `BYP-${buy.id}`), "bare number");
  assert.deepEqual(await find("BYP-99999999"), []);
  assert.equal((await call("salesman", "GET", "/api/vouchers/find?q=BYP-1")).status, 403);
  // 5) the officer voids the supplier's bill: the unload AND the later client drop made from it go with it
  const plan = ok(await call("wholesale", "GET", `/api/vouchers/bypass/${buy.id}/plan`), "plan");
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers));
  assert.deepEqual(plan.cascade.map((c: any) => c.delivery_id).sort(), [un.voucher_id, sale.id].sort());
  ok(await call("wholesale", "POST", `/api/vouchers/bypass/${buy.id}/void`, { reason: "ghalat supplier" }), "void by officer");
  near(ok(await call("admin", "GET", `/api/wholesale/clients/${W.id}/statement`), "stmt").closing_balance, due0, "client due back");
  near(ok(await call("wholesale", "GET", `/api/bypass/suppliers/${S.id}/statement`), "st").closing_balance, owed0, "supplier owed back");
  near(ok(await call("wholesale", "GET", "/api/bypass/stock"), "stock").by_product.find((x: any) => x.product === "HSD")?.litres ?? 0, stock0, "bypass stock back");
  near(db.get("SELECT current_l FROM tanks WHERE id=?", tank.id)!.current_l as number, tank.capacity_l - 1000, "tank back");
  for (const id of [buy.id, un.voucher_id, sale.id]) assert.equal(db.get("SELECT voided FROM bypass_deliveries WHERE id=?", id)!.voided, 1, `voucher ${id} mansookh`);
  // 6) mansookh vouchers do not disappear: hidden by default, listed on request, still found by ID
  assert.ok(!ok(await call("wholesale", "GET", "/api/bypass/deliveries"), "list").some((d: any) => d.id === buy.id));
  assert.ok(ok(await call("wholesale", "GET", "/api/bypass/deliveries?voided=1"), "list+void").some((d: any) => d.id === buy.id && d.voided));
  assert.equal((await find(`BYP-${un.voucher_id}`))[0].voided, true);
  await books();
  // 7) a tank whose fuel was sold on blocks the reversal (never a half reversal)
  const buy2 = ok(await call("wholesale", "POST", "/api/bypass/deliveries", { station_id: st, purchases: [{ supplier_id: S.id, product: "HSD", litres: 800, cost_rate: 250 }], drops: [], to_tank: [{ tank_id: tank.id, product: "HSD", litres: 800 }] }), "buy 2");
  db.run("UPDATE tanks SET current_l = 100 WHERE id=?", tank.id);
  const p2 = ok(await call("wholesale", "GET", `/api/vouchers/bypass/${buy2.id}/plan`), "plan 2");
  assert.equal(p2.ok, false); assert.match(p2.blockers.join(" "), /bik chuke/);
  assert.equal((await call("wholesale", "POST", `/api/vouchers/bypass/${buy2.id}/void`, { reason: "koshish" })).status, 400);
});
