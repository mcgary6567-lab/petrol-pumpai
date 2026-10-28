/** The read-only "aaj ki saari entries" feed returns the day's events, day totals and a per-person roll-up. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-dayfeed-"));
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

before(async () => {
  const { app } = await import("../src/index.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  tokens.admin = (await call("", "POST", "/api/auth/login", { email: "admin@pumpai.pk", password: "demo1234" })).data.token;
});
after(() => server?.close());

test("day-feed: rows + day totals + per-person roll-up, read-only", async () => {
  const r = await call("admin", "GET", "/api/day-feed");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(Array.isArray(r.data.rows), "rows is a list");
  assert.ok(r.data.totals && typeof r.data.totals.count === "number", "day totals present");
  assert.ok(Array.isArray(r.data.by_person), "per-person roll-up present");
  assert.equal(r.data.is_today, true, "defaults to today");
  // every row carries the fields the feed UI needs
  for (const row of r.data.rows.slice(0, 20)) {
    assert.ok(typeof row.at === "string" && row.kind && typeof row.amount === "number" && ["in", "out", "neutral"].includes(row.dir), `row shape: ${JSON.stringify(row)}`);
  }
  // a specific past date is accepted and flagged not-today
  const past = await call("admin", "GET", "/api/day-feed?date=2000-01-01");
  assert.equal(past.status, 200);
  assert.equal(past.data.is_today, false);
});

test("wholesale tab = the wholesale officer's own entries; CEO's wholesale entries stay out; vehicle in its own field", async () => {
  tokens.wholesale = (await call("", "POST", "/api/auth/login", { email: "wholesale@pumpai.pk", password: "demo1234" })).data.token;
  const st = (await call("admin", "GET", "/api/stations")).data[0].id;
  const cl = (await call("wholesale", "GET", "/api/wholesale/clients")).data[0];
  const mine = await call("wholesale", "POST", `/api/wholesale/clients/${cl.id}/supply`, { station_id: st, product: "HSD", litres: 30, vehicle_no: "LES-1234", override_limit: true });
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  const ceo = await call("admin", "POST", `/api/wholesale/clients/${cl.id}/supply`, { station_id: st, product: "HSD", litres: 20, override_limit: true });
  assert.equal(ceo.status, 200, JSON.stringify(ceo.data));
  const feed = (await call("admin", "GET", "/api/day-feed?scope=wholesale")).data;
  const ids = feed.rows.map((r: any) => r.id);
  assert.ok(ids.includes(`wtx-${mine.data.id}`), "officer's supply shown");
  assert.ok(!ids.includes(`wtx-${ceo.data.id}`), "CEO's supply not on the officer's tab");
  const row = feed.rows.find((r: any) => r.id === `wtx-${mine.data.id}`);
  assert.equal(row.vehicle, "LES-1234"); assert.ok(!row.label.includes("LES-1234"), "vehicle not repeated in the label");
});
