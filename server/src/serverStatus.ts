/**
 * Server status for the platform owner — everything they would otherwise open Fly.io for:
 * machine / region / image, uptime, CPU load, memory, the data volume (used / free GB), database + backups size,
 * request traffic for the last hour (per minute, latency, 4xx / 5xx), health checks, and an error log that survives
 * restarts (server_log table). With FLY_API_TOKEN set, the Fly Machines API adds machine state, size and volume facts.
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import { all, get, run, now, db } from "./db.js";
import { config } from "./config.js";
import { setServerErrorHook } from "./auth.js";
import { listBackups, backupDir } from "./routes/system.js";

db.exec(`CREATE TABLE IF NOT EXISTS server_log (
  id INTEGER PRIMARY KEY, level TEXT NOT NULL, message TEXT NOT NULL, stack TEXT, method TEXT, path TEXT, status INTEGER, created_at TEXT NOT NULL)`);

/* ---------- error log (last 1,000 kept) ---------- */
let logCount = 0;
export function logServerError(level: "error" | "warn", message: string, extra: { stack?: string | null; method?: string; path?: string; status?: number } = {}) {
  try {
    run("INSERT INTO server_log (level,message,stack,method,path,status,created_at) VALUES (?,?,?,?,?,?,?)", level, String(message).slice(0, 2000), extra.stack?.slice(0, 8000) ?? null, extra.method ?? null, extra.path?.slice(0, 300) ?? null, extra.status ?? null, now());
    if (++logCount % 50 === 0) run("DELETE FROM server_log WHERE id NOT IN (SELECT id FROM server_log ORDER BY id DESC LIMIT 1000)");
  } catch { /* never let logging break a request */ }
}
export function installProcessLogging() {
  setServerErrorHook((m, extra) => logServerError("error", m, extra));
  process.on("uncaughtException", (e) => { logServerError("error", `uncaughtException: ${e?.message ?? e}`, { stack: e?.stack }); console.error(e); });
  process.on("unhandledRejection", (e: any) => { logServerError("error", `unhandledRejection: ${e?.message ?? e}`, { stack: e?.stack }); console.error(e); });
}

/* ---------- request metrics: per-minute ring for the last 60 minutes ---------- */
type Bucket = { minute: number; requests: number; ms: number; slow: number; s4xx: number; s5xx: number; max_ms: number };
const ring: Bucket[] = [];
let total = 0, totalMs = 0;
const startedAt = Date.now();
function bucket(): Bucket {
  const minute = Math.floor(Date.now() / 60_000);
  const last = ring[ring.length - 1];
  if (last && last.minute === minute) return last;
  const b = { minute, requests: 0, ms: 0, slow: 0, s4xx: 0, s5xx: 0, max_ms: 0 };
  ring.push(b);
  while (ring.length > 60) ring.shift();
  return b;
}
export function requestMetrics(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api/")) return next();
  const t0 = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const b = bucket();
    b.requests++; b.ms += ms; if (ms > b.max_ms) b.max_ms = ms; if (ms > 1000) b.slow++;
    if (res.statusCode >= 500) b.s5xx++; else if (res.statusCode >= 400) b.s4xx++;
    total++; totalMs += ms;
    if (ms > 3000) logServerError("warn", `slow request ${Math.round(ms)} ms: ${req.method} ${req.path}`, { method: req.method, path: req.originalUrl, status: res.statusCode });
  });
  next();
}

/* ---------- event-loop lag sampler ---------- */
let loopLag = 0;
{
  let last = Date.now();
  setInterval(() => { const d = Date.now() - last - 1000; loopLag = Math.max(0, d); last = Date.now(); }, 1000).unref();
}

/* ---------- helpers ---------- */
function dirSize(p: string, budget = { files: 0 }): number {
  let n = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (++budget.files > 20000) break;
      const f = path.join(p, e.name);
      if (e.isDirectory()) n += dirSize(f, budget); else if (e.isFile()) { try { n += fs.statSync(f).size; } catch { /* gone */ } }
    }
  } catch { /* no dir */ }
  return n;
}
function statfs(p: string) {
  try { const s = fs.statfsSync(p); const total = Number(s.blocks) * Number(s.bsize), free = Number(s.bavail) * Number(s.bsize); return { total, free, used: total - free }; } catch { return null; }
}
function cpuTimes() { const c = os.cpus(); let idle = 0, all = 0; for (const x of c) { idle += x.times.idle; all += x.times.user + x.times.nice + x.times.sys + x.times.irq + x.times.idle; } return { idle, all }; }
let cpuPrev = cpuTimes(), cpuPct = 0;
setInterval(() => { const c = cpuTimes(); const d = c.all - cpuPrev.all; cpuPct = d > 0 ? Math.round((1 - (c.idle - cpuPrev.idle) / d) * 100) : 0; cpuPrev = c; }, 5000).unref();

