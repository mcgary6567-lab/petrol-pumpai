/** SaaS mode: public sign-up (trial) → gate locks an expired/suspended pump → platform owner + activation code unlock it; pumps are isolated. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-saas-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.DEMO_DATA = "0";            // empty db — SaaS signups, no demo pump
process.env.SAAS_MODE = "1";
process.env.TRIAL_DAYS = "7";
process.env.PLATFORM_ADMIN_EMAIL = "owner@petrolpumpai.pk";
process.env.PLATFORM_ADMIN_PASSWORD = "platform-pass-123";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server, base = "";
async function call(tok: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`); return r.data; };

const signupBody = (name: string, email: string) => ({
  business: { name, owner_name: "Owner " + name, owner_phone: "03001234567" },
  admin: { name: "Owner " + name, email, password: "owner12345" },
  stations: [{ name: name + " Station", tanks: [{ name: "T1", product: "PMG", capacity_l: 20000, current_l: 10000, nozzles: 2 }] }],
  prices: { PMG: 280 },
});

before(async () => {
  const { app } = await import("../src/index.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("anyone can sign up and gets a working pump on a trial", async () => {
  const st = ok(await call("", "GET", "/api/setup/status"), "status");
  assert.equal(st.saas, true, "server is in SaaS mode");

  const a = ok(await call("", "POST", "/api/signup", signupBody("Al-Madina", "a@al-madina.pk")), "signup A");
  assert.ok(a.token && a.user.role === "admin", "got an admin token");
  const acc = ok(await call(a.token, "GET", "/api/account/status"), "account");
  assert.equal(acc.status, "trial");
  assert.ok(acc.days_left >= 6 && acc.days_left <= 7, "about 7 trial days left");

  // the pump works on trial (can read its own dashboard-ish data)
  ok(await call(a.token, "GET", "/api/stations"), "stations work on trial");

  // duplicate email is refused
  assert.equal((await call("", "POST", "/api/signup", signupBody("Dup", "a@al-madina.pk"))).status, 400);
});

test("two pumps are fully isolated", async () => {
  const b = ok(await call("", "POST", "/api/signup", signupBody("Khan Fuels", "b@khan.pk")), "signup B");
  const aTok = (await call("", "POST", "/api/auth/login", { email: "a@al-madina.pk", password: "owner12345" })).data.token;
  const aStations = ok(await call(aTok, "GET", "/api/stations"), "A stations");
  const bStations = ok(await call(b.token, "GET", "/api/stations"), "B stations");
  assert.equal(aStations[0].name, "Al-Madina Station");
  assert.equal(bStations[0].name, "Khan Fuels Station");
  assert.notEqual(aStations[0].id, bStations[0].id);
});

test("the platform owner can see all pumps, suspend/activate, and issue codes", async () => {
  const p = ok(await call("", "POST", "/api/platform/login", { email: "owner@petrolpumpai.pk", password: "platform-pass-123" }), "platform login").token;
  assert.equal((await call("", "POST", "/api/platform/login", { email: "owner@petrolpumpai.pk", password: "wrong" })).status, 401);

  const list = ok(await call(p, "GET", "/api/platform/tenants"), "tenant list");
  assert.ok(list.tenants.length >= 2, "both pumps are listed");
  const al = list.tenants.find((t: any) => t.name === "Al-Madina");

  // suspend Al-Madina → its owner is locked out of the app but can still reach its account
  ok(await call(p, "POST", `/api/platform/tenants/${al.id}/suspend`, {}), "suspend");
  const aTok = (await call("", "POST", "/api/auth/login", { email: "a@al-madina.pk", password: "owner12345" })).data.token;
  assert.equal((await call(aTok, "GET", "/api/stations")).status, 402, "suspended pump is gated");
  ok(await call(aTok, "GET", "/api/account/status"), "but can still read account");

  // platform activates it again → works
  ok(await call(p, "POST", `/api/platform/tenants/${al.id}/activate`, {}), "activate");
  ok(await call(aTok, "GET", "/api/stations"), "active again");
});

test("a pump owner activates with a one-time code (after cash)", async () => {
  const p = (await call("", "POST", "/api/platform/login", { email: "owner@petrolpumpai.pk", password: "platform-pass-123" })).data.token;
  const made = ok(await call(p, "POST", "/api/platform/codes", { count: 1, plan: "lifetime" }), "make code").codes;
  const code = made[0];
  assert.ok(code.startsWith("PPAI-"), "got an activation code");

  // put Khan Fuels on an expired trial → locked
  const list = ok(await call(p, "GET", "/api/platform/tenants"), "list").tenants;
  const khan = list.find((t: any) => t.name === "Khan Fuels");
  ok(await call(p, "POST", `/api/platform/tenants/${khan.id}/suspend`, {}), "suspend khan");
  const bTok = (await call("", "POST", "/api/auth/login", { email: "b@khan.pk", password: "owner12345" })).data.token;
  assert.equal((await call(bTok, "GET", "/api/stations")).status, 402, "locked");

  // owner enters the code → unlocked forever
  ok(await call(bTok, "POST", "/api/account/activate", { code }), "activate by code");
  assert.equal(ok(await call(bTok, "GET", "/api/account/status"), "acc").status, "active");
  ok(await call(bTok, "GET", "/api/stations"), "works after activation");

  // the same code can't be used twice
  assert.equal((await call(bTok, "POST", "/api/account/activate", { code })).status, 400);
});

test("public sales page is served (no login) in SaaS mode", async () => {
  const res = await fetch(base + "/sell");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /html/);
  const html = await res.text();
  assert.match(html, /Petrol PumpAI/);
  assert.match(html, /Chori khatam/);                    // key selling point present
  assert.match(html, /\/signup/);                         // CTA points at sign-up
  assert.doesNotMatch(html, /SIGNUP_URL|WHATSAPP_URL/);   // placeholders were filled
});
