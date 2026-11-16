/** Wholesale entries are findable and reversible: IDs for every entry, own-tank unload vouchers, clear full-tank refusal, cascade reversal. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-triptk-"));
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

test("a trip with two tankers: each bill line and each drop names its tanker; the drop is costed from that tanker's bill, never more than it carries, and a client with no rate card takes a typed rate", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const st = db.get("SELECT id FROM stations WHERE tenant_id=? ORDER BY id LIMIT 1", t)!.id as number;
  const S = ok(await call("wholesale", "GET", "/api/bypass/suppliers"), "suppliers").filter((x: any) => !x.client_id)[0];
  const clients = ok(await call("admin", "GET", "/api/wholesale/clients"), "clients");
  const W = (clients.clients ?? clients).find((c: any) => c.rates?.HSD);
  const N = ok(await call("admin", "POST", "/api/wholesale/clients", { name: "Naya Client Bina Rate" }), "new client");
  const tankers = [{ vehicle_no: "TK-A" }, { vehicle_no: "TK-B" }];
  const purchases = [
    { supplier_id: S.id, product: "HSD", litres: 10_000, cost_rate: 250, vehicle_no: "TK-A" },
    { supplier_id: S.id, product: "HSD", litres: 10_000, cost_rate: 260, vehicle_no: "tk-b" },
    { supplier_id: S.id, product: "PMG", litres: 5_000, cost_rate: 240, vehicle_no: "TK-A" },
  ];
  const post = (drops: any[]) => call("wholesale", "POST", "/api/bypass/deliveries", { station_id: st, tankers, purchases, drops });
  const before_ = db.get("SELECT COUNT(*) n FROM bypass_deliveries")!.n;
  // a tanker that is not on the trip, and more than the tanker carries: refused, nothing written
  const stranger = await post([{ client_id: W.id, product: "HSD", litres: 100, vehicle_no: "TK-Z" }]);
  assert.equal(stranger.status, 400); assert.match(stranger.data.error, /trip mein nahi/);
  const tooMuch = await post([{ client_id: W.id, product: "HSD", litres: 11_000, vehicle_no: "TK-B" }]);
  assert.equal(tooMuch.status, 400); assert.match(tooMuch.data.error, /TK-B par .* sirf 10,000 L/);
  // no rate card and no rate typed: refused
  const noRate = await post([{ client_id: N.id, product: "PMG", litres: 1_000, vehicle_no: "TK-A" }]);
  assert.equal(noRate.status, 400);
  assert.equal(db.get("SELECT COUNT(*) n FROM bypass_deliveries")!.n, before_);
  const r = ok(await post([
    { client_id: W.id, product: "HSD", litres: 4_000, vehicle_no: "TK-B" },
    { client_id: N.id, product: "PMG", litres: 1_000, rate: 300, vehicle_no: "TK-A" },
  ]), "trip");
  const drops = db.all("SELECT * FROM bypass_drops WHERE delivery_id=? ORDER BY id", r.id) as any[];
  assert.equal(drops[0].vehicle_no, "TK-B"); near(drops[0].unit_cost, 260, "HSD off TK-B costs TK-B's bill, not the 255 blend");
  near(drops[1].unit_cost, 240); near(r.drops[1].amount, 300_000, "typed rate x litres");
  assert.equal(db.get("SELECT vehicle_no v FROM wholesale_txns WHERE id=?", drops[0].wtx_id)!.v, "TK-B");
  const v = ok(await call("wholesale", "GET", `/api/bypass/deliveries/${r.id}`), "voucher");
  assert.deepEqual(v.purchases.map((p: any) => p.vehicle_no), ["TK-A", "TK-B", "TK-A"]);
  assert.deepEqual(v.drops.map((d: any) => d.vehicle_no), ["TK-B", "TK-A"]);
  // Baqi stock: what is left sits on the right tanker
  const hsd = ok(await call("wholesale", "GET", "/api/bypass/lots"), "lots").fuels.find((f: any) => f.product === "HSD").lots.filter((l: any) => l.delivery_id === r.id);
  near(hsd.find((l: any) => l.vehicles.join() === "TK-A").left, 10_000); near(hsd.find((l: any) => l.vehicles.join() === "TK-B").left, 6_000);
  await books();
});
