/**
 * Encrypt sensitive settings (WhatsApp token, OAuth refresh tokens, app secrets) at rest in the database.
 * The key is derived from JWT_SECRET, which lives in the server's environment — NOT in the database or its
 * backups. So a leaked database / cloud backup reveals only ciphertext; the key stays on the server.
 * AES-256-GCM. Legacy plaintext values (no "enc:v1:" prefix) pass through unchanged and get encrypted on next save.
 */
import crypto from "node:crypto";
import { config } from "./config.js";

const key = crypto.createHash("sha256").update(`pumpai-secretbox:${config.jwtSecret}`).digest();
const PFX = "enc:v1:";

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PFX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
export function decryptSecret(v: string | null | undefined): string {
  if (!v) return "";
  if (!v.startsWith(PFX)) return v; // legacy plaintext
  try {
    const raw = Buffer.from(v.slice(PFX.length), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch { return ""; }
}
export const isEncrypted = (v?: string | null) => Boolean(v && v.startsWith(PFX));
