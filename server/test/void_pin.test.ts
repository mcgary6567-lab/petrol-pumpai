/** Cancelling (void / undo / delete) an entry needs the person's own 4-digit PIN when the CEO turns it on (default in production). */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-voidpin-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server;
let base = "";
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, msg: string) => { assert.equal(r.status, 200, `${msg}: ${JSON.stringify(r.data)}`); return r.data; };

before(async () => {
  const { app } = await import("../src/index.js");
  const db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
  db.run("UPDATE users SET pin_hash=NULL WHERE email IN ('manager@pumpai.pk','admin@pumpai.pk')"); // nobody has a PIN yet
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("void / delete asks for the person's PIN: none set → set one with the password; wrong → refused + counted; right → done", async () => {
  ok(await call("admin", "POST", "/api/expense-categories", { name: "Chai & biskut" }), "category");
  ok(await call("admin", "PUT", "/api/settings", { void_pin: true }), "turn on");
  assert.equal(ok(await call("admin", "GET", "/api/settings"), "settings").void_pin, true);
  const exp = ok(await call("manager", "POST", "/api/expenses", { category: "Chai & biskut", amount: 150 }), "expense");
  // no PIN set yet
  const noPin = await call("admin", "DELETE", `/api/expenses/${exp.id}`);
  assert.equal(noPin.status, 428); assert.equal(noPin.data.code, "pin_not_set");
  assert.equal((await call("admin", "POST", "/api/me/pin", { password: "wrong", pin: "4821" })).status, 400, "password checked");
  assert.equal((await call("admin", "POST", "/api/me/pin", { password: "demo1234", pin: "1111" })).status, 400, "easy PIN refused");
  ok(await call("admin", "POST", "/api/me/pin", { password: "demo1234", pin: "4821" }), "set own PIN");
  // asked, wrong, right
  const ask = await call("admin", "DELETE", `/api/expenses/${exp.id}`);
  assert.equal(ask.status, 428); assert.equal(ask.data.code, "pin_required");
  const wrong = await call("admin", "DELETE", `/api/expenses/${exp.id}`, undefined, { "x-action-pin": "0000" });
  assert.equal(wrong.status, 428); assert.equal(wrong.data.code, "pin_wrong"); assert.match(wrong.data.error, /4 koshishein/);
  ok(await call("admin", "DELETE", `/api/expenses/${exp.id}`, undefined, { "x-action-pin": "4821" }), "deleted with the right PIN");
  // ordinary writes are not affected
  ok(await call("manager", "POST", "/api/expenses", { category: "Chai & biskut", amount: 90 }), "normal write needs no PIN");
  // 5 wrong PINs lock it
  const exp2 = ok(await call("manager", "POST", "/api/expenses", { category: "Chai & biskut", amount: 80 }), "expense 2");
  for (let i = 0; i < 5; i++) await call("admin", "DELETE", `/api/expenses/${exp2.id}`, undefined, { "x-action-pin": "9999" });
  assert.equal((await call("admin", "DELETE", `/api/expenses/${exp2.id}`, undefined, { "x-action-pin": "4821" })).status, 429, "locked after 5 wrong");
  // the CEO can switch it off
  ok(await call("admin", "PUT", "/api/settings", { void_pin: false }), "turn off");
  ok(await call("admin", "DELETE", `/api/expenses/${exp2.id}`), "no PIN needed when off");
});

test("which requests count as a cancel (PIN needed)", async () => {
  const { isCancelRequest } = await import("../src/auth.js");
  for (const [m, p] of [["POST", "/wholesale/txns/5/void"], ["POST", "/sales/9/undo"], ["POST", "/shop/sales/9/undo"], ["DELETE", "/expenses/3"], ["DELETE", "/other-entries/7"], ["DELETE", "/shifts/4/expenses/2"]] as const)
    assert.equal(isCancelRequest(m, p), true, `${m} ${p}`);
  for (const [m, p] of [["POST", "/expenses"], ["GET", "/sales/9/undo"], ["DELETE", "/users/3"], ["POST", "/wholesale/txns"]] as const)
    assert.equal(isCancelRequest(m, p), false, `${m} ${p}`);
});
