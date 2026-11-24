/** Wholesale entries are findable and reversible: IDs for every entry, own-tank unload vouchers, clear full-tank refusal, cascade reversal. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-desk4-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server; let base = ""; let db: typeof import("../src/db.js");
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`); return r.data; };
const near = (a: number, b: number, m?: string) => assert.ok(Math.abs(a - b) < 0.05, `${m ?? ""} ${a} ≈ ${b}`);
const round2 = (n: number) => Math.round(n * 100) / 100;
const books = async () => { const b = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.equal(b.ok, true, JSON.stringify(b.checks.filter((c: any) => !c.ok))); };
const cashNow = async () => ok(await call("admin", "GET", "/api/cash"), "cash").cash_in_hand as number;
const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000 + 5 * 3600_000).toISOString().slice(0, 10);

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "salesman", "wholesale"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("dashboard: a salesman on an open shift counts as on duty (no duty time / attendance needed); the overdue-shift alert names its start and stays current", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  // no duty times set and no attendance today (as at a pump that never set up the staff page)
  db.run("UPDATE users SET duty_start=NULL WHERE tenant_id=?", t);
  db.run("DELETE FROM attendance");
  for (const s of db.all("SELECT id FROM shifts WHERE status='open'")) db.run("UPDATE shifts SET status='closed', closed_at=? WHERE id=?", new Date().toISOString(), s.id);
  let d = ok(await call("admin", "GET", "/api/dashboard/desk"), "desk");
  assert.equal(d.staff_summary.on_duty, 0); assert.equal(d.staff_summary.total, 0);
  const st = db.get("SELECT id FROM stations WHERE tenant_id=? ORDER BY id LIMIT 1", t)!.id;
  const sh = ok(await call("admin", "POST", "/api/shifts/open", { station_id: st, attendant: "Sajjad" }), "open");
  d = ok(await call("admin", "GET", "/api/dashboard/desk"), "desk");
  assert.equal(d.staff_summary.on_duty, 1, "the man on the open shift is on duty"); assert.equal(d.staff_summary.total, 1); assert.equal(d.staff_summary.on_shift, 1);
  // 25.5 h open (past the 24 h shift): the overdue job writes an alert with the hours and the start time, and keeps it current
  db.run("UPDATE shifts SET opened_at=? WHERE id=?", new Date(Date.now() - 25.5 * 3600_000).toISOString(), sh.id);
  const { JOBS } = await import("../src/automation/jobs.js") as any;
  const job = (JOBS ?? []).find((j: any) => j.key === "shift_watch") ?? (await import("../src/automation/jobs.js") as any).jobs?.find((j: any) => j.key === "shift_watch");
  if (job) {
    await job.run(t);
    const a = db.get("SELECT * FROM alerts WHERE dedupe_key=?", `shift-overdue-${sh.id}`)!;
    assert.match(a.title, /Shift still open: Sajjad \(25 h, since \d\d-[A-Z][a-z]{2} \d{1,2}:\d\d (am|pm)\)/);
    db.run("UPDATE shifts SET opened_at=? WHERE id=?", new Date(Date.now() - 30.2 * 3600_000).toISOString(), sh.id);
    await job.run(t);
    assert.match(db.get("SELECT title FROM alerts WHERE id=?", a.id)!.title, /\(30 h,/, "the same alert now says 30 h");
    assert.equal(db.get("SELECT COUNT(*) n FROM alerts WHERE dedupe_key=?", `shift-overdue-${sh.id}`)!.n, 1, "still one alert");
  } else assert.fail("shift_overdue job not found");
});
