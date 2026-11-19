import cron from "node-cron";
import { all, get, run, now } from "../db.js";
import { config } from "../config.js";
import { JOBS } from "./jobs.js";
/** Jobs that message customers, charge them or block their khata start switched off — the owner turns them on knowingly. */
const OFF_AT_START = new Set(["khata_reminders", "churn_winback", "khata_overdue", "khata_late_fee", "monthly_bills", "staff_coaching"]);
export function ensureAutomations(tenantId) {
    for (const j of JOBS) {
        run(`INSERT INTO automations (tenant_id,key,name,description,cron,enabled) VALUES (?,?,?,?,?,?)
       ON CONFLICT(tenant_id,key) DO UPDATE SET name=excluded.name, description=excluded.description`, tenantId, j.key, j.name, j.description, j.cron, OFF_AT_START.has(j.key) ? 0 : 1);
    }
}
const running = new Set();
export async function runJob(tenantId, key) {
    const job = JOBS.find((j) => j.key === key);
    if (!job)
        throw new Error(`Unknown job ${key}`);
    const lock = `${tenantId}:${key}`;
    if (running.has(lock))
        return "Already running";
    running.add(lock);
    let result;
    try {
        result = await job.run(tenantId);
    }
    catch (e) {
        result = `Error: ${e.message}`;
        console.error(`[automation] ${key} failed`, e);
    }
    finally {
        running.delete(lock);
    }
    run("UPDATE automations SET last_run_at=?, last_result=? WHERE tenant_id=? AND key=?", now(), result, tenantId, key);
    return result;
}
export function startScheduler() {
    if (!config.schedulerEnabled)
        return;
    for (const t of all("SELECT id FROM tenants"))
        ensureAutomations(t.id);
    for (const job of JOBS) {
        cron.schedule(job.cron, async () => {
            for (const t of all("SELECT id FROM tenants")) {
                const a = get("SELECT enabled, cron, last_run_at FROM automations WHERE tenant_id=? AND key=?", t.id, job.key);
                // a cron tick (shared hosting) may already have run it this minute
                if (a?.enabled && !(a.last_run_at && Date.now() - Date.parse(a.last_run_at) < 60_000))
                    await runJob(t.id, job.key);
            }
        }, { timezone: config.timezone });
    }
    console.log(`[automation] ${JOBS.length} jobs scheduled (${config.timezone})`);
}
/* ---------------- catch-up runs (shared hosting) ----------------
 * On hosting where the app is put to sleep when nobody visits (Hostinger web/business hosting), the in-process timers
 * above do not fire while it sleeps. A hosting cron job opens /api/cron/tick every few minutes: that wakes the app and
 * runs every job whose last scheduled moment fell inside the catch-up window and has not run since. The window is short
 * (default 2 hours) so a customer reminder due at 11:00 is never sent late at night after a long outage. */
/** Does one cron field match this value? Supports *, *\/n, a, a-b, a-b/n and comma lists. */
function fieldMatches(field, v, min) {
    for (const part of field.split(",")) {
        const [range, stepS] = part.split("/");
        const step = stepS ? Number(stepS) : 1;
        let lo, hi;
        if (range === "*") {
            lo = min;
            hi = Number.MAX_SAFE_INTEGER;
        }
        else if (range.includes("-")) {
            const [a, b] = range.split("-").map(Number);
            lo = a;
            hi = b;
        }
        else {
            lo = Number(range);
            hi = stepS ? Number.MAX_SAFE_INTEGER : lo;
        }
        if (v >= lo && v <= hi && (v - lo) % step === 0)
            return true;
    }
    return false;
}
/** The wall-clock parts of a moment in the pump's time zone. */
function zoned(ms, tz) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" })
        .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
    return { minute: Number(p.minute), hour: Number(p.hour) % 24, day: Number(p.day), month: Number(p.month), dow };
}
export function cronMatches(expr, ms, tz = config.timezone) {
    const [mi, ho, dom, mon, dw] = expr.trim().split(/\s+/);
    const z = zoned(ms, tz);
    const dowOk = fieldMatches(dw, z.dow, 0) || (z.dow === 0 && fieldMatches(dw, 7, 0));
    const domOk = fieldMatches(dom, z.day, 1);
    // classic cron: when both day fields are restricted, either may match
    const dayOk = dom !== "*" && dw !== "*" ? domOk || dowOk : domOk && dowOk;
    return fieldMatches(mi, z.minute, 0) && fieldMatches(ho, z.hour, 0) && fieldMatches(mon, z.month, 1) && dayOk;
}
/** The latest scheduled minute at or before `nowMs`, looking back at most `windowMin` minutes (null = none in the window). */
export function lastFire(expr, nowMs, windowMin, tz = config.timezone) {
    const start = Math.floor(nowMs / 60_000) * 60_000;
    for (let i = 0; i <= windowMin; i++) {
        const t = start - i * 60_000;
        if (cronMatches(expr, t, tz))
            return t;
    }
    return null;
}
/** Run every enabled job that was due in the catch-up window and has not run since. Returns what was started. */
export function runDueJobs(nowMs = Date.now(), windowMin = Number(process.env.CRON_CATCHUP_MIN ?? 120)) {
    const started = [];
    for (const t of all("SELECT id FROM tenants")) {
        ensureAutomations(t.id);
        for (const job of JOBS) {
            const a = get("SELECT enabled, last_run_at FROM automations WHERE tenant_id=? AND key=?", t.id, job.key);
            if (!a?.enabled)
                continue;
            const due = lastFire(job.cron, nowMs, windowMin);
            if (due == null)
                continue;
            if (a.last_run_at && Date.parse(a.last_run_at) >= due)
                continue;
            started.push({ tenant_id: t.id, key: job.key, due_at: new Date(due).toISOString() });
        }
    }
    // one after another in the background, so the cron request returns at once (hosting cuts a request at 120 s)
    setImmediate(async () => { for (const s of started)
        await runJob(s.tenant_id, s.key); });
    return started;
}
