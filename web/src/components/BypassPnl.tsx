/** Bypass munafa as an ERP / accounting statement: period filter, KPI strip, month-by-month P&L with totals (tap a month
 *  for its voucher-wise lines), by fuel and by client, the trend chart, print and Excel. Same figures as the books. */
import { useState } from "react";
import { Download, Printer } from "lucide-react";
import { useApi } from "../lib/api";
import { PRODUCTS, dt, num, pkr } from "../lib/format";
import { Loading } from "./ui";
import { Ur } from "./VoiceShell";
import { BypassVoucher, MonthlyProfitChart } from "../pages/Bypass";

const ym = (offset = 0) => { const d = new Date(Date.now() + 5 * 3600_000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + offset); return d.toISOString().slice(0, 7); };
const MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const mLabel = (m: string) => `${MON[Number(m.slice(5, 7))]} ${m.slice(0, 4)}`;
const PRESETS: { k: string; label: string; r: () => [string, string] }[] = [
  { k: "this", label: "Is mahina", r: () => [ym(), ym()] }, { k: "last", label: "Pichla mahina", r: () => [ym(-1), ym(-1)] },
  { k: "3", label: "3 mahine", r: () => [ym(-2), ym()] }, { k: "6", label: "6 mahine", r: () => [ym(-5), ym()] },
  { k: "12", label: "12 mahine", r: () => [ym(-11), ym()] }, { k: "year", label: "Is saal", r: () => [`${ym().slice(0, 4)}-01`, ym()] },
];
const pct = (v: number | null) => (v == null ? "—" : `${v}%`);
const tone = (v: number) => (v < -0.5 ? "text-rose-700" : "text-emerald-700");

