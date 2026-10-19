/** The suppliers list issues a constant number of queries regardless of how many suppliers exist (no N+1),
 *  and the figures (owed, bypass_owed, total_owed) still match the per-supplier helpers exactly. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-perfsup-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";
let server: Server; let base = ""; let db: typeof import("../src/db.js"); let admin = "";
async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", authorization: `Bearer ${admin}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`); return r.data; };
before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  admin = (await (await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@pumpai.pk", password: "demo1234" }) })).json() as any).token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function listQueries(): Promise<number> {
  db._resetQueryCount();
  await call("GET", "/api/suppliers");
  return db._queryCount();
}

test("suppliers list: query count stays flat as suppliers grow (no N+1), figures match the per-row helpers", async () => {
  const { supplierOwed } = await import("../src/routes/suppliers.js");
  const { bypassOwed } = await import("../src/routes/bypass.js");
  // one supplier with activity
  const s1 = ok(await call("POST", "/api/suppliers", { name: "Perf Depot A", opening_balance: 50000 }), "s1");
  ok(await call("POST", `/api/suppliers/${s1.id}/payment`, { amount: 10000, method: "Cash" }), "pay s1");
  const few = await listQueries();
  // add 20 more suppliers, each with a purchase + payment
  for (let i = 0; i < 20; i++) {
    const s = ok(await call("POST", "/api/suppliers", { name: `Perf Depot ${i}`, opening_balance: 1000 * i }), `s${i}`);
    ok(await call("POST", `/api/suppliers/${s.id}/payment`, { amount: 500, method: "Cash" }), `pay ${i}`);
  }
  const many = await listQueries();
  assert.ok(many <= few + 1, `query count must not grow with suppliers: ${few} → ${many}`);
  assert.ok(many <= 8, `suppliers list should be a handful of queries, got ${many}`);
  // figures still correct vs the per-supplier helpers
  const list = ok(await call("GET", "/api/suppliers"), "list") as any[];
  const row = list.find((x) => x.id === s1.id);
  assert.equal(row.owed, supplierOwed(s1.id), "owed matches helper");
  assert.equal(row.bypass_owed, bypassOwed(s1.id), "bypass matches helper");
  assert.equal(row.total_owed, Math.round((supplierOwed(s1.id) + bypassOwed(s1.id)) * 100) / 100, "total matches");
});
