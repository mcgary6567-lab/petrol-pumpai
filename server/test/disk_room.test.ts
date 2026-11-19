/** Wholesale entries are findable and reversible: IDs for every entry, own-tank unload vouchers, clear full-tank refusal, cascade reversal. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-disk-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.BACKUP_DIR = path.join(dir, "backups");
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

test("a full disk: the oldest local backups make room (the newest two always stay), a backup never fills the disk, health shows free space", async () => {
  const sys = await import("../src/routes/system.js");
  const bdir = process.env.BACKUP_DIR!;
  fs.mkdirSync(bdir, { recursive: true });
  const names = [1, 2, 3, 4, 5, 6].map((d) => `pumpai-2026-11-0${d}T02-00-00.db`);
  for (const n of names) fs.writeFileSync(path.join(bdir, n), "x".repeat(1000));
  const real = fs.statfsSync;
  try {
    // a nearly full disk (10 MB free) that never frees up: everything but the newest two goes
    (fs as any).statfsSync = () => ({ bavail: 10, bsize: 1024 * 1024 });
    const r = sys.makeRoom();
    assert.deepEqual(r.removed, names.slice(0, 4), "oldest first");
    assert.deepEqual(fs.readdirSync(bdir).sort(), names.slice(4), "the newest two stay");
    assert.throws(() => sys.makeBackup(), /Disk almost full/);
    assert.equal(fs.readdirSync(bdir).length, 2, "no half backup written");
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.equal(h.disk_free_mb, 10); assert.equal(h.disk_low, true);
    // plenty of room: nothing is removed and a backup is made
    (fs as any).statfsSync = () => ({ bavail: 100_000, bsize: 1024 * 1024 });
    assert.deepEqual(sys.makeRoom().removed, []);
    const b = sys.makeBackup(); assert.ok(b.bytes > 0);
    assert.equal(fs.readdirSync(bdir).length, 3);
  } finally { (fs as any).statfsSync = real; }
  const h2 = await (await fetch(`${base}/api/health`)).json();
  assert.equal(typeof h2.disk_free_mb, "number"); assert.equal(h2.disk_low, false);
});
