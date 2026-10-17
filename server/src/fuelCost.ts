/**
 * What a litre of each fuel cost us — one answer used by the P&L, the owner dashboard, product margins and the balance sheet.
 *
 *  weighted average of (go-live opening value + purchases into our tanks over the last 120 days) ÷ (their litres)
 *  → else the last purchase rate ever → else the opening rate → else null (no cost known: profit cannot be worked out)
 *
 * The opening value (fuel_opening_values) is what makes a brand-new pump's first days right: before the first tanker, the
 * stock it is selling was bought at that rate, so profit is margin only — never the whole sale.
 */
import { all, get } from "./db.js";
import { round2 } from "./services.js";

const DAY = 86_400_000;

/** The active go-live row of a fuel (null when none was entered). */
export function fuelOpening(t: number, product: string) {
  return get("SELECT * FROM fuel_opening_values WHERE tenant_id=? AND product=? AND voided=0 ORDER BY id DESC LIMIT 1", t, product) ?? null;
}

/** Cost per litre of `product` as known at `toIso` (default now). */
export function fuelCostPerL(t: number, product: string, toIso?: string): number | null {
  const to = toIso ?? new Date().toISOString();
  const since = new Date(Date.parse(to) - 120 * DAY).toISOString();
  const open = fuelOpening(t, product);
  const openIn = open && open.created_at <= to ? open : null;
  const r = get("SELECT COALESCE(SUM(amount),0) a, COALESCE(SUM(litres),0) l FROM supplier_txns WHERE tenant_id=? AND type='purchase' AND trip_id IS NULL AND product=? AND txn_date <= ? AND txn_date >= ?", t, product, to, since)!;
  const litres = Number(r.l) + (openIn ? Number(openIn.litres) : 0);
  const amount = Number(r.a) + (openIn ? Number(openIn.amount) : 0);
  if (litres > 0.001 && amount > 0) return amount / litres;
  const last = get("SELECT rate FROM supplier_txns WHERE tenant_id=? AND type='purchase' AND product=? AND rate > 0 AND txn_date <= ? ORDER BY txn_date DESC LIMIT 1", t, product, to)?.rate;
  if (last) return Number(last);
  return openIn ? Number(openIn.rate) : null;
}

/** Per fuel: the litres sitting in the active tanks right now (what an opening value is booked against). */
export function litresInTanks(t: number): Record<string, number> {
  return Object.fromEntries(all("SELECT tk.product p, COALESCE(SUM(tk.current_l),0) l FROM tanks tk JOIN stations s ON s.id=tk.station_id WHERE s.tenant_id=? AND COALESCE(tk.active,1)=1 GROUP BY tk.product", t).map((x) => [x.p, round2(x.l)]));
}

/** Last purchase rate of a fuel (default for the opening rate box). */
export function lastPurchaseRate(t: number, product: string): number | null {
  return get("SELECT rate FROM supplier_txns WHERE tenant_id=? AND type='purchase' AND product=? AND rate > 0 ORDER BY txn_date DESC LIMIT 1", t, product)?.rate ?? null;
}
