/**
 * Meter reset / repair: a dispenser comes back from repair (or is replaced, or jumps back to 0). The manager records the
 * reset; the next shift starts from the new reading, and a reset during a running shift keeps that shift's litres true.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-mreset-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server;
let base = "";
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, msg: string) => { assert.equal(r.status, 200, `${msg}: ${JSON.stringify(r.data)}`); return r.data; };
const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 0.05, `${msg ?? ""} ${a} ≈ ${b}`);
const tankL = async (product: string) => ok(await call("admin", "GET", "/api/stations"), "stations")[0].tanks.find((t: any) => t.product === product).current_l as number;

before(async () => {
  const { app } = await import("../src/index.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "salesman"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let noz: any;

test("meter back from repair at 0: manager records the reset, unbilled litres leave stock + CEO alerted, next shift opens at 0", async () => {
  const hand = ok(await call("salesman", "GET", "/api/shifts/handover"), "handover");
  noz = hand.nozzles.find((n: any) => n.product === "PMG" && !n.busy);
  // a lower reading is refused until the reset is recorded
  const refused = await call("salesman", "POST", "/api/shifts/open", { station_id: hand.station_id, readings: { [noz.nozzle_id]: 0 } });
  assert.equal(refused.status, 400); assert.match(refused.data.error, /Meter reset/);
  // a salesman cannot reset a meter
  assert.equal((await call("salesman", "POST", `/api/nozzles/${noz.nozzle_id}/reset`, { new_reading: 0, reason: "repair" })).status, 403);
  // old meter below the last recorded reading is impossible
  assert.equal((await call("manager", "POST", `/api/nozzles/${noz.nozzle_id}/reset`, { old_reading: noz.last_reading - 10, new_reading: 0, reason: "repair" })).status, 400);
  const tank0 = await tankL("PMG");
  // the old meter ran 5 L past the last closing before it went for repair; it came back at 0
  const r = ok(await call("manager", "POST", `/api/nozzles/${noz.nozzle_id}/reset`, { old_reading: noz.last_reading + 5, new_reading: 0, reason: "Repair se wapas aaya, 0 par" }), "reset");
  near(r.gap_l, 5); assert.equal(r.shift_id, null);
  near(tank0 - (await tankL("PMG")), 5, "unbilled 5 L taken from book stock");
  const alerts = ok(await call("admin", "GET", "/api/notifications"), "notes").items;
  assert.ok(alerts.some((n: any) => n.type === "meter_reset"), "CEO alerted");
  const hand2 = ok(await call("salesman", "GET", "/api/shifts/handover"), "handover2");
  assert.equal(hand2.nozzles.find((n: any) => n.nozzle_id === noz.nozzle_id).last_reading, 0, "next shift starts at the new reading");
  const list = ok(await call("manager", "GET", "/api/meter-resets"), "history");
  assert.equal(list[0].nozzle_id, noz.nozzle_id); near(list[0].old_reading, noz.last_reading + 5); assert.equal(list[0].new_reading, 0);
});

test("meter reset during a running shift: litres before + after the reset both count, shift closes clean", async () => {
  const hand = ok(await call("salesman", "GET", "/api/shifts/handover"), "handover");
  const sh = ok(await call("salesman", "POST", "/api/shifts/open", { station_id: hand.station_id, readings: { [noz.nozzle_id]: 0 } }), "open at 0");
  // Settings → meter list knows the meter is in a running shift, from which reading, and whose shift (the reset window opens in shift mode)
  const sn = ok(await call("admin", "GET", "/api/stations"), "stations")[0].nozzles.find((x: any) => x.id === noz.nozzle_id);
  assert.ok(sn.busy); assert.equal(sn.shift_start, 0); assert.ok(sn.shift_by, "shift's salesman named");
  // a running meter needs the old meter's last reading
  assert.equal((await call("manager", "POST", `/api/nozzles/${noz.nozzle_id}/reset`, { new_reading: 0, reason: "kharab" })).status, 400);
  // old meter pumped 120 L this shift, then was swapped for one showing 3000
  ok(await call("manager", "POST", `/api/nozzles/${noz.nozzle_id}/reset`, { old_reading: 120, new_reading: 3000, reason: "Meter badla" }), "mid-shift reset");
  const live = ok(await call("salesman", "GET", `/api/shifts/${sh.id}/live`), "live");
  const rd = live.readings.find((x: any) => x.nozzle_id === noz.nozzle_id);
  near(rd.reset_adj, 120 - 3000); assert.match(rd.reset_note, /Meter reset 120 → 3000/);
  // the new meter then ran 80 L: 3000 → 3080; the shift sold 120 + 80 = 200 L
  const closed = ok(await call("salesman", "POST", `/api/shifts/${sh.id}/close`, { readings: { [noz.nozzle_id]: 3080 }, cash_actual: 0 }), "close");
  const rep = ok(await call("salesman", "GET", `/api/shifts/${sh.id}/report`), "report");
  near(rep.readings.find((x: any) => x.nozzle_id === noz.nozzle_id).litres, 200, "shift litres across the reset");
  near(closed.litres ?? rep.shift.litres, 200, "shift total litres");
  const hand2 = ok(await call("salesman", "GET", "/api/shifts/handover"), "handover after");
  assert.equal(hand2.nozzles.find((n: any) => n.nozzle_id === noz.nozzle_id).last_reading, 3080, "next shift starts at the new meter's closing");
  assert.equal(ok(await call("admin", "GET", "/api/books/check"), "books").ok, true, "books still tally");
});
