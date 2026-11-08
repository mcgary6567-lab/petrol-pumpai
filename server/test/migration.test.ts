/** Moving the install to a new server: the old server exports one encrypted file (database + login secret); the new one
 *  takes it in parts behind the setup code, decrypts it with the password and stages it for the next start. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-migr-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";
process.env.SETUP_TOKEN = "AB12CD34";

let server: Server; let base = ""; let token = ""; let cfg: typeof import("../src/config.js");
before(async () => {
  const { app } = await import("../src/index.js");
  cfg = await import("../src/config.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  token = (await (await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@pumpai.pk", password: "demo1234" }) })).json() as any).token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function upload(file: Buffer, code: string, part = 3 * 1024 * 1024) {
  const id = "a1b2c3d4e5f6a7b8c9d0";
  for (let i = 0; i * part < file.length; i++) {
    const r = await fetch(`${base}/api/migration/upload?id=${id}&part=${i}`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-setup-code": code }, body: file.subarray(i * part, (i + 1) * part) });
    if (!r.ok) return { status: r.status, data: await r.json() as any, id };
  }
  return { status: 200, data: null, id };
}

test("export → upload in parts → finish: wrong code 403, wrong password 400 (nothing staged), right password stages the database + login secret", async () => {
  assert.equal((await fetch(`${base}/api/migration/export`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ password: "short" }) })).status, 400, "password too short");
  const ex = await fetch(`${base}/api/migration/export`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ password: "pump-move-2026!" }) });
  assert.equal(ex.status, 200);
  const file = Buffer.from(await ex.arrayBuffer());
  assert.equal(file.subarray(0, 8).toString(), "PUMPAIMG");
  assert.equal(String(file.length), ex.headers.get("content-length"));
  assert.ok(file.length > 1024 * 1024, "the whole demo database is inside");

  // wrong setup code
  const bad = await upload(file, "WRONG000");
  assert.equal(bad.status, 403);
  // right code, wrong password → refused at finish, nothing staged
  const up = await upload(file, "ab12cd34");
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const wrong = await fetch(`${base}/api/migration/finish`, { method: "POST", headers: { "content-type": "application/json", "x-setup-code": "AB12CD34" }, body: JSON.stringify({ id: up.id, size: file.length, password: "not-the-password" }) });
  assert.equal(wrong.status, 400);
  assert.equal(fs.existsSync(`${cfg.config.dbPath}.restore`), false, "nothing staged on a wrong password");
  // right password
  const ok = await fetch(`${base}/api/migration/finish`, { method: "POST", headers: { "content-type": "application/json", "x-setup-code": "AB12CD34" }, body: JSON.stringify({ id: up.id, size: file.length, password: "pump-move-2026!" }) });
  const okd = await ok.json() as any;
  assert.equal(ok.status, 200, JSON.stringify(okd));
  assert.equal(okd.restarting, true);
  const staged = `${cfg.config.dbPath}.restore`;
  assert.ok(fs.existsSync(staged), "database staged for the next start");
  assert.equal(fs.readFileSync(staged).subarray(0, 15).toString(), "SQLite format 3");
  const { DatabaseSync } = await import("node:sqlite");
  const copy = new DatabaseSync(staged, { readOnly: true });
  assert.ok(Number((copy.prepare("SELECT COUNT(*) n FROM tenants").get() as any).n) > 0, "real data inside");
  copy.close();
  assert.equal(fs.readFileSync(path.join(dir, ".jwt_secret_imported"), "utf8").trim(), cfg.config.jwtSecret, "login secret carried over");
  // a damaged / truncated upload is refused
  const half = file.subarray(0, Math.floor(file.length / 2));
  const up2 = await upload(half, "AB12CD34");
  const trunc = await fetch(`${base}/api/migration/finish`, { method: "POST", headers: { "content-type": "application/json", "x-setup-code": "AB12CD34" }, body: JSON.stringify({ id: up2.id, size: file.length, password: "pump-move-2026!" }) });
  assert.equal(trunc.status, 400);
});