/* ---------- Fly Machines API (optional) ---------- */
let flyCache: { at: number; data: any } | null = null;
async function flyInfo() {
  const token = process.env.FLY_API_TOKEN, app = process.env.FLY_APP_NAME;
  if (!token || !app) return { configured: false };
  if (flyCache && Date.now() - flyCache.at < 30_000) return flyCache.data;
  const hdr = { authorization: `Bearer ${token}` };
  const getJ = async (u: string) => { const r = await fetch(u, { headers: hdr, signal: AbortSignal.timeout(6000) }); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
  try {
    const [machines, volumes] = await Promise.all([getJ(`https://api.machines.dev/v1/apps/${app}/machines`), getJ(`https://api.machines.dev/v1/apps/${app}/volumes`)]);
    const data = {
      configured: true,
      machines: (machines as any[]).map((m) => ({ id: m.id, name: m.name, state: m.state, region: m.region, image: m.image_ref?.tag ?? m.config?.image, cpu_kind: m.config?.guest?.cpu_kind, cpus: m.config?.guest?.cpus, memory_mb: m.config?.guest?.memory_mb, updated_at: m.updated_at, checks: (m.checks ?? []).map((c: any) => ({ name: c.name, status: c.status, output: c.output })) })),
      volumes: (volumes as any[]).map((v) => ({ id: v.id, name: v.name, state: v.state, region: v.region, size_gb: v.size_gb, encrypted: v.encrypted, attached_machine_id: v.attached_machine_id, created_at: v.created_at })),
    };
    flyCache = { at: Date.now(), data };
    return data;
  } catch (e) { return { configured: true, error: (e as Error).message }; }
}

/* ---------- the status document ---------- */
export async function serverStatus() {
  const mem = process.memoryUsage();
  const dataDir = path.dirname(config.dbPath);
  const vol = statfs(dataDir);
  const dbBytes = (() => { try { return fs.statSync(config.dbPath).size; } catch { return 0; } })();
  const walBytes = (() => { try { return fs.statSync(config.dbPath + "-wal").size; } catch { return 0; } })();
  const backups = listBackups();
  const backupBytes = backups.reduce((a, b) => a + b.bytes, 0);
  const dataBytes = dirSize(dataDir);
  const latestBackupAt = backups[0] ? (() => { try { return fs.statSync(path.join(backupDir(), backups[0].name)).mtimeMs; } catch { return 0; } })() : 0;
  const load = os.loadavg();
  const cores = os.cpus().length || 1;
  const minutes = ring.slice(-60);
  const last5 = minutes.filter((b) => b.minute >= Math.floor(Date.now() / 60_000) - 5);
  const sum = (k: keyof Bucket, arr = minutes) => arr.reduce((a, b) => a + (b[k] as number), 0);
  const errs24 = get("SELECT COUNT(*) n FROM server_log WHERE level='error' AND created_at>=?", new Date(Date.now() - 86_400_000).toISOString())!.n as number;
  const quick = (() => { try { return String(db.prepare("PRAGMA quick_check(1)").get()?.quick_check ?? "ok"); } catch (e) { return (e as Error).message; } })();
  const checks = [
    { name: "Database", ok: quick === "ok", detail: quick === "ok" ? `integrity ok · ${(dbBytes / 1e6).toFixed(1)} MB · WAL ${(walBytes / 1e6).toFixed(1)} MB` : quick },
    { name: "Data volume", ok: !vol || vol.free / vol.total > 0.1, detail: vol ? `${(vol.free / 1e9).toFixed(2)} GB free of ${(vol.total / 1e9).toFixed(2)} GB` : "statfs nahi mila" },
    { name: "Backups", ok: backups.length > 0 && Date.now() - latestBackupAt < 36 * 3600_000, detail: backups[0] ? `aakhri ${backups[0].name} · ${backups.length} files · ${(backupBytes / 1e6).toFixed(0)} MB` : "koi backup nahi" },
    { name: "Memory", ok: mem.rss / os.totalmem() < 0.85, detail: `process ${(mem.rss / 1e6).toFixed(0)} MB of ${(os.totalmem() / 1e6).toFixed(0)} MB` },
    { name: "CPU", ok: cpuPct < 85, detail: `${cpuPct}% abhi · load ${load.map((x) => x.toFixed(2)).join(" / ")} on ${cores} core` },
    { name: "Event loop", ok: loopLag < 200 || process.uptime() < 90, detail: `${loopLag} ms lag${process.uptime() < 90 ? " (abhi start hua)" : ""}` },
    { name: "Errors (24h)", ok: errs24 === 0, detail: `${errs24} server errors` },
    { name: "5xx (last hour)", ok: sum("s5xx") === 0, detail: `${sum("s5xx")} of ${sum("requests")} requests` },
  ];
  return {
    now: now(),
    machine: {
      app: process.env.FLY_APP_NAME ?? null, region: process.env.FLY_REGION ?? null, machine_id: process.env.FLY_MACHINE_ID ?? null, alloc_id: process.env.FLY_ALLOC_ID ?? null,
      image: process.env.FLY_IMAGE_REF ?? null, public_ip: process.env.FLY_PUBLIC_IP ?? null, hostname: os.hostname(), platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      node: process.version, pid: process.pid, process_uptime_s: Math.round(process.uptime()), os_uptime_s: Math.round(os.uptime()), started_at: new Date(startedAt).toISOString(),
      env: config.saas ? "SaaS" : "single", timezone: config.timezone, public_url: config.publicUrl,
    },
    cpu: { percent: cpuPct, load_1: load[0], load_5: load[1], load_15: load[2], cores, model: os.cpus()[0]?.model ?? null, event_loop_lag_ms: loopLag },
    memory: { total: os.totalmem(), free: os.freemem(), used: os.totalmem() - os.freemem(), rss: mem.rss, heap_used: mem.heapUsed, heap_total: mem.heapTotal, external: mem.external },
    disk: { mount: dataDir, volume: vol, data_bytes: dataBytes, db_bytes: dbBytes, wal_bytes: walBytes, backups_bytes: backupBytes, backups: backups.length, backup_dir: backupDir(), latest_backup: backups[0] ? { ...backups[0], at: latestBackupAt ? new Date(latestBackupAt).toISOString() : null } : null },
    requests: {
      total_since_start: total, avg_ms_since_start: total ? Math.round(totalMs / total) : 0,
      last_hour: { requests: sum("requests"), avg_ms: sum("requests") ? Math.round(sum("ms") / sum("requests")) : 0, slow: sum("slow"), s4xx: sum("s4xx"), s5xx: sum("s5xx") },
      last_5min: { requests: sum("requests", last5), avg_ms: sum("requests", last5) ? Math.round(sum("ms", last5) / sum("requests", last5)) : 0, s5xx: sum("s5xx", last5) },
      per_minute: minutes.map((b) => ({ t: new Date(b.minute * 60_000).toISOString(), requests: b.requests, avg_ms: b.requests ? Math.round(b.ms / b.requests) : 0, max_ms: Math.round(b.max_ms), s4xx: b.s4xx, s5xx: b.s5xx })),
    },
    db: { tenants: get("SELECT COUNT(*) n FROM tenants")!.n, users: get("SELECT COUNT(*) n FROM users")!.n, sales: get("SELECT COUNT(*) n FROM sales")!.n, audit_rows: get("SELECT COUNT(*) n FROM audit_log")!.n, sessions_live: get("SELECT COUNT(*) n FROM sessions WHERE revoked_at IS NULL")!.n, journal_mode: String(db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "") },
    errors: { last_24h: errs24, last_7d: get("SELECT COUNT(*) n FROM server_log WHERE level='error' AND created_at>=?", new Date(Date.now() - 7 * 86_400_000).toISOString())!.n },
    checks, healthy: checks.every((c) => c.ok),
    fly: await flyInfo(),
  };
}
export function serverLogs(level?: string, limit = 200) {
  return all(`SELECT * FROM server_log ${level && level !== "all" ? "WHERE level=?" : ""} ORDER BY id DESC LIMIT ?`, ...(level && level !== "all" ? [level] : []), limit);
}
export function clearServerLogs() { return run("DELETE FROM server_log").changes; }
