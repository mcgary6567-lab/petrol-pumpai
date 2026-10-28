/** Security fixes from the full-system review: board XSS, staff screen privilege, feed scopes, register CSV, review link, upload before login. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-secfix-"));
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
  for (const who of ["admin", "manager", "salesman", "cashier"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });


test("TV board: an offer with </script> cannot break out of the page script", async () => {
  ok(await call("manager", "PUT", "/api/board/settings", { offers: "</script><script>alert(1)</script>" }), "offers");
  const link = ok(await call("manager", "GET", "/api/board-link"), "link").url as string;
  const html = await (await fetch(base + new URL(link).pathname)).text();
  assert.ok(!html.includes("</script><script>alert(1)"), "raw script tag never reaches the page");
  assert.match(html, /\\u003c\/script>/);
});

test("a manager cannot turn off or edit the owner from the staff screen", async () => {
  const me = ok(await call("admin", "GET", "/api/me"), "me");
  const id = me.user?.id ?? me.id;
  assert.equal((await call("manager", "PATCH", `/api/staff/${id}`, { active: false })).status, 403);
  assert.equal((await call("manager", "PATCH", `/api/staff/${id}`, { name: "Hacked" })).status, 403);
  assert.equal((await call("admin", "PATCH", `/api/staff/${id}`, { active: false })).status, 400, "owner not turned off here");
});

test("day feed: cashier can't open supplier / wholesale feeds; ranges capped", async () => {
  assert.equal((await call("cashier", "GET", "/api/day-feed?scope=supplier")).status, 403);
  assert.equal((await call("cashier", "GET", "/api/day-feed?scope=wholesale")).status, 403);
  assert.equal((await call("cashier", "GET", "/api/day-feed?scope=cashier")).status, 200);
  assert.equal((await call("admin", "GET", "/api/day-feed?from=2000-01-01&to=2026-01-01")).status, 400);
});

test("stock register CSV needs stock rights; a huge range is refused before any work", async () => {
  assert.equal((await call("cashier", "GET", "/api/register.csv")).status, 403);
  assert.equal((await call("admin", "GET", "/api/register?from=0001-01-01&to=2026-01-01")).status, 400);
});

test("receipt review link must be https", async () => {
  assert.equal((await call("admin", "PUT", "/api/settings", { google_review_url: "javascript:alert(1)" })).status, 400);
  ok(await call("admin", "PUT", "/api/settings", { google_review_url: "https://g.page/r/abc" }), "https ok");
});

test("platform backup upload is refused before the body is read (no login)", async () => {
  const r = await fetch(base + "/api/platform/catalog/from-backup", { method: "POST", body: "x".repeat(1000) });
  assert.ok(r.status === 401 || r.status === 404, String(r.status));
});

test("encrypted backup: password goes in a POST for a one-time ticket — never in the download link", async () => {
  ok(await call("admin", "POST", "/api/backups", {}), "make a backup");
  const name = ok(await call("admin", "GET", "/api/backups"), "list").backups[0].name;
  assert.equal((await call("admin", "POST", `/api/backups/${name}/enc-ticket`, { pass: "short" })).status, 400);
  const { ticket } = ok(await call("admin", "POST", `/api/backups/${name}/enc-ticket`, { pass: "very-secret-pass" }), "ticket");
  const dl = await fetch(`${base}/api/backups/${name}/enc?ticket=${ticket}`, { headers: { authorization: `Bearer ${tokens.admin}` } });
  assert.equal(dl.status, 200); assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 8).toString("latin1"), "Salted__");
  const again = await fetch(`${base}/api/backups/${name}/enc?ticket=${ticket}`, { headers: { authorization: `Bearer ${tokens.admin}` } });
  assert.equal(again.status, 400, "ticket works once");
  const old = await fetch(`${base}/api/backups/${name}/enc?pass=very-secret-pass`, { headers: { authorization: `Bearer ${tokens.admin}` } });
  assert.equal(old.status, 400, "password in the URL no longer accepted");
});
