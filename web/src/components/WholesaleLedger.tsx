import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Download, FilePlus2, Printer, Send, Wallet } from "lucide-react";
import { api, linkToken, useApi } from "../lib/api";
import { Empty, ErrorBox, Loading, useAction } from "./ui";
import { PRODUCTS, num, pkr } from "../lib/format";
import { useAuth } from "../App";
import { WholesaleEntryView } from "./EntryView";

const Ur = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => <span lang="ur" dir="rtl" className={`font-urdu ${className}`}>{children}</span>;
const pkToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const pkDay = (iso: string) => new Date(Date.parse(iso) + 5 * 3600_000).toISOString().slice(0, 10);
const dayLabel = (iso: string) => new Date(Date.parse(iso)).toLocaleDateString("en-PK", { day: "2-digit", month: "short", year: "2-digit" });
const amt = (n: number) => num(Math.round(n * 100) / 100, 0);
/** Balance with its side: Dr = they owe us, Cr = their advance with us. */
const drcr = (n: number) => (Math.abs(n) < 0.5 ? "0" : `${amt(Math.abs(n))} ${n > 0 ? "Dr" : "Cr"}`);

/** Voucher number per entry type: WS supply, RV receipt, CN credit note (return), JV journal (kiraya / adjustment). */
export const voucherNo = (l: any) => l.voucher_no ?? `${l.type === "supply" ? "WS" : l.type === "payment" ? "RV" : l.type === "return" ? "CN" : "JV"}-${l.id}`;
function particulars(l: any): string {
  const fuel = PRODUCTS[l.product] ?? l.product ?? "";
  if (l.type === "supply") return `Supply · ${fuel}${l.location ? ` → ${l.location}` : ""}`;
  if (l.type === "return") return `Return · ${fuel}${l.note ? ` (${l.note})` : ""}`;
  if (l.type === "payment") return `Payment received · ${l.method ?? "cash"}${l.ref ? ` · ${l.ref}` : ""}`;
  if (l.type === "carriage") return `Carriage / kiraya${l.ref ? ` · bilty ${l.ref}` : ""}`;
  if (l.type === "adjustment") return l.ref === "refund:" ? "Advance returned" : `Adjustment${l.note ? ` · ${l.note}` : ""}`;
  if (l.type === "fuel_note") return l.fuel_mode === "direct" ? `Fuel paid to depot direct — ${l.depot_name ?? "depot"} (record only)` : `Fuel money through us → ${l.depot_name ?? "depot"} (record only)`;
  return l.type;
}
const AGE = [
  { k: "a30", label: "0–30 days", test: (d: number) => d <= 30, cls: "text-slate-900" },
  { k: "a60", label: "31–60 days", test: (d: number) => d > 30 && d <= 60, cls: "text-amber-700" },
  { k: "a90", label: "61–90 days", test: (d: number) => d > 60 && d <= 90, cls: "text-orange-700" },
  { k: "old", label: "90+ days", test: (d: number) => d > 90, cls: "text-red-700" },
];

