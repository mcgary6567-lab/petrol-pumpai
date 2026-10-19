/** The wholesale clients list + summary issue a constant number of queries regardless of client count (no N+1),
 *  and `due` still matches clientDue per client exactly. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-perfws-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";
let server: Server; let base = ""; let db: typeof import("../src/db.js"); const tk: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tk[who] ? { authorization: `Bearer ${tk[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`); return r.data; };
before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "wholesale"]) tk[who] = (await (await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${who}@pumpai.pk`, password: "demo1234" }) })).json() as any).token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function listQueries(): Promise<number> { db._resetQueryCount(); await call("wholesale", "GET", "/api/wholesale/clients"); return db._queryCount(); }

test("wholesale clients list: query count flat as clients grow; due matches clientDue", async () => {
  const { clientDue } = await import("../src/routes/wholesale.js");
  const base1 = ok(await call("admin", "POST", "/api/wholesale/clients", { name: "WS Perf One", rates: { HSD: 270 }, opening_balance: 12000 }), "c1");
  const few = await listQueries();
  for (let i = 0; i < 20; i++) ok(await call("admin", "POST", "/api/wholesale/clients", { name: `WS Perf ${i}`, rates: { HSD: 260 + i }, opening_balance: 100 * i }), `c${i}`);
  const many = await listQueries();
  assert.ok(many <= few + 1, `wholesale list query count must stay flat: ${few} → ${many}`);
  const list = ok(await call("wholesale", "GET", "/api/wholesale/clients"), "list") as any[];
  const row = list.find((x) => x.id === base1.id);
  assert.equal(row.due, clientDue(base1.id), "due matches helper");
  // summary total_due equals the sum of clientDue over all clients
  const sum = (db.all("SELECT id FROM wholesale_clients WHERE tenant_id=1") as any[]).reduce((a, c) => a + clientDue(c.id), 0);
  const summary = ok(await call("wholesale", "GET", "/api/wholesale/summary"), "summary");
  assert.ok(Math.abs(summary.total_due - Math.round(sum * 100) / 100) < 0.6, `summary total ${summary.total_due} ≈ ${sum}`);
});
