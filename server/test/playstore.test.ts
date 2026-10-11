/** Play Store (TWA) wiring: Digital Asset Links at /.well-known/assetlinks.json, plus the public privacy & terms pages. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-play-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.DEMO_DATA = "0";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";
// the Android app's identity — the route echoes these into assetlinks.json
process.env.ANDROID_PACKAGE = "site.petrolpumpai.twa";
process.env.ANDROID_CERT_FINGERPRINTS = "AA:BB:CC:DD:EE:FF:00:11:22:33, aa:bb:cc:dd:ee:ff:00:11:22:34";

let server: Server, base = "";
before(async () => {
  const { app } = await import("../src/index.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("assetlinks.json names the app package and fingerprints (upper-cased, trimmed)", async () => {
  const res = await fetch(base + "/.well-known/assetlinks.json");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const links = await res.json();
  assert.equal(Array.isArray(links), true);
  assert.equal(links.length, 1);
  const t = links[0].target;
  assert.equal(links[0].relation[0], "delegate_permission/common.handle_all_urls");
  assert.equal(t.namespace, "android_app");
  assert.equal(t.package_name, "site.petrolpumpai.twa");
  assert.deepEqual(t.sha256_cert_fingerprints, ["AA:BB:CC:DD:EE:FF:00:11:22:33", "AA:BB:CC:DD:EE:FF:00:11:22:34"]);
});

test("privacy and terms pages are public (no login) and link to each other", async () => {
  const p = await fetch(base + "/privacy");
  assert.equal(p.status, 200);
  const pb = await p.text();
  assert.match(pb, /Privacy notice/);
  assert.match(pb, /\/terms/);

  const t = await fetch(base + "/terms");
  assert.equal(t.status, 200);
  const tb = await t.text();
  assert.match(tb, /Terms of use/);
  assert.match(tb, /\/privacy/);
});
