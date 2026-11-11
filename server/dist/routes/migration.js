/**
 * Moving the whole install to another server (e.g. Fly.io → Hostinger) without a terminal:
 *
 *  1. OLD server, platform owner: POST /platform/migration/export {password} → one encrypted file holding a consistent copy
 *     of the database and the login secret (JWT_SECRET — sign-in, PIN devices, customer portal / bill links all hang on it).
 *  2. NEW server, setup code (printed in the start-up log, kept in the data folder): the /migrate page uploads that file in
 *     small parts (shared hosting cuts a request at 120 s), then POST /migration/finish decrypts it with the same password,
 *     checks it is a real database, stages it as `<db>.restore` (swapped in at the next start, the current data kept as
 *     `.before-restore-*`), stores the login secret, and restarts the app.
 *
 * File format: "PUMPAIMG" | 0x01 | salt(16) | iv(12) | AES-256-GCM( u32 metaLen | meta JSON | database bytes ) | tag(16).
 * Key = scrypt(password, salt). A wrong password or a damaged file fails the GCM tag — nothing is staged.
 */
import { Router } from "express";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";
import { z } from "zod";
import { db } from "../db.js";
import { config } from "../config.js";
import { h, parse } from "../auth.js";
import { AppError } from "../services.js";
const MAGIC = Buffer.from("PUMPAIMG");
const VERSION = 1;
const HEAD = MAGIC.length + 1 + 16 + 12;
const TAG = 16;
const dataDir = () => path.dirname(config.dbPath);
const kdf = (password, salt) => crypto.scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
/** The imported login secret; config prefers it over JWT_SECRET so every old sign-in and link keeps working. */
export const IMPORTED_SECRET_FILE = ".jwt_secret_imported";
/* ------------------------------------------------------------------ export (old server) ------------------------------------------------------------------ */
export function mountMigrationExport(r, guard, who) {
    r.post("/migration/export", guard, async (req, res, next) => {
        let tmp = "";
        try {
            const b = parse(z.object({ password: z.string().min(10, "Password kam se kam 10 harf ka rakhein") }), req.body);
            tmp = path.join(dataDir(), `migration-${Date.now()}.db`);
            db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); // a consistent copy, the live database keeps running
            const size = fs.statSync(tmp).size;
            const meta = Buffer.from(JSON.stringify({ v: VERSION, created_at: new Date().toISOString(), from: config.publicUrl || null, jwt_secret: config.jwtSecret, db_bytes: size }));
            const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv("aes-256-gcm", kdf(b.password, salt), iv);
            const len = Buffer.alloc(4);
            len.writeUInt32BE(meta.length);
            const stamp = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 16).replace(/[:T]/g, "-");
            res.setHeader("Content-Type", "application/octet-stream");
            res.setHeader("Content-Disposition", `attachment; filename="pumpai-migration-${stamp}.pumpai"`);
            res.setHeader("Content-Length", String(HEAD + 4 + meta.length + size + TAG));
            res.write(Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv]));
            res.write(cipher.update(Buffer.concat([len, meta])));
            await pipeline(fs.createReadStream(tmp), new Transform({ transform(chunk, _e, cb) { cb(null, cipher.update(chunk)); } }), new Writable({
                write(chunk, _e, cb) { if (res.write(chunk))
                    cb();
                else
                    res.once("drain", () => cb()); },
            }));
            const fin = cipher.final();
            if (fin.length)
                res.write(fin);
            res.end(cipher.getAuthTag());
            console.log(`[migration] export downloaded by ${who(req)} (${size} bytes of database)`);
        }
        catch (e) {
            if (!res.headersSent)
                next(e);
            else
                res.destroy(e);
        }
        finally {
            if (tmp)
                fs.rmSync(tmp, { force: true });
        }
    });
}
/* ------------------------------------------------------------------ import (new server) ------------------------------------------------------------------ */
export const migrationPublic = Router();
let fails = 0, failWindow = 0;
/** Setup code from the start-up log; 10 wrong tries an hour lock it for the rest of that hour. */
function checkCode(code) {
    if (Date.now() - failWindow > 3600_000) {
        fails = 0;
        failWindow = Date.now();
    }
    if (fails >= 10)
        throw new AppError(429, "Bahut ghalat setup code — 1 ghante baad dobara try karein");
    const want = Buffer.from((config.setupToken ?? "").trim().toUpperCase()), got = Buffer.from(String(code ?? "").trim().toUpperCase());
    if (!want.length)
        throw new AppError(403, "Is server par setup code nahi (SETUP_TOKEN) — migration band hai");
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
        fails++;
        throw new AppError(403, "Setup code ghalat hai");
    }
}
const uploadDir = () => path.join(dataDir(), "migration-upload");
const idOk = (id) => typeof id === "string" && /^[a-z0-9]{16,40}$/.test(id);
/** One part of the uploaded file (raw bytes, at most 8 MB). Parts arrive in order: part 0 starts a fresh upload. */
migrationPublic.post("/migration/upload", express.raw({ type: "application/octet-stream", limit: "9mb" }), h((req) => {
    checkCode(req.get("x-setup-code"));
    const id = String(req.query.id ?? ""), part = Number(req.query.part);
    if (!idOk(id) || !Number.isInteger(part) || part < 0)
        throw new AppError(400, "Upload id / part ghalat");
    if (!Buffer.isBuffer(req.body) || !req.body.length)
        throw new AppError(400, "Khaali hissa");
    fs.mkdirSync(uploadDir(), { recursive: true });
    const file = path.join(uploadDir(), `${id}.part`);
    if (part === 0) {
        for (const f of fs.readdirSync(uploadDir()))
            fs.rmSync(path.join(uploadDir(), f), { force: true }); // only one upload at a time
        if (!req.body.subarray(0, MAGIC.length).equals(MAGIC))
            throw new AppError(400, "Ye migration file nahi (.pumpai file chunein)");
    }
    else if (!fs.existsSync(file))
        throw new AppError(400, "Upload shuru se dobara karein");
    fs.appendFileSync(file, req.body);
    return { ok: true, part, bytes: fs.statSync(file).size };
}));
/** Decrypt the uploaded file with the password, stage the database and the login secret, then restart. */
migrationPublic.post("/migration/finish", h(async (req, res) => {
    checkCode(req.get("x-setup-code"));
    const b = parse(z.object({ id: z.string(), size: z.number().int().positive(), password: z.string().min(1) }), req.body);
    if (!idOk(b.id))
        throw new AppError(400, "Upload id ghalat");
    const file = path.join(uploadDir(), `${b.id}.part`);
    if (!fs.existsSync(file))
        throw new AppError(400, "Upload nahi mila — dobara karein");
    const total = fs.statSync(file).size;
    if (total !== b.size)
        throw new AppError(400, `File poori nahi pohanchi (${total} / ${b.size} bytes) — dobara upload karein`);
    if (total < HEAD + 4 + TAG + 100)
        throw new AppError(400, "File bahut chhoti — sahi migration file nahi");
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(HEAD), tag = Buffer.alloc(TAG);
    fs.readSync(fd, head, 0, HEAD, 0);
    fs.readSync(fd, tag, 0, TAG, total - TAG);
    fs.closeSync(fd);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC) || head[MAGIC.length] !== VERSION)
        throw new AppError(400, "Ye migration file nahi, ya naye version ki hai");
    const salt = head.subarray(MAGIC.length + 1, MAGIC.length + 17), iv = head.subarray(MAGIC.length + 17, HEAD);
    const decipher = crypto.createDecipheriv("aes-256-gcm", kdf(b.password, salt), iv);
    decipher.setAuthTag(tag);
    const out = `${config.dbPath}.restore.tmp`;
    const sink = fs.createWriteStream(out);
    let pending = Buffer.alloc(0), metaLen = -1, meta = null;
    const splitter = new Writable({
        write(chunk, _e, cb) {
            if (meta) {
                if (sink.write(chunk))
                    cb();
                else
                    sink.once("drain", () => cb());
                return;
            }
            pending = Buffer.concat([pending, chunk]);
            if (metaLen < 0 && pending.length >= 4)
                metaLen = pending.readUInt32BE(0);
            if (metaLen >= 0 && pending.length >= 4 + metaLen) {
                try {
                    meta = JSON.parse(pending.subarray(4, 4 + metaLen).toString("utf8"));
                }
                catch {
                    return cb(new AppError(400, "Password ghalat hai, ya file kharab hai"));
                }
                const rest = pending.subarray(4 + metaLen);
                pending = Buffer.alloc(0);
                if (rest.length && !sink.write(rest)) {
                    sink.once("drain", () => cb());
                    return;
                }
            }
            cb();
        },
        final(cb) { sink.end(() => cb()); },
    });
    try {
        await pipeline(fs.createReadStream(file, { start: HEAD, end: total - TAG - 1 }), decipher, splitter);
    }
    catch {
        fs.rmSync(out, { force: true });
        throw new AppError(400, "Password ghalat hai, ya file kharab / adhoori hai — kuch nahi badla");
    }
    const sqliteHead = Buffer.alloc(16);
    const ofd = fs.openSync(out, "r");
    fs.readSync(ofd, sqliteHead, 0, 16, 0);
    fs.closeSync(ofd);
    if (!meta || sqliteHead.toString("latin1") !== "SQLite format 3\u0000" || fs.statSync(out).size !== meta.db_bytes) {
        fs.rmSync(out, { force: true });
        throw new AppError(400, "File ke andar database sahi nahi mila — kuch nahi badla");
    }
    fs.renameSync(out, `${config.dbPath}.restore`);
    if (typeof meta.jwt_secret === "string" && meta.jwt_secret.length >= 16)
        fs.writeFileSync(path.join(dataDir(), IMPORTED_SECRET_FILE), meta.jwt_secret + "\n", { mode: 0o600 });
    fs.rmSync(uploadDir(), { recursive: true, force: true });
    console.log(`[migration] database from ${meta.from ?? "old server"} (${meta.created_at}) staged — restarting`);
    // the host starts the app again on the next request; db.ts swaps the staged database in before opening it
    if (process.env.NODE_ENV !== "test")
        res.on("finish", () => setTimeout(() => process.exit(0), 1500));
    return { ok: true, from: meta.from ?? null, created_at: meta.created_at, db_bytes: meta.db_bytes, restarting: true };
}));
