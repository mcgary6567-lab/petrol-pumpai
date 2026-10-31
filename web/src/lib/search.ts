/**
 * One search grammar for every list in the app (ERP-style "find the entry"):
 *   plain words          → every word must appear somewhere in the row (any column, case-insensitive)
 *   #63  ·  id:63        → the row whose id (or voucher / delivery / trip / sale / ref number) is exactly 63
 *   WS-125 · BYP-2 · RV-7 · CN-3 · JV-9 · TR-4 · INV-12 · SALE-88 → voucher / document numbers (prefix + id)
 *   field:value          → one column: type:payment  client:green  fuel:hsd  method:cash  by:israr  gaari:lea  tank:1
 *   date:2026-10-28      → that day (date:2026-10 = that month); also d:28 for the day of month
 *   amount:>50000  amount:<1000  amount:50000-60000  litre:>=1000  rate:258  → number compare / range
 * Several tokens are AND-ed. Works on any object: the keys are matched loosely (client → client_name, fuel → product …).
 */
const ID_KEYS = ["id", "no", "voucher_no", "delivery_id", "trip_id", "sale_id", "wtx_id", "stx_id", "txn_id", "order_id", "bill_no", "invoice_no", "cheque_no", "ref"];
const ALIAS: Record<string, string[]> = {
  fuel: ["product"], product: ["product"], client: ["client_name", "client", "name", "business_name"], customer: ["customer_name", "customer", "name"], supplier: ["supplier", "supplier_name", "party_name", "name"],
  party: ["party_name", "client_name", "customer_name", "supplier", "name"], by: ["created_by", "by", "who", "user", "attendant"], date: ["txn_date", "created_at", "day", "date", "deal_date", "cheque_date"], d: ["txn_date", "created_at", "day", "date"],
  amount: ["amount", "total", "cost_amount", "sale_amount"], amt: ["amount"], litre: ["litres"], litres: ["litres"], l: ["litres"], rate: ["rate", "cost_rate", "sale_rate", "unit_cost"], type: ["type", "kind"], kind: ["type", "kind"],
  method: ["method", "payment_method", "mode"], gaari: ["vehicle_no", "tanker_no", "tanker"], vehicle: ["vehicle_no", "tanker_no"], tanker: ["vehicle_no", "tanker_no", "tanker"], driver: ["driver_name", "driver"], tank: ["tank", "tank_name"],
  station: ["station", "station_name"], voucher: ["voucher_no", "no"], ref: ["ref", "slip_no", "receipt_ref"], note: ["note", "narration"], status: ["status"], id: ["id"],
};
const PREFIX_KEYS: Record<string, string[]> = { ws: ["voucher_no", "id"], rv: ["voucher_no", "id"], cn: ["voucher_no", "id"], jv: ["voucher_no", "id"], fn: ["id"], byp: ["delivery_id", "id"], tr: ["trip_id", "id"], trip: ["trip_id", "id"], inv: ["no", "id"], sale: ["sale_id", "id"], pos: ["sale_id", "id"], stx: ["id"], chq: ["id"], del: ["delivery_id", "id"] };

const num = (v: unknown): number | null => { if (v == null || v === "") return null; const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, "")); return Number.isFinite(n) ? n : null; };
const pkDay = (v: unknown): string => { const s = String(v ?? ""); if (!s) return ""; const t = Date.parse(s); if (Number.isNaN(t) || /^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(0, 10); return new Date(t + 5 * 3600_000).toISOString().slice(0, 10); };
export const rowText = (r: unknown): string => {
  if (r == null) return ""; if (typeof r !== "object") return String(r);
  return Object.values(r as Record<string, unknown>).map((v) => (v && typeof v === "object" ? "" : String(v ?? ""))).join(" ");
};
const fieldsFor = (r: Record<string, unknown>, key: string): unknown[] => {
  const names = ALIAS[key] ?? [];
  const out: unknown[] = [];
  for (const k of Object.keys(r)) { const lk = k.toLowerCase(); if (names.includes(lk) || lk === key || (!names.length && lk.includes(key))) out.push(r[k]); }
  return out;
};
/** a numeric id anywhere the row names one (id, voucher_no "WS-125", delivery_id …) */
const idMatch = (r: Record<string, unknown>, n: number, keys: string[] = ID_KEYS): boolean =>
  keys.some((k) => { const v = r[k]; if (v == null) return false; if (num(v) === n && !/^[a-z]+-/i.test(String(v))) return true; const m = String(v).match(/-(\d+)$/); return !!m && Number(m[1]) === n; });
const cmpNum = (v: unknown, expr: string): boolean => {
  const x = num(v); if (x == null) return false;
  let m: RegExpMatchArray | null;
  if ((m = expr.match(/^(>=|<=|>|<)\s*([\d.,]+)$/))) { const y = num(m[2])!; return m[1] === ">" ? x > y : m[1] === "<" ? x < y : m[1] === ">=" ? x >= y : x <= y; }
  if ((m = expr.match(/^([\d.,]+)\s*-\s*([\d.,]+)$/))) { const a = num(m[1])!, b = num(m[2])!; return x >= Math.min(a, b) && x <= Math.max(a, b); }
  const y = num(expr); return y != null && Math.abs(x - y) < 0.005;
};
/** Does one row satisfy the whole query? `text` is the row's own searchable text when the caller has a better one than every column. */
export function matchRow(q: string, row: unknown, text?: string): boolean {
  const tokens = (q ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const r = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
  const hay = (text ?? rowText(row)).toLowerCase();
  return tokens.every((tok) => {
    let m: RegExpMatchArray | null;
    if ((m = tok.match(/^#(\d+)$/))) return idMatch(r, Number(m[1])) || hay.includes(tok) || hay.split(/\s+/).includes(m[1]);
    if ((m = tok.match(/^([a-z]{2,5})-(\d+)$/)) && PREFIX_KEYS[m[1]]) return hay.includes(tok) || idMatch(r, Number(m[2]), PREFIX_KEYS[m[1]]);
    if ((m = tok.match(/^([a-z_]+):(.+)$/))) {
      const key = m[1], val = m[2];
      if (key === "id") return idMatch(r, Number(val));
      const vals = fieldsFor(r, key);
      if (!vals.length) return ALIAS[key] && Object.keys(r).length ? false : hay.includes(val); // a known column the row lacks → no match; an unknown word:value → plain text
      if (key === "date" || key === "d") return vals.some((v) => { const day = pkDay(v); return key === "d" ? day.endsWith(`-${val.padStart(2, "0")}`) || day.includes(val) : day.startsWith(val) || day.includes(val); });
      if (/^(>=|<=|>|<)?\s*[\d.,]+(\s*-\s*[\d.,]+)?$/.test(val)) return vals.some((v) => cmpNum(v, val)) || vals.some((v) => String(v ?? "").toLowerCase().includes(val));
      return vals.some((v) => String(v ?? "").toLowerCase().includes(val));
    }
    return hay.includes(tok);
  });
}
/** Short help for the search box tooltip. */
export const SEARCH_HELP = "Tips: #63 · WS-125 · BYP-2 · type:payment · client:green · fuel:hsd · method:cash · by:israr · date:2026-10-28 · amount:>50000 · litre:1000-5000";
