import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell } from "recharts";
import { ArrowDownRight, ArrowUpRight, Banknote, BookOpen, CalendarClock, ChevronRight, ClipboardList, FilePlus2, Plus, Receipt, Route, Search, Truck, Wallet } from "lucide-react";
import { ErpBar } from "./WholesaleErp";
import { ChequeForm, OrderForm, PromiseForm } from "./WholesaleDesk";
import { WholesaleVoice } from "./WholesaleVoice";
import { useApi } from "../lib/api";
import { Badge, Loading, Modal, Pager, usePaged, useListFilter } from "./ui";
import { ErpSearch } from "./WholesaleErp";
import { dt } from "../lib/format";
import { PRODUCTS, PRODUCT_COLORS, num, pkr, pkrShort } from "../lib/format";
import { useAuth } from "../App";

/* chart roles: series slots 1 and 3 of the validated palette; recessive grid and axes */
const BILLED = "#2a78d6", RECEIVED = "#1baf7a", GRID = "#e5e7eb", AXIS = "#6b7280";
/* due ageing: one hue, light → dark as money gets older (sequential, labelled — never colour alone) */
const AGE = [
  { k: "d0_15", label: "0–15 days", fill: "#fde68a" }, { k: "d16_30", label: "16–30 days", fill: "#fbbf24" },
  { k: "d31_60", label: "31–60 days", fill: "#d97706" }, { k: "d60", label: "60+ days", fill: "#92400e" },
] as const;
const HEALTH: Record<string, { label: string; dot: string }> = {
  green: { label: "Good", dot: "bg-emerald-500" }, amber: { label: "Watch", dot: "bg-amber-500" }, red: { label: "Risk", dot: "bg-red-500" },
};

