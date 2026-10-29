import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FilePlus2, Search } from "lucide-react";
import { api, useApi } from "../lib/api";
import { ErrorBox, Loading, useAction } from "./ui";
import { PRODUCTS, num, pkr } from "../lib/format";
import { useAuth } from "../App";
import { OrderForm } from "./WholesaleDesk";

const Ur = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => <span lang="ur" dir="rtl" className={`font-urdu ${className}`}>{children}</span>;
const day = (iso: string) => new Date(iso.length === 10 ? iso + "T00:00:00+05:00" : iso).toLocaleDateString("en-PK", { day: "numeric", month: "short" });
const COLS: Record<string, { title: string; ur: string; hint: string; tint: string }> = {
  requests: { title: "Client requests", ur: "کلائنٹ کی درخواست", hint: "from the client portal", tint: "border-t-violet-500" },
  orders: { title: "Order book", ur: "آرڈر بک", hint: "booked, not yet supplied", tint: "border-t-amber-500" },
  unpaid: { title: "Supplied — unpaid", ur: "سپلائی، رقم باقی", hint: "bills up to 30 days", tint: "border-t-sky-500" },
  overdue: { title: "Overdue", ur: "لیٹ ادائیگی", hint: "unpaid over 30 days", tint: "border-t-red-500" },
  paid: { title: "Paid", ur: "وصول", hint: "payments in the last 7 days", tint: "border-t-emerald-500" },
};
const Tag = ({ cls, children }: { cls: string; children: React.ReactNode }) => <span className={`self-start rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>;

/** Order to cash: every wholesale deal from the client's ask to the money in, as one board built from the real records. */
export function OrderToCash() {
  const { can, user } = useAuth();
  const nav = useNavigate();
  const { data, error, reload } = useApi<any>("/wholesale/pipeline");
  const [q, setQ] = useState("");
  const [fuel, setFuel] = useState("");
  const [book, setBook] = useState<any>(null);
  const { busy, run } = useAction();
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const manage = can("wholesale.manage"), ceo = user?.role === "admin";
  const keep = (x: any) => (!q || String(x.client_name ?? "").toLowerCase().includes(q.toLowerCase()) || String(x.no ?? x.vehicle_no ?? "").toLowerCase().includes(q.toLowerCase()))
    && (!fuel || x.product === fuel || (x.products ?? []).includes(fuel));
  const col = (k: string) => data.columns.find((c: any) => c.key === k);
  const decide = (r: any, d: "approve" | "reject") => run(() => api(`/wholesale/requests/${r.id}/${d}`, { body: {} }), d === "approve" ? "Approve — client ko WhatsApp chala gaya" : "Reject kar diya").then((x) => x && reload());

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div className="mr-auto"><div className="text-xs text-slate-500"><Link to="/wholesale" className="hover:underline">Wholesale</Link> › Sales</div>
          <h1 className="text-xl font-bold">Order to cash · <Ur className="font-normal">آرڈر سے وصولی تک</Ur></h1></div>
        <label className="relative"><Search size={15} className="absolute left-2.5 top-2.5 text-slate-400" /><input className="input w-56 pl-8" placeholder="Client, bill no…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <select className="input w-auto" value={fuel} onChange={(e) => setFuel(e.target.value)} aria-label="Fuel"><option value="">Fuel: all</option>{Object.entries(PRODUCTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        {manage && <button className="btn-secondary" onClick={() => setBook({})}>+ Order</button>}
        {manage && <button className="btn-primary" onClick={() => nav("/wholesale/voucher")}><FilePlus2 size={15} /> Supply voucher</button>}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm">
        <span>Requests <b>{col("requests").count}</b> · {num(col("requests").litres)} L</span>
        <span>Booked <b>{num(col("orders").litres)} L</b></span>
        <span>Unpaid <b className="text-sky-800">{pkr(col("unpaid").amount)}</b></span>
        <span>Overdue <b className="text-red-700">{pkr(col("overdue").amount)}</b></span>
        <span>Paid this week <b className="text-emerald-700">{pkr(col("paid").amount)}</b></span>
      </div>

      <div className="flex items-start gap-3 overflow-x-auto pb-3 xl:grid xl:grid-cols-5 xl:overflow-visible">
        {data.columns.map((c: any) => {
          const meta = COLS[c.key], items = c.items.filter(keep);
          return (
            <section key={c.key} aria-label={meta.title} className={`flex w-72 min-w-0 shrink-0 flex-col gap-2 xl:w-auto rounded-xl border-t-4 bg-slate-100 p-2.5 ${meta.tint}`}>
              <div className="px-1">
                <div className="flex items-baseline justify-between gap-2"><b>{meta.title}</b><span className="text-xs text-slate-500">{items.length}{c.amount != null ? ` · ${pkr(c.amount)}` : c.litres ? ` · ${num(c.litres)} L` : ""}</span></div>
                <div className="text-xs text-slate-500">{meta.hint} · <Ur>{meta.ur}</Ur></div>
              </div>
              {!items.length && <div className="rounded-lg border border-dashed border-slate-300 p-3 text-center text-xs text-slate-500">Khaali</div>}
              {items.slice(0, 40).map((x: any) => (
                <article key={`${c.key}${x.id ?? x.no}`} className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-sm">
                  <button className="text-left font-semibold hover:underline" onClick={() => nav(`/wholesale/${x.client_id}`)}>{x.client_name}</button>
                  {c.key === "requests" && <>
                    <span>{PRODUCTS[x.product] ?? x.product} · {num(x.litres)} L</span>
                    <span className="text-xs text-slate-500">Wants {day(x.want_date)}{x.note ? ` · ${x.note}` : ""}</span>
                    {ceo ? <div className="mt-1 flex gap-2"><button disabled={busy} className="rounded-md bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white" onClick={() => decide(x, "approve")}>Approve</button><button disabled={busy} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs" onClick={() => decide(x, "reject")}>Reject</button></div>
                      : <Tag cls="bg-violet-50 text-violet-700">CEO approves</Tag>}
                  </>}
                  {c.key === "orders" && <>
                    <span>{PRODUCTS[x.product] ?? x.product} · {num(x.litres)} L</span>
                    <span className="text-xs text-slate-500">SO-{x.id} · for {day(x.needed_on)}{x.location ? ` · ${x.location}` : ""}</span>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {x.state === "late" ? <Tag cls="bg-red-50 text-red-700">Late</Tag> : x.state === "today" ? <Tag cls="bg-amber-50 text-amber-800">Today</Tag> : null}
                      {manage && <button className="rounded-md bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white" onClick={() => nav(`/wholesale/voucher?client=${x.client_id}&order=${x.id}`)}>Make voucher</button>}
                    </div>
                  </>}
                  {(c.key === "unpaid" || c.key === "overdue") && <>
                    <button className="text-left text-brand-700 hover:underline" onClick={() => nav(`/wholesale/invoices?no=${x.no}&client=${x.client_id}&from=2000-01-01`)}>{x.no} · {pkr(x.amount)}</button>
                    <span className="text-xs text-slate-500">{day(x.txn_date)}{x.litres ? ` · ${num(x.litres)} L` : ""}{x.vehicle_no ? ` · ${x.vehicle_no}` : ""}</span>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Tag cls={c.key === "overdue" ? "bg-red-50 text-red-700" : x.status === "partly" ? "bg-amber-50 text-amber-800" : "bg-sky-50 text-sky-800"}>{c.key === "overdue" ? `${x.days} days · due ${pkr(x.unpaid)}` : x.status === "partly" ? `Partly paid · due ${pkr(x.unpaid)}` : `Due ${pkr(x.unpaid)}`}</Tag>
                      {manage && <button className="rounded-md border border-brand-600 px-2 py-0.5 text-xs font-semibold text-brand-700" onClick={() => nav(`/wholesale/${x.client_id}?do=payment`)}>Receipt</button>}
                    </div>
                  </>}
                  {c.key === "paid" && <>
                    <span className="font-semibold text-emerald-700">{pkr(x.amount)}</span>
                    <span className="text-xs text-slate-500">RV-{x.id} · {day(x.txn_date)} · {x.method ?? "cash"}{x.ref && x.ref !== "refund:" ? ` · ${x.ref}` : ""}</span>
                  </>}
                </article>
              ))}
              {items.length > 40 && <button className="rounded-lg bg-white p-2 text-center text-xs font-semibold text-brand-700" onClick={() => nav(c.key === "orders" ? "/wholesale?tab=orders" : "/wholesale/invoices?status=open")}>+ {items.length - 40} more</button>}
            </section>
          );
        })}
      </div>
      <p className="text-xs text-slate-500">Board asal records se banta hai: portal ki requests, order book, bill (FIFO se purane bill pehle ada) aur wasooli.</p>
      {book && <OrderForm onClose={() => setBook(null)} onDone={() => { setBook(null); reload(); }} />}
    </div>
  );
}
