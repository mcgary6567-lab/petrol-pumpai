/** Global search (sidebar box + Ctrl K): records beyond parties — the stations, tanks and meters themselves. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-search-"));
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


test("global search finds the forecourt too: station, tank and meter names open Settings → Stations, tanks & meters", async () => {
  const st = ok(await call("admin", "GET", "/api/stations"), "stations")[0];
  const tank = st.tanks[0], noz = st.nozzles[0];
  const hits = async (who: string, q: string) => ok(await call(who, "GET", `/api/search?q=${encodeURIComponent(q)}`), "search").hits as any[];
  assert.ok((await hits("admin", st.name.slice(0, 5))).some((h) => h.kind === "station" && h.to === "/settings#set-stations"), "station");
  assert.ok((await hits("admin", tank.name)).some((h) => h.kind === "tank" && h.to === "/stock"), "tank");
  assert.ok((await hits("admin", noz.label)).some((h) => h.kind === "meter" && h.to === "/settings#set-stations"), "meter");
  // a salesman (no settings / stock rights) gets none of these
  assert.ok(!(await hits("salesman", st.name.slice(0, 5))).some((h) => ["station", "tank", "meter"].includes(h.kind)), "salesman blocked");
});
