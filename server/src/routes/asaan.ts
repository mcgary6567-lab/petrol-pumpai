/**
 * "Asaan mode" — the simple home for salesmen, cashiers (and anyone who switches it on): one call that gives the
 * few numbers those screens show in big type. Read-only; every number comes from the same books the rest of the app uses.
 *
 *  - my open shift (salesman / anyone on a shift) and what it has sold so far
 *  - the cash in the drawer (galla) — only for a role that may see the cash book
 *  - every tank: litres, % full and how many days of fuel are left at the last 7 days' sale (traffic-light colour)
 */
import { Router } from "express";
import { all, get } from "../db.js";
import { h, tid, can, scopedStation } from "../auth.js";
import { round2 } from "../services.js";
import { cashPosition } from "./backoffice.js";

export const asaan = Router();

const DAYS = 7;
/** green > 3 days, amber 1.5–3, red below 1.5 (order now). No sale history → by % full. */
export const tankLight = (daysLeft: number | null, pct: number) =>
  daysLeft != null ? (daysLeft < 1.5 ? "red" : daysLeft <= 3 ? "amber" : "green") : (pct < 15 ? "red" : pct < 30 ? "amber" : "green");

/** Tanks with litres, % full and days of fuel left (station + product sale over the last 7 days). */
export function tankLevels(t: number, stationId?: number | null) {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const tanks = all(`SELECT k.id, k.name, k.product, k.capacity_l, k.current_l, k.station_id, s.name station_name FROM tanks k JOIN stations s ON s.id=k.station_id
    WHERE s.tenant_id=?${stationId ? " AND k.station_id=?" : ""} ORDER BY s.id, k.product, k.name`, ...(stationId ? [t, stationId] : [t]));
  // a product's sale at a station is shared by all its tanks: days left = all that product's litres ÷ its daily sale
  const sold = new Map<string, number>();
  for (const r of all(`SELECT x.station_id, x.product, COALESCE(SUM(x.litres),0) l FROM sales x JOIN stations s ON s.id=x.station_id
    WHERE s.tenant_id=? AND x.created_at >= ? GROUP BY x.station_id, x.product`, t, since)) sold.set(`${r.station_id}:${r.product}`, Number(r.l));
  const stock = new Map<string, number>();
  for (const k of tanks) stock.set(`${k.station_id}:${k.product}`, (stock.get(`${k.station_id}:${k.product}`) ?? 0) + Number(k.current_l));
  return tanks.map((k) => {
    const key = `${k.station_id}:${k.product}`, perDay = (sold.get(key) ?? 0) / DAYS;
    const pct = k.capacity_l > 0 ? Math.max(0, Math.min(100, Math.round((k.current_l / k.capacity_l) * 100))) : 0;
    const daysLeft = perDay > 1 ? Math.round(((stock.get(key) ?? 0) / perDay) * 10) / 10 : null;
    return { id: k.id, name: k.name, product: k.product, station_name: k.station_name, capacity_l: Math.round(k.capacity_l), current_l: Math.round(k.current_l),
      pct, per_day_l: Math.round(perDay), days_left: daysLeft, light: tankLight(daysLeft, pct) };
  });
}

asaan.get("/asaan/home", h((req) => {
  const t = tid(req), u = req.user!;
  const station = u.role === "salesman" ? scopedStation(req) : null;
  const shift = get(`SELECT sh.id, sh.opened_at, sh.station_id, s.name station_name FROM shifts sh JOIN stations s ON s.id=sh.station_id
    WHERE s.tenant_id=? AND sh.status='open' AND sh.attendant=? ORDER BY sh.id DESC LIMIT 1`, t, u.name);
  const sale = shift ? get("SELECT COALESCE(SUM(amount),0) amount, COALESCE(SUM(litres),0) litres, COUNT(*) n FROM sales WHERE shift_id=?", shift.id)! : null;
  const cash = can(u, "cash.book") || can(u, "expenses.view") ? cashPosition(t).cash_in_hand : null;
  return {
    shift: shift ? { ...shift, sale_amount: round2(Number(sale!.amount)), sale_litres: Math.round(Number(sale!.litres)), sale_n: Number(sale!.n) } : null,
    cash_in_hand: cash,
    tanks: tankLevels(t, station ? Number(station) : null),
  };
}));