const Change = ({ v }: { v: number | null }) => v == null ? null : (
  <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${v >= 0 ? "text-emerald-700" : "text-red-600"}`}>
    {v >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{Math.abs(v)}% vs last month
  </span>
);
const Ur = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => <span lang="ur" dir="rtl" className={`font-urdu ${className}`}>{children}</span>;

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ErpKpi = ({ label, ur, value, sub, accent }: { label: string; ur?: string; value: string; sub?: React.ReactNode; accent?: string }) => (
  <div className="card h-full p-4">
    <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs font-medium text-slate-500"><span>{label}</span>{ur && <Ur className="text-xs">{ur}</Ur>}</div>
    <div className={`mt-1 whitespace-nowrap text-xl font-extrabold tabular-nums 2xl:text-2xl ${accent ?? "text-slate-900"}`}>{value}</div>
    {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
  </div>
);
const ActionRow = ({ label, value, hot, onClick }: { label: string; value: string; hot?: boolean; onClick?: () => void }) => (
  <li><button disabled={!onClick} onClick={onClick} className={`flex w-full items-center justify-between gap-3 py-2.5 text-left ${onClick ? "hover:bg-slate-50" : ""}`}>
    <span className={hot ? "font-medium text-red-700" : "text-slate-700"}>{label}</span>
    <span className={`flex items-center gap-1 font-bold tabular-nums ${hot ? "text-red-700" : ""}`}>{value}{onClick && <ChevronRight size={14} className="text-slate-400" />}</span>
  </button></li>
);

/** Reminder for the wholesale officer: bypass fuel we already bought but haven't delivered — deliver it first. */
function BypassHeldBanner({ onDeliver }: { onDeliver?: () => void }) {
  const { data } = useApi<any>("/bypass/stock");
  const lines = (data?.by_product ?? []) as any[];
  if (!lines.length || !(data?.total?.litres > 0)) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-300">
      <Truck size={20} className="shrink-0 text-amber-700" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-amber-900">Pehle se humare paas bypass maal ruka hai — pehle ise deliver karein</div>
        <div className="text-sm text-amber-800">{lines.map((p) => `${num(p.litres)} L ${PRODUCTS[p.product] ?? p.product}`).join(" · ")} · total {pkr(data.total.value)} (cost par) <Ur className="ml-1">باقی مال پہلے دیں</Ur></div>
      </div>
      {onDeliver && <button className="btn-primary !bg-amber-600 shrink-0 hover:!bg-amber-700" onClick={onDeliver}><Truck size={15} /> Deliver karein</button>}
    </div>
  );
}

/** Wholesale home: today's actions, KPIs, suggestions, trends, ageing and client health. */
export function WholesaleDashboard({ onTrip, onAddClient, onTab, recent = [] }: { onTrip: () => void; onAddClient: () => void; onFleet: () => void; onTab: (t: string) => void; recent?: any[] }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const { data, reload } = useApi<any>("/wholesale/dashboard");
  const [desk, setDesk] = useState<null | "order" | "cheque" | "promise">(null);
  const [pick, setPick] = useState<null | "supply" | "payment">(null);
  const [q, setQ] = useState("");
  // hooks must run before any early return — derive the filtered + paged list null-safely, then guard on data
  const clients = (data?.clients ?? []).filter((c: any) => !q || c.name.toLowerCase().includes(q.toLowerCase()));
  const paged = usePaged(clients, 10);
  if (!data) return <Loading />;
  const k = data.kpi;
  const manage = can("wholesale.manage");
  const ageTotal = AGE.reduce((s, a) => s + data.ageing[a.k], 0);

  return (
    <div className="space-y-5">
      <BypassHeldBanner onDeliver={manage ? onTrip : undefined} />
      {/* ERP toolbar: the voucher is the main entry; the rest are one tap away */}
      <ErpBar crumb="Dashboard" title="Wholesale dashboard" ur="ڈیش بورڈ">
        <button className="btn-secondary" onClick={() => nav("/wholesale/ledger")}><BookOpen size={15} /> Party ledger</button>
        <button className="btn-secondary" onClick={() => nav("/wholesale/invoices")}><Receipt size={15} /> Invoices</button>
        <button className="btn-secondary" onClick={() => nav("/wholesale/board")}><Route size={15} /> Order to cash</button>
        {manage && <>
          <button className="btn-secondary" onClick={onTrip}><Truck size={15} /> Tanker trip</button>
          <button className="btn-secondary" onClick={() => setPick("payment")}><Wallet size={15} /> Receipt</button>
          <button className="btn-secondary" onClick={() => setDesk("order")}><ClipboardList size={15} /> Order</button>
          <button className="btn-secondary" onClick={() => setDesk("cheque")}><Banknote size={15} /> Cheque</button>
          <button className="btn-secondary" onClick={() => setDesk("promise")}><CalendarClock size={15} /> Promise</button>
          <button className="btn-secondary" onClick={onAddClient}><Plus size={15} /> Client</button>
          <button className="btn-primary" onClick={() => nav("/wholesale/voucher")}><FilePlus2 size={15} /> New supply voucher</button>
        </>}
      </ErpBar>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
        <ErpKpi label="Total receivable" ur="کل وصولی باقی" value={pkr(k.total_due)} sub={`${data.clients.filter((c: any) => c.due > 0.5).length} clients`} />
        <ErpKpi label="Overdue > 30 days" ur="30 دن سے پرانا" value={pkr(k.overdue_30)} accent={k.overdue_30 > 0 ? "text-red-700" : "text-emerald-700"}
          sub={<span className={k.overdue_30 > 0 ? "text-red-700" : ""}>{data.clients.filter((c: any) => c.due > 0.5 && c.oldest_days > 30).length} clients · {k.total_due > 0 ? Math.round((k.overdue_30 / k.total_due) * 100) : 0}% of total</span>} />
        <ErpKpi label="Supplied this month" ur="اس مہینے سپلائی" value={`${num(k.month_litres)} L`} sub={<>{pkr(k.month_billed)}{k.month_litres_change != null && <> · <Change v={k.month_litres_change} /></>}</>} />
        <ErpKpi label="Collected this month" ur="اس مہینے وصولی" value={pkr(k.month_received)} accent="text-emerald-700" sub={k.collection_pct == null ? "nothing billed yet" : `${k.collection_pct}% collection rate`} />
        <ErpKpi label="Gross margin" ur="منافع" value={k.profit_estimate != null ? pkr(k.profit_estimate) : "—"} sub={k.profit_estimate != null ? <>{k.margin_per_l != null ? `Rs ${k.margin_per_l.toFixed(2)} per litre` : ""}{k.month_profit_change != null && <> · <Change v={k.month_profit_change} /></>}</> : "Add purchase rates to see margin"} />
      </div>

      <WholesaleVoice compact onDone={reload} />
      <RecentEntries rows={recent} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <div className="card p-4 xl:col-span-2">
          <div className="mb-3 flex items-baseline justify-between"><h2 className="font-bold">Receivable aging · <Ur className="font-normal">بقایا کتنا پرانا</Ur></h2><button className="text-sm text-brand-700 underline" onClick={() => onTab("collect")}>Recovery</button></div>
          {ageTotal > 0 ? <div className="mb-3 flex h-3 gap-0.5 overflow-hidden rounded" role="img" aria-label="Due by age">
            {AGE.map((a) => data.ageing[a.k] > 0 && <div key={a.k} title={`${a.label}: ${pkr(data.ageing[a.k])}`} style={{ width: `${(data.ageing[a.k] / ageTotal) * 100}%`, background: a.fill }} />)}
          </div> : <p className="mb-3 text-sm text-emerald-700">Koi baqaya nahi ✓</p>}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            {AGE.map((a) => <div key={a.k}><div className="flex items-center gap-1.5 text-xs text-slate-500"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: a.fill }} />{a.label}</div>
              <div className={`font-bold tabular-nums ${a.k === "d31_60" || a.k === "d60" ? (data.ageing[a.k] > 0 ? "text-red-700" : "") : ""}`}>{pkr(data.ageing[a.k])}</div></div>)}
          </div>
        </div>
        <div className="card p-4 xl:col-span-3">
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2"><h2 className="font-bold">Supply vs collection · last 6 months · <Ur className="font-normal">سپلائی اور وصولی</Ur></h2></div>
          <div className="h-56"><ResponsiveContainer>
            <BarChart data={data.monthly ?? []} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barGap={3}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="month" tickFormatter={(ym: string) => MONTHS[Number(ym.split("-")[1])] ?? ym} tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tickFormatter={(v) => (v >= 10_000_000 ? `${(v / 10_000_000).toFixed(1)}Cr` : v >= 100_000 ? `${Math.round(v / 100_000)}L` : v >= 1000 ? `${Math.round(v / 1000)}k` : v)} tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
              <Tooltip cursor={{ fill: "rgba(15,23,42,.05)" }} formatter={(v: number, n: string) => [pkr(v), n === "supplied" ? "Supplied" : "Collected"]} labelFormatter={(ym) => String(ym)} />
              <Legend formatter={(v) => <span className="text-xs text-slate-700">{v === "supplied" ? "Supplied" : "Collected"}</span>} iconType="square" iconSize={10} />
              <Bar dataKey="supplied" fill={BILLED} radius={[4, 4, 0, 0]} maxBarSize={30} />
              <Bar dataKey="collected" fill={RECEIVED} radius={[4, 4, 0, 0]} maxBarSize={30} />
            </BarChart>
          </ResponsiveContainer></div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="card overflow-hidden xl:col-span-2">
          <div className="flex items-baseline justify-between p-4 pb-2"><h2 className="font-bold">Top outstanding clients · <Ur className="font-normal">سب سے زیادہ ادھار</Ur></h2><button className="text-sm text-brand-700 underline" onClick={() => onTab("clients")}>All clients</button></div>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500"><th className="px-4 py-2">Client</th><th className="px-3 py-2">Credit limit used</th><th className="px-3 py-2 text-right">Outstanding</th><th className="px-3 py-2 text-right">Oldest bill</th><th className="px-3 py-2" /></tr></thead>
            <tbody>{[...data.clients].filter((c: any) => c.due > 0.5).sort((a: any, b: any) => b.due - a.due).slice(0, 6).map((c: any) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="px-4 py-2.5"><button className="text-left font-semibold hover:underline" onClick={() => nav(`/wholesale/${c.id}`)}>{c.name}</button><div className="text-xs text-slate-500">{[c.city, c.phone].filter(Boolean).join(" · ")}</div></td>
                <td className="px-3 py-2.5">{c.limit_pct != null ? <><div className="h-1.5 w-36 rounded bg-slate-100"><div className="h-full rounded" style={{ width: `${Math.min(100, Math.max(0, c.limit_pct))}%`, background: c.limit_pct >= 90 ? "#dc2626" : c.limit_pct >= 75 ? "#f59e0b" : "#0b6e4f" }} /></div><div className="mt-0.5 text-xs text-slate-500">{c.limit_pct}% of {pkrShort(c.credit_limit)}</div></> : <span className="text-xs text-slate-400">no limit</span>}</td>
                <td className="px-3 py-2.5 text-right font-bold tabular-nums">{pkr(c.due)}</td>
                <td className={`px-3 py-2.5 text-right tabular-nums ${c.oldest_days > 30 ? "font-semibold text-red-700" : ""}`}>{c.oldest_days} days</td>
                <td className="px-3 py-2.5 text-right"><button className="btn-secondary min-h-8 !px-2.5 !py-1 text-xs" onClick={() => nav(`/wholesale/ledger?client=${c.id}`)}>Ledger</button></td>
              </tr>
            ))}</tbody>
          </table></div>
          {!data.clients.some((c: any) => c.due > 0.5) && <p className="p-4 text-center text-sm text-emerald-700">Kisi client ka baqaya nahi ✓</p>}
        </div>
        <div className="card p-4">
          <h2 className="mb-2 font-bold">Needs action today · <Ur className="font-normal">آج کے کام</Ur></h2>
          <ul className="divide-y divide-slate-100 text-sm">
            <ActionRow label="Orders for today / late" value={String(k.orders_today)} hot={k.orders_today > 0} onClick={() => onTab("orders")} />
            <ActionRow label="Open orders" value={`${k.open_orders} · ${num(k.open_orders_l)} L`} onClick={() => onTab("orders")} />
            <ActionRow label="Promised to pay today" value={pkr(k.promised_today)} onClick={() => onTab("collect")} />
            <ActionRow label="Broken promises" value={String(k.broken_promises)} hot={k.broken_promises > 0} onClick={() => onTab("collect")} />
            <ActionRow label="Cheques to clear" value={pkr(k.cheques_in_hand)} onClick={() => onTab("collect")} />
            <ActionRow label="Over 90% of credit limit" value={`${data.clients.filter((c: any) => (c.limit_pct ?? 0) >= 90).length} clients`} hot={data.clients.some((c: any) => (c.limit_pct ?? 0) >= 90)} onClick={() => onTab("clients")} />
            <ActionRow label="Today so far" value={`${num(k.today.litres)} L · ${pkrShort(k.today.received)} in`} />
          </ul>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="card p-4">
          <h2 className="font-semibold">Litres supplied — last 30 days · <Ur>لیٹر سپلائی</Ur></h2>
          <p className="mb-2 text-xs text-slate-500">Per day, by fuel</p>
          <div className="h-64"><ResponsiveContainer>
            <BarChart data={data.daily} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="day" tickFormatter={(d) => d.slice(8)} tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} interval={2} />
              <YAxis tickFormatter={(v) => (v >= 1000 ? `${v / 1000}k` : v)} tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={false} width={36} />
              <Tooltip cursor={{ fill: "rgba(15,23,42,.05)" }} formatter={(v: number, n: string) => [`${num(v)} L`, PRODUCTS[n] ?? n]} labelFormatter={(d) => d} />
              <Legend formatter={(v) => <span className="text-xs text-slate-700">{PRODUCTS[v] ?? v}</span>} iconType="square" iconSize={10} />
              {Object.keys(PRODUCTS).map((p, i, arr) => <Bar key={p} dataKey={p} stackId="l" fill={PRODUCT_COLORS[p]} stroke="#fff" strokeWidth={1} radius={i === arr.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={22} />)}
            </BarChart>
          </ResponsiveContainer></div>
        </div>
        <div className="card p-4">
          <h2 className="font-semibold">Billed vs received — last 8 weeks · <Ur>بل اور وصولی</Ur></h2>
          <p className="mb-2 text-xs text-slate-500">When received stays below billed, dues are growing</p>
          <div className="h-64"><ResponsiveContainer>
            <BarChart data={data.weekly} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barGap={2}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="week" tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={(w) => `wk ${w}`} />
              <YAxis tickFormatter={(v) => (v >= 100_000 ? `${Math.round(v / 100_000)}L` : v >= 1000 ? `${Math.round(v / 1000)}k` : v)} tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
              <Tooltip cursor={{ fill: "rgba(15,23,42,.05)" }} formatter={(v: number, n: string) => [pkr(v), n === "billed" ? "Billed" : "Received"]} labelFormatter={(w) => `Week of ${w}`} />
              <Legend formatter={(v) => <span className="text-xs text-slate-700">{v === "billed" ? "Billed" : "Received"}</span>} iconType="square" iconSize={10} />
              <Bar dataKey="billed" fill={BILLED} radius={[4, 4, 0, 0]} maxBarSize={18} />
              <Bar dataKey="received" fill={RECEIVED} radius={[4, 4, 0, 0]} maxBarSize={18} />
            </BarChart>
          </ResponsiveContainer></div>
        </div>
      </div>

      {data.monthly_profit?.some((m: any) => m.profit) && <div className="card p-4">
        <h2 className="font-semibold">Munafa — last 6 months · <Ur>ماہانہ منافع</Ur></h2>
        <p className="mb-2 text-xs text-slate-500">Supply rate over our purchase cost, har mahine</p>
        <div className="h-56"><ResponsiveContainer>
          <BarChart data={data.monthly_profit} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="month" tickFormatter={(ym: string) => ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(ym.split("-")[1])] ?? ym} tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} />
            <YAxis tickFormatter={(v) => (Math.abs(v) >= 100_000 ? `${Math.round(v / 100_000)}L` : Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : v)} tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
            <Tooltip cursor={{ fill: "rgba(15,23,42,.05)" }} formatter={(v: number) => [pkr(v), "Munafa"]} labelFormatter={(ym) => String(ym)} />
            <Bar dataKey="profit" radius={[4, 4, 0, 0]} maxBarSize={40}>
              {data.monthly_profit.map((m: any, i: number) => <Cell key={i} fill={m.profit >= 0 ? RECEIVED : "#e11d48"} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer></div>
      </div>}

      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-2">
          <h2 className="font-semibold">Clients at a glance · <Ur>کلائنٹس</Ur></h2>
          <div className="relative w-full sm:w-56"><Search size={15} className="absolute left-2.5 top-2.5 text-slate-400" /><input className="input pl-8" placeholder="Search client" aria-label="Search client" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        </div>
        {/* phone: one card per client */}
        <ul className="divide-y divide-slate-100 sm:hidden">{paged.slice.map((c: any) => (
          <li key={c.id}><button className="w-full px-4 py-3 text-left active:bg-slate-50" onClick={() => nav(`/wholesale/${c.id}`)}>
            <div className="flex items-start gap-2">
              <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${HEALTH[c.health].dot}`} />
              <span className="min-w-0 flex-1"><span className="block font-semibold">{c.name}</span><span className="text-xs text-slate-500">{c.city}{c.city ? " · " : ""}{num(c.month_l)} L this month</span></span>
              <span className="text-right"><span className="block font-bold tabular-nums">{pkr(c.due)}</span><span className={`text-xs ${c.oldest_days > 30 ? "font-semibold text-red-600" : "text-slate-500"}`}>{c.due > 0 ? `oldest ${c.oldest_days} d` : "nothing due"}</span></span>
            </div>
            {c.limit_pct != null && <div className="ml-4 mt-2 flex items-center gap-2"><div className="h-1.5 flex-1 rounded-full bg-slate-100"><div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, c.limit_pct))}%`, background: c.limit_pct >= 90 ? "#e34948" : c.limit_pct >= 75 ? "#eda100" : "#2a78d6" }} /></div><span className="text-xs tabular-nums text-slate-600">{c.limit_pct}% of limit</span></div>}
            <div className="ml-4 mt-1 text-xs text-slate-500">Last order {c.last_supply_days == null ? "never" : c.last_supply_days === 0 ? "today" : `${c.last_supply_days} day${c.last_supply_days === 1 ? "" : "s"} ago`}{c.margins.length ? ` · margin ${c.margins.map((m: any) => `${PRODUCTS[m.product].split(" ")[0]} Rs ${m.margin.toFixed(2)}`).join(", ")}` : ""}</div>
          </button></li>
        ))}</ul>
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full">
            <thead><tr><th className="th">Client</th><th className="th">Health</th><th className="th text-right">Due</th><th className="th">Credit limit used</th><th className="th text-right">Oldest unpaid</th><th className="th text-right">This month</th><th className="th">Last order</th><th className="th">Margin / L</th></tr></thead>
            <tbody>{paged.slice.map((c: any) => (
              <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => nav(`/wholesale/${c.id}`)}>
                <td className="td"><div className="font-medium">{c.name}</div><div className="text-xs text-slate-500">{c.city}</div></td>
                <td className="td"><span className="inline-flex items-center gap-1.5 text-sm"><span className={`h-2.5 w-2.5 rounded-full ${HEALTH[c.health].dot}`} />{HEALTH[c.health].label}</span></td>
                <td className="td text-right font-semibold tabular-nums">{pkr(c.due)}</td>
                <td className="td">{c.limit_pct != null ? <div className="flex items-center gap-2"><div className="h-1.5 w-24 rounded-full bg-slate-100"><div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, c.limit_pct))}%`, background: c.limit_pct >= 90 ? "#e34948" : c.limit_pct >= 75 ? "#eda100" : "#2a78d6" }} /></div><span className="text-xs tabular-nums text-slate-600">{c.limit_pct}%</span></div> : <span className="text-xs text-slate-400">no limit</span>}</td>
                <td className={`td text-right text-sm tabular-nums ${c.oldest_days > 30 ? "font-semibold text-red-600" : ""}`}>{c.due > 0 ? `${c.oldest_days} days` : "—"}</td>
                <td className="td text-right tabular-nums">{num(c.month_l)} L</td>
                <td className="td text-xs">{c.last_supply_days == null ? "never" : c.last_supply_days === 0 ? "today" : `${c.last_supply_days} day${c.last_supply_days === 1 ? "" : "s"} ago`}{c.usual_gap_days ? <div className="text-slate-500">usually every {c.usual_gap_days} d</div> : null}</td>
                <td className="td text-xs">{c.margins.map((m: any) => <div key={m.product} className={m.margin < 1 ? "font-semibold text-red-600" : "text-slate-700"}>{PRODUCTS[m.product]} Rs {m.margin.toFixed(2)}</div>)}{!c.margins.length && <span className="text-slate-400">—</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {!clients.length && <div className="p-4 text-center text-sm text-slate-500">{q ? "Koi client nahi mila" : "Koi client nahi"}</div>}
        <div className="px-4 pb-3"><Pager {...paged} /></div>
      </div>

      {desk === "order" && <OrderForm onClose={() => setDesk(null)} onDone={() => { setDesk(null); reload(); }} />}
      {desk === "cheque" && <ChequeForm onClose={() => setDesk(null)} onDone={() => { setDesk(null); reload(); }} />}
      {desk === "promise" && <PromiseForm onClose={() => setDesk(null)} onDone={() => { setDesk(null); reload(); }} />}
      {pick && (
        <Modal open onClose={() => setPick(null)} title={pick === "supply" ? "Supply to which client?" : "Payment from which client?"}>
          <div className="max-h-[60vh] space-y-1 overflow-y-auto">
            {data.clients.map((c: any) => (
              <button key={c.id} className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-slate-50" onClick={() => nav(pick === "supply" ? `/wholesale/voucher?client=${c.id}` : `/wholesale/${c.id}?do=${pick}`)}>
                <span><span className="font-medium">{c.name}</span> <span className="text-xs text-slate-500">{c.city}</span></span>
                <span className="text-sm tabular-nums text-slate-600">due {pkr(c.due)}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}


/* ---------------- Recent wholesale entries: the day's postings right under the voice box, ERP style ---------------- */
const KIND: Record<string, { label: string; tone: "blue" | "green" | "amber" | "violet" | "slate" | "red"; vch: string }> = {
  supply: { label: "Supply", tone: "blue", vch: "WS" }, payment: { label: "Payment", tone: "green", vch: "RV" }, return: { label: "Return", tone: "amber", vch: "CN" },
  adjustment: { label: "Adjustment", tone: "violet", vch: "JV" }, carriage: { label: "Carriage", tone: "slate", vch: "JV" }, fuel_note: { label: "Fuel note", tone: "slate", vch: "FN" },
};
const GROUPS: Record<string, { label: string; ur: string; kinds: string[] }> = {
  supply: { label: "Supply entries", ur: "سپلائی", kinds: ["supply", "return", "carriage"] },
  account: { label: "Account entries", ur: "حساب", kinds: ["payment", "adjustment", "fuel_note"] },
};
const groupOf = (type: string) => (GROUPS.supply.kinds.includes(type) ? "supply" : "account");
function RecentEntries({ rows: all }: { rows: any[] }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [group, setGroupRaw] = useState("");
  const setGroup = (g: string) => { setGroupRaw(g); setKind(""); };
  const inGroup = (r: any) => !group || groupOf(r.type) === group;
  const pool = all.filter(inGroup);
  const side = (r: any) => {
    if (r.type === "fuel_note") return { dr: 0, cr: 0 };
    const dr = r.type === "supply" || r.type === "carriage" || (r.type === "adjustment" && r.amount > 0) ? Math.abs(r.amount) : 0;
    return { dr, cr: dr ? 0 : Math.abs(r.amount) };
  };
  const vch = (r: any) => r.voucher_no ?? `${KIND[r.type]?.vch ?? "TX"}-${r.id}`;
  const text = (r: any) => [vch(r), r.client_name, KIND[r.type]?.label, r.product && PRODUCTS[r.product], r.vehicle_no, r.driver_name, r.ref, r.note, r.method, r.location, r.amount, r.created_by].filter((v) => v != null && v !== "").join(" ").toLowerCase();
  const rows = useListFilter(all, { q, keep: (r) => inGroup(r) && (!kind || r.type === kind), text: (r) => `${text(r)} ${r.id}` });
  const paged = usePaged(rows, 10);
  const kinds = (group ? GROUPS[group].kinds : ["supply", "payment", "return", "adjustment", "carriage", "fuel_note"]).map((k) => ({ k, n: pool.filter((r) => r.type === k).length })).filter((x) => x.n > 0);
  const totals = rows.reduce((a, r) => { const s = side(r); if (!r.voided) { a.dr += s.dr; a.cr += s.cr; } return a; }, { dr: 0, cr: 0 });
  return (
    <section className="card overflow-hidden" aria-label="Recent wholesale entries">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3 sm:px-4">
        <h2 className="font-bold">Recent wholesale entries · <Ur className="font-normal">حالیہ اندراجات</Ur> <span className="text-xs font-normal text-slate-500">aakhri {all.length} · Debit = client par barha · Credit = wasool / kam hua</span></h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <ErpSearch value={q} onChange={setQ} placeholder="Voucher / client / gaari / ref… · تلاش" />
          <select className="input min-h-9 w-auto py-1 text-xs font-semibold" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Entry group">
            <option value="">Sab entries · {all.length}</option>
            {Object.entries(GROUPS).map(([g, m]) => <option key={g} value={g}>{m.label} · {m.ur} · {all.filter((r) => groupOf(r.type) === g).length}</option>)}
          </select>
          <button onClick={() => setKind("")} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${!kind ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600"}`}>All · {pool.length}</button>
          {kinds.map((x) => <button key={x.k} onClick={() => setKind(x.k === kind ? "" : x.k)} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${kind === x.k ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600"}`}>{KIND[x.k].label} · {x.n}</button>)}
        </div>
      </div>
      {!rows.length ? <p className="p-4 text-sm text-slate-500">{all.length ? "Kuch nahi mila · کچھ نہیں ملا" : "Abhi koi entry nahi."}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-sm">
            <thead><tr><th className="th">Tareekh</th><th className="th">Voucher</th><th className="th">Client</th><th className="th">Kism</th><th className="th">Fuel</th><th className="th text-right">Litre</th><th className="th text-right">Rate</th><th className="th text-right">Debit</th><th className="th text-right">Credit</th><th className="th">Tafseel</th><th className="th">By</th></tr></thead>
            <tbody className="tabular-nums">
              {paged.slice.map((r: any) => { const s = side(r); return (
                <tr key={r.id} className={`border-t ${r.voided ? "text-slate-400 line-through" : ""}`}>
                  <td className="td whitespace-nowrap text-xs">{dt(r.txn_date)}</td>
                  <td className="td whitespace-nowrap"><Link to={`/wholesale/ledger?client=${r.client_id}`} className="font-mono text-xs text-brand-700 underline">{vch(r)}</Link>{r.voided ? <Badge tone="red">VOID</Badge> : null}</td>
                  <td className="td"><Link to={`/wholesale/${r.client_id}`} className="font-medium hover:underline">{r.client_name}</Link></td>
                  <td className="td"><Badge tone={KIND[r.type]?.tone ?? "slate"}>{KIND[r.type]?.label ?? r.type}</Badge></td>
                  <td className="td text-xs">{r.product ? PRODUCTS[r.product] ?? r.product : r.method ?? "—"}</td>
                  <td className="td text-right">{r.litres ? `${num(r.litres)} L` : ""}</td>
                  <td className="td text-right">{r.rate ? num(r.rate, 2) : ""}</td>
                  <td className="td text-right text-rose-700">{s.dr ? pkr(s.dr) : ""}</td>
                  <td className="td text-right text-emerald-700">{s.cr ? pkr(s.cr) : ""}</td>
                  <td className="td max-w-[260px] truncate text-xs text-slate-600" title={[r.vehicle_no, r.driver_name, r.location, r.ref, r.note, r.voided && r.void_reason].filter(Boolean).join(" · ")}>{[r.vehicle_no && `🚛 ${r.vehicle_no}`, r.driver_name, r.location && `📍 ${r.location}`, r.ref, r.note, r.voided && `mansookh: ${r.void_reason ?? ""}`].filter(Boolean).join(" · ")}</td>
                  <td className="td text-xs text-slate-500">{r.created_by ?? ""}</td>
                </tr>); })}
            </tbody>
            <tfoot><tr className="border-t-2 bg-slate-50 font-semibold tabular-nums"><td className="td" colSpan={7}>Kul · {rows.length} entries{group ? ` · ${GROUPS[group].label}` : ""}{kind ? ` · ${KIND[kind]?.label}` : ""}</td><td className="td text-right text-rose-700">{pkr(totals.dr)}</td><td className="td text-right text-emerald-700">{pkr(totals.cr)}</td><td className="td" colSpan={2}></td></tr></tfoot>
          </table>
        </div>
      )}
      {rows.length > 10 && <div className="border-t px-3 py-2"><Pager page={paged.page} pages={paged.pages} setPage={paged.setPage} total={paged.total} size={paged.size} /></div>}
    </section>
  );
}
