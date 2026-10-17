/** A bypass delivery with no fuel cost known anywhere: profit everywhere is the margin (billed − supplier bill), never the whole sale. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-bypprofit-"));
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
const near = (a: number, b: number, m?: string) => assert.ok(Math.abs(a - b) < 1, `${m ?? ""} ${a} ≈ ${b}`);

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "wholesale"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("no purchase rate anywhere: bypass 100 L bought 38,000 sold 39,081 → +1,081 profit on dashboard, P&L and munafa card; supplier owes +38,000; wholesale profit untouched", async () => {
  // a pump that has never recorded a purchase or an opening rate (the brand-new-pump case)
  db.run("DELETE FROM supplier_txns WHERE tenant_id=1");
  db.run("DELETE FROM fuel_opening_values WHERE tenant_id=1");
  const sup = ok(await call("admin", "GET", "/api/suppliers"), "suppliers")[0];
  const cl = ok(await call("wholesale", "GET", "/api/wholesale/clients"), "clients")[0];
  const st = ok(await call("admin", "GET", "/api/stations"), "stations")[0].id;
  const month = new Date().toISOString().slice(0, 7);

  const snap = async () => ({
    today: ok(await call("admin", "GET", "/api/owner/overview"), "overview").today,
    rep: ok(await call("admin", "GET", "/api/reports"), "reports").summary,
    pl: ok(await call("admin", "GET", `/api/analysis/pl?month=${month}`), "pl").pl,
    biz: ok(await call("admin", "GET", "/api/dashboard"), "insights").biz_profit,
    ws: ok(await call("wholesale", "GET", "/api/wholesale/summary"), "ws summary"),
    sup: ok(await call("admin", "GET", "/api/suppliers"), "suppliers").find((s: any) => s.id === sup.id),
  });
  const a = await snap();
  // with no cost known, the cost is assumed at pump price and the report says so (never a null profit, never zero cost)
  assert.ok(a.rep.gross_profit_estimate != null, "profit shown even with no purchase history");
  assert.ok(a.rep.cost_assumed_products.length > 0, "report flags the assumed cost");
  assert.ok(a.pl.cost_note, "P&L carries the note");

  const d = ok(await call("wholesale", "POST", "/api/bypass/deliveries", { station_id: st,
    purchases: [{ supplier_id: sup.id, product: "HSD", litres: 100, amount: 38000, cost_rate: 380 }],
    drops: [{ client_id: cl.id, product: "HSD", litres: 100, amount: 39081, override_limit: true }] }), "bypass delivery");
  near(d.billed, 39081); near(d.cost, 38000); near(d.margin, 1081, "form margin");

  const b = await snap();
  near(b.today.revenue - a.today.revenue, 39081, "today revenue up by the sale");
  near(b.today.profit_estimate - a.today.profit_estimate, 1081, "today profit up by the MARGIN only");
  near(b.rep.gross_profit_estimate - a.rep.gross_profit_estimate, 1081, "report gross profit: margin only");
  near(b.pl.gross_profit - a.pl.gross_profit, 1081, "monthly P&L: margin only (was the whole sale when cost was unknown)");
  near(b.biz.today.bypass - a.biz.today.bypass, 1081, "munafa card: bypass = margin");
  near(b.biz.today.wholesale - a.biz.today.wholesale, 0, "munafa card: wholesale clients line not double-counting the bypass sale");
  near(b.biz.month.total - a.biz.month.total, 1081, "munafa card total");
  near((b.ws.kpi?.profit_estimate ?? 0) - (a.ws.kpi?.profit_estimate ?? 0), 0, "wholesale dashboard profit untouched by a bypass drop");
  near(b.sup.bypass_owed - a.sup.bypass_owed, 38000, "supplier bypass account up by the bill");
  near(b.sup.total_owed - a.sup.total_owed, 38000, "supplier total owed up by the bill");
  // ledger: the sale is income, the supplier bill is cost — net 1,081 to profit
  const chk = ok(await call("admin", "GET", "/api/books/check"), "books");
  assert.deepEqual(chk.checks.filter((r: any) => !r.ok && !r.advisory).map((r: any) => r.label), [], "books tally");
});
