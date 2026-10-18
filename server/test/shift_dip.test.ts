/** Per-shift wet-stock reconciliation: opening + closing dip, meter sale vs dip sale, variance, tank set to dip, tally stays. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-shiftdip-"));
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

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "salesman"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("opening + closing dip reconcile against the meter; variance flagged, tank set to the dip, books tally", async () => {
  // a station whose salesman shift has a PMG tank + nozzle
  const noz = db.get("SELECT n.id nozzle_id, n.tank_id, n.station_id, n.totalizer, t.product, t.current_l FROM nozzles n JOIN tanks t ON t.id=n.tank_id JOIN stations s ON s.id=n.station_id WHERE s.tenant_id=1 AND n.active=1 AND t.product='PMG' ORDER BY n.id LIMIT 1") as any;
  assert.ok(noz, "a PMG nozzle");
  db.run("UPDATE tanks SET current_l = 5000 WHERE id=?", noz.tank_id);
  // close any open shift on this station (demo seeds one)
  for (const sh of db.all("SELECT id FROM shifts WHERE station_id=? AND status='open'", noz.station_id) as any[]) db.run("UPDATE shifts SET status='closed', closed_at=? WHERE id=?", new Date().toISOString(), sh.id);

  const open = ok(await call("salesman", "POST", "/api/shifts/open", { station_id: noz.station_id, readings: { [noz.nozzle_id]: noz.totalizer }, dips: [{ tank_id: noz.tank_id, measured_l: 5000 }] }), "open shift with opening dip");
  const shid = open.id;
  assert.equal(db.get("SELECT measured_l FROM shift_dips WHERE shift_id=? AND phase='open'", shid).measured_l, 5000, "opening dip stored");
  near(db.get("SELECT current_l FROM tanks WHERE id=?", noz.tank_id).current_l, 5000, "tank book stock = opening dip");

  // meter will show 100 L pumped; record 100 L cash so nothing extra is booked at close
  ok(await call("salesman", "POST", "/api/sales", { station_id: noz.station_id, product: "PMG", litres: 100, payment_method: "cash" }), "100 L cash sale");

  // closing: meter +100 (sold 100), closing dip 4890 → dip sold = 5000 − 4890 = 110 → variance = 100 − 110 = −10 (tank lost 10 more)
  const prev = ok(await call("salesman", "POST", `/api/shifts/${shid}/preview`, { readings: { [noz.nozzle_id]: noz.totalizer + 100 }, dips: [{ tank_id: noz.tank_id, measured_l: 4890 }] }), "preview");
  const prow = prev.dip_recon.find((d: any) => d.tank_id === noz.tank_id);
  near(prow.meter_l, 100, "preview meter"); near(prow.dip_sold_l, 110, "preview dip sold"); near(prow.variance_l, -10, "preview variance");
  // preview must not persist the closing dip or move the tank
  assert.equal(db.get("SELECT COUNT(*) n FROM shift_dips WHERE shift_id=? AND phase='close'", shid).n, 0, "preview saved nothing");

  const closed = ok(await call("salesman", "POST", `/api/shifts/${shid}/close`, { readings: { [noz.nozzle_id]: noz.totalizer + 100 }, cash_actual: 0, dips: [{ tank_id: noz.tank_id, measured_l: 4890 }] }), "close with closing dip");
  const row = closed.dip_recon.find((d: any) => d.tank_id === noz.tank_id);
  near(row.meter_l, 100); near(row.dip_sold_l, 110); near(row.variance_l, -10, "closed variance");
  near(db.get("SELECT current_l FROM tanks WHERE id=?", noz.tank_id).current_l, 4890, "tank set to the closing dip");

  // report endpoint
  const rep = ok(await call("manager", "GET", `/api/shifts/${shid}/dip-recon`), "dip-recon endpoint");
  near(rep.rows.find((d: any) => d.tank_id === noz.tank_id).variance_l, -10, "report variance");

  const { tallyBooks } = await import("./helpers/tally.js");
  await tallyBooks("shift dip recon");
  assert.equal(ok(await call("admin", "GET", "/api/books/check"), "books").ok, true, "books tally after dip close");
});

test("dip stick in cm: /shifts/dip-litres converts via the tank chart for a salesman; open + close accept measured_cm and keep the cm on the recon", async () => {
  const noz = db.get("SELECT n.id nozzle_id, n.tank_id, n.station_id, n.totalizer, t.product FROM nozzles n JOIN tanks t ON t.id=n.tank_id JOIN stations s ON s.id=n.station_id WHERE s.tenant_id=1 AND n.active=1 AND t.product='HSD' ORDER BY n.id LIMIT 1") as any;
  assert.ok(noz, "an HSD nozzle");
  for (const sh of db.all("SELECT id FROM shifts WHERE station_id=? AND status='open'", noz.station_id) as any[]) db.run("UPDATE shifts SET status='closed', closed_at=? WHERE id=?", new Date().toISOString(), sh.id);
  // a simple linear chart on this tank: 0 cm = 0 L … 200 cm = 20,000 L (100 L per cm)
  db.run("UPDATE tanks SET dip_chart_id=NULL, current_l=10000 WHERE id=?", noz.tank_id);
  db.run("DELETE FROM tank_charts WHERE tank_id=?", noz.tank_id);
  for (let cm = 0; cm <= 200; cm += 10) db.run("INSERT INTO tank_charts (tank_id,cm,litres) VALUES (?,?,?)", noz.tank_id, cm, cm * 100);

  // lookup (salesman role, shifts.manage only)
  const look = ok(await call("salesman", "GET", `/api/shifts/dip-litres?tank_id=${noz.tank_id}&cm=100`), "lookup cm");
  assert.equal(look.has_chart, true); near(look.litres, 10000, "100 cm → 10,000 L");
  near(ok(await call("salesman", "GET", `/api/shifts/dip-litres?tank_id=${noz.tank_id}&mm=955`), "lookup mm").litres, 9550, "955 mm → 9,550 L (interpolated)");
  const oor = ok(await call("salesman", "GET", `/api/shifts/dip-litres?tank_id=${noz.tank_id}&cm=250`), "out of range");
  assert.equal(oor.litres, null); assert.match(oor.error, /beech/);
  const noArg = ok(await call("salesman", "GET", `/api/shifts/dip-litres?tank_id=${noz.tank_id}`), "range only");
  assert.equal(noArg.range.max_cm, 200); assert.equal(noArg.litres, null);

  // open with cm, sell 100 L, close with cm → recon carries litres and the stick reading
  const open = ok(await call("salesman", "POST", "/api/shifts/open", { station_id: noz.station_id, readings: { [noz.nozzle_id]: noz.totalizer }, dips: [{ tank_id: noz.tank_id, measured_cm: 100 }] }), "open with cm dip");
  const od = db.get("SELECT measured_l, measured_cm FROM shift_dips WHERE shift_id=? AND phase='open'", open.id);
  near(od.measured_l, 10000); assert.equal(od.measured_cm, 100);
  ok(await call("salesman", "POST", "/api/sales", { station_id: noz.station_id, product: "HSD", litres: 100, payment_method: "cash" }), "100 L cash sale");
  // closing stick 98.9 cm → 9,890 L → tank lost 110 → variance −10
  const closed = ok(await call("salesman", "POST", `/api/shifts/${open.id}/close`, { readings: { [noz.nozzle_id]: noz.totalizer + 100 }, cash_actual: 0, dips: [{ tank_id: noz.tank_id, measured_cm: 98.9 }] }), "close with cm dip");
  const row = closed.dip_recon.find((d: any) => d.tank_id === noz.tank_id);
  near(row.closing_dip, 9890); near(row.dip_sold_l, 110); near(row.variance_l, -10, "variance from cm dips");
  assert.equal(row.opening_cm, 100); assert.equal(row.closing_cm, 98.9);
  near(db.get("SELECT current_l FROM tanks WHERE id=?", noz.tank_id).current_l, 9890, "tank set to the cm dip");

  // a tank with no chart answers has_chart=false instead of erroring
  const bare = db.get("SELECT t.id FROM tanks t JOIN stations s ON s.id=t.station_id WHERE s.tenant_id=1 AND t.id<>? AND t.dip_chart_id IS NULL AND NOT EXISTS (SELECT 1 FROM tank_charts c WHERE c.tank_id=t.id) LIMIT 1", noz.tank_id) as any;
  if (bare) { const r = ok(await call("salesman", "GET", `/api/shifts/dip-litres?tank_id=${bare.id}&cm=50`), "no chart"); assert.equal(r.has_chart, false); assert.equal(r.litres, null); }
});

test("opening dip is the tank's real stock: book stock replaced, stock register row written with the variance against the old book", async () => {
  const noz = db.get("SELECT n.id nozzle_id, n.tank_id, n.station_id, n.totalizer, t.capacity_l FROM nozzles n JOIN tanks t ON t.id=n.tank_id JOIN stations s ON s.id=n.station_id WHERE s.tenant_id=1 AND n.active=1 AND t.product='HSD' ORDER BY n.id LIMIT 1") as any;
  assert.ok(noz, "an HSD nozzle");
  for (const sh of db.all("SELECT id FROM shifts WHERE station_id=? AND status='open'", noz.station_id) as any[]) db.run("UPDATE shifts SET status='closed', closed_at=? WHERE id=?", new Date().toISOString(), sh.id);
  db.run("UPDATE tanks SET current_l = 0 WHERE id=?", noz.tank_id); // a tank the system thinks is empty (e.g. go-live without a stock entry)
  const before = db.get("SELECT COUNT(*) n FROM dip_readings WHERE tank_id=?", noz.tank_id).n;

  // more than the tank holds is refused, nothing written
  const tooMuch = await call("salesman", "POST", "/api/shifts/open", { station_id: noz.station_id, readings: { [noz.nozzle_id]: noz.totalizer }, dips: [{ tank_id: noz.tank_id, measured_l: noz.capacity_l * 2 }] });
  assert.equal(tooMuch.status, 400);
  assert.equal(db.get("SELECT COUNT(*) n FROM shifts WHERE station_id=? AND status='open'", noz.station_id).n, 0, "no shift opened on a refused dip");

  const open = ok(await call("salesman", "POST", "/api/shifts/open", { station_id: noz.station_id, readings: { [noz.nozzle_id]: noz.totalizer }, dips: [{ tank_id: noz.tank_id, measured_l: 6200 }] }), "open with 6,200 L diesel dip");
  near(db.get("SELECT current_l FROM tanks WHERE id=?", noz.tank_id).current_l, 6200, "diesel tank now shows the opening dip");
  const reg = db.get("SELECT measured_l, book_l FROM dip_readings WHERE tank_id=? ORDER BY id DESC LIMIT 1", noz.tank_id);
  assert.equal(db.get("SELECT COUNT(*) n FROM dip_readings WHERE tank_id=?", noz.tank_id).n, before + 1, "one stock-register dip row");
  near(reg.measured_l, 6200); near(reg.book_l, 0, "variance recorded against the old book stock");
  // the stations list (what every screen shows) carries it too
  const tank = (ok(await call("admin", "GET", "/api/stations"), "stations") as any[]).flatMap((s) => s.tanks).find((t) => t.id === noz.tank_id);
  near(tank.current_l, 6200, "stations API");
  ok(await call("salesman", "POST", `/api/shifts/${open.id}/close`, { readings: { [noz.nozzle_id]: noz.totalizer }, cash_actual: 0 }), "close");
});
