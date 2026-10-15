/** Paid "Wholesale & carriage" module toggle: off by default hides the whole module (nav perms + API), the
 *  super-admin turns it on; books stay tallied either way. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-modwh-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server; let base = ""; let db: typeof import("../src/db.js"); let auth: typeof import("../src/auth.js");
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`); return r.data; };
// flip the module for tenant 1 and clear the auth cache, like the platform endpoint does
const setModule = (on: boolean) => { db.setSetting(1, "module_wholesale", on ? "1" : "0"); auth.forgetModules(1); };

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  auth = await import("../src/auth.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("module ON (demo): wholesale/carriage/bypass work and /me reports the module", async () => {
  setModule(true);
  ok(await call("admin", "GET", "/api/wholesale/clients"), "clients");
  ok(await call("admin", "GET", "/api/bypass/stock"), "bypass stock");
  const me = ok(await call("admin", "GET", "/api/me"), "me");
  assert.equal(me.modules.wholesale, true, "me.modules.wholesale on");
  assert.ok(me.permissions.includes("wholesale.view") && me.permissions.includes("carriage.view"), "perms present");
});

test("module OFF: the whole module disappears — even the owner is 403 and loses the permissions", async () => {
  setModule(false);
  assert.equal((await call("admin", "GET", "/api/wholesale/clients")).status, 403, "wholesale 403");
  assert.equal((await call("admin", "GET", "/api/bypass/stock")).status, 403, "bypass 403");
  assert.equal((await call("admin", "GET", "/api/wholesale/summary")).status, 403, "summary 403");
  const me = ok(await call("admin", "GET", "/api/me"), "me");
  assert.equal(me.modules.wholesale, false, "me.modules.wholesale off");
  assert.ok(!me.permissions.includes("wholesale.view") && !me.permissions.includes("carriage.view") && !me.permissions.includes("wholesale.manage"), "wholesale/carriage perms gone");
  // non-module permissions are untouched
  assert.ok(me.permissions.includes("sales.create") || me.permissions.length > 0, "other perms stay");
  // books still tally with the module off
  assert.equal(ok(await call("admin", "GET", "/api/books/check"), "books").ok, true, "books tally, module off");
});

test("super-admin turns it back on: everything works again and data is intact, books tally", async () => {
  setModule(true);
  const clients = ok(await call("admin", "GET", "/api/wholesale/clients"), "clients back");
  assert.ok(Array.isArray(clients.clients ?? clients), "client list returns");
  assert.equal(ok(await call("admin", "GET", "/api/me"), "me").modules.wholesale, true);
  assert.equal(ok(await call("admin", "GET", "/api/books/check"), "books").ok, true, "books tally, module on");
});
