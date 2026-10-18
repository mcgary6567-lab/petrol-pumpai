/** Test pump: a fresh pump with every role and one entry of every kind — every hand-worked figure must match what the system shows. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-testpump-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.NODE_ENV = "test";
process.env.SAAS_MODE = "1";
process.env.PUBLIC_URL = "http://localhost:9999";
process.env.PLATFORM_ADMIN_EMAIL = "owner@petrolpumpai.pk";
process.env.PLATFORM_ADMIN_PASSWORD = "platform-pass-123";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server; let base = "";
before(async () => {
  const { app } = await import("../src/index.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("every step of the test pump matches its hand calculation (direct)", async () => {
  const { runTestPump } = await import("../src/testPump.js");
  const r = await runTestPump(base, { tag: "unit" });
  const bad = r.steps.filter((s) => !s.ok).map((s) => `#${s.n} ${s.title}: expected ${s.expect} | got ${s.actual}`);
  assert.deepEqual(bad, []);
  assert.equal(r.steps.length, 18);
  assert.equal(r.logins.length, 5);
  assert.equal(r.pump.slug, "test-pump-unit");
  assert.deepEqual(r.totals, { office_cash: 194100, banks: 550000, money_total: 744100, receivable: 803000, payable: 1349000, gross_profit: 40350, net_profit: 61850, fuel_stock_value: 4970000 });
});

test("platform button: POST /platform/test-pump needs the platform login and returns the report", async () => {
  const anon = await fetch(base + "/api/platform/test-pump", { method: "POST" });
  assert.equal(anon.status, 401);
  const login = await fetch(base + "/api/platform/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@petrolpumpai.pk", password: "platform-pass-123" }) });
  const token = (await login.json() as any).token;
  const res = await fetch(base + "/api/platform/test-pump", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const r = await res.json() as any;
  assert.equal(r.summary.failed, 0);
  assert.ok(r.pump.url?.startsWith("http://localhost:9999/p/test-pump-"));
});
