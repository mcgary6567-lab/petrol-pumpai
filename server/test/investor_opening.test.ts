/** Old pump, investors already on board: opening balance (capital + unpaid profit, no cash move) and the
 *  "Investors" module switch — off by default for a new pump, on for the demo, CEO flips it from Go-live. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-invopen-"));
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
const near = (a: number, b: number, m?: string) => assert.ok(Math.abs(a - b) < 0.05, `${m ?? ""} ${a} ≈ ${b}`);
const books = async () => { const b = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.equal(b.ok, true, JSON.stringify(b.checks.filter((c: any) => !c.ok))); };
const cashNow = async () => ok(await call("admin", "GET", "/api/cash"), "cash").cash_in_hand as number;

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js"); auth = await import("../src/auth.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let inv: any;
test("opening balance: capital + unpaid profit credited as of a past day, no cash moves, books tally", async () => {
  inv = ok(await call("admin", "POST", "/api/investors", { name: "Purana Investor", our_pct: 60 }), "add");
  const cash0 = await cashNow();
  assert.equal((await call("admin", "POST", `/api/investors/${inv.id}/opening`, { as_of: "2025-01-01", capital: 0, profit_due: 0 })).status, 400, "zero refused");
  assert.equal((await call("admin", "POST", `/api/investors/${inv.id}/opening`, { as_of: "2099-01-01", capital: 1 })).status, 400, "future date refused");
  assert.equal((await call("manager", "POST", `/api/investors/${inv.id}/opening`, { as_of: "2025-01-01", capital: 1 })).status, 403, "CEO only");
  const r = ok(await call("admin", "POST", `/api/investors/${inv.id}/opening`, { as_of: "2025-01-01", capital: 500_000, profit_due: 20_000, note: "purana register" }), "opening");
  near(r.balance, 520_000);
  assert.equal(r.ids.length, 2);
  near(await cashNow(), cash0, "cash untouched");
  const st = ok(await call("admin", "GET", `/api/investors/${inv.id}?from=2025-01-01&to=2025-01-31`), "statement");
  near(st.investor.balance, 520_000); near(st.investor.capital_in, 500_000); near(st.investor.free, 520_000);
  assert.equal(st.lines.filter((l: any) => l.method === "Opening").length, 2, "two opening lines dated as-of");
  assert.ok(st.lines.every((l: any) => l.created_at.startsWith("2025-01-01")), "dated the as-of day");
  assert.equal((await call("admin", "POST", `/api/investors/${inv.id}/opening`, { as_of: "2025-01-01", capital: 1 })).status, 400, "only once");
  await books();
  // it shows in the books as go-live opening equity vs Investors payable
  const ov = ok(await call("admin", "GET", "/api/owner/overview"), "overview");
  assert.ok(ov.we_owe.investors >= 520_000 - 0.05, `we owe includes opening: ${ov.we_owe.investors}`);
});

test("after opening: a back-dated deal uses the capital, a payout clears the old profit; void the opening profit row works", async () => {
  const d = ok(await call("admin", "POST", `/api/investors/${inv.id}/deals`, { product: "HSD", litres: 1000, cost_rate: 250, deal_date: "2025-01-05" }), "back-dated deal");
  assert.equal(d.deal_date, "2025-01-05");
  const p = ok(await call("admin", "POST", `/api/investors/${inv.id}/money`, { dir: "out", amount: 20_000, method: "Cash", purpose: "profit" }), "pay old profit");
  near(p.balance, 500_000);
  await books();
  const st = ok(await call("admin", "GET", `/api/investors/${inv.id}`), "st");
  const op = st.lines.find((l: any) => l.method === "Opening" && l.type === "profit");
  ok(await call("admin", "POST", `/api/investor-txns/${op.id}/void`, { reason: "ghalat raqam" }), "void opening profit");
  near(ok(await call("admin", "GET", `/api/investors/${inv.id}`), "st2").investor.balance, 480_000);
  await books();
});

test("module switch: off → investors API 403 and /me says so; Go-live toggle turns it on; new tenants default off", async () => {
  db.setSetting(1, "module_investors", "0"); auth.forgetModules(1);
  assert.equal((await call("admin", "GET", "/api/investors")).status, 403, "investors 403 when off");
  const me = ok(await call("admin", "GET", "/api/me"), "me");
  assert.equal(me.modules.investors, false); assert.ok(!me.permissions.includes("investors.manage"));
  const gl = ok(await call("admin", "GET", "/api/golive"), "golive");
  const item = gl.items.find((x: any) => x.key === "investors");
  assert.ok(item && item.on === false, "checklist row shows OFF");
  ok(await call("admin", "POST", "/api/golive/investors", { on: true }), "toggle on");
  assert.equal(ok(await call("admin", "GET", "/api/me"), "me2").modules.investors, true);
  ok(await call("admin", "GET", "/api/investors"), "investors back");
  await books();
});
