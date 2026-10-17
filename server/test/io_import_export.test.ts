/** Master-list import / export: CSV round-trips, phone/barcode matching (no doubles), upsert mode, errors, books still tally. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-io-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server, base = "";
const tok: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tok[who] ? { authorization: `Bearer ${tok[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, data: ct.includes("json") ? await res.json() : await res.text() };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };

before(async () => {
  const { app } = await import("../src/index.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "salesman"]) tok[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("customers: export is a CSV with the header + every customer; template is header only", async () => {
  const csv = ok(await call("admin", "GET", "/api/io/customers.csv"), "export") as string;
  assert.ok(csv.replace(/^\uFEFF/, "").startsWith("Name,Phone,Type,City,Credit limit"), csv.slice(0, 80));
  const n = ok(await call("admin", "GET", "/api/customers"), "list").length;
  assert.equal(csv.trim().split("\r\n").length - 1, n, "one line per customer");
  const tpl = ok(await call("admin", "GET", "/api/io/customers/template.csv"), "template") as string;
  assert.equal(tpl.trim().split("\r\n").length, 1);
  assert.equal((await call("salesman", "GET", "/api/io/customers.csv")).status, 403, "salesman cannot export the customer list");
});

test("customers: paste from Excel (tabs) → preview → import; re-import matches by phone and never doubles", async () => {
  const sheet = ["Name\tPhone\tType\tCity\tCredit limit\tOpening balance\tVehicles", "Import Traders\t03005550001\tfleet\tLahore\t150000\t12000\tLEA-1234 | LEB-55", "Walk In Ali\t0300-555-0002\t\tKasur\t0\t\t", "Bad Row\t12\t\t\t\t\t"].join("\n");
  const pv = ok(await call("admin", "POST", "/api/io/customers/preview", { text: sheet }), "preview");
  assert.deepEqual(pv.summary, { new: 2, update: 0, skip: 0, error: 1 });
  assert.match(pv.rows[2].message, /Phone/);
  const r = ok(await call("admin", "POST", "/api/io/customers/import", { text: sheet }), "import");
  assert.equal(r.added, 2); assert.equal(r.errors.length, 1);
  const list = ok(await call("admin", "GET", "/api/customers?q=Import%20Traders"), "find");
  const c = list.find((x: any) => x.name === "Import Traders");
  assert.ok(c, "imported"); assert.equal(c.credit_limit, 150000); assert.equal(c.phone, "923005550001");
  assert.ok(Math.abs(c.balance - 12000) < 1, `opening balance on the khata: ${c.balance}`);
  const detail = ok(await call("admin", "GET", `/api/customers/${c.id}`), "detail");
  assert.deepEqual((detail.vehicles ?? []).map((v: any) => v.plate_no).sort(), ["LEA-1234", "LEB-55"]);
  // same sheet again: nothing doubles; in "add" mode they are skipped, in "upsert" mode the limit/city update but the balance does not
  const again = ok(await call("admin", "POST", "/api/io/customers/import", { text: sheet }), "again");
  assert.equal(again.added, 0); assert.equal(again.skipped, 2);
  const up = ok(await call("admin", "POST", "/api/io/customers/import", { text: sheet.replace("150000\t12000", "999000\t5"), mode: "upsert" }), "upsert");
  assert.equal(up.updated, 2);
  const c2 = ok(await call("admin", "GET", `/api/customers/${c.id}`), "detail2");
  assert.equal(c2.credit_limit, 999000, "limit updated"); assert.ok(Math.abs(c2.balance - 12000) < 1, "balance untouched by a re-import");
  assert.equal(ok(await call("admin", "GET", "/api/customers?q=Import%20Traders"), "count").filter((x: any) => x.name === "Import Traders").length, 1, "no duplicate");
  // a manager may import customers but not credit / opening balances
  assert.equal((await call("manager", "POST", "/api/io/customers/import", { text: sheet })).status, 403);
  const { tallyBooks } = await import("./helpers/tally.js");
  tallyBooks();
});

test("wholesale clients with rates, suppliers, thekedars and shop items import; shop opening stock is booked", async () => {
  const ws = ok(await call("admin", "POST", "/api/io/wholesale/import", { text: "Name,Business,Phone,Credit limit,Rate Diesel (Rs/L),Rate Petrol (Rs/L)\nImport Filling,IF Traders,03007770001,500000,261.5,270" }), "ws");
  assert.equal(ws.added, 1);
  const wc = ok(await call("admin", "GET", "/api/wholesale/clients?q=Import%20Filling"), "ws list").find((x: any) => x.name === "Import Filling");
  assert.ok(wc); const wd = ok(await call("admin", "GET", `/api/wholesale/clients/${wc.id}`), "ws detail");
  assert.equal(wd.rate_card.HSD.rate, 261.5);
  const sup = ok(await call("admin", "POST", "/api/io/suppliers/import", { text: "Name;Company;Phone;Opening balance\nImport Depot Guy;PSO;03008880001;25000" }), "sup");
  assert.equal(sup.added, 1);
  const s = ok(await call("admin", "GET", "/api/suppliers"), "suppliers").find((x: any) => x.name === "Import Depot Guy");
  assert.ok(s && Math.abs(s.owed - 25000) < 1, `supplier owed ${s?.owed}`);
  const th = ok(await call("admin", "POST", "/api/io/thekedars/import", { text: "Name,Phone,City\nImport Thekedar,03009990001,Multan" }), "thk");
  assert.equal(th.added, 1);
  const st = ok(await call("admin", "GET", "/api/stations"), "stations")[0].name;
  const sh = ok(await call("admin", "POST", "/api/io/shop/import", { text: `Station,Item,Category,Barcode,Cost,Sale price,Stock\n${st},Import Oil 4L,lubricant,IMP-4L,2000,2600,10\n${st},Zero Price,other,,10,0,1` }), "shop");
  assert.equal(sh.added, 1); assert.equal(sh.errors.length, 1);
  const item = ok(await call("admin", "GET", "/api/shop/items"), "items").find((x: any) => x.name === "Import Oil 4L");
  assert.ok(item && item.stock === 10 && item.price === 2600, JSON.stringify(item));
  // export of each list includes the imported row
  for (const [k, needle] of [["wholesale", "Import Filling"], ["suppliers", "Import Depot Guy"], ["thekedars", "Import Thekedar"], ["shop", "Import Oil 4L"]])
    assert.ok((ok(await call("admin", "GET", `/api/io/${k}.csv`), k) as string).includes(needle), `${k} export has ${needle}`);
  const { tallyBooks } = await import("./helpers/tally.js");
  tallyBooks();
});
