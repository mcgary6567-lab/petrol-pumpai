/**
 * Room on the data disk, with no database needed — so it can run BEFORE the database is opened.
 *
 * On a small disk (Fly: 1 GB volume) the local backups (full database copies) can fill it. Then every write fails:
 * sign-in shows "Internal server error", and a restart dies on the start-up table changes before anything else runs.
 * When the disk is low, the OLDEST local backups go first; the newest MIN_KEEP always stay.
 */
import fs from "node:fs";
import path from "node:path";

const MB = 1024 * 1024;
const MIN_KEEP = 2;
export const BACKUP_NAME = /^pumpai-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$/;

/** Free bytes on the disk that holds this folder (null when the platform cannot tell). */
export function diskFree(dir: string): number | null {
  try { const st = fs.statfsSync(dir); return Number(st.bavail) * Number(st.bsize); } catch { return null; }
}
export const dbBytes = (dbPath: string) => [dbPath, `${dbPath}-wal`].reduce((a, f) => { try { return a + fs.statSync(f).size; } catch { return a; } }, 0);
/** Room the database needs to keep working: two database sizes, at least 200 MB. */
export const roomNeeded = (dbPath: string) => Math.max(200 * MB, 2 * dbBytes(dbPath) + 50 * MB);
export const backupDirFor = (dbPath: string) => process.env.BACKUP_DIR ?? path.join(path.dirname(dbPath), "backups");

export function makeRoomFor(dbPath: string): { free_mb: number | null; removed: string[] } {
  const removed: string[] = [];
  const dir = path.dirname(dbPath);
  let free = diskFree(dir);
  if (free == null) return { free_mb: null, removed };
  const bdir = backupDirFor(dbPath);
  let list: { name: string; bytes: number }[] = [];
  try { list = fs.readdirSync(bdir).filter((f) => BACKUP_NAME.test(f)).map((f) => ({ name: f, bytes: fs.statSync(path.join(bdir, f)).size })).sort((a, b) => b.name.localeCompare(a.name)); } catch { /* no folder yet */ }
  while (free < roomNeeded(dbPath) && list.length > MIN_KEEP) {
    const old = list.pop()!;
    try { fs.rmSync(path.join(bdir, old.name), { force: true }); removed.push(old.name); } catch { break; }
    free = diskFree(dir) ?? free + old.bytes;
  }
  // still low: a half-written upload (.restore.tmp), then the older safety copies kept at a restore (the newest one stays)
  const base = path.basename(dbPath);
  const near = () => { try { return fs.readdirSync(dir); } catch { return [] as string[]; } };
  if (free < roomNeeded(dbPath)) for (const f of near().filter((x) => x === `${base}.restore.tmp`)) { fs.rmSync(path.join(dir, f), { force: true }); removed.push(f); free = diskFree(dir) ?? free; }
  if (free < roomNeeded(dbPath)) {
    const stamps = [...new Set(near().map((f) => f.match(new RegExp(`^${base.replace(/\./g, "\\.")}\\.before-restore-(.+?)(-wal|-shm)?$`))?.[1]).filter(Boolean) as string[])].sort().reverse();
    for (const st of stamps.slice(1)) {
      if (free >= roomNeeded(dbPath)) break;
      for (const ext of ["", "-wal", "-shm"]) { const f = `${base}.before-restore-${st}${ext}`; if (fs.existsSync(path.join(dir, f))) { fs.rmSync(path.join(dir, f), { force: true }); removed.push(f); } }
      free = diskFree(dir) ?? free;
    }
  }
  if (removed.length) console.warn(`[disk] disk was low — removed ${removed.length} oldest local backup(s): ${removed.join(", ")}`);
  return { free_mb: Math.round(free / MB), removed };
}
