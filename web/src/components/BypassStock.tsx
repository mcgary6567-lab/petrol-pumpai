/** "Baqi stock" — lot-wise bypass stock (which supplier bill the held fuel sits on), the per-fuel reconciliation and the
 *  outs; a lot stays here until it is delivered to a client or unloaded into our tank. */
import { Link } from "react-router-dom";
import { useApi } from "../lib/api";
import { Empty, Loading } from "./ui";
import { Ur } from "./VoiceShell";
import { PRODUCTS, dt, num, pkr } from "../lib/format";
import { AlertTriangle, Layers } from "lucide-react";

export function BypassStockTab() {
  const { data, error } = useApi<any>("/bypass/lots");
  if (error) return <div className="card p-4 text-sm text-red-700">{String(error)}</div>;
  if (!data) return <Loading />;
  const fuels: any[] = data.fuels ?? [];
  const live = fuels.filter((f) => f.bought > 0 || f.delivered > 0 || f.unloaded > 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Layers size={18} className="text-slate-500" /> Baqi stock (bypass) · <Ur>باقی اسٹاک</Ur></h2>
          <p className="text-sm text-slate-600">Supplier se jitna liya − client ko jitna diya − apne tank me jitna dala = jo abhi tanker / depot par hamara pada hai. Har lot us bill ke saath jab tak bik na jaye ya tank me na jaye.</p>
        </div>
        <div className="text-right"><div className="text-xs text-slate-500">Kul baqi</div><div className={`text-xl font-bold tabular-nums ${data.total.litres < -0.01 ? "text-rose-700" : ""}`}>{num(data.total.litres)} L · {pkr(data.total.value)}</div></div>
      </div>
      {!live.length && <Empty>Abhi koi bypass khareed nahi.</Empty>}
      {live.map((f) => (
        <section key={f.product} className="card overflow-hidden" aria-label={`${PRODUCTS[f.product] ?? f.product} stock`}>
          <div className="grid grid-cols-2 gap-px border-b bg-slate-100 sm:grid-cols-4">
            {[["Khareeda (bought)", f.bought, ""], ["Client ko diya", f.delivered, "text-slate-700"], ["Apne tank me", f.unloaded, "text-slate-700"], ["Baqi", f.balance, f.balance < -0.01 ? "text-rose-700" : "text-emerald-700"]].map(([l, v, c]) => (
              <div key={String(l)} className="bg-white p-3"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{PRODUCTS[f.product] ?? f.product} · {l}</div><div className={`text-lg font-bold tabular-nums ${c}`}>{num(v as number)} L</div></div>
            ))}
          </div>
          {f.balance < -0.01 && (
            <div className="flex items-start gap-2 border-b bg-rose-50 p-3 text-sm text-rose-900">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div><b>{num(-f.balance)} L zyada nikla</b> jitna khareeda hi nahi — kisi delivery me supplier wali khareed (purchase line) likhna reh gayi, ya litre ghalat hain. Neeche "zyada nikla" entries dekh kar us delivery ko kholein aur khareed add / theek karein.
                {f.over?.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs">{f.over.map((o: any) => <li key={o.id}>{dt(o.txn_date)} · {num(o.litres)} L · {o.tank ? `apne tank ${o.tank}` : o.client} · delivery #{o.delivery_id ?? "—"}</li>)}</ul>}
              </div>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead><tr><th className="th">Tareekh</th><th className="th">Delivery</th><th className="th">Supplier (kis se liya)</th><th className="th">Gaari</th><th className="th text-right">Khareeda</th><th className="th text-right">Rate</th><th className="th text-right">Nikla</th><th className="th text-right">Baqi</th><th className="th text-right">Value (cost)</th><th className="th text-right">Din</th></tr></thead>
              <tbody className="tabular-nums">
                {!f.lots.length && <tr><td className="td text-center text-slate-500" colSpan={10}>Is fuel ka koi lot baqi nahi{f.closed_lots ? ` · ${f.closed_lots} lot poore bik / unload ho chuke` : ""}.</td></tr>}
                {f.lots.map((l: any) => (
                  <tr key={l.id} className="border-t">
                    <td className="td whitespace-nowrap">{dt(l.txn_date)}</td>
                    <td className="td">{l.delivery_id ? <Link className="text-brand-700 underline" to={`/wholesale?tab=trips`}>#{l.delivery_id}</Link> : "—"}{l.ref ? <div className="text-xs text-slate-500">{l.ref}</div> : null}</td>
                    <td className="td font-medium">{l.supplier}</td>
                    <td className="td text-xs">{[l.vehicle_no, l.driver_name].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="td text-right">{num(l.litres)} L</td>
                    <td className="td text-right">Rs {num(l.cost_rate, 2)}</td>
                    <td className="td text-right text-slate-600">{num(l.used)} L</td>
                    <td className="td text-right font-semibold">{num(l.left)} L</td>
                    <td className="td text-right">{pkr(l.value_left)}</td>
                    <td className="td text-right">{l.days}</td>
                  </tr>
                ))}
              </tbody>
              {f.lots.length > 0 && <tfoot><tr className="border-t-2 bg-slate-50 font-semibold tabular-nums"><td className="td" colSpan={7}>Kul baqi · {PRODUCTS[f.product] ?? f.product}</td><td className="td text-right">{num(f.lots.reduce((a: number, l: any) => a + l.left, 0))} L</td><td className="td text-right">{pkr(f.value)}</td><td className="td"></td></tr></tfoot>}
            </table>
          </div>
          {f.outs?.length > 0 && (
            <details className="border-t">
              <summary className="cursor-pointer px-4 py-2 text-sm text-slate-600">Nikla hua maal — aakhri {f.outs.length} entries · <Ur>نکلا ہوا مال</Ur></summary>
              <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm">
                <thead><tr><th className="th">Tareekh</th><th className="th">Kahan gaya</th><th className="th">Delivery</th><th className="th text-right">Litre</th><th className="th text-right">Cost rate</th><th className="th text-right">Cost</th><th className="th text-right">Sale</th><th className="th">By</th></tr></thead>
                <tbody className="tabular-nums">{f.outs.map((o: any) => (
                  <tr key={o.id} className="border-t"><td className="td whitespace-nowrap">{dt(o.txn_date)}</td><td className="td">{o.tank ? <>Apna tank · {o.tank}</> : <>Client · {o.client}</>}</td><td className="td">{o.delivery_id ? `#${o.delivery_id}` : "—"}</td>
                    <td className="td text-right">{num(o.litres)} L</td><td className="td text-right">Rs {num(o.unit_cost, 2)}</td><td className="td text-right">{pkr(o.cost_amount)}</td><td className="td text-right">{o.sale_amount ? <>{pkr(o.sale_amount)} <span className="text-xs text-slate-500">@ {num(o.sale_rate, 2)}</span></> : "—"}</td><td className="td text-xs">{o.created_by}</td></tr>
                ))}</tbody>
              </table></div>
            </details>
          )}
        </section>
      ))}
    </div>
  );
}
