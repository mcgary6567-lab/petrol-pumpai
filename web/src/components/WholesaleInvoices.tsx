import { Fragment, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Ban, BookOpen, FilePlus2, Printer, Send, Wallet } from "lucide-react";
import { api, useApi } from "../lib/api";
import { Empty, ErrorBox, Loading, Pager, useAction, usePaged } from "./ui";
import { ErpBar, ErpSearch, Ur } from "./WholesaleErp";
import { PRODUCTS, num, pkr } from "../lib/format";
import { useAuth } from "../App";
import { useBusiness } from "./Letterhead";
import { askCancel, pinHeader } from "./CancelEntry";

const day = (iso: string) => new Date(Date.parse(iso)).toLocaleDateString("en-PK", { day: "2-digit", month: "short", year: "numeric" });
const amt = (n: number) => num(Math.round(n * 100) / 100, 0);
export const INV_STATUS: Record<string, { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  partly: { label: "Partly paid", cls: "bg-amber-50 text-amber-800 ring-amber-200" },
  unpaid: { label: "Unpaid", cls: "bg-sky-50 text-sky-800 ring-sky-200" },
  overdue: { label: "Overdue", cls: "bg-red-50 text-red-700 ring-red-200" },
  void: { label: "Void", cls: "bg-slate-100 text-slate-500 ring-slate-200" },
};
export const StatusChip = ({ s }: { s: string }) => <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${INV_STATUS[s]?.cls ?? ""}`}>{INV_STATUS[s]?.label ?? s}</span>;
const TABS = [["all", "All"], ["open", "Open"], ["unpaid", "Unpaid"], ["partly", "Partly paid"], ["overdue", "Overdue"], ["paid", "Paid"], ["void", "Void"]] as const;
const pkToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);

/** Zoho-style supply invoices: every voucher / supply as one bill with paid / unpaid status, and a printable bill beside the list. */
export function SupplyInvoices() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "all";
  const [q, setQ] = useState(params.get("q") ?? "");
  const from = params.get("from") ?? new Date(Date.now() - 89 * 864e5 + 5 * 3600_000).toISOString().slice(0, 10);
  const to = params.get("to") ?? "";
  const client = params.get("client") ?? "";
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  const qs = new URLSearchParams(Object.entries({ status, from, to, client, q: params.get("q") ?? "" }).filter(([, v]) => v)).toString();
  const list = useApi<any>(`/wholesale/invoices?${qs}`);
  const sel = params.get("no") ?? list.data?.invoices?.[0]?.no ?? "";
  useEffect(() => { const t = setTimeout(() => set("q", q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const data = list.data;
  const paged = usePaged(data?.invoices ?? [], 10);
  return (
    <div className="space-y-4">
      <ErpBar crumb="Sales › Supply invoices" title="Supply invoices" ur="سپلائی بل">
        <ErpSearch value={q} onChange={setQ} placeholder="Bill no, client, gaari, bilty… · تلاش" className="w-full sm:w-64" />
        <input type="date" className="input w-auto" aria-label="From" value={from} onChange={(e) => set("from", e.target.value)} />
        <input type="date" className="input w-auto" aria-label="To" max={pkToday()} value={to} onChange={(e) => set("to", e.target.value)} />
        {can("wholesale.manage") && <button className="btn-primary" onClick={() => nav("/wholesale/voucher")}><FilePlus2 size={15} /> New voucher</button>}
      </ErpBar>

      <div className="flex gap-1 overflow-x-auto border-b border-slate-200 print:hidden">
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => { const p = new URLSearchParams(params); p.set("status", k); p.delete("no"); setParams(p, { replace: true }); }}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${status === k ? "border-brand-600 font-semibold text-brand-700" : "border-transparent text-slate-600"}`}>
            {l} {data && <span className="ml-1 rounded-full bg-slate-100 px-1.5 text-xs text-slate-600">{data.counts[k]}</span>}
          </button>
        ))}
      </div>

      {list.error && <ErrorBox error={list.error} />}
      {data && <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-100 sm:grid-cols-5 print:hidden">
        {[["Billed", pkr(data.totals.billed), ""], ["Collected", pkr(data.totals.collected), "text-emerald-700"], ["Unpaid", pkr(data.totals.unpaid), "text-sky-800"], ["Overdue > 30 days", pkr(data.totals.overdue), data.totals.overdue > 0 ? "text-red-700" : ""], ["Litres", `${num(data.totals.litres)} L`, ""]].map(([l, v, c]) => (
          <div key={l} className="bg-white px-4 py-3"><div className="text-xs text-slate-500">{l}</div><div className={`text-lg font-bold tabular-nums ${c}`}>{v}</div></div>
        ))}
      </div>}

      {!data ? <Loading /> : (
        <div className="flex flex-wrap items-start gap-4">
          <section aria-label="Invoices" className="min-w-0 flex-[1_1_420px] overflow-hidden rounded-xl border border-slate-200 bg-white print:hidden">
            {!data.invoices.length ? <Empty>Is filter mein koi bill nahi</Empty> : (
              <ul className="divide-y divide-slate-100">
                {(paged.slice as any[]).map((i) => (
                  <li key={i.no}><button onClick={() => set("no", i.no)} className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 ${sel === i.no ? "bg-brand-50/60 ring-1 ring-inset ring-brand-200" : ""}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><b className="truncate">{i.client_name}</b><StatusChip s={i.status} /></div>
                      <div className="mt-0.5 text-xs text-slate-500">{i.no} · {day(i.txn_date)}{i.litres ? ` · ${num(i.litres)} L ${i.products.map((p: string) => PRODUCTS[p] ?? p).join(" + ")}` : " · kiraya"}{i.vehicle_no ? ` · ${i.vehicle_no}` : ""}</div>
                    </div>
                    <div className="text-right tabular-nums">
                      <div className="font-bold">{pkr(i.amount)}</div>
                      <div className={`text-xs ${i.status === "overdue" ? "font-semibold text-red-700" : "text-slate-500"}`}>{i.unpaid > 0.5 ? `due ${pkr(i.unpaid)} · ${i.days} d` : i.status === "void" ? "void" : "settled"}</div>
                    </div>
                  </button></li>
                ))}
              </ul>
            )}
            <div className="px-4 pb-2"><Pager {...paged} /></div>
          </section>
          <div className="min-w-0 flex-[1.4_1_520px]">{sel ? <InvoiceView no={sel} onChanged={() => list.reload()} /> : <Empty>Bill chunen</Empty>}</div>
        </div>
      )}
    </div>
  );
}

