/**
 * One person who is both a khata customer and a wholesale client. The CEO links the two accounts once; after that a
 * payment booked on the wrong side can be shifted across: a khata payment → the client's wholesale ledger, or a
 * wholesale payment → the khata. Same amount, same method / bank account, same date and minute, so the cash book and
 * banks do not move — only whose due it cleared. The moved row carries a note naming where it came from, and shifting it
 * back is the same move the other way. CEO + manager; a closed day is CEO-only.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { all, get, run, tx, type Row } from "../db.js";
import { h, parse, tid, requireAny } from "../auth.js";
import { AppError, audit, khataEntry, round2 } from "../services.js";
import { insertTxn, clientDue } from "./wholesale.js";
import { guardClosedDay } from "./backoffice.js";
import { lookups } from "./lookups.js";
import { DEPOT_PAY, BYPASS_PAY } from "./banks.js";

export const partyShift = Router();
const canShift = requireAny("entries.edit", "khata.manage");

const isMoney = (t: number, method: unknown) => {
  const m = String(method ?? "").trim().toLowerCase();
  if (!m) return false;
  return lookups(t, "payment_method", true).some((l) => l.key.toLowerCase() === m || String(l.label ?? "").toLowerCase() === m) || /^(cash|bank|bank transfer|online)$/.test(m);
};

/** The wholesale client linked to this khata customer (and back). */
export function linkedClient(t: number, customerId: number): Row | undefined {
  return get("SELECT id, name, khata_customer_id FROM wholesale_clients WHERE tenant_id=? AND khata_customer_id=? ORDER BY id LIMIT 1", t, customerId);
}

/** Link (or unlink with null) a wholesale client to the khata account of the same person. */
partyShift.post("/party-shift/link", canShift, h((req) => {
  const t = tid(req);
  const b = parse(z.object({ client_id: z.number().int().positive(), customer_id: z.number().int().positive().nullable() }), req.body);
  const c = get("SELECT * FROM wholesale_clients WHERE id=? AND tenant_id=?", b.client_id, t);
  if (!c) throw new AppError(404, "Wholesale client nahi mila");
  if (b.customer_id) {
    const k = get("SELECT id, name FROM customers WHERE id=? AND tenant_id=?", b.customer_id, t);
    if (!k) throw new AppError(404, "Khata customer nahi mila");
    const other = get("SELECT name FROM wholesale_clients WHERE tenant_id=? AND khata_customer_id=? AND id<>?", t, k.id, c.id);
    if (other) throw new AppError(400, `Ye khata pehle se ${other.name} (wholesale) se juda hai`);
  }
  run("UPDATE wholesale_clients SET khata_customer_id=? WHERE id=?", b.customer_id, c.id);
  audit(t, req.user!, "party_link", `wclient:${c.id}`, { from: c.khata_customer_id ?? null, to: b.customer_id });
  return { ok: true, client_id: c.id, customer_id: b.customer_id };
}));

/** The link for one side, for the pages: ?client_id= or ?customer_id=. */
partyShift.get("/party-shift/link", canShift, h((req) => {
  const t = tid(req);
  const clientId = Number(req.query.client_id) || 0, customerId = Number(req.query.customer_id) || 0;
  const c = clientId ? get("SELECT id, name, khata_customer_id FROM wholesale_clients WHERE id=? AND tenant_id=?", clientId, t)
    : customerId ? linkedClient(t, customerId) : undefined;
  const k = c?.khata_customer_id ? get("SELECT id, name, phone FROM customers WHERE id=? AND tenant_id=?", c.khata_customer_id, t) : undefined;
  return { client: c ? { id: c.id, name: c.name } : null, customer: k ?? null };
}));

/** Why a khata row cannot be shifted (or null when it can). */
function khataBlock(t: number, k: Row): string | null {
  const ref = String(k.ref ?? "");
  if (k.type !== "credit") return "Sirf payment (jama) shift hoti hai";
  if (/^(SALE-|SHOP-|oth-|open:|refund:)/.test(ref)) return "Ye payment nahi, kisi aur entry ka hissa hai";
  if (/^cheque$/i.test(ref)) return "Cheque register wali payment — cheque register se badlein";
  if (!isMoney(t, ref)) return "Ye payment nahi (paise ki entry nahi)";
  return null;
}
function wholesaleBlock(t: number, x: Row): string | null {
  if (x.type !== "payment" || x.voided) return "Sirf chalu payment shift hoti hai";
  if (x.method === DEPOT_PAY || x.method === BYPASS_PAY) return "Depot / bypass wali payment shift nahi hoti";
  if (x.sale_id) return "Ye POS sale ki payment hai — POS sale se badlein";
  if (String(x.ref ?? "").startsWith("oth-")) return "Other-entries wali entry hai";
  if (get("SELECT 1 FROM wholesale_cheques WHERE tenant_id=? AND payment_txn_id=?", t, x.id)) return "Cheque register wali payment — cheque register se badlein";
  if (!isMoney(t, x.method)) return "Ye payment nahi (paise ki entry nahi)";
  return null;
}

/** Move a cashier voucher (and photos) that pointed at the old row to the new one, so nothing is left dangling. */
function followVoucher(t: number, oldSrc: string, newSrc: string, partyType: string, partyId: number, partyName: string) {
  run("UPDATE cashier_vouchers SET src=?, party_type=?, party_id=?, party_name=? WHERE tenant_id=? AND src=?", newSrc, partyType, partyId, partyName, t, oldSrc);
  run("UPDATE photos SET ref=? WHERE tenant_id=? AND ref=?", newSrc, t, oldSrc);
}

