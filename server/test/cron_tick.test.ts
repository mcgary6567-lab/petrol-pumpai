/** Shared hosting (Hostinger business): the hosting cron opens /api/cron/tick to wake the app and run the jobs that fell
 *  due while it slept. Checks the cron matcher (Asia/Karachi), the catch-up window and the endpoint's key guard. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-cron-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";
process.env.CRON_KEY = "test-cron-key-0123456789abcdef";

let server: Server; let base = ""; let sch: typeof import("../src/automation/scheduler.js"); let db: typeof import("../src/db.js");
before(async () => {
  const { app } = await import("../src/index.js");
  sch = await import("../src/automation/scheduler.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const pk = (s: string) => Date.parse(`${s}:00+05:00`);

test("cron matcher works in Pakistan time: daily, every-15, weekday, first of month, lists and ranges", () => {
  assert.equal(sch.cronMatches("0 2 * * *", pk("2026-11-08T02:00"), "Asia/Karachi"), true);
  assert.equal(sch.cronMatches("0 2 * * *", pk("2026-11-08T03:00"), "Asia/Karachi"), false);
  assert.equal(sch.cronMatches("*/15 * * * *", pk("2026-11-08T10:45"), "Asia/Karachi"), true);
  assert.equal(sch.cronMatches("*/15 * * * *", pk("2026-11-08T10:46"), "Asia/Karachi"), false);
  assert.equal(sch.cronMatches("0 9 * * 1", pk("2026-11-09T09:00"), "Asia/Karachi"), true, "9 Nov 2026 is a Monday");
  assert.equal(sch.cronMatches("0 9 * * 1", pk("2026-11-10T09:00"), "Asia/Karachi"), false);
  assert.equal(sch.cronMatches("0 8 1 * *", pk("2026-12-01T08:00"), "Asia/Karachi"), true);
  assert.equal(sch.cronMatches("0 12,20 * * *", pk("2026-11-08T20:00"), "Asia/Karachi"), true);
  assert.equal(sch.cronMatches("30 8-10 * * *", pk("2026-11-08T09:30"), "Asia/Karachi"), true);
  // last scheduled minute inside the catch-up window, none outside it
  assert.equal(sch.lastFire("0 2 * * *", pk("2026-11-08T03:10"), 120, "Asia/Karachi"), pk("2026-11-08T02:00"));
  assert.equal(sch.lastFire("0 11 * * *", pk("2026-11-08T23:00"), 120, "Asia/Karachi"), null, "an 11:00 reminder is not sent at 23:00");
});

test("tick endpoint: wrong key 403, right key runs due jobs once, a second tick runs nothing", async () => {
  assert.equal((await fetch(`${base}/api/cron/tick?key=wrong-key-wrong-key-wrong`)).status, 403);
  assert.equal((await fetch(`${base}/api/cron/tick`)).status, 403);
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  // a job that runs every 15 minutes is due now if it has never run
  db.run("UPDATE automations SET enabled=1, last_run_at=NULL WHERE tenant_id=? AND key IN (SELECT key FROM automations WHERE cron LIKE '*/15%')", t);
  const r1 = await (await fetch(`${base}/api/cron/tick?key=${process.env.CRON_KEY}`)).json() as any;
  assert.equal(r1.ok, true);
  assert.ok(r1.started.length > 0, "due jobs started");
  // the jobs run in the background: wait until they have stamped last_run_at
  for (let i = 0; i < 100; i++) {
    const left = db.get("SELECT COUNT(*) n FROM automations WHERE tenant_id=? AND enabled=1 AND cron LIKE '*/15%' AND last_run_at IS NULL", t)!.n;
    if (!left) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r2 = await (await fetch(`${base}/api/cron/tick?key=${process.env.CRON_KEY}`)).json() as any;
  assert.deepEqual(r2.started.filter((s: any) => s.tenant_id === t && /\*\/15/.test(String(db.get("SELECT cron FROM automations WHERE tenant_id=? AND key=?", t, s.key)?.cron))), [], "nothing runs twice");
});