export function BypassPnl() {
  const [preset, setPreset] = useState("6");
  const [[from, to], setRange] = useState<[string, string]>(PRESETS[3].r());
  const [month, setMonth] = useState<string | null>(null);
  const [voucher, setVoucher] = useState<number | null>(null);
  const { data, error } = useApi<any>(`/bypass/pnl?from=${from}&to=${to}${month ? `&month=${month}` : ""}`);
  const csv = () => {
    if (!data) return;
    const L = [["Mahina", "Litre", "Sale (client)", "Cost", "Munafa", "Margin %", "Munafa / L", "Drops"], ...data.months.map((m: any) => [m.month, m.litres, m.sale, m.cost, m.profit, m.margin_pct ?? "", m.per_litre ?? "", m.drops]),
      ["Kul", data.total.litres, data.total.sale, data.total.cost, data.total.profit, data.total.margin_pct ?? "", data.total.per_litre ?? "", data.total.drops]];
    const blob = new Blob([L.map((r) => r.map((c: any) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `bypass-munafa-${from}-${to}.csv`; a.click();
  };
  const T = data?.total;
  return (
    <div className="space-y-4">
      <div className="card p-0 print:hidden">
        <div className="flex items-center gap-3 overflow-x-auto border-b border-slate-100 px-4 py-3">
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Muddat</span>
          <div role="group" className="inline-flex shrink-0 rounded-lg bg-slate-100 p-0.5">
            {PRESETS.map((p) => <button key={p.k} type="button" aria-pressed={preset === p.k} onClick={() => { setPreset(p.k); setRange(p.r()); setMonth(null); }}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium ${preset === p.k ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:text-slate-900"}`}>{p.label}</button>)}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3 px-4 py-3">
          <label className="block"><span className="label">Se (mahina)</span><input className="input" type="month" value={from} max={to} onChange={(e) => { setPreset("custom"); setRange([e.target.value || from, to]); setMonth(null); }} /></label>
          <label className="block"><span className="label">Tak (mahina)</span><input className="input" type="month" value={to} min={from} max={ym()} onChange={(e) => { setPreset("custom"); setRange([from, e.target.value || to]); setMonth(null); }} /></label>
          <div className="ml-auto flex gap-2"><button className="btn-secondary" onClick={() => window.print()}><Printer size={15} /> Print / PDF</button><button className="btn-secondary" onClick={csv}><Download size={15} /> Excel / CSV</button></div>
        </div>
      </div>

      {error ? <p className="text-sm text-rose-700">{String(error)}</p> : !data ? <Loading /> : <>
        <div className="hidden print:block"><h2 className="text-lg font-bold">Bypass munafa · {mLabel(from)} – {mLabel(to)}</h2></div>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 sm:grid-cols-3 lg:grid-cols-6">
          {[["Sale (client ko bill)", pkr(T.sale), ""], ["Cost (delivered)", pkr(T.cost), ""], ["Munafa", pkr(T.profit), tone(T.profit)], ["Margin", pct(T.margin_pct), tone(T.profit)], ["Munafa / litre", T.per_litre == null ? "—" : `Rs ${num(T.per_litre, 2)}`, tone(T.profit)], ["Litre · drops", `${num(T.litres)} L · ${T.drops}`, ""]].map(([l, v, c]) => (
            <div key={l} className="bg-white p-3"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{l}</div><div className={`mt-0.5 text-lg font-bold tabular-nums ${c}`}>{v}</div></div>
          ))}
        </div>

        <div className="card overflow-hidden">
          <div className="flex items-baseline justify-between px-4 pt-4"><h3 className="font-semibold">Nafa-nuqsan · mahine-war · <Ur>ماہانہ نفع نقصان</Ur></h3><span className="text-xs text-slate-500 print:hidden">Mahine par tap karein: voucher-war tafseel</span></div>
          <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[760px] text-sm">
            <thead><tr><th className="th">Mahina</th><th className="th text-right">Litre</th><th className="th text-right">Sale</th><th className="th text-right">Cost</th><th className="th text-right">Munafa</th><th className="th text-right">Margin</th><th className="th text-right">Munafa / L</th><th className="th text-right">Drops</th></tr></thead>
            <tbody className="tabular-nums">{data.months.map((m: any) => (
              <tr key={m.month} onClick={() => setMonth(month === m.month ? null : m.month)} className={`cursor-pointer border-t hover:bg-slate-50 ${month === m.month ? "bg-brand-50" : ""}`}>
                <td className="td font-medium">{mLabel(m.month)}{month === m.month ? " ▾" : ""}</td><td className="td text-right">{num(m.litres)}</td><td className="td text-right">{pkr(m.sale)}</td><td className="td text-right">{pkr(m.cost)}</td>
                <td className={`td text-right font-semibold ${tone(m.profit)}`}>{pkr(m.profit)}</td><td className="td text-right">{pct(m.margin_pct)}</td><td className="td text-right">{m.per_litre == null ? "—" : num(m.per_litre, 2)}</td><td className="td text-right">{m.drops}</td>
              </tr>))}</tbody>
            <tfoot><tr className="border-t-2 bg-slate-50 font-bold tabular-nums"><td className="td">Kul jama · <Ur>کل</Ur></td><td className="td text-right">{num(T.litres)}</td><td className="td text-right">{pkr(T.sale)}</td><td className="td text-right">{pkr(T.cost)}</td><td className={`td text-right ${tone(T.profit)}`}>{pkr(T.profit)}</td><td className="td text-right">{pct(T.margin_pct)}</td><td className="td text-right">{T.per_litre == null ? "—" : num(T.per_litre, 2)}</td><td className="td text-right">{T.drops}</td></tr></tfoot>
          </table></div>
          {month && (
            <div className="border-t bg-slate-50/60 p-3">
              <div className="mb-2 text-sm font-semibold">{mLabel(month)} · voucher-war tafseel · {data.lines.length} drops</div>
              <div className="overflow-x-auto rounded-lg bg-white ring-1 ring-slate-200"><table className="w-full min-w-[820px] text-sm">
                <thead><tr><th className="th">Tareekh</th><th className="th">Voucher</th><th className="th">Client</th><th className="th">Fuel</th><th className="th text-right">Litre</th><th className="th text-right">Sale rate</th><th className="th text-right">Sale</th><th className="th text-right">Cost rate</th><th className="th text-right">Cost</th><th className="th text-right">Munafa</th></tr></thead>
                <tbody className="tabular-nums">{data.lines.map((l: any) => (
                  <tr key={l.id} className="border-t"><td className="td whitespace-nowrap">{dt(l.txn_date)}</td><td className="td">{l.delivery_id ? <button type="button" className="font-mono text-brand-700 underline" onClick={() => setVoucher(l.delivery_id)}>BYP-{l.delivery_id}</button> : "—"}</td><td className="td">{l.client}</td><td className="td">{PRODUCTS[l.product] ?? l.product}</td>
                    <td className="td text-right">{num(l.litres)}</td><td className="td text-right">{num(l.sale_rate, 2)}</td><td className="td text-right">{pkr(l.sale)}</td><td className="td text-right">{num(l.unit_cost, 2)}</td><td className="td text-right">{pkr(l.cost_amount)}</td><td className={`td text-right font-semibold ${tone(l.profit)}`}>{pkr(l.profit)}</td></tr>))}
                  {!data.lines.length && <tr><td className="td text-center text-slate-500" colSpan={10}>Is mahine koi drop nahi</td></tr>}</tbody>
              </table></div>
            </div>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {([["Fuel-war · فیول", data.by_fuel, (r: any) => PRODUCTS[r.product] ?? r.product], ["Client-war · کلائنٹ", data.by_client, (r: any) => r.client]] as const).map(([title, rows, name]) => (
            <div key={title} className="card overflow-hidden">
              <h3 className="px-4 pt-4 font-semibold">{title}</h3>
              <div className="mt-2 overflow-x-auto"><table className="w-full text-sm">
                <thead><tr><th className="th"></th><th className="th text-right">Litre</th><th className="th text-right">Sale</th><th className="th text-right">Munafa</th><th className="th text-right">Margin</th></tr></thead>
                <tbody className="tabular-nums">{(rows as any[]).map((r, i) => <tr key={i} className="border-t"><td className="td font-medium">{(name as any)(r)}</td><td className="td text-right">{num(r.litres)}</td><td className="td text-right">{pkr(r.sale)}</td><td className={`td text-right font-semibold ${tone(r.profit)}`}>{pkr(r.profit)}</td><td className="td text-right">{pct(r.margin_pct)}</td></tr>)}
                  {!(rows as any[]).length && <tr><td className="td text-center text-slate-500" colSpan={5}>Kuch nahi</td></tr>}</tbody>
              </table></div>
            </div>
          ))}
        </div>
        <div className="print:hidden"><MonthlyProfitChart data={data.months.map((m: any) => ({ month: m.month, billed: m.sale, cost: m.cost, profit: m.profit }))} /></div>
      </>}
      {voucher != null && <BypassVoucher id={voucher} onClose={() => setVoucher(null)} />}
    </div>
  );
}