/** One bill, printable: letterhead, bill-to, lines, totals and balance, plus the journal it posted and its history. */
export function InvoiceView({ no, onChanged }: { no: string; onChanged?: () => void }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const biz = useBusiness();
  const inv = useApi<any>(`/wholesale/invoices/${no}`);
  const { busy, run } = useAction();
  if (inv.error) return <ErrorBox error={inv.error} />;
  if (!inv.data) return <Loading />;
  const i = inv.data, c = i.client;
  const live = i.lines.filter((l: any) => !l.voided);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 print:hidden">
        <button className="btn-secondary" onClick={() => window.print()}><Printer size={15} /> Print / PDF</button>
        {can("wholesale.manage") && c.phone && i.status !== "void" && <button className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/wholesale/invoices/${i.no}/whatsapp`, { body: {} }), "Poora bill WhatsApp par bhej diya")}><Send size={15} /> WhatsApp</button>}
        {can("wholesale.manage") && i.unpaid > 0.5 && <button className="btn-secondary !border-brand-600 !text-brand-700" onClick={() => nav(`/wholesale/${c.id}?do=payment`)}><Wallet size={15} /> Record payment</button>}
        <button className="btn-secondary" onClick={() => nav(`/wholesale/ledger?client=${c.id}`)}><BookOpen size={15} /> Ledger</button>
        {can("wholesale.void") && live.length > 0 && <button className="btn-secondary !text-red-700" onClick={async () => {
          const a = await askCancel({ title: `Bill ${i.no} mansookh karein`, what: <><b>{pkr(i.amount)}</b> · {c.name} · {live.length} line{live.length > 1 ? "s" : ""}<div className="text-xs">Stock tank mein wapas aayega aur khata kam hoga</div></> });
          if (!a) return;
          for (const l of live) await api(`/wholesale/txns/${l.id}/void`, { body: { reason: a.reason }, headers: pinHeader(a) }).catch((e) => alert(e.message));
          inv.reload(); onChanged?.();
        }}><Ban size={15} /> Void</button>}
      </div>

      <article className="rounded-xl border border-slate-200 bg-white p-6 print:border-0 print:p-0">
        <div className="hidden text-center text-lg font-extrabold tracking-wide print:block">SUPPLY INVOICE · {i.no}</div>
        <div className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-brand-600 pb-3 print:hidden">
          <div><div className="text-lg font-extrabold">{biz?.name ?? ""}</div><div className="text-xs text-slate-500">{[biz?.place, biz?.biz_phone || biz?.owner_phone].filter(Boolean).join(" · ")}</div></div>
          <div className="text-right"><div className="text-xl font-extrabold tracking-wide text-slate-800">SUPPLY INVOICE</div><div className="text-sm text-slate-600">{i.no}</div></div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div><div className="text-xs font-semibold uppercase text-slate-500">Bill to</div><div className="font-bold">{c.name}</div><div className="text-slate-600">{[c.business_name, c.address || c.city, c.phone].filter(Boolean).join(" · ")}</div></div>
          <div className="text-right"><div><span className="text-slate-500">Invoice no </span><b>{i.no}</b></div><div><span className="text-slate-500">Date </span>{day(i.txn_date)}</div>
            {i.ref && <div><span className="text-slate-500">Bilty / ref </span>{i.ref}</div>}{i.vehicle_no && <div><span className="text-slate-500">Vehicle </span>{i.vehicle_no}</div>}
            <div className="mt-1 print:hidden"><StatusChip s={i.status} /></div></div>
        </div>
        <table className="mt-4 w-full text-sm tabular-nums">
          <thead><tr className="border-y border-slate-300 bg-slate-50 text-left text-xs font-bold text-slate-700"><th className="px-2 py-2">#</th><th className="px-2 py-2">Item</th><th className="px-2 py-2">From</th><th className="px-2 py-2 text-right">Litres</th><th className="px-2 py-2 text-right">Rate</th><th className="px-2 py-2 text-right">Amount</th></tr></thead>
          <tbody>{i.lines.map((l: any, n: number) => (
            <tr key={l.id} className={`border-b border-slate-100 ${l.voided ? "text-slate-400 line-through" : ""}`}>
              <td className="px-2 py-2">{n + 1}</td>
              <td className="px-2 py-2">{l.type === "supply" ? `${PRODUCTS[l.product] ?? l.product}` : "Carriage / kiraya"}{l.location ? <div className="text-xs text-slate-500">→ {l.location}</div> : null}</td>
              <td className="px-2 py-2 text-xs text-slate-600">{l.tank_name ?? l.station_name ?? ""}</td>
              <td className="px-2 py-2 text-right">{l.litres ? num(l.litres) : ""}</td>
              <td className="px-2 py-2 text-right">{l.rate ? Number(l.rate).toFixed(2) : ""}</td>
              <td className="px-2 py-2 text-right font-semibold">{amt(l.amount)}</td>
            </tr>
          ))}</tbody>
        </table>
        <div className="mt-3 flex justify-end">
          <div className="w-72 space-y-1 text-sm tabular-nums">
            <div className="flex justify-between"><span className="text-slate-500">Litres</span><span>{num(i.litres)} L</span></div>
            <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-bold"><span>Total</span><span>{pkr(i.amount)}</span></div>
            <div className="flex justify-between text-emerald-700"><span>Paid against this bill</span><span>{pkr(i.amount - i.unpaid)}</span></div>
            <div className={`flex justify-between rounded-md px-2 py-1 font-extrabold ${i.unpaid > 0.5 ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}><span>Balance due</span><span>{pkr(i.unpaid)}</span></div>
            <div className="flex justify-between text-xs text-slate-500"><span>Client's total balance</span><span>{pkr(c.due)}</span></div>
          </div>
        </div>
        {live[0]?.note && <p className="mt-3 text-sm"><span className="text-slate-500">Narration: </span>{live[0].note}</p>}
        <div className="mt-8 hidden grid-cols-2 gap-10 text-center text-xs text-slate-600 print:grid"><div className="border-t border-slate-400 pt-1">Received by (client)</div><div className="border-t border-slate-400 pt-1">Authorised signature</div></div>
      </article>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 print:hidden">
        <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <div className="mb-2 font-bold">Journal entry · <Ur className="font-normal">کھاتے میں انٹری</Ur></div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 gap-y-1 text-xs tabular-nums">
            <span className="font-semibold text-slate-500">Account</span><span className="text-right font-semibold text-slate-500">Dr</span><span className="text-right font-semibold text-slate-500">Cr</span>
            {i.posting.map((p: any) => <Fragment key={p.account}><span className={p.cr ? "pl-3" : ""}>{p.account}</span><span className="text-right">{p.dr ? amt(p.dr) : ""}</span><span className="text-right">{p.cr ? amt(p.cr) : ""}</span></Fragment>)}
          </div>
          {!i.posting.length && <p className="text-slate-500">Void — kuch post nahi</p>}
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <div className="mb-2 font-bold">Activity</div>
          <ul className="space-y-1.5">{i.activity.map((a: any, n: number) => <li key={n} className="text-xs"><span className="text-slate-700">{a.text}</span>{a.who && <span className="text-slate-500"> · {a.who}</span>}{a.at && <span className="text-slate-400"> · {new Date(a.at).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" })}</span>}</li>)}</ul>
        </section>
      </div>
    </div>
  );
}
