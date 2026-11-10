import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-newest-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server;
let base = "";
let db: typeof import("../src/db.js");
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, msg: string) => { assert.equal(r.status, 200, `${msg}: ${JSON.stringify(r.data)}`); return r.data; };

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  tokens.admin = (await call("", "POST", "/api/auth/login", { email: "admin@pumpai.pk", password: "demo1234" })).data.token;
});
after(() => server?.close());

test("Dip charts: a Diesel tank on the Petrol chart is flagged, and one tap puts it on the Diesel (Zain Oil) chart", async () => {
  const list0 = ok(await call("admin", "GET", "/api/dip-charts"), "list");
  const hsdTpl = list0.templates.find((x: any) => x.key === "ug-1700-hsd");
  assert.ok(hsdTpl && hsdTpl.product === "HSD", "diesel Zain Oil template offered");
  const hsd = list0.tanks.find((t: any) => t.product === "HSD"), pmg = list0.tanks.find((t: any) => t.product === "PMG");
  assert.ok(hsd && pmg, "demo has petrol and diesel tanks");
  // the mistake: the petrol chart on both tanks
  const petrol = ok(await call("admin", "POST", "/api/dip-charts", { template_key: "ug-14370-pmg", assign_tank_ids: [pmg.id, hsd.id] }), "petrol chart");
  const list1 = ok(await call("admin", "GET", "/api/dip-charts"), "list 1");
  const t1 = list1.tanks.find((t: any) => t.id === hsd.id);
  assert.equal(t1.chart_product, "PMG", "diesel tank shows it is on a petrol chart");
  // a petrol template cannot be put on a diesel tank
  assert.equal((await call("admin", "POST", `/api/tanks/${hsd.id}/dip-chart/template`, { template_key: "ug-14370-pmg" })).status, 400);
  const fixed = ok(await call("admin", "POST", `/api/tanks/${hsd.id}/dip-chart/template`, { template_key: "ug-1700-hsd" }), "fix");
  assert.equal(fixed.product, "HSD");
  assert.equal(fixed.rows, 171, "0 + 169 sheet rows + 1700 mm");
  const list2 = ok(await call("admin", "GET", "/api/dip-charts"), "list 2");
  assert.equal(list2.tanks.find((t: any) => t.id === hsd.id).chart_product, "HSD", "diesel tank now on the diesel chart");
  assert.equal(list2.tanks.find((t: any) => t.id === pmg.id).dip_chart_id, petrol.id, "petrol tank untouched");
  // again: reuses the same copy, no duplicate chart
  const again = ok(await call("admin", "POST", `/api/tanks/${hsd.id}/dip-chart/template`, { template_key: "ug-1700-hsd" }), "again");
  assert.equal(again.id, fixed.id);
  const r = db.get("SELECT litres FROM dip_chart_rows WHERE chart_id=? AND depth_mm=1000", fixed.id);
  assert.equal(Number(r.litres), 4228.2, "1000 mm = 4,228.2 L as on the sheet");
});

test("Statements: ?newest=1 gives the latest entries on page 1, each line keeping its own running balance", async () => {
  const clients = ok(await call("admin", "GET", "/api/wholesale/clients"), "clients");
  const c = clients.find((x: any) => x.id);
  const old = ok(await call("admin", "GET", `/api/wholesale/clients/${c.id}/statement?page=1&size=100`), "oldest first");
  const neu = ok(await call("admin", "GET", `/api/wholesale/clients/${c.id}/statement?page=1&size=100&newest=1`), "newest first");
  assert.ok(old.lines.length >= 2, "client has entries");
  assert.equal(neu.total, old.total);
  if (old.total <= 100) assert.deepEqual(neu.lines.map((l: any) => [l.id, l.balance]), [...old.lines].reverse().map((l: any) => [l.id, l.balance]));
  assert.ok(neu.lines[0].txn_date >= neu.lines[neu.lines.length - 1].txn_date, "latest date on top");
  assert.equal(neu.lines[0].balance, neu.closing_balance, "top line's balance = closing balance");
  // sales list: latest date first
  const sales = ok(await call("admin", "GET", "/api/sales"), "sales");
  for (let i = 1; i < sales.length; i++) assert.ok(sales[i - 1].created_at >= sales[i].created_at, "sales by date, newest first");
});
