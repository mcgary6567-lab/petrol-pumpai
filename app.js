/**
 * Petrol PumpAI — entry file for Hostinger web / business hosting (hPanel → Node.js app → Entry file: app.js).
 *
 * CommonJS on purpose: the host may load the entry with require() (LiteSpeed / Passenger) or run it with node — both work.
 * The server itself is an ES module and is loaded with import() below.
 *
 * Before starting it checks what would lose data or fail quietly on shared hosting:
 *  1. Node 22.13 or newer (the database uses node:sqlite);
 *  2. DB_PATH set to an absolute path OUTSIDE the app folder (a redeploy may replace the app folder);
 *  3. CRON_KEY set, so the hosting cron job can wake the app for the nightly backup / reminders (see HOSTINGER.md).
 * Every start and any start-up error is also written to pumpai-startup.log one level above the app folder (not web-served),
 * so the reason is visible in File Manager even when the host's runtime log is empty.
 */
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

// the ready-built "hostinger" branch has server/dist next to this file; on main it lives in deploy/hostinger
const here = fs.existsSync(path.join(__dirname, "server", "dist", "index.js")) ? __dirname : path.resolve(__dirname, "..", "..");
const logFile = path.resolve(here, "..", "pumpai-startup.log");
const note = (msg) => {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { fs.appendFileSync(logFile, line); } catch { /* read-only: console only */ }
  console.log(`[PumpAI] ${msg}`);
};
const stop = (msg) => { note(`STOP: ${msg}`); console.error(`\n[PumpAI] ${msg}\n`); process.exit(1); };
process.on("uncaughtException", (e) => { note(`CRASH: ${e && e.stack ? e.stack : e}`); process.exit(1); });
process.on("unhandledRejection", (e) => { note(`CRASH (promise): ${e && e.stack ? e.stack : e}`); });

// hPanel lists every setting the code reads; a row left empty counts as "not set"
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string" && v.trim() === "") delete process.env[k];

note(`start · node ${process.versions.node} · app ${here} · PORT=${process.env.PORT ?? "(none)"}`);
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 13)) stop(`Node ${process.versions.node} chal raha hai — Node 22.13 ya naya chahiye. hPanel → Node version 22 chunein.`);

process.env.NODE_ENV = process.env.NODE_ENV || "production";
const db = process.env.DB_PATH || "";
if (!db) stop("DB_PATH set nahi — Environment variables me DB_PATH=/home/<user>/pumpai-data/pumpai.db likhein (app folder se BAHAR).");
if (!path.isAbsolute(db)) stop(`DB_PATH poora rasta hona chahiye (/home/... se shuru): ${db}`);
const rel = path.relative(here, path.resolve(db));
if (!rel.startsWith("..") && !path.isAbsolute(rel)) stop(`DB_PATH app folder ke ANDAR hai (${db}). Redeploy is folder ko badal sakta hai — app folder se bahar ka rasta dein.`);
try { fs.mkdirSync(path.dirname(db), { recursive: true }); fs.accessSync(path.dirname(db), fs.constants.W_OK); }
catch (e) { stop(`Data folder ${path.dirname(db)} nahi ban saka / likh nahi sakte (${e.code || e.message}). Doosra rasta dein, misal /home/<user>/domains/<site>/pumpai-data`); }
process.env.BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(db), "backups");
process.env.WEB_DIST = process.env.WEB_DIST || path.join(here, "web", "dist");
if (!process.env.CRON_KEY || process.env.CRON_KEY.length < 16) note("CRON_KEY set nahi — raat ka backup aur reminders tabhi chalenge jab koi app khola hua ho. HOSTINGER.md dekhein.");

const entry = path.join(here, "server", "dist", "index.js");
if (!fs.existsSync(entry)) stop(`${entry} nahi mila — build nahi hua. Build command "npm run build" rakhein.`);
import(pathToFileURL(entry).href).then(() => {
  note("server loaded");
  // the setup code guards the first-run wizard and the /migrate upload; the owner reads it here (this log is not web-served)
  try { const code = fs.readFileSync(path.join(path.dirname(db), ".setup_code"), "utf8").trim(); if (code) note(`SETUP CODE: ${code}  (setup wizard / migrate page)`); } catch { /* SETUP_TOKEN set instead */ }
}).catch((e) => { note(`CRASH (load): ${e && e.stack ? e.stack : e}`); process.exit(1); });
