/**
 * Petrol PumpAI — entry file for Hostinger web / business hosting (hPanel → Websites → Node.js app → Entry file: app.js).
 *
 * Checks the three things that would otherwise lose data or fail quietly on shared hosting, then starts the server:
 *  1. Node 22.13 or newer (the database uses node:sqlite);
 *  2. DB_PATH set to an absolute path OUTSIDE this app folder (a redeploy from GitHub may replace the app folder —
 *     the database, its backups and its secret files must live somewhere it never touches);
 *  3. CRON_KEY set, so the hosting cron job can wake the app and run the nightly backup / reminders (see HOSTINGER.md).
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = path.dirname(fileURLToPath(import.meta.url));
// the ready-built "hostinger" branch has server/dist next to this file; on main this file sits in deploy/hostinger
const here = fs.existsSync(path.join(self, "server", "dist", "index.js")) ? self : path.resolve(self, "..", "..");
// hPanel lists every setting the code reads; a row left empty must count as "not set" (an empty PORT or TZ_NAME would
// otherwise start the app on a random port or break the backup / reminder clock)
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string" && v.trim() === "") delete process.env[k];
const stop = (msg) => { console.error(`\n[PumpAI] ${msg}\n`); process.exit(1); };

const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 13)) stop(`Node ${process.versions.node} chal raha hai — Node 22.13 ya naya chahiye. hPanel → Node.js → version 22 chunein.`);

process.env.NODE_ENV ??= "production";
const db = process.env.DB_PATH ?? "";
if (!db) stop("DB_PATH set nahi — hPanel → Environment variables me DB_PATH=/home/<user>/pumpai-data/pumpai.db likhein (app folder se BAHAR).");
if (!path.isAbsolute(db)) stop(`DB_PATH poora rasta hona chahiye (/home/... se shuru): ${db}`);
const rel = path.relative(here, path.resolve(db));
if (!rel.startsWith("..") && !path.isAbsolute(rel)) stop(`DB_PATH app folder ke ANDAR hai (${db}). GitHub redeploy is folder ko badal sakta hai aur data mit sakta hai — app folder se bahar ka rasta dein.`);
fs.mkdirSync(path.dirname(db), { recursive: true });
process.env.BACKUP_DIR ??= path.join(path.dirname(db), "backups");
process.env.WEB_DIST ??= path.join(here, "web", "dist");
if (!process.env.CRON_KEY || process.env.CRON_KEY.length < 16) console.warn("[PumpAI] CRON_KEY set nahi — raat ka backup aur reminders tabhi chalenge jab koi app khola hua ho. HOSTINGER.md dekhein.");

const entry = path.join(here, "server", "dist", "index.js");
if (!fs.existsSync(entry)) stop(`${entry} nahi mila — build nahi hua. hPanel me Build command "npm run build" rakhein.`);
await import(pathToFileURL(entry).href);