/** Khata payment → the linked client's wholesale ledger. */
partyShift.post("/party-shift/khata/:id/to-wholesale", canShift, h((req: Request) => {
  const t = tid(req);
  const b = parse(z.object({ reason: z.string().trim().max(200).optional().nullable() }), req.body ?? {});
  const k = get("SELECT k.*, c.name customer_name FROM khata_ledger k JOIN customers c ON c.id=k.customer_id WHERE k.id=? AND c.tenant_id=?", Number(req.params.id), t);
  if (!k) throw new AppError(404, "Khata entry nahi mili");
  const why = khataBlock(t, k);
  if (why) throw new AppError(400, why);
  const client = linkedClient(t, k.customer_id);
  if (!client) throw new AppError(400, `${k.customer_name} kisi wholesale client se juda nahi — pehle Wholesale → client → "Khata se jorein"`);
  guardClosedDay(req, t, String(k.created_at));
  const moved = tx(() => {
    run("DELETE FROM khata_ledger WHERE id=?", k.id);
    run("UPDATE customers SET balance = balance + ? WHERE id=?", k.amount, k.customer_id);
    const note = `Khata se shift (${k.customer_name}, K-${k.id})${k.note ? ` · ${k.note}` : ""}`;
    const w = insertTxn(req, client.id, { type: "payment", amount: k.amount, method: k.ref, account_id: k.account_id ?? null, ref: `kshift:${k.id}`, note, txn_date: k.created_at, silent: true });
    run("UPDATE wholesale_txns SET created_at=? WHERE id=?", k.created_at, w.id); // same moment for the cash book as before
    followVoucher(t, `khata:${k.id}`, `wtx:${w.id}`, "wholesale", client.id, client.name);
    return w;
  });
  audit(t, req.user!, "party_shift", `khata:${k.id}`, { to: `wtx:${moved.id}`, amount: k.amount, method: k.ref, customer_id: k.customer_id, client_id: client.id, reason: b.reason ?? null });
  return { ok: true, wtx_id: moved.id, client: { id: client.id, name: client.name, due_after: round2(clientDue(client.id)) },
    khata_balance_after: round2(get("SELECT balance FROM customers WHERE id=?", k.customer_id)!.balance) };
}));

/** Wholesale payment → the linked khata account. */
partyShift.post("/party-shift/wholesale/:id/to-khata", canShift, h((req: Request) => {
  const t = tid(req);
  const b = parse(z.object({ reason: z.string().trim().max(200).optional().nullable() }), req.body ?? {});
  const x = get("SELECT x.*, c.name client_name, c.khata_customer_id FROM wholesale_txns x JOIN wholesale_clients c ON c.id=x.client_id WHERE x.id=? AND x.tenant_id=?", Number(req.params.id), t);
  if (!x) throw new AppError(404, "Wholesale entry nahi mili");
  const why = wholesaleBlock(t, x);
  if (why) throw new AppError(400, why);
  const cust = x.khata_customer_id ? get("SELECT id, name FROM customers WHERE id=? AND tenant_id=?", x.khata_customer_id, t) : null;
  if (!cust) throw new AppError(400, `${x.client_name} kisi khata se juda nahi — pehle Wholesale → client → "Khata se jorein"`);
  guardClosedDay(req, t, String(x.txn_date));
  const kid = tx(() => {
    run("UPDATE wholesale_txns SET voided=1, void_reason=? WHERE id=?", `Khata par shift (${cust.name})`, x.id);
    const note = `Wholesale se shift (${x.client_name}, W-${x.id})${x.note ? ` · ${x.note}` : ""}`;
    // the cash book reads a khata payment by created_at and the wholesale one by created_at too: keep that moment
    khataEntry(cust.id, "credit", x.amount, x.method, note, x.account_id ?? null, x.created_at);
    const id = get("SELECT MAX(id) id FROM khata_ledger WHERE customer_id=?", cust.id)!.id as number;
    followVoucher(t, `wtx:${x.id}`, `khata:${id}`, "khata", cust.id, cust.name);
    return id;
  });
  audit(t, req.user!, "party_shift", `wtx:${x.id}`, { to: `khata:${kid}`, amount: x.amount, method: x.method, client_id: x.client_id, customer_id: cust.id, reason: b.reason ?? null });
  return { ok: true, khata_id: kid, customer: { id: cust.id, name: cust.name, balance_after: round2(get("SELECT balance FROM customers WHERE id=?", cust.id)!.balance) },
    client_due_after: round2(clientDue(x.client_id)) };
}));

/** Which of these rows can be shifted (for the buttons): ?side=khata|wholesale&ids=1,2,3 */
partyShift.get("/party-shift/movable", canShift, h((req) => {
  const t = tid(req);
  const ids = String(req.query.ids ?? "").split(",").map(Number).filter((n) => n > 0).slice(0, 500);
  if (!ids.length) return { movable: {} };
  const q = ids.map(() => "?").join(",");
  const out: Record<number, string | null> = {};
  if (req.query.side === "khata") {
    for (const k of all(`SELECT k.* FROM khata_ledger k JOIN customers c ON c.id=k.customer_id WHERE c.tenant_id=? AND k.id IN (${q})`, t, ...ids))
      out[k.id as number] = linkedClient(t, k.customer_id) ? khataBlock(t, k) : "not-linked";
  } else {
    for (const x of all(`SELECT x.*, c.khata_customer_id FROM wholesale_txns x JOIN wholesale_clients c ON c.id=x.client_id WHERE x.tenant_id=? AND x.id IN (${q})`, t, ...ids))
      out[x.id as number] = x.khata_customer_id ? wholesaleBlock(t, x) : "not-linked";
  }
  return { movable: out };
}));
