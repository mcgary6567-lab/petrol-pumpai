import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ResponsiveContainer, ComposedChart, Bar, Line, LineChart, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import { Download, Printer, ArrowDownLeft, ArrowUpRight, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { useApi } from "../lib/api";
import { Badge, Empty, ErrorBox, Loading, PageHeader, SearchBar, Stat, matchQuery } from "../components/ui";
import { Ur } from "../components/VoiceShell";
import { PRODUCTS, PRODUCT_COLORS, ago, dt, num, pkr, pkrShort } from "../lib/format";

/** English + Urdu together, bank-app style. Urdu sits under or beside the English. */
const Lbl = ({ en, ur, block }: { en: string; ur: string; block?: boolean }) =>
  block ? <>{en}<Ur className="mt-0.5 block text-[11px] font-normal opacity-70">{ur}</Ur></> : <>{en} · <Ur className="opacity-70">{ur}</Ur></>;

/**
 * "vs last period" change, like a bank statement's up/down arrow. Green when the move is good for the owner
 * (more revenue/profit, LESS expense), red when it's bad. `lowerIsBetter` flips the colour for cost lines.
 */
function Delta({ now, prev, lowerIsBetter = false, money = true }: { now: number; prev?: number; lowerIsBetter?: boolean; money?: boolean }) {
  if (prev == null || !isFinite(prev)) return null;
  const diff = now - prev;
  const pct = prev !== 0 ? (diff / Math.abs(prev)) * 100 : now !== 0 ? 100 : 0;
  const flat = Math.abs(pct) < 0.05;
  const good = flat ? null : lowerIsBetter ? diff < 0 : diff > 0;
  const cls = good == null ? "text-slate-400" : good ? "text-emerald-600" : "text-rose-600";
  const Icon = flat ? Minus : diff > 0 ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${cls}`} title="Pichhle barabar period se">
      <Icon size={12} />{flat ? "—" : `${diff > 0 ? "+" : "−"}${Math.abs(pct).toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%`}
      <span className="font-normal text-slate-400">{diff !== 0 ? `(${diff > 0 ? "+" : "−"}${money ? pkrShort(Math.abs(diff)) : num(Math.abs(diff))})` : ""}</span>
    </span>
  );
}

const DAY = 86_400_000;
const PRESETS = [
  { key: "24h", label: "24 hours", ur: "24 گھنٹے", days: 1 }, { key: "7d", label: "7 days", ur: "7 دن", days: 7 }, { key: "1m", label: "1 month", ur: "1 مہینہ", days: 30 },
  { key: "6m", label: "6 months", ur: "6 مہینے", days: 182 }, { key: "1y", label: "1 year", ur: "1 سال", days: 365 }, { key: "custom", label: "Custom", ur: "اپنی مرضی", days: 0 },
];
const TABS = [
  ["overview", "Overview", "خلاصہ"], ["sales", "Sales", "فروخت"], ["stock", "Stock", "اسٹاک"], ["expenses", "Expenses", "اخراجات"], ["receivables", "Receivables (owed to us)", "ہمارا باقی"],
  ["payables", "Payables (we owe)", "ہم پر باقی"], ["khata", "Khata", "کھاتہ"], ["wholesale", "Wholesale", "ہول سیل"], ["shifts", "Shifts & cash", "شفٹ اور کیش"],
] as const;
type Tab = (typeof TABS)[number][0];

/* ---------- tiny table + CSV helpers ---------- */
type Col = { h: string; v: (r: any) => ReactNode; csv?: (r: any) => unknown; right?: boolean };
type TableDef = { title: string; rows: any[]; cols: Col[] };

// Urdu for the common table headers across every tab — applied by a lookup so column definitions stay untouched.
const TH_UR: Record<string, string> = {
  "Date": "تاریخ", "Period": "عرصہ", "Product": "پراڈکٹ", "Station": "اسٹیشن", "Meter": "میٹر", "Method": "طریقہ",
  "Litres": "لیٹر", "Amount": "رقم", "Transactions": "لین دین", "Shifts": "شفٹیں", "Salesmen": "سیلزمین",
  "Customer": "گاہک", "Type": "قسم", "Visits": "چکر", "Name": "نام", "Phone": "فون", "Reason": "وجہ",
  "Category": "قسم", "Paid to": "کس کو دیا", "Note": "نوٹ", "By": "کس نے", "Entries": "انٹریز", "Entered by": "داخل کیا",
  "Credit given": "ادھار دیا", "Collected": "وصول", "Balance now": "موجودہ بیلنس", "Limit": "حد", "Credit limit": "ادھار کی حد",
  "Amount due": "باقی رقم", "Last payment": "آخری ادائیگی", "Aging": "عمر", "Client": "کلائنٹ",
  "Supplied L": "سپلائی لیٹر", "Returned L": "واپس لیٹر", "Net billed": "خالص بل", "Received": "وصول", "Due now": "ابھی باقی",
  "Net litres": "خالص لیٹر", "Attendant": "سیلزمین", "Expected": "متوقع", "Counted": "گنا", "Variance": "فرق", "Worst": "بدترین",
  "Retail": "ریٹیل", "Expenses": "اخراجات", "Petrol L": "پیٹرول لیٹر", "Hi-Octane L": "ہائی آکٹین لیٹر", "Diesel L": "ڈیزل لیٹر",
  "Wholesale": "ہول سیل", "Wholesale L": "ہول سیل لیٹر", "Tank": "ٹینک", "Capacity": "گنجائش", "Stock L": "اسٹاک لیٹر",
  "Cost": "لاگت", "Tanker": "ٹینکر", "Supplier": "سپلائر", "Invoice L": "انوائس لیٹر", "Rate": "ریٹ", "Opening": "ابتدائی",
};
/** English column header with its Urdu underneath (when known). */
const Th = ({ h }: { h: string }) => (<>{h}{TH_UR[h] ? <Ur className="block text-[10px] font-normal opacity-60">{TH_UR[h]}</Ur> : null}</>);

/** Dependency-free sparkline: a tiny trend line for a KPI card. */
function Sparkline({ data, color = "#2a78d6", width = 108, height = 26 }: { data: number[]; color?: string; width?: number; height?: number }) {
  const pts = (data ?? []).filter((n) => typeof n === "number" && isFinite(n));
  if (pts.length < 2) return null;
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const dx = width / (pts.length - 1);
  const xy = pts.map((v, i) => [i * dx, height - 2 - ((v - min) / span) * (height - 4)]);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible" aria-hidden>
      <path d={area} fill={color} opacity={0.08} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r={2} fill={color} />
    </svg>
  );
}

function Table({ title, rows, cols }: TableDef) {
  const [q, setQ] = useState("");
  // searchable text of a row = each column's CSV value (or its plain string/number cell)
  const textOf = (c: Col, r: any) => { const x = c.csv ? c.csv(r) : c.v(r); return typeof x === "string" || typeof x === "number" ? x : ""; };
  const shown = q.trim() ? rows.filter((r) => matchQuery(q, ...cols.map((c) => textOf(c, r)))) : rows;
  return (
    // a short table stays on one page; a long one runs on (else it jumps whole to the next page and leaves half a page blank)
    <div className={`card overflow-hidden ${shown.length <= 12 ? "break-inside-avoid" : ""}`}>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-3">
        <h3 className="text-sm font-semibold">{title} <span className="font-normal text-slate-400">({shown.length}{q.trim() && shown.length !== rows.length ? ` / ${rows.length}` : ""})</span></h3>
        {rows.length > 8 && <SearchBar value={q} onChange={setQ} placeholder="Is table mein dhoondein…" className="ml-auto w-full max-w-xs print:hidden" />}
      </div>
      {shown.length ? (<>
        {/* phone: one card per row — names on top, every number with its label */}
        <ul className="max-h-[520px] divide-y divide-slate-100 overflow-auto border-t border-slate-100 sm:hidden print:hidden">
          {shown.map((r, i) => {
            const names = cols.filter((c) => !c.right), nums = cols.filter((c) => c.right);
            return (
              <li key={i} className="px-4 py-2.5 text-sm">
                <div className="min-w-0">{names.map((c, j) => <span key={c.h} className={j === 0 ? "block font-medium" : "mr-2 text-xs text-slate-500"}>{c.v(r)}</span>)}</div>
                {nums.length > 0 && <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">{nums.map((c) => <span key={c.h} className="whitespace-nowrap">{c.h}{TH_UR[c.h] ? <Ur className="opacity-60"> {TH_UR[c.h]}</Ur> : null} <b className="tabular-nums text-slate-800">{c.v(r)}</b></span>)}</div>}
              </li>
            );
          })}
        </ul>
        <div className="hidden max-h-[480px] overflow-auto sm:block print:block print:max-h-none">
          <table className="w-full">
            <thead className="sticky top-0"><tr>{cols.map((c) => <th key={c.h} className={`th ${c.right ? "text-right" : ""}`}><Th h={c.h} /></th>)}</tr></thead>
            <tbody>{shown.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c.h} className={`td text-sm ${c.right || c.h === "Date" ? "whitespace-nowrap" : ""} ${c.right ? "text-right tabular-nums" : ""}`}>{c.v(r)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </>) : <Empty>Is period mein kuch nahi · <Ur>اس عرصے میں کچھ نہیں</Ur></Empty>}
    </div>
  );
}

function downloadCsv(name: string, tables: TableDef[]) {
  const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const text = (x: ReactNode | unknown) => (typeof x === "string" || typeof x === "number" ? x : "");
  const lines: string[] = [];
  for (const t of tables) {
    lines.push(esc(t.title), t.cols.map((c) => esc(c.h)).join(","));
    for (const r of t.rows) lines.push(t.cols.map((c) => esc(c.csv ? c.csv(r) : text(c.v(r)))).join(","));
    lines.push("");
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
  a.download = `${name}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const money = (k: string): Col => ({ h: "", v: (r) => pkr(r[k]), csv: (r) => Math.round(r[k] ?? 0), right: true });
const m = (h: string, k: string): Col => ({ ...money(k), h });
const l = (h: string, k: string): Col => ({ h, v: (r) => num(r[k]), csv: (r) => Math.round(r[k] ?? 0), right: true });
const txt = (h: string, k: string | ((r: any) => string)): Col => ({ h, v: (r) => (typeof k === "function" ? k(r) : r[k]) ?? "—" });

const localInput = (iso: string) => new Date(Date.parse(iso) + 5 * 3600_000).toISOString().slice(0, 16); // Pakistan time for <input type=datetime-local>
const fromLocal = (v: string) => new Date(Date.parse(v + ":00Z") - 5 * 3600_000).toISOString();

export default function Reports() {
  const [preset, setPreset] = useState("1m");
  const [custom, setCustom] = useState({ from: localInput(new Date(Date.now() - 7 * DAY).toISOString()), to: localInput(new Date().toISOString()) });
  const [tab, setTab] = useState<Tab>("overview");
  const [nowKey] = useState(() => Date.now());

  const { from, to } = useMemo(() => {
    if (preset === "custom") return { from: fromLocal(custom.from), to: fromLocal(custom.to) };
    const days = PRESETS.find((p) => p.key === preset)!.days;
    return { from: new Date(nowKey - days * DAY).toISOString(), to: new Date(nowKey).toISOString() };
  }, [preset, custom, nowKey]);

  const { data: r, error, loading } = useApi<any>(`/reports?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const tables = r ? tablesFor(tab, r) : [];
  const periodLabel = `${dt(from)} → ${dt(to)}`;

  return (
    <div className="space-y-5">
      <PageHeader title={<Lbl en="Reports" ur="رپورٹس" />} subtitle={`Pakistan time · ${periodLabel}`}
        actions={<div className="flex gap-2 print:hidden">
          <button className="btn-secondary" disabled={!r} onClick={() => downloadCsv(`pumpai-${tab}-${from.slice(0, 10)}_${to.slice(0, 10)}`, tables)}><Download size={15} /> Excel / CSV</button>
          <button className="btn-secondary" onClick={() => window.print()}><Printer size={15} /> Print / PDF · <Ur>پرنٹ</Ur></button>
        </div>} />

      <div className="flex flex-wrap items-end gap-2 print:hidden">
        {PRESETS.map((p) => (
          <button key={p.key} onClick={() => setPreset(p.key)} className={`min-h-10 rounded-full px-4 py-1.5 text-sm ${preset === p.key ? "bg-brand-600 text-white" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>{p.label} <Ur className="text-[11px] opacity-80">{p.ur}</Ur></button>
        ))}
        {preset === "custom" && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-600">From<input className="input mt-0.5" type="datetime-local" value={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} /></label>
            <label className="text-xs text-slate-600">To<input className="input mt-0.5" type="datetime-local" value={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} /></label>
          </div>
        )}
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-slate-200 print:hidden">
        {TABS.map(([k, label, ur]) => (
          <button key={k} onClick={() => setTab(k)} className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === k ? "border-brand-600 font-medium text-brand-700" : "border-transparent text-slate-600 hover:text-slate-900"}`}>{label} <Ur className="text-[11px] opacity-80">{ur}</Ur></button>
        ))}
      </div>
      <h2 className="hidden text-lg font-semibold print:block">{TABS.find(([k]) => k === tab)![1]} · <Ur>{TABS.find(([k]) => k === tab)![2]}</Ur></h2>

      {error && <ErrorBox error={error} />}
      {!r || loading ? <Loading /> : (
        <div className="space-y-5">
          {tab === "overview" && <Overview r={r} />}
          {tab === "sales" && <SalesHead r={r} />}
          {tab === "stock" && <StockHead r={r} />}
          {tab === "expenses" && <ExpensesHead r={r} />}
          {tab === "receivables" && <ReceivablesHead r={r} />}
          {tab === "payables" && <PayablesHead r={r} />}
          {tab === "khata" && <div className="grid grid-cols-3 gap-3"><Stat label={<Lbl en="Credit given" ur="ادھار دیا" block />} value={pkrShort(r.khata.given)} /><Stat label={<Lbl en="Collected" ur="وصول ہوا" block />} value={pkrShort(r.khata.collected)} tone="green" /><Stat label={<Lbl en="Net change" ur="خالص تبدیلی" block />} value={pkrShort(r.khata.net_change)} tone={r.khata.net_change > 0 ? "amber" : "green"} hint="Positive = more credit given than collected" /></div>}
          {tab === "wholesale" && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label={<Lbl en="Supplied" ur="سپلائی" block />} value={`${num(r.wholesale.supplied_l)} L`} hint={`Returned ${num(r.wholesale.returned_l)} L`} /><Stat label={<Lbl en="Net billed" ur="خالص بل" block />} value={pkrShort(r.wholesale.net_billed)} /><Stat label={<Lbl en="Received" ur="وصول" block />} value={pkrShort(r.wholesale.received)} tone="green" /><Stat label={<Lbl en="Due now (all clients)" ur="ابھی باقی" block />} value={pkrShort(r.receivables.wholesale_total)} tone="amber" /></div>}
          {tab === "shifts" && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label={<Lbl en="Closed shifts" ur="بند شفٹیں" block />} value={r.shifts.totals.n} /><Stat label={<Lbl en="Cash expected" ur="متوقع کیش" block />} value={pkrShort(r.shifts.totals.expected)} /><Stat label={<Lbl en="Cash counted" ur="گنا ہوا کیش" block />} value={pkrShort(r.shifts.totals.counted)} /><Stat label={<Lbl en="Total variance" ur="کل فرق" block />} value={pkr(r.shifts.totals.variance)} tone={r.shifts.totals.variance < -1000 ? "red" : "green"} /></div>}
          <div className={`grid gap-5 ${tables.length > 1 ? "xl:grid-cols-2" : ""}`}>{tables.map((t) => <Table key={t.title} {...t} />)}</div>
        </div>
      )}
    </div>
  );
}

/** One plain-language line: what happened this period, in Roman Urdu + Urdu. Rule-based (no AI key needed), always consistent. */
function smartSummary(r: any): { en: string; ur: string } {
  const s = r.summary, prev = s.prev, en: string[] = [], ur: string[] = [];
  if (prev && s.net_profit_estimate != null) {
    const d = s.net_profit_estimate - prev.net_profit_estimate;
    const pct = prev.net_profit_estimate ? Math.round(Math.abs((d / prev.net_profit_estimate) * 100)) : null;
    if (Math.abs(d) < 1) { en.push("Munafa pichle period jaisa hi raha"); ur.push("منافع تقریباً وہی رہا"); }
    else { en.push(`Munafa ${d > 0 ? "barha" : "gira"}${pct != null ? ` ${pct}%` : ""} (${pkrShort(Math.abs(d))})`); ur.push(`منافع ${d > 0 ? "بڑھا" : "گرا"}${pct != null ? ` ${pct}%` : ""}`); }
  } else { en.push(`Is period munafa ${pkrShort(s.net_profit_estimate ?? 0)}`); ur.push(`اس عرصے منافع ${pkrShort(s.net_profit_estimate ?? 0)}`); }
  const bp = [...(r.sales?.by_product ?? [])].sort((a, b) => b.litres - a.litres)[0];
  if (bp?.litres > 0) { en.push(`sab se zyada ${PRODUCTS[bp.product] ?? bp.product} bika (${num(bp.litres)} L)`); ur.push(`سب سے زیادہ ${PRODUCTS[bp.product] ?? bp.product} بکا`); }
  const be = r.expenses?.by_category?.[0];
  if (be) { en.push(`sab se bara kharcha ${be.category} (${pkrShort(be.amount)})`); ur.push(`سب سے بڑا خرچ ${be.category}`); }
  return { en: en.join(" · "), ur: ur.join(" · ") };
}

/** Red-flags the owner should act on, derived from the period's numbers — so nothing has to be hunted for. */
function healthSignals(r: any): { tone: "red" | "amber"; en: string; ur: string }[] {
  const s = r.summary, out: { tone: "red" | "amber"; en: string; ur: string }[] = [];
  if (s.net_profit_estimate != null && s.net_profit_estimate < 0) out.push({ tone: "red", en: "Is period net LOSS hai", ur: "اس عرصے میں نقصان ہے" });
  else if (s.prev && s.net_profit_estimate != null && s.prev.net_profit_estimate > 0) {
    const drop = (s.prev.net_profit_estimate - s.net_profit_estimate) / s.prev.net_profit_estimate;
    if (drop >= 0.2) out.push({ tone: "amber", en: `Munafa pichle period se ${Math.round(drop * 100)}% kam hua`, ur: "منافع نمایاں کم ہوا" });
  }
  if (s.cost_assumed_products?.length) out.push({ tone: "amber", en: `${s.cost_assumed_products.join(", ")}: khareed rate nahi — munafa theek nahi aa raha, Opening balances me rate daalein`, ur: "خرید ریٹ درج کریں" });
  const aging90 = r.receivables?.aging?.find((a: any) => a.bucket === "90+ days");
  if (aging90 && aging90.amount > 0) out.push({ tone: "red", en: `${aging90.count} account 90+ din se baqi: ${pkrShort(aging90.amount)} — wasooli karein`, ur: "پرانا ادھار وصول کریں" });
  if (r.payables?.pending_expenses?.count > 0) out.push({ tone: "amber", en: `${r.payables.pending_expenses.count} kharche approval ke muntazir: ${pkrShort(r.payables.pending_expenses.amount)}`, ur: "منظوری باقی" });
  if (r.shifts?.totals?.variance < -1000) out.push({ tone: "red", en: `Shift cash ${pkrShort(Math.abs(r.shifts.totals.variance))} kam nikla`, ur: "کیش کم نکلا" });
  for (const t of (r.stock?.tanks ?? []).filter((t: any) => typeof t.days_to_empty === "number" && isFinite(t.days_to_empty) && t.days_to_empty <= 3))
    out.push({ tone: "amber", en: `${t.station} — ${t.tank} (${PRODUCTS[t.product] ?? t.product}) ~${t.days_to_empty} din mein khali, order karein`, ur: "ٹینک خالی ہونے والا" });
  return out;
}

/** Bank-style Profit & Loss statement for the period — revenue down to net profit, each line bilingual, prints cleanly. */
function ProfitLoss({ r }: { r: any }) {
  const s = r.summary;
  if (s.gross_profit_estimate == null) return null;
  const shopCost = Math.max(0, (s.shop_sales ?? 0) - (s.shop_profit ?? 0));
  const other = (s.rent_income ?? 0) + (s.carriage_income ?? 0);
  const rows: { k: string; ur: string; v: number; bold?: boolean; hl?: boolean; sub?: boolean; hide?: boolean }[] = [
    { k: "Revenue (sales)", ur: "کل آمدن", v: s.revenue, bold: true },
    { k: "Retail fuel", ur: "ریٹیل تیل", v: s.retail_sales, sub: true },
    { k: "Wholesale (net)", ur: "ہول سیل", v: s.wholesale_net, sub: true },
    { k: "Shop", ur: "شاپ", v: s.shop_sales ?? 0, sub: true, hide: !s.shop_sales },
    { k: "− Cost of fuel / goods sold", ur: "بیچے مال کی لاگت", v: -(s.fuel_cost_estimate + shopCost) },
    { k: "= Gross profit", ur: "مجموعی منافع", v: s.gross_profit_estimate, bold: true, hl: true },
    { k: "− Operating expenses", ur: "چلانے کے اخراجات", v: -s.expenses },
    { k: "+ Other income (rent, carriage)", ur: "دیگر آمدن (کرایہ، ڈھلائی)", v: other, hide: !other },
    { k: "= Net profit", ur: "خالص منافع", v: s.net_profit_estimate, bold: true, hl: true },
  ];
  return (
    <div className="card break-inside-avoid p-4">
      <h3 className="mb-2 text-sm font-semibold">Profit &amp; Loss (est.) · <Ur className="text-slate-500">نفع و نقصان</Ur></h3>
      <div className="divide-y divide-slate-100">
        {rows.filter((x) => !x.hide).map((x) => (
          <div key={x.k} className={`flex items-center justify-between py-1.5 text-sm ${x.hl ? "bg-slate-50 px-2 font-semibold" : x.bold ? "font-semibold" : x.sub ? "pl-4 text-slate-500" : ""}`}>
            <span className="min-w-0">{x.k} <Ur className="ml-1 text-[11px] text-slate-400">{x.ur}</Ur></span>
            <span className={`shrink-0 tabular-nums ${x.v < 0 ? "text-rose-700" : x.hl ? "text-slate-900" : ""}`}>{x.v < 0 ? `− ${pkr(Math.abs(x.v))}` : pkr(x.v)}</span>
          </div>
        ))}
      </div>
      {s.cost_assumed_products?.length ? <p className="mt-2 text-[11px] text-amber-700">Note: {s.cost_assumed_products.join(", ")} ka khareed rate nahi mila — unki cost pump price par mani gayi (0 margin). Opening balances me rate daalein to munafa sahi aayega.</p> : null}
    </div>
  );
}

/* ---------- headers / charts per tab ---------- */
function Overview({ r }: { r: any }) {
  const s = r.summary;
  const est = s.gross_profit_estimate != null;
  const prev = s.prev;
  const margin = s.revenue ? (s.net_profit_estimate / s.revenue) * 100 : null;
  // per-bucket trend lines for the KPI sparklines (from the same data the chart below uses)
  const revSeries = (r.trend ?? []).map((b: any) => (b.retail ?? 0) + (b.wholesale ?? 0));
  const expSeries = (r.trend ?? []).map((b: any) => b.expenses ?? 0);
  const summ = smartSummary(r);
  const signals = healthSignals(r);
  return (
    <>
      {/* bank-statement style account band: the period's bottom line at a glance, with last-period comparison */}
      <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-brand-700 to-brand-900 p-4 text-white shadow-sm sm:p-5 print:hidden">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-white/70">Net profit (est.) · <Ur>خالص منافع</Ur></div>
            <div className="mt-1 text-3xl font-bold tabular-nums sm:text-4xl">{est ? pkr(s.net_profit_estimate) : "—"}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/80">
              {prev && est && <span className="rounded-full bg-white/15 px-2 py-0.5"><Delta now={s.net_profit_estimate} prev={prev.net_profit_estimate} /></span>}
              {margin != null && <span>Margin {margin.toFixed(1)}% · <Ur>مارجن</Ur></span>}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 text-right">
            {[["Revenue", "آمدن", s.revenue, prev?.revenue, false], ["Expenses", "اخراجات", s.expenses, prev?.expenses, true], ["Gross profit", "مجموعی منافع", s.gross_profit_estimate, prev?.gross_profit_estimate, false]].map(([en, ur, now, pv, low]: any) => (
              <div key={en}>
                <div className="text-[11px] uppercase tracking-wide text-white/60">{en}</div>
                <div className="text-sm font-semibold tabular-nums sm:text-lg">{now != null ? pkrShort(now) : "—"}</div>
                <Ur className="block text-[10px] text-white/50">{ur}</Ur>
                {prev && now != null && <div className="mt-0.5 text-[11px]"><Delta now={now} prev={pv} lowerIsBetter={low} money={false} /></div>}
              </div>
            ))}
          </div>
        </div>
        {prev && <div className="mt-3 border-t border-white/15 pt-2 text-[11px] text-white/60">Comparison: pichhle barabar period se ({dt(prev.from)} → {dt(prev.to)}) · <Ur>پچھلے عرصے سے موازنہ</Ur></div>}
      </div>

      {/* plain-language one-liner: what this period looks like, both scripts */}
      <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
        <span className="mr-1 font-semibold text-slate-700">Khulasa:</span>{summ.en}
        {summ.ur && <Ur className="mt-0.5 block text-xs text-slate-500">{summ.ur}</Ur>}
      </div>

      {/* red-flags to act on */}
      {signals.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 print:hidden">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-800">Dhyan dein · <Ur>توجہ طلب</Ur> <span className="font-normal">({signals.length})</span></div>
          <ul className="space-y-1 text-sm">
            {signals.map((g, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${g.tone === "red" ? "bg-rose-500" : "bg-amber-500"}`} />
                <span className="min-w-0">{g.en} <Ur className="text-xs text-slate-500">{g.ur}</Ur></span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={<Lbl en="Total revenue" ur="کل آمدن" block />} value={pkrShort(s.revenue)} tone="green" hint={<>Retail {pkrShort(s.retail_sales)} ({num(s.retail_litres)} L) · Wholesale {pkrShort(s.wholesale_net)} ({num(s.wholesale_litres)} L){prev && <div className="mt-0.5"><Delta now={s.revenue} prev={prev.revenue} /></div>}<Sparkline data={revSeries} color="#16a34a" /></>} />
        <Stat label={<Lbl en="Expenses" ur="اخراجات" block />} value={pkrShort(s.expenses)} tone="red" hint={<>{r.expenses.count} entries{prev && <div className="mt-0.5"><Delta now={s.expenses} prev={prev.expenses} lowerIsBetter /></div>}<Sparkline data={expSeries} color="#e11d48" /></>} />
        <Stat label={<Lbl en="Gross profit (est.)" ur="مجموعی منافع" block />} value={est ? pkrShort(s.gross_profit_estimate) : "—"} tone="blue" hint={<>{est ? (s.cost_assumed_products?.length ? `${s.cost_assumed_products.join(", ")}: khareed rate nahi, pump price par cost mana (0 margin) — Opening balances me rate likhein` : `Revenue − fuel cost ${pkrShort(s.fuel_cost_estimate)}`) : "Add purchase rates on deliveries"}{prev && est && <div className="mt-0.5"><Delta now={s.gross_profit_estimate} prev={prev.gross_profit_estimate} /></div>}</>} />
        <Stat label={<Lbl en="Net profit (est.)" ur="خالص منافع" block />} value={est ? pkrShort(s.net_profit_estimate) : "—"} tone={est && s.net_profit_estimate < 0 ? "red" : "green"} hint={<>Gross profit − expenses{prev && est && <div className="mt-0.5"><Delta now={s.net_profit_estimate} prev={prev.net_profit_estimate} /></div>}</>} />
      </div>

      <ProfitLoss r={r} />

      {/* this period vs the one before it, side by side — each metric scaled to its own pair so nothing drowns out */}
      {prev && <div className="card p-4">
        <h3 className="mb-3 text-sm font-semibold">Is period vs pichla · <Ur className="text-slate-500">اس عرصے کا پچھلے سے موازنہ</Ur></h3>
        <div className="space-y-3">
          {[["Revenue", "آمدن", s.revenue, prev.revenue, "#16a34a"], ["Expenses", "اخراجات", s.expenses, prev.expenses, "#e11d48"], ["Net profit", "خالص منافع", s.net_profit_estimate, prev.net_profit_estimate, "#2a78d6"]].map(([en, ur, now, pv, c]: any) => {
            const mx = Math.max(Math.abs(now ?? 0), Math.abs(pv ?? 0)) || 1;
            return (
              <div key={en} className="text-xs">
                <div className="mb-1 flex justify-between"><span className="font-medium text-slate-700">{en} · <Ur className="text-slate-400">{ur}</Ur></span></div>
                <div className="flex items-center gap-2"><span className="w-20 shrink-0 text-slate-500">Ab · <Ur>اب</Ur></span><div className="h-3 flex-1 rounded-full bg-slate-100"><div className="h-full rounded-full" style={{ width: `${(Math.abs(now ?? 0) / mx) * 100}%`, background: c }} /></div><span className="w-24 shrink-0 text-right font-semibold tabular-nums">{pkrShort(now ?? 0)}</span></div>
                <div className="mt-1 flex items-center gap-2"><span className="w-20 shrink-0 text-slate-400">Pichla · <Ur>پچھلا</Ur></span><div className="h-3 flex-1 rounded-full bg-slate-100"><div className="h-full rounded-full bg-slate-300" style={{ width: `${(Math.abs(pv ?? 0) / mx) * 100}%` }} /></div><span className="w-24 shrink-0 text-right tabular-nums text-slate-500">{pkrShort(pv ?? 0)}</span></div>
              </div>
            );
          })}
        </div>
      </div>}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><ArrowDownLeft size={15} className="text-emerald-600" /> Money in · <Ur className="text-slate-500">پیسہ آیا</Ur></h3>
          {[["Cash sales", "کیش فروخت", s.money_in.cash_sales], ["Digital (JazzCash, Easypaisa, Raast, card)", "ڈیجیٹل", s.money_in.digital_sales], ["Khata collected", "کھاتہ وصول", s.money_in.khata_collected], ["Wholesale payments received", "ہول سیل وصولی", s.money_in.wholesale_received]].map(([k, u, v]) => <Row key={k as string} k={k as string} ur={u as string} v={pkr(v as number)} />)}
          <Row k="Total" ur="کل" v={pkr(Object.values(s.money_in).reduce((a: number, b: any) => a + b, 0) as number)} bold />
        </div>
        <div className="card p-4">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><ArrowUpRight size={15} className="text-red-600" /> Money out · <Ur className="text-slate-500">پیسہ گیا</Ur></h3>
          <Row k="Expenses" ur="اخراجات" v={pkr(s.money_out.expenses)} />
          <Row k="Paid to fuel suppliers" ur="سپلائر کو ادائیگی" v={pkr(s.money_out.supplier_payments)} />
          <Row k="Fuel purchased in period (cost)" ur="خریدا گیا تیل (لاگت)" v={pkr(s.purchases_cost)} muted />
          {r.stock.direct?.cost > 0 && <Row k={`Depot direct to clients (${num(r.stock.direct.litres)} L, not in stock)`} v={pkr(r.stock.direct.cost)} muted />}
          <Row k="Shift cash variance" ur="شفٹ کیش فرق" v={pkr(s.cash_variance)} muted />
          <Row k="Total paid out" ur="کل ادائیگی" v={pkr(s.money_out.expenses + s.money_out.supplier_payments)} bold />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Owed to us (now)" value={pkrShort(r.receivables.total)} tone="amber" hint={`Khata ${pkrShort(r.receivables.khata_total)} · Wholesale ${pkrShort(r.receivables.wholesale_total)}`} />
        <Stat label="We owe (now)" value={pkrShort(r.payables.total)} tone="red" hint={`Suppliers ${pkrShort(r.payables.suppliers_total)}`} />
        <Stat label="Stock now" value={`${num(r.stock.products.reduce((a: number, p: any) => a + p.closing_l, 0))} L`} hint={r.stock.products.map((p: any) => `${p.name} ${num(p.closing_l)}`).join(" · ")} />
        <Stat label="Stock value (at cost)" value={r.stock.products.every((p: any) => p.closing_value != null) ? pkrShort(r.stock.products.reduce((a: number, p: any) => a + p.closing_value, 0)) : "—"} />
      </div>
      <div className="card p-4">
        <h3 className="mb-2 text-sm font-semibold">Revenue vs expenses by {r.grain} · <Ur className="text-slate-500">آمدن بمقابلہ اخراجات</Ur></h3>
        <div className="h-72">
          <ResponsiveContainer>
            <ComposedChart data={r.trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: "#64748b" }} tickLine={false} minTickGap={24} tickFormatter={(b: string) => r.grain === "hour" ? b.slice(11) : r.grain === "day" ? b.slice(5) : b} />
              <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => pkrShort(v).replace("Rs ", "")} />
              <Tooltip formatter={(v: any, n: string) => [pkr(v), n]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="retail" name="Retail sales" stackId="rev" fill="#2a78d6" radius={[0, 0, 0, 0]} />
              <Bar dataKey="wholesale" name="Wholesale" stackId="rev" fill="#eb6834" radius={[4, 4, 0, 0]} />
              <Line dataKey="expenses" name="Expenses" stroke="#4a3aa7" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}

const Row = ({ k, ur, v, bold, muted }: { k: string; ur?: string; v: string; bold?: boolean; muted?: boolean }) => (
  <div className={`flex justify-between gap-2 border-b border-slate-100 py-1.5 text-sm ${bold ? "font-semibold" : ""} ${muted ? "text-slate-500" : ""}`}><span className="min-w-0">{k}{ur ? <Ur className="ml-1 text-[11px] text-slate-400">{ur}</Ur> : null}</span><span className="shrink-0 tabular-nums">{v}</span></div>
);

function SalesHead({ r }: { r: any }) {
  return (
    <div className="card p-4">
      <h3 className="mb-2 text-sm font-semibold">Litres sold by {r.grain} (retail) · <Ur className="text-slate-500">فروخت لیٹر</Ur></h3>
      <div className="h-64">
        <ResponsiveContainer>
          <LineChart data={r.trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: "#64748b" }} tickLine={false} minTickGap={24} tickFormatter={(b: string) => r.grain === "hour" ? b.slice(11) : r.grain === "day" ? b.slice(5) : b} />
            <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => num(v)} />
            <Tooltip formatter={(v: any, n: string) => [`${num(v)} L`, n]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {Object.keys(PRODUCTS).map((p) => <Line key={p} dataKey={p} name={PRODUCTS[p]} stroke={PRODUCT_COLORS[p]} strokeWidth={2} dot={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function StockHead({ r }: { r: any }) {
  return (
    <div className="card overflow-x-auto">
      <h3 className="px-4 pt-3 text-sm font-semibold">Stock movement (litres)</h3>
      {/* phone: one card per fuel, closing first */}
      <ul className="mt-1 divide-y divide-slate-100 sm:hidden print:hidden">{r.stock.products.map((p: any) => (
        <li key={p.product} className="px-4 py-2.5 text-sm">
          <div className="flex items-baseline justify-between gap-2"><span className="min-w-0 font-medium">{p.name}</span>
            <span className="shrink-0 text-right"><b className="tabular-nums">{num(p.closing_l)} L</b><span className="block text-[11px] text-slate-500">{p.closing_value != null ? `${pkr(p.closing_value)} at cost` : "closing"}</span></span></div>
          <div className="mt-0.5 text-xs leading-relaxed text-slate-500">
            Opening <b className="tabular-nums text-slate-700">{num(p.opening_l)}</b> + received <b className="tabular-nums text-slate-700">{num(p.received_l)}</b>
            {p.returns_in_l ? <> + returns <b className="tabular-nums text-slate-700">{num(p.returns_in_l)}</b></> : null}
            {" "}− sold <b className="tabular-nums text-slate-700">{num(p.retail_sold_l)}</b>
            {p.wholesale_out_l ? <> − wholesale <b className="tabular-nums text-slate-700">{num(p.wholesale_out_l)}</b></> : null}
            {p.dip_adjust_l ? <> ± dip <b className={`tabular-nums ${p.dip_adjust_l < 0 ? "text-red-600" : "text-slate-700"}`}>{num(p.dip_adjust_l)}</b></> : null}
            {p.avg_cost ? <> · avg cost <b className="tabular-nums text-slate-700">Rs {p.avg_cost}/L</b></> : null}
          </div>
        </li>
      ))}</ul>
      <table className="hidden w-full sm:table print:table">
        <thead><tr>{["Product", "Opening", "+ Received", "+ Returns", "− Retail sold", "− Wholesale", "± Dip adj.", "= Closing", "Avg cost / L", "Closing value"].map((h, i) => <th key={h} className={`th ${i ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
        <tbody>{r.stock.products.map((p: any) => (
          <tr key={p.product}>
            <td className="td font-medium">{p.name}</td>
            {[p.opening_l, p.received_l, p.returns_in_l, p.retail_sold_l, p.wholesale_out_l, p.dip_adjust_l].map((v, i) => <td key={i} className={`td text-right tabular-nums ${i === 5 && v < 0 ? "text-red-600" : ""}`}>{num(v)}</td>)}
            <td className="td text-right font-semibold tabular-nums">{num(p.closing_l)}</td>
            <td className="td text-right tabular-nums">{p.avg_cost ? `Rs ${p.avg_cost}` : "—"}</td>
            <td className="td text-right tabular-nums">{p.closing_value != null ? pkr(p.closing_value) : "—"}</td>
          </tr>
        ))}</tbody>
      </table>
      <p className="px-4 py-2 text-xs text-slate-500">Opening + received + returns − sold − wholesale ± dip adjustments = closing. Dip adjustment is the difference between physical dip and book stock (leakage, evaporation, meter error).</p>
    </div>
  );
}

function ExpensesHead({ r }: { r: any }) {
  const max = Math.max(1, ...r.expenses.by_category.map((c: any) => c.amount));
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[260px_1fr]">
      <Stat label={<Lbl en="Total expenses" ur="کل اخراجات" block />} value={pkr(r.expenses.total)} tone="red" hint={<>{r.expenses.count} entries · {r.summary.revenue ? ((r.expenses.total / r.summary.revenue) * 100).toFixed(1) : 0}% of revenue{r.summary.prev && <div className="mt-0.5"><Delta now={r.expenses.total} prev={r.summary.prev.expenses} lowerIsBetter /></div>}</>} />
      <div className="card space-y-1.5 p-4">
        {r.expenses.by_category.map((c: any) => (
          <div key={c.category} className="grid grid-cols-[180px_1fr_110px] items-center gap-2 text-xs">
            <span className="truncate">{c.category}</span>
            <div className="h-1.5 rounded-full bg-slate-100"><div className="h-full rounded-full bg-[#2a78d6]" style={{ width: `${(c.amount / max) * 100}%` }} /></div>
            <span className="text-right tabular-nums">{pkr(c.amount)}</span>
          </div>
        ))}
        {!r.expenses.by_category.length && <Empty>No expenses in this period</Empty>}
      </div>
    </div>
  );
}

function ReceivablesHead({ r }: { r: any }) {
  const rv = r.receivables;
  return (
    <>
      <p className="text-sm text-slate-600">Balances <b>as of now</b> (not limited to the selected period). Aging is days since the last payment. · <Ur className="text-slate-500">ابھی کا باقی — عمر = آخری ادائیگی سے دن</Ur></p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label={<Lbl en="Total owed to us" ur="کل ہمارا باقی" block />} value={pkr(rv.total)} tone="amber" />
        <Stat label={<Lbl en="Khata customers" ur="کھاتہ گاہک" block />} value={pkr(rv.khata_total)} />
        <Stat label={<Lbl en="Wholesale clients" ur="ہول سیل کلائنٹ" block />} value={pkr(rv.wholesale_total)} />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {rv.aging.map((a: any) => <Stat key={a.bucket} label={a.bucket} value={pkrShort(a.amount)} hint={`${a.count} accounts`} tone={a.bucket === "90+ days" && a.amount > 0 ? "red" : "slate"} />)}
      </div>
    </>
  );
}

function PayablesHead({ r }: { r: any }) {
  const p = r.payables;
  return (
    <>
      <p className="text-sm text-slate-600">What the business owes <b>as of now</b>: fuel suppliers, customer advances, and expenses still waiting for approval. · <Ur className="text-slate-500">ابھی ہم پر باقی</Ur></p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label={<Lbl en="Total we owe" ur="کل ہم پر باقی" block />} value={pkr(p.total)} tone="red" />
        <Stat label={<Lbl en="Fuel suppliers" ur="تیل سپلائر" block />} value={pkr(p.suppliers_total)} hint={<Link to="/suppliers" className="text-brand-600 hover:underline">Pay suppliers →</Link>} />
        <Stat label={<Lbl en="Expenses awaiting approval" ur="منظوری کے منتظر" block />} value={pkr(p.pending_expenses.amount)} hint={`${p.pending_expenses.count} entries`} tone="amber" />
      </div>
    </>
  );
}

/* ---------- tables per tab (also used for CSV export) ---------- */
function tablesFor(tab: Tab, r: any): TableDef[] {
  const prod = (k = "product"): Col => ({ h: "Product", v: (x) => PRODUCTS[x[k]] ?? x[k] });
  switch (tab) {
    case "overview":
      return [{ title: `Totals by ${r.grain}`, rows: [...r.trend].reverse(), cols: [txt("Period", "bucket"), l("Petrol L", "PMG"), l("Hi-Octane L", "HOBC"), l("Diesel L", "HSD"), m("Retail", "retail"), l("Wholesale L", "wholesale_l"), m("Wholesale", "wholesale"), m("Expenses", "expenses")] }];
    case "sales":
      return [
        { title: "By product", rows: r.sales.by_product, cols: [prod(), l("Litres", "litres"), m("Amount", "amount"), l("Transactions", "txns")] },
        { title: "By station", rows: r.sales.by_station, cols: [txt("Station", "station"), l("Litres", "litres"), m("Amount", "amount"), l("Transactions", "txns")] },
        { title: "By meter (No.1, No.2 …) — from meter readings", rows: r.sales.by_meter ?? [], cols: [txt("Station", (x) => x.station), txt("Meter", "meter"), prod(), l("Litres", "litres"), m("Sale (Rs)", "amount"), l("Shifts", "shifts"), txt("Salesmen", (x) => x.salesmen.join(", "))] },
        { title: "By payment method", rows: r.sales.by_payment, cols: [txt("Method", "method"), m("Amount", "amount"), l("Transactions", "txns")] },
        { title: "Top customers", rows: r.sales.top_customers, cols: [txt("Customer", "name"), txt("Type", "type"), l("Litres", "litres"), m("Amount", "amount"), l("Visits", "visits")] },
      ];
    case "stock":
      return [
        { title: "Tanks now", rows: r.stock.tanks, cols: [txt("Station", "station"), txt("Tank", "tank"), l("Capacity", "capacity_l"), l("Stock L", "current_l"), { h: "Fill %", v: (x) => `${x.fill_pct}%`, csv: (x) => x.fill_pct, right: true }, { h: "Days to empty", v: (x) => x.days_to_empty, right: true }] },
        { title: "Fuel purchased (supplier invoices)", rows: r.stock.purchases, cols: [prod(), l("Litres", "litres"), m("Cost", "cost")] },
        { title: "Tanker deliveries", rows: r.stock.deliveries, cols: [{ h: "Date", v: (x) => dt(x.created_at) }, txt("Tank", (x) => `${x.station} ${x.tank}`), txt("Tanker", "tanker_no"), txt("Supplier", "supplier"), l("Invoice L", "invoice_l"), l("Received L", "received_l"), { h: "Short %", v: (x) => <span className={x.shortage_pct >= 0.3 ? "font-semibold text-red-600" : ""}>{x.shortage_pct}%</span>, csv: (x) => x.shortage_pct, right: true }, { h: "Rate", v: (x) => x.purchase_rate ? `Rs ${x.purchase_rate}` : "—", csv: (x) => x.purchase_rate, right: true }] },
        { title: "Dip readings", rows: r.stock.dips, cols: [{ h: "Date", v: (x) => dt(x.created_at) }, txt("Tank", (x) => `${x.station} ${x.tank}`), l("Book L", "book_l"), l("Dip L", "measured_l"), { h: "Variance", v: (x) => <span className={Math.abs(x.variance_pct) >= 0.5 ? "font-semibold text-red-600" : ""}>{x.variance_pct}%</span>, csv: (x) => x.variance_pct, right: true }] },
      ];
    case "expenses":
      return [
        { title: "By category", rows: r.expenses.by_category, cols: [txt("Category", "category"), m("Amount", "amount"), l("Entries", "n")] },
        { title: "By station", rows: r.expenses.by_station, cols: [txt("Station", "station"), m("Amount", "amount")] },
        { title: "By payment method", rows: r.expenses.by_method, cols: [txt("Method", "method"), m("Amount", "amount")] },
        { title: "All expenses", rows: r.expenses.list, cols: [txt("Date", "expense_date"), txt("Category", "category"), txt("Paid to", "paid_to"), txt("Method", "method"), m("Amount", "amount"), txt("Note", "note"), txt("By", "created_by")] },
      ];
    case "receivables":
      return [{ title: "Who owes us", rows: r.receivables.list, cols: [
        { h: "Name", v: (x) => <Link className="hover:underline" to={x.kind === "Wholesale client" ? `/wholesale/${x.id}` : `/customers/${x.id}`}>{x.name}</Link>, csv: (x) => x.name },
        { h: "Type", v: (x) => <Badge tone={x.kind === "Wholesale client" ? "amber" : "blue"}>{x.kind}</Badge>, csv: (x) => x.kind },
        txt("Phone", "phone"), m("Amount due", "amount"), m("Credit limit", "credit_limit"),
        { h: "Last payment", v: (x) => ago(x.last_payment), csv: (x) => x.last_payment?.slice(0, 10) },
        { h: "Aging", v: (x) => <Badge tone={x.aging === "90+ days" || x.aging === "No payment yet" ? "red" : x.aging === "61-90 days" ? "amber" : "slate"}>{x.aging}</Badge>, csv: (x) => x.aging },
      ] }];
    case "payables":
      return [
        { title: "Whom we owe", rows: r.payables.list, cols: [txt("Name", "name"), txt("Type", "kind"), txt("Reason", "reason"), m("Amount", "amount"), { h: "Last payment", v: (x) => ago(x.last_payment), csv: (x) => x.last_payment?.slice(0, 10) }] },
        { title: "Expenses awaiting approval", rows: r.payables.pending_expenses.list, cols: [txt("Date", "expense_date"), txt("Category", "category"), txt("Paid to", "paid_to"), m("Amount", "amount"), txt("Entered by", "created_by")] },
      ];
    case "khata":
      return [{ title: "Khata activity by customer", rows: r.khata.by_customer, cols: [
        { h: "Customer", v: (x) => <Link className="hover:underline" to={`/customers/${x.id}`}>{x.name}</Link>, csv: (x) => x.name }, txt("Type", "type"),
        m("Credit given", "given"), m("Collected", "collected"), m("Balance now", "balance_now"), m("Limit", "credit_limit")] }];
    case "wholesale":
      return [
        { title: "By client", rows: r.wholesale.by_client, cols: [{ h: "Client", v: (x) => <Link className="hover:underline" to={`/wholesale/${x.id}`}>{x.name}</Link>, csv: (x) => x.name },
          l("Supplied L", "supplied_l"), l("Returned L", "returned_l"), m("Net billed", "billed"), m("Received", "received"), m("Due now", "due_now")] },
        { title: "By product", rows: r.wholesale.by_product, cols: [prod(), l("Net litres", "net_l"), m("Amount", "amount")] },
      ];
    case "shifts":
      return [{ title: "By attendant", rows: r.shifts.by_attendant, cols: [
        { h: "Attendant", v: (x) => <>{x.attendant}<span className="block text-[10px] text-slate-500">{x.station}</span></>, csv: (x) => `${x.attendant} (${x.station})` },
        l("Shifts", "shifts"), l("Litres", "litres"), m("Expected", "expected"), m("Counted", "counted"),
        { h: "Variance", v: (x) => <span className={x.variance < -500 ? "font-semibold text-red-600" : ""}>{pkr(x.variance)}</span>, csv: (x) => x.variance, right: true }, m("Worst", "worst")] }];
  }
}
