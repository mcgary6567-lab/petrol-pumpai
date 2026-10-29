import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Download, FilePlus2, Printer, Send, Wallet } from "lucide-react";
import { api, linkToken, useApi } from "../lib/api";
import { Empty, ErrorBox, Loading, Pager, useAction, usePaged } from "./ui";
import { PRODUCTS, num, pkr } from "../lib/format";
import { useAuth } from "../App";
import { WholesaleEntryView } from "./EntryView";
import { ErpBar, ErpSearch, Ur, bal } from "./WholesaleErp";

const pkToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const dayLabel = (iso: string) => new Date(Date.parse(iso)).toLocaleDateString("en-PK", { day: "2-digit", month: "short", year: "2-digit" });
const amt = (n: number) => num(Math.round(n * 100) / 100, 0);

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
const TH = "px-3 py-2 text-left text-xs font-bold text-slate-700";
const TD = "px-3 py-2";

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
  const setRange = (f: string, t: string) => { const p = new URLSearchParams(params); p.set("client", clientId); p.set("from", f); p.set("to", t); setParams(p, { replace: true }); };
  const [view, setView] = useState<"detailed" | "monthly" | "unpaid">("detailed");
  const [q, setQ] = useState("");
  const [dq, setDq] = useState(""); // debounced search sent to the server
  const [page, setPage] = useState(1);
  const [showFleet, setShowFleet] = useState(true);
  const [showVoid, setShowVoid] = useState(false);
  useEffect(() => { const t = setTimeout(() => { setDq(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setPage(1); }, [clientId, from, to, showVoid]);
  const qs = new URLSearchParams(Object.entries({ from, to, page: String(page), size: "10", q: dq, voided: showVoid ? "true" : "" }).filter(([, v]) => v)).toString();
  // one page of lines + running balances + period totals + months, computed server-side (a 5-year client never ships 20k rows)
  const stmt = useApi<any>(clientId ? `/wholesale/clients/${clientId}/statement?${qs}` : null);
  const [open, setOpen] = useState<any>(null);
  const { busy, run } = useAction();

  const s = stmt.data;
  const needle = dq.toLowerCase();
  const lines: any[] = s?.lines ?? [];
  const paged = { slice: lines, page: s?.page ?? 1, pages: s?.pages ?? 1, total: s?.total ?? 0, size: 10, setPage };
  const dr = s?.period?.debit ?? 0, cr = s?.period?.credit ?? 0, litres = s?.period?.litres ?? 0;
  const months: { month: string; opening: number; dr: number; cr: number; closing: number; litres: number; n: number }[] = s?.months ?? [];
  const unpaidRows = useMemo(() => (s?.unpaid?.bills ?? []).filter((b: any) => !needle || [voucherNo(b), particulars(b), b.vehicle_no, b.ref, b.amount, b.unpaid].some((v) => String(v ?? "").toLowerCase().includes(needle))), [s, needle]);
  const pagedUnpaid = usePaged(unpaidRows, 10);
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
  const cols = showFleet ? 9 : 6;
  const Bal = ({ n, strong }: { n: number; strong?: boolean }) => <span className={`whitespace-nowrap tabular-nums ${n < -0.5 ? "text-emerald-700" : ""} ${strong ? "font-extrabold" : ""}`}>{bal(n)}</span>;

  return (
    <div className="space-y-4">
      <ErpBar crumb="Accounts › Party ledger" title="Party account" ur="پارٹی کھاتہ">
        <select className="input w-auto min-w-[200px] font-semibold" aria-label="Client" value={clientId} onChange={(e) => set("client", e.target.value)}>
          {list.map((x: any) => <option key={x.id} value={x.id}>{x.name}{x.city ? ` — ${x.city}` : ""}</option>)}
        </select>
        <input type="date" className="input w-auto" aria-label="From" value={from} onChange={(e) => set("from", e.target.value)} />
        <input type="date" className="input w-auto" aria-label="To" value={to} onChange={(e) => set("to", e.target.value)} />
        <div className="flex gap-1">
          {([["Month", monthStart, pkToday()], ["3 mo", new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10), pkToday()], ["All", "", ""]] as const).map(([l, f, t]) => (
            <button key={l} className={`min-h-7 rounded-md border px-2 py-1 text-xs ${from === f && to === t ? "border-brand-600 bg-brand-50 font-semibold text-brand-700" : "border-slate-200 hover:bg-slate-50"}`} onClick={() => setRange(f, t)}>{l}</button>
          ))}
        </div>
        <button className="btn-secondary" onClick={() => window.print()} title="Print"><Printer size={15} /><span className="hidden sm:inline"> Print</span></button>
        <a className="btn-secondary" href={csvUrl} title="Excel / CSV"><Download size={15} /><span className="hidden sm:inline"> Excel</span></a>
        {can("wholesale.manage") && c?.phone && <button className="btn-secondary" disabled={busy} title="WhatsApp statement" onClick={() => run(() => api(`/wholesale/clients/${clientId}/send-statement`, { body: { month: (to || pkToday()).slice(0, 7) } }), "Statement WhatsApp par bhej di")}><Send size={15} /><span className="hidden sm:inline"> WhatsApp</span></button>}
        {can("wholesale.manage") && <button className="btn-secondary !border-brand-600 !text-brand-700" onClick={() => nav(`/wholesale/${clientId}?do=payment`)}><Wallet size={15} /> Receipt</button>}
        {can("wholesale.manage") && <button className="btn-primary" onClick={() => nav(`/wholesale/voucher?client=${clientId}`)}><FilePlus2 size={15} /><span className="hidden sm:inline"> Supply voucher</span><span className="sm:hidden"> Voucher</span></button>}
      </ErpBar>

      {stmt.error && <ErrorBox error={stmt.error} />}
      {!s ? <Loading /> : <>
        <div className="hidden print:block">
          <div className="text-lg font-bold">Statement of account — {c.name}</div>
          <div className="text-xs text-slate-600">{[c.business_name, c.city, c.phone].filter(Boolean).join(" · ")} · Period {from || "start"} to {to || "today"}</div>
        </div>
        {/* summary strip */}
        <section aria-label="Account summary" className="grid grid-cols-2 overflow-hidden rounded-xl border border-slate-200 bg-white sm:grid-cols-3 xl:grid-cols-6 print:grid-cols-6">
          <Cell label={`Opening${from ? ` · ${dayLabel(from + "T00:00:00+05:00")}` : ""}`} value={<Bal n={s.opening_balance} />} />
          <Cell label="Debit · supply / kiraya" value={amt(dr)} cls="text-red-700" />
          <Cell label="Credit · payment / return" value={amt(cr)} cls="text-emerald-700" />
          <Cell label={s.closing_balance < -0.5 ? "Closing · advance with us" : "Closing · client owes"} value={<Bal n={s.closing_balance} strong />} tint />
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
              {([["detailed", "Detailed"], ["monthly", "Monthly"], ["unpaid", `Unpaid bills${s.unpaid?.bills?.length ? ` (${s.unpaid.bills.length})` : ""}`]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setView(k)} className={`rounded-md px-3 py-1.5 text-sm ${view === k ? "bg-white font-semibold shadow-sm" : "text-slate-600"}`}>{l}</button>
              ))}
            </div>
            {view !== "monthly" && <ErpSearch value={q} onChange={setQ} placeholder="Voucher, gaari, ref, raqam… · تلاش" className="w-full sm:w-64" />}
            <div className="flex-1" />
            {view === "detailed" && <>
              <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showFleet} onChange={(e) => setShowFleet(e.target.checked)} /> Vehicle &amp; litres</label>
              <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showVoid} onChange={(e) => setShowVoid(e.target.checked)} /> Voided</label>
            </>}
          </div>

          {view === "detailed" && <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead><tr className="border-b border-slate-300 bg-slate-100">
                <th className={TH}>Date</th><th className={TH}>Voucher</th><th className={TH}>Particulars</th>
                {showFleet && <><th className={TH}>Vehicle</th><th className={`${TH} text-right`}>Litres</th><th className={`${TH} text-right`}>Rate</th></>}
                <th className={`${TH} text-right`}>Debit</th><th className={`${TH} text-right`}>Credit</th><th className={`${TH} text-right`}>Balance</th>
              </tr></thead>
              <tbody>
                {paged.page === 1 && !needle && <tr className="border-b border-slate-100 bg-slate-50 font-semibold text-slate-700"><td className={TD}>{from ? dayLabel(from + "T00:00:00+05:00") : "—"}</td><td /><td className={TD}>Opening balance b/f</td>{showFleet && <><td /><td /><td /></>}<td /><td /><td className={`${TD} text-right`}><Bal n={s.opening_balance} /></td></tr>}
                {(paged.slice as any[]).map((l) => {
                  const note = l.type === "fuel_note";
                  return (
                    <tr key={l.id} className={`border-b border-slate-100 ${l.voided ? "text-slate-400 line-through" : note ? "text-slate-500" : "hover:bg-slate-50"}`}>
                      <td className={`${TD} whitespace-nowrap`}>{dayLabel(l.txn_date)}</td>
                      <td className={`${TD} whitespace-nowrap`}>{note ? "—" : <button className="inline-flex min-h-6 items-center font-medium text-brand-700 hover:underline print:text-slate-900" onClick={() => setOpen(l)}>{voucherNo(l)}</button>}</td>
                      <td className={TD}>{particulars(l)}{l.voided ? " (VOID)" : ""}</td>
                      {showFleet && <><td className={`${TD} whitespace-nowrap`}>{l.vehicle_no ?? ""}</td>
                        <td className={`${TD} text-right`}>{l.litres ? (l.type === "return" ? "−" : "") + num(l.litres, 0) : ""}</td>
                        <td className={`${TD} text-right`}>{l.rate ? Number(l.rate).toFixed(2) : ""}</td></>}
                      <td className={`${TD} text-right text-red-700`}>{l.debit ? amt(l.debit) : ""}</td>
                      <td className={`${TD} text-right text-emerald-700`}>{l.credit ? amt(l.credit) : ""}</td>
                      <td className={`${TD} text-right`}><Bal n={l.balance} /></td>
                    </tr>
                  );
                })}
                {!lines.length && <tr><td colSpan={cols} className="px-3 py-8 text-center text-slate-500">{needle ? "Kuch nahi mila · کچھ نہیں ملا" : "Is muddat mein koi entry nahi"}</td></tr>}
                {stmt.loading && lines.length > 0 && <tr><td colSpan={cols} className="px-3 py-1 text-center text-xs text-slate-400">…</td></tr>}
                {!needle && <tr className="bg-slate-50 font-bold text-slate-800">{/* period totals on every page — they are the period's, not the page's */}
                  <td className={TD} colSpan={showFleet ? 4 : 3}>Totals for the period</td>
                  {showFleet && <><td className={`${TD} text-right`}>{num(litres, 0)}</td><td /></>}
                  <td className={`${TD} text-right text-red-700`}>{amt(dr)}</td><td className={`${TD} text-right text-emerald-700`}>{amt(cr)}</td>
                  <td className={`${TD} text-right`}><Bal n={s.closing_balance} strong /></td>
                </tr>}
              </tbody>
            </table>
            <div className="px-4 pb-2"><Pager {...paged} /></div>
          </div>}

          {view === "monthly" && <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead><tr className="border-b border-slate-300 bg-slate-100"><th className={TH}>Month</th><th className={`${TH} text-right`}>Entries</th><th className={`${TH} text-right`}>Litres</th><th className={`${TH} text-right`}>Opening</th><th className={`${TH} text-right`}>Debit</th><th className={`${TH} text-right`}>Credit</th><th className={`${TH} text-right`}>Closing</th></tr></thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m.month} className="border-b border-slate-100">
                    <td className={`${TD} font-medium`}>{new Date(m.month + "-15").toLocaleDateString("en-PK", { month: "long", year: "numeric" })}</td>
                    <td className={`${TD} text-right`}>{m.n}</td><td className={`${TD} text-right`}>{num(m.litres, 0)}</td>
                    <td className={`${TD} text-right`}><Bal n={m.opening} /></td><td className={`${TD} text-right text-red-700`}>{amt(m.dr)}</td>
                    <td className={`${TD} text-right text-emerald-700`}>{amt(m.cr)}</td><td className={`${TD} text-right font-semibold`}><Bal n={m.closing} /></td>
                  </tr>
                ))}
                {!months.length && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500">Is muddat mein koi entry nahi</td></tr>}
                <tr className="bg-slate-50 font-bold"><td className={TD} colSpan={2}>Total</td><td className={`${TD} text-right`}>{num(litres, 0)}</td><td className={`${TD} text-right`}><Bal n={s.opening_balance} /></td><td className={`${TD} text-right text-red-700`}>{amt(dr)}</td><td className={`${TD} text-right text-emerald-700`}>{amt(cr)}</td><td className={`${TD} text-right`}><Bal n={s.closing_balance} strong /></td></tr>
              </tbody>
            </table>
          </div>}

          {view === "unpaid" && <div className="overflow-x-auto">
            <p className="px-4 pt-3 text-xs text-slate-500">Aaj tak ka baqaya {pkr(s.due_now)} — purane bill pehle ada maane gaye hain (FIFO). Ye list date filter se azad hai.</p>
            <table className="mt-2 w-full text-sm tabular-nums">
              <thead><tr className="border-b border-slate-300 bg-slate-100"><th className={TH}>Date</th><th className={TH}>Voucher</th><th className={TH}>Particulars</th><th className={TH}>Vehicle</th><th className={`${TH} text-right`}>Bill</th><th className={`${TH} text-right`}>Unpaid</th><th className={`${TH} text-right`}>Age</th></tr></thead>
              <tbody>
                {(pagedUnpaid.slice as any[]).map((b) => (
                  <tr key={b.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className={`${TD} whitespace-nowrap`}>{dayLabel(b.txn_date)}</td>
                    <td className={TD}><button className="inline-flex min-h-6 items-center font-medium text-brand-700 hover:underline" onClick={() => setOpen(b)}>{voucherNo(b)}</button></td>
                    <td className={TD}>{particulars(b)}{b.litres ? ` · ${num(b.litres, 0)} L` : ""}</td>
                    <td className={TD}>{b.vehicle_no ?? ""}</td>
                    <td className={`${TD} text-right`}>{amt(b.amount)}</td>
                    <td className={`${TD} text-right font-semibold`}>{amt(b.unpaid)}</td>
                    <td className={`${TD} whitespace-nowrap text-right ${b.days > 60 ? "font-semibold text-red-700" : b.days > 30 ? "text-amber-700" : ""}`}>{b.days} days</td>
                  </tr>
                ))}
                {s.unpaid?.older > 0 && pagedUnpaid.page === pagedUnpaid.pages && <tr className="border-b border-slate-100 text-slate-600"><td className={TD} colSpan={5}>Opening balance / older than any bill</td><td className={`${TD} text-right font-semibold`}>{amt(s.unpaid.older)}</td><td /></tr>}
                {!unpaidRows.length && !(s.unpaid?.older > 0) && <tr><td colSpan={7} className="px-3 py-8 text-center text-emerald-700">{needle ? "Kuch nahi mila" : "Koi bill baqi nahi — hisaab saaf hai ✓"}</td></tr>}
                <tr className="bg-slate-50 font-bold"><td className={TD} colSpan={5}>Total unpaid</td><td className={`${TD} text-right`}>{amt(Math.max(0, s.due_now))}</td><td /></tr>
              </tbody>
            </table>
            <div className="px-4 pb-2"><Pager {...pagedUnpaid} /></div>
          </div>}
          <div className="flex flex-wrap justify-between gap-2 px-4 py-3 text-xs text-slate-500 print:hidden">
            <span>Balance = client par baqaya · <b className="text-emerald-700">Adv</b> = client ka advance humare paas · voucher number par click karein: poori entry, print, WhatsApp · WS supply · RV receipt · CN return · JV kiraya / adjustment</span>
            <span>{paged.total} entries</span>
          </div>
        </section>
      </>}
      {open && <WholesaleEntryView clientId={Number(clientId)} txnId={Number(open.id)} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Cell({ label, value, cls = "", tint }: { label: string; value: React.ReactNode; cls?: string; tint?: boolean }) {
  return (
    <div className={`border-b border-r border-slate-100 p-4 ${tint ? "bg-amber-50/60" : ""}`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}
