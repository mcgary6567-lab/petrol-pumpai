/** "Client se maal" on the PUMP side: a supplier purchase (supplier_txns) that was really a wholesale client's own fuel was
 *  moved to the client's linked supplier card and settled there by a DEPOT_PAY wholesale payment + its `wtx:<id>` supplier
 *  row whose note starts with `cfuel:stx:<purchase id>:from:<old supplier id>`. These two helpers undo that pairing when
 *  either leg is voided, so neither card is left with a stranded line. db-only imports: safe to call from any router. */
import { all, get, run } from "../db.js";

const MARK = /^cfuel:stx:(\d+):from:(\d+)/;

/** The purchase is being voided / deleted: drop its settlement row and void the client's DEPOT_PAY payment. */
export function dropClientFuelSettlement(t: number, purchaseId: number, reason: string) {
  for (const s of all("SELECT id, ref, note FROM supplier_txns WHERE tenant_id=? AND type='payment' AND note LIKE ?", t, `cfuel:stx:${purchaseId}:%`)) {
    run("DELETE FROM supplier_txns WHERE id=? AND tenant_id=?", s.id, t);
    const wtx = /^wtx:(\d+)$/.exec(String(s.ref ?? ""));
    if (wtx) run("UPDATE wholesale_txns SET voided=1, void_reason=? WHERE id=? AND tenant_id=? AND voided=0", reason, Number(wtx[1]), t);
  }
}

/** The client's DEPOT_PAY payment is being voided: if it settled a shifted purchase, move that purchase back to the
 *  supplier it came from (the settlement row itself is deleted by the caller's existing `wtx:` cleanup). */
export function unshiftClientFuel(t: number, wtxId: number) {
  const s = get("SELECT note FROM supplier_txns WHERE tenant_id=? AND ref=? AND type='payment'", t, `wtx:${wtxId}`);
  const m = s ? MARK.exec(String(s.note ?? "")) : null;
  if (!m) return false;
  run("UPDATE supplier_txns SET supplier_id=?, note=COALESCE(note,'') || ' · client shift wapas' WHERE id=? AND tenant_id=?", Number(m[2]), Number(m[1]), t);
  return true;
}
