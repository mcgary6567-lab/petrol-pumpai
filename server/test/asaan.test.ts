import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-asaan-"));
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
void tokens;

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "salesman", "cashier"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => server?.close());

test("Asaan home: tanks with days of fuel left and a traffic light for everyone; the cash drawer only for roles that see cash", async () => {
  const s = ok(await call("salesman", "GET", "/api/asaan/home"), "salesman home");
  assert.ok(s.tanks.length > 0, "salesman sees tank levels (no stock permission needed)");
  for (const t of s.tanks) {
    assert.ok(["green", "amber", "red"].includes(t.light), "light");
    assert.ok(t.pct >= 0 && t.pct <= 100, "pct");
    if (t.days_left != null) assert.ok(t.days_left >= 0, "days");
  }
  assert.equal(s.cash_in_hand, null, "salesman does not see the cash drawer");
  const me = ok(await call("salesman", "GET", "/api/me"), "me");
  assert.ok(s.tanks.every((t: any) => t.station_name === me.user.station_name || !me.user.station_name), "salesman: own station only");

  const c = ok(await call("cashier", "GET", "/api/asaan/home"), "cashier home");
  assert.equal(typeof c.cash_in_hand, "number", "cashier sees the galla");
  const a = ok(await call("admin", "GET", "/api/asaan/home"), "admin home");
  assert.ok(a.tanks.length >= s.tanks.length, "owner sees every station's tanks");
  assert.equal((await call("", "GET", "/api/asaan/home")).status, 401, "needs sign-in");
});

test("traffic light rule: red under 1.5 days, amber up to 3, green above; no history → by % full", async () => {
  const { tankLight } = await import("../src/routes/asaan.js");
  assert.equal(tankLight(1, 80), "red"); assert.equal(tankLight(2, 10), "amber"); assert.equal(tankLight(5, 10), "green");
  assert.equal(tankLight(null, 10), "red"); assert.equal(tankLight(null, 20), "amber"); assert.equal(tankLight(null, 60), "green");
});
