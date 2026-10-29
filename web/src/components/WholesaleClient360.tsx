import { useNavigate } from "react-router-dom";
import { FilePlus2, Wallet } from "lucide-react";
import { useApi } from "../lib/api";
import { Loading } from "./ui";
import { num, phone, pkr, pkrShort } from "../lib/format";
import { useAuth } from "../App";

const Ur = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => <span lang="ur" dir="rtl" className={`font-urdu ${className}`}>{children}</span>;
const TONE: Record<string, string> = { green: "bg-emerald-50 text-emerald-700", amber: "bg-amber-50 text-amber-800", red: "bg-red-50 text-red-700", slate: "bg-slate-100 text-slate-600", blue: "bg-sky-50 text-sky-800" };
const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" }) : "—");
const ago = (iso?: string | null) => { if (!iso) return "never"; const d = Math.floor((Date.now() - Date.parse(iso)) / 864e5); return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`; };
const KIND: Record<string, string> = { supply: "bg-sky-100 text-sky-800", payment: "bg-emerald-100 text-emerald-800", return: "bg-amber-100 text-amber-800", carriage: "bg-violet-100 text-violet-800",
  adjustment: "bg-slate-100 text-slate-700", order: "bg-amber-100 text-amber-800", promise: "bg-orange-100 text-orange-800", cheque: "bg-teal-100 text-teal-800", request: "bg-violet-100 text-violet-800" };
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

/** Odoo-style client master: who they are, smart counts that open the right list, the key terms and one activity timeline. */
export function Client360({ c, refreshKey, onAction, onTab }: { c: any; refreshKey: number; onAction: (a: any) => void; onTab: (t: string) => void }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const { data } = useApi<any>(`/wholesale/clients/${c.id}/360?k=${refreshKey}`);
  if (!data) return <Loading />;
  const k = data.counts;
  const limitPct = c.credit_limit > 0 ? Math.round((data.due / c.credit_limit) * 100) : null;
  const smart: { label: string; value: string; go: () => void; tone?: string }[] = [
    { label: "Invoices", value: String(k.invoices), go: () => nav(`/wholesale/invoices?client=${c.id}&from=2000-01-01`) },
    { label: data.due < -0.5 ? "Advance · Cr" : "Outstanding · Dr", value: pkrShort(Math.abs(data.due)), go: () => nav(`/wholesale/ledger?client=${c.id}`), tone: data.due > 0.5 ? (data.oldest_days > 30 ? "red" : "amber") : "green" },
    { label: "Unpaid bills", value: String(k.unpaid_invoices), go: () => nav(`/wholesale/invoices?client=${c.id}&status=open&from=2000-01-01`) },
    { label: "Payments", value: String(k.payments), go: () => nav(`/wholesale/ledger?client=${c.id}&from=&to=`) },
    { label: "Open orders", value: k.open_orders ? `${k.open_orders} · ${num(k.open_orders_l)} L` : "0", go: () => onTab("desk") },
    ...(k.pending_requests ? [{ label: "Portal requests", value: String(k.pending_requests), go: () => nav("/wholesale/board"), tone: "blue" }] : []),
    { label: "Vehicles", value: String(k.vehicles), go: () => onTab("vehicles") },
    { label: "Litres this year", value: num(k.litres_year), go: () => onTab("rates") },
  ];
  const field = (l: string, v: React.ReactNode) => <div className="grid grid-cols-[140px_1fr] items-baseline gap-2 border-b border-slate-100 py-2 text-sm"><span className="text-slate-500">{l}</span><b className="min-w-0 break-words font-semibold">{v}</b></div>;

  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex min-w-0 flex-[999_1_600px] flex-col gap-4">
        <nav aria-label="Client records" className="flex flex-wrap gap-2 print:hidden">
          {smart.map((s) => (
            <button key={s.label} onClick={s.go} className={`flex min-h-11 min-w-[118px] flex-col items-start rounded-xl border px-3.5 py-2.5 text-left hover:border-brand-400 ${s.tone === "red" ? "border-red-200 bg-red-50" : s.tone === "amber" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"}`}>
              <b className={`text-lg tabular-nums ${s.tone === "red" ? "text-red-700" : s.tone === "amber" ? "text-amber-800" : s.tone === "green" ? "text-emerald-700" : ""}`}>{s.value}</b>
              <span className="text-xs text-slate-500">{s.label}</span>
            </button>
          ))}
        </nav>
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="mb-3 flex flex-wrap items-center gap-4">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-xl font-extrabold text-brand-800">{initials(c.name)}</span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Client profile · <Ur className="normal-case">کلائنٹ پروفائل</Ur></div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {data.tags.map((t: any) => <span key={t.label} className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[t.tone]}`}>{t.label}</span>)}
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">Since {new Date(data.since).toLocaleDateString("en-PK", { month: "short", year: "numeric" })}</span>
              </div>
            </div>
            {can("wholesale.manage") && <div className="flex flex-wrap gap-2 print:hidden">
              <button className="btn-primary" disabled={!c.active} onClick={() => nav(`/wholesale/voucher?client=${c.id}`)}><FilePlus2 size={15} /> Supply voucher</button>
              <button className="btn-secondary !border-brand-600 !text-brand-700" onClick={() => onAction("payment")}><Wallet size={15} /> Receipt</button>
            </div>}
          </div>
          <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
            <div>
              {field("Business", c.business_name || "—")}
              {field("Phone / WhatsApp", c.phone ? phone(c.phone) : "—")}
              {field("City / address", [c.city, c.address].filter(Boolean).join(" · ") || "—")}
              {field("Notes", c.notes || "—")}
            </div>
            <div>
              {field("Credit limit", c.credit_limit > 0 ? <>{pkr(c.credit_limit)} <span className={`font-medium ${limitPct! >= 90 ? "text-red-700" : limitPct! >= 75 ? "text-amber-700" : "text-slate-500"}`}>({limitPct}% used)</span></> : "No limit")}
              {field("Oldest unpaid bill", data.due > 0.5 ? <span className={data.oldest_days > 30 ? "text-red-700" : ""}>{data.oldest_days} days</span> : "Nothing due")}
              {field("Last supply", <>{day(data.last_supply)} <span className="font-normal text-slate-500">({ago(data.last_supply)})</span></>)}
              {field("Last payment", <>{day(data.last_payment)} <span className="font-normal text-slate-500">({ago(data.last_payment)})</span></>)}
            </div>
          </div>
        </section>
      </div>

      <aside aria-label="Activity" className="flex max-h-[560px] flex-[1_1_300px] flex-col gap-2 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 lg:max-w-sm print:hidden">
        <div className="flex items-baseline justify-between"><b>Activity · <Ur className="font-normal">سرگرمی</Ur></b><span className="text-xs text-slate-500">{data.activity.length} latest</span></div>
        {!data.activity.length && <p className="text-sm text-slate-500">Abhi koi entry nahi</p>}
        <ol className="space-y-2.5">
          {data.activity.map((e: any, i: number) => (
            <li key={i} className={`flex gap-2.5 text-sm ${e.voided ? "opacity-50" : ""}`}>
              <span className={`mt-0.5 h-fit shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase ${KIND[e.kind] ?? KIND.adjustment}`}>{e.kind}</span>
              <div className="min-w-0">
                <div className={e.voided ? "line-through" : ""}>{e.text}{e.amount != null && e.kind !== "order" && e.kind !== "request" ? <b className="tabular-nums"> · {pkr(e.amount)}</b> : null}</div>
                <div className="text-xs text-slate-500">{e.who ?? ""}{e.who ? " · " : ""}{new Date(e.at).toLocaleString("en-PK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}{e.voided ? " · VOID" : ""}</div>
              </div>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}

/** The vehicles that have taken this client's fuel, from the supply entries. */
export function ClientVehicles({ id }: { id: number }) {
  const { data } = useApi<any>(`/wholesale/clients/${id}/360`);
  if (!data) return <Loading />;
  if (!data.vehicles.length) return <p className="p-4 text-sm text-slate-500">Abhi kisi supply par gaari ka number nahi likha gaya.</p>;
  return (
    <table className="w-full text-sm">
      <thead><tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500"><th className="px-4 py-2">Vehicle</th><th className="px-4 py-2 text-right">Supplies</th><th className="px-4 py-2">Last used</th></tr></thead>
      <tbody>{data.vehicles.map((v: any) => <tr key={v.v} className="border-t border-slate-100"><td className="px-4 py-2 font-semibold">{v.v}</td><td className="px-4 py-2 text-right tabular-nums">{v.n}</td><td className="px-4 py-2">{day(v.last)}</td></tr>)}</tbody>
    </table>
  );
}