/** ERP party account: one client's ledger like a bank statement — opening, Dr / Cr, running balance, monthly view and unpaid bills. */
export function PartyLedger() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const clients = useApi<any[]>("/wholesale/clients");
  const monthStart = pkToday().slice(0, 8) + "01";
  const from = params.get("from") ?? monthStart, to = params.get("to") ?? pkToday();
  const list = (clients.data ?? []).filter((c: any) => c.active !== 0);
  const clientId = params.get("client") ?? (list.length ? String([...list].sort((a: any, b: any) => (b.due ?? 0) - (a.due ?? 0))[0].id) : "");
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); if (!p.get("client") && clientId) p.set("client", clientId); setParams(p, { replace: true }); };
  const qs = new URLSearchParams(Object.entries({ from, to }).filter(([, v]) => v)).toString();
  const stmt = useApi<any>(clientId ? `/wholesale/clients/${clientId}/statement?${qs}` : null);
  const [view, setView] = useState<"detailed" | "monthly" | "unpaid">("detailed");
  const [showFleet, setShowFleet] = useState(true);
  const [showVoid, setShowVoid] = useState(false);
  const [open, setOpen] = useState<any>(null);
  const { busy, run } = useAction();

  const s = stmt.data;
  const lines: any[] = useMemo(() => (s?.lines ?? []).filter((l: any) => showVoid || !l.voided), [s, showVoid]);
  const real = lines.filter((l: any) => l.type !== "fuel_note" && !l.voided);
  const dr = real.reduce((a, l) => a + l.debit, 0), cr = real.reduce((a, l) => a + l.credit, 0);
  const litres = real.reduce((a, l) => a + (l.type === "supply" ? l.litres ?? 0 : l.type === "return" ? -(l.litres ?? 0) : 0), 0);
  const months = useMemo(() => {
    if (!s) return [];
    const m = new Map<string, { month: string; opening: number; dr: number; cr: number; closing: number; litres: number; n: number }>();
    let bal = s.opening_balance;
    for (const l of (s.lines as any[]).filter((x) => x.type !== "fuel_note" && !x.voided)) {
      const k = pkDay(l.txn_date).slice(0, 7);
      if (!m.has(k)) m.set(k, { month: k, opening: bal, dr: 0, cr: 0, closing: bal, litres: 0, n: 0 });
      const r = m.get(k)!;
      r.dr += l.debit; r.cr += l.credit; r.n++; bal = l.balance; r.closing = bal;
      if (l.type === "supply") r.litres += l.litres ?? 0;
    }
    return [...m.values()];
  }, [s]);
  const ageing = useMemo(() => {
    const out: Record<string, number> = { a30: 0, a60: 0, a90: 0, old: 0 };
    for (const b of s?.unpaid?.bills ?? []) out[AGE.find((a) => a.test(b.days))!.k] += b.unpaid;
    out.old += s?.unpaid?.older ?? 0;
    return out;
  }, [s]);

  if (clients.error) return <ErrorBox error={clients.error} />;
  if (!clients.data) return <Loading />;
  if (!list.length) return <Empty>Pehle koi wholesale client add karein · <Link className="text-brand-600 underline" to="/wholesale?tab=clients&do=add-client">Add client</Link></Empty>;
  const c = s?.client;
  const limitPct = c?.credit_limit > 0 ? Math.round((s.due_now / c.credit_limit) * 100) : null;
  const csvUrl = `/api/wholesale/clients/${clientId}/statement.csv?${qs}&token=${linkToken()}`;

  return (
    <div className="space-y-4">
      {/* header bar: client, period, actions */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 print:hidden">
        <div className="mr-2">
          <div className="text-xs text-slate-500"><Link to="/wholesale" className="hover:underline">Wholesale</Link> › Accounts › Party ledger</div>
          <h1 className="text-xl font-bold text-slate-900">Party account · <Ur className="font-normal">پارٹی کھاتہ</Ur></h1>
        </div>
        <label className="min-w-[240px] flex-1 sm:flex-none">
          <span className="block text-xs font-medium text-slate-500">Client</span>
          <select className="input font-semibold" value={clientId} onChange={(e) => set("client", e.target.value)}>
            {list.map((x: any) => <option key={x.id} value={x.id}>{x.name}{x.city ? ` — ${x.city}` : ""}</option>)}
          </select>
        </label>
        <label><span className="block text-xs font-medium text-slate-500">From</span><input type="date" className="input" value={from} onChange={(e) => set("from", e.target.value)} /></label>
        <label><span className="block text-xs font-medium text-slate-500">To</span><input type="date" className="input" value={to} onChange={(e) => set("to", e.target.value)} /></label>
        <div className="flex flex-wrap gap-1.5">
          {[["This month", monthStart, pkToday()], ["3 months", new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10), pkToday()], ["All", "", ""]].map(([l, f, t]) => (
            <button key={l} className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50" onClick={() => { const p = new URLSearchParams(params); p.set("client", clientId); f ? p.set("from", f) : p.set("from", ""); t ? p.set("to", t) : p.set("to", ""); setParams(p, { replace: true }); }}>{l}</button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={() => window.print()}><Printer size={15} /> Print</button>
          <a className="btn-secondary" href={csvUrl}><Download size={15} /> Excel</a>
          {can("wholesale.manage") && c?.phone && <button className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/wholesale/clients/${clientId}/send-statement`, { body: { month: (to || pkToday()).slice(0, 7) } }), "Statement WhatsApp par bhej di")}><Send size={15} /> WhatsApp</button>}
          {can("wholesale.manage") && <button className="btn-secondary !border-brand-600 !text-brand-700" onClick={() => nav(`/wholesale/${clientId}?do=payment`)}><Wallet size={15} /> Receipt</button>}
          {can("wholesale.manage") && <button className="btn-primary" onClick={() => nav(`/wholesale/voucher?client=${clientId}`)}><FilePlus2 size={15} /> Supply voucher</button>}
        </div>
      </div>

      {stmt.error && <ErrorBox error={stmt.error} />}
      {!s ? <Loading /> : <>
        <div className="hidden print:block">
          <div className="text-lg font-bold">Statement of account — {c.name}</div>
          <div className="text-xs text-slate-600">{[c.business_name, c.city, c.phone].filter(Boolean).join(" · ")} · Period {from || "start"} to {to || "today"}</div>
        </div>
        {/* summary strip */}
        <section aria-label="Account summary" className="grid grid-cols-2 overflow-hidden rounded-xl border border-slate-200 bg-white sm:grid-cols-3 xl:grid-cols-6 print:grid-cols-6">
          <Cell label={`Opening${from ? ` (${dayLabel(from + "T00:00:00+05:00")})` : ""}`} value={drcr(s.opening_balance)} />
          <Cell label="Debit (supply / kiraya)" value={amt(dr)} cls="text-red-700" />
          <Cell label="Credit (payment / return)" value={amt(cr)} cls="text-emerald-700" />
          <Cell label="Closing balance" value={drcr(s.closing_balance)} strong tint />
          <div className="border-b border-r border-slate-100 p-4">
            <div className="text-xs text-slate-500">Credit limit</div>
            <div className="text-lg font-bold tabular-nums">{c.credit_limit > 0 ? amt(c.credit_limit) : "No limit"}</div>
            {limitPct != null && <><div className="mt-1.5 h-1.5 rounded bg-slate-100"><div className="h-full rounded" style={{ width: `${Math.min(100, Math.max(0, limitPct))}%`, background: limitPct >= 90 ? "#dc2626" : limitPct >= 75 ? "#f59e0b" : "#0b6e4f" }} /></div><div className="mt-1 text-xs text-slate-500">{limitPct}% used (today)</div></>}
          </div>
          <div className="border-b border-r border-slate-100 p-4">
            <div className="text-xs text-slate-500">Aging of balance (today)</div>
            <div className="mt-1 grid grid-cols-2 gap-x-3 text-xs leading-5">
              {AGE.map((a) => <span key={a.k}>{a.label.replace(" days", "")}: <b className={`tabular-nums ${ageing[a.k] > 0 ? a.cls : "text-slate-400"}`}>{amt(ageing[a.k])}</b></span>)}
            </div>
          </div>
        </section>

        <section aria-label="Ledger" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 print:hidden">
            <div className="flex rounded-lg bg-slate-100 p-0.5">
              {([["detailed", "Detailed"], ["monthly", "Monthly summary"], ["unpaid", "Unpaid bills"]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setView(k)} className={`rounded-md px-3 py-1.5 text-sm ${view === k ? "bg-white font-semibold shadow-sm" : "text-slate-600"}`}>{l}</button>
              ))}
            </div>
            <div className="flex-1" />
            {view === "detailed" && <>
              <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showFleet} onChange={(e) => setShowFleet(e.target.checked)} /> Vehicle &amp; litres</label>
              <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showVoid} onChange={(e) => setShowVoid(e.target.checked)} /> Show voided</label>
            </>}
          </div>

          {view === "detailed" && <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead><tr className="border-b border-slate-300 bg-slate-100 text-left text-xs font-bold text-slate-700">
                <th className="px-3 py-2">Date</th><th className="px-3 py-2">Voucher</th><th className="px-3 py-2">Particulars</th>
                {showFleet && <><th className="px-3 py-2">Vehicle</th><th className="px-3 py-2 text-right">Litres</th><th className="px-3 py-2 text-right">Rate</th></>}
                <th className="px-3 py-2 text-right">Debit</th><th className="px-3 py-2 text-right">Credit</th><th className="px-3 py-2 text-right">Balance</th>
              </tr></thead>
              <tbody>
                <tr className="border-b border-slate-100 bg-slate-50 font-semibold text-slate-700"><td className="px-3 py-2">{from ? dayLabel(from + "T00:00:00+05:00") : "—"}</td><td /><td className="px-3 py-2">Opening balance b/f</td>{showFleet && <><td /><td /><td /></>}<td /><td /><td className="px-3 py-2 text-right">{drcr(s.opening_balance)}</td></tr>
                {lines.map((l: any) => {
                  const note = l.type === "fuel_note";
                  return (
                    <tr key={l.id} className={`border-b border-slate-100 ${l.voided ? "text-slate-400 line-through" : note ? "text-slate-500" : "hover:bg-slate-50"}`}>
                      <td className="whitespace-nowrap px-3 py-2">{dayLabel(l.txn_date)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{note ? "—" : <button className="font-medium text-brand-700 hover:underline print:text-slate-900" onClick={() => setOpen(l)}>{voucherNo(l)}</button>}</td>
                      <td className="px-3 py-2">{particulars(l)}{l.voided ? " (VOID)" : ""}</td>
                      {showFleet && <><td className="whitespace-nowrap px-3 py-2">{l.vehicle_no ?? ""}</td>
                        <td className="px-3 py-2 text-right">{l.litres ? (l.type === "return" ? "−" : "") + num(l.litres, 0) : ""}</td>
                        <td className="px-3 py-2 text-right">{l.rate ? Number(l.rate).toFixed(2) : ""}</td></>}
                      <td className="px-3 py-2 text-right text-red-700">{l.debit ? amt(l.debit) : ""}</td>
                      <td className="px-3 py-2 text-right text-emerald-700">{l.credit ? amt(l.credit) : ""}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">{drcr(l.balance)}</td>
                    </tr>
                  );
                })}
                {!lines.length && <tr><td colSpan={showFleet ? 9 : 6} className="px-3 py-8 text-center text-slate-500">Is muddat mein koi entry nahi</td></tr>}
                <tr className="bg-slate-50 font-bold text-slate-800">
                  <td className="px-3 py-2" colSpan={showFleet ? 4 : 3}>Totals for the period</td>
                  {showFleet && <><td className="px-3 py-2 text-right">{num(litres, 0)}</td><td /></>}
                  <td className="px-3 py-2 text-right text-red-700">{amt(dr)}</td><td className="px-3 py-2 text-right text-emerald-700">{amt(cr)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">{drcr(s.closing_balance)}</td>
                </tr>
              </tbody>
            </table>
          </div>}

          {view === "monthly" && <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead><tr className="border-b border-slate-300 bg-slate-100 text-left text-xs font-bold text-slate-700"><th className="px-3 py-2">Month</th><th className="px-3 py-2 text-right">Entries</th><th className="px-3 py-2 text-right">Litres</th><th className="px-3 py-2 text-right">Opening</th><th className="px-3 py-2 text-right">Debit</th><th className="px-3 py-2 text-right">Credit</th><th className="px-3 py-2 text-right">Closing</th></tr></thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m.month} className="border-b border-slate-100">
                    <td className="px-3 py-2 font-medium">{new Date(m.month + "-15").toLocaleDateString("en-PK", { month: "long", year: "numeric" })}</td>
                    <td className="px-3 py-2 text-right">{m.n}</td><td className="px-3 py-2 text-right">{num(m.litres, 0)}</td>
                    <td className="px-3 py-2 text-right">{drcr(m.opening)}</td><td className="px-3 py-2 text-right text-red-700">{amt(m.dr)}</td>
                    <td className="px-3 py-2 text-right text-emerald-700">{amt(m.cr)}</td><td className="px-3 py-2 text-right font-semibold">{drcr(m.closing)}</td>
                  </tr>
                ))}
                {!months.length && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500">Is muddat mein koi entry nahi</td></tr>}
                <tr className="bg-slate-50 font-bold"><td className="px-3 py-2" colSpan={2}>Total</td><td className="px-3 py-2 text-right">{num(litres, 0)}</td><td className="px-3 py-2 text-right">{drcr(s.opening_balance)}</td><td className="px-3 py-2 text-right text-red-700">{amt(dr)}</td><td className="px-3 py-2 text-right text-emerald-700">{amt(cr)}</td><td className="px-3 py-2 text-right">{drcr(s.closing_balance)}</td></tr>
              </tbody>
            </table>
          </div>}

          {view === "unpaid" && <div className="overflow-x-auto">
            <p className="px-4 pt-3 text-xs text-slate-500">Aaj tak ka baqaya {pkr(s.due_now)} — purane bill pehle ada maane gaye hain (FIFO). Ye list date filter se azad hai.</p>
            <table className="mt-2 w-full text-sm tabular-nums">
              <thead><tr className="border-b border-slate-300 bg-slate-100 text-left text-xs font-bold text-slate-700"><th className="px-3 py-2">Date</th><th className="px-3 py-2">Voucher</th><th className="px-3 py-2">Particulars</th><th className="px-3 py-2">Vehicle</th><th className="px-3 py-2 text-right">Bill</th><th className="px-3 py-2 text-right">Unpaid</th><th className="px-3 py-2 text-right">Age</th></tr></thead>
              <tbody>
                {(s.unpaid?.bills ?? []).map((b: any) => (
                  <tr key={b.id} className="border-b border-slate-100">
                    <td className="whitespace-nowrap px-3 py-2">{dayLabel(b.txn_date)}</td>
                    <td className="px-3 py-2"><button className="font-medium text-brand-700 hover:underline" onClick={() => setOpen(b)}>{voucherNo(b)}</button></td>
                    <td className="px-3 py-2">{particulars(b)}{b.litres ? ` · ${num(b.litres, 0)} L` : ""}</td>
                    <td className="px-3 py-2">{b.vehicle_no ?? ""}</td>
                    <td className="px-3 py-2 text-right">{amt(b.amount)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{amt(b.unpaid)}</td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right ${b.days > 60 ? "font-semibold text-red-700" : b.days > 30 ? "text-amber-700" : ""}`}>{b.days} days</td>
                  </tr>
                ))}
                {s.unpaid?.older > 0 && <tr className="border-b border-slate-100 text-slate-600"><td className="px-3 py-2" colSpan={5}>Opening balance / older than any bill</td><td className="px-3 py-2 text-right font-semibold">{amt(s.unpaid.older)}</td><td /></tr>}
                {!(s.unpaid?.bills ?? []).length && !(s.unpaid?.older > 0) && <tr><td colSpan={7} className="px-3 py-8 text-center text-emerald-700">Koi bill baqi nahi — hisaab saaf hai ✓</td></tr>}
                <tr className="bg-slate-50 font-bold"><td className="px-3 py-2" colSpan={5}>Total unpaid</td><td className="px-3 py-2 text-right">{amt(Math.max(0, s.due_now))}</td><td /></tr>
              </tbody>
            </table>
          </div>}
          <div className="flex flex-wrap justify-between gap-2 px-4 py-3 text-xs text-slate-500 print:hidden">
            <span>Voucher number par click karein — poori entry, print aur WhatsApp. WS = supply · RV = receipt · CN = return · JV = kiraya / adjustment</span>
            <span>{lines.length} entries</span>
          </div>
        </section>
      </>}
      {open && <WholesaleEntryView clientId={Number(clientId)} txnId={Number(open.id)} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Cell({ label, value, cls = "", strong, tint }: { label: string; value: string; cls?: string; strong?: boolean; tint?: boolean }) {
  return (
    <div className={`border-b border-r border-slate-100 p-4 ${tint ? "bg-rose-50/60" : ""}`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-lg tabular-nums ${strong ? "font-extrabold" : "font-bold"} ${cls}`}>{value}</div>
    </div>
  );
}
