/** "Baqi stock" — lot-wise bypass stock (which supplier bill the held fuel sits on), the per-fuel reconciliation and the
 *  outs; a lot stays here until it is delivered to a client or unloaded into our tank. */
import { useState } from "react";
import { BypassDeliveryForm, BypassVoucher } from "../pages/Bypass";
import { api, useApi } from "../lib/api";
import { Empty, Field, Loading, Modal, useAction } from "./ui";
import { useAuth } from "../App";
import { Ur } from "./VoiceShell";
import { PRODUCTS, dt, num, pkr } from "../lib/format";
import { AlertTriangle, Fuel, Layers, Truck } from "lucide-react";

/** Vouchers saved before same-voucher costing carry the old pooled-average cost: one click re-costs them all. */
function RecostBanner({ onDone }: { onDone: () => void }) {
  const { can } = useAuth();
  const pre = useApi<any>(can("entries.edit") ? "/bypass/recost" : null);
  const { busy, run } = useAction();
  if (!pre.data || !pre.data.vouchers?.length) return null;
  const v = pre.data;
  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="font-semibold">{v.vouchers.length} purane voucher purane (average) rule par costed hain · <Ur>پرانے واؤچر</Ur></div>
      <p className="mt-1 text-xs">Naya rule: voucher ka maal usi voucher ki khareed par cost hota hai, held stock sirf zaid litres par. Recost se in vouchers ka munafa kul <b>{pkr(Math.abs(v.margin_shift))}</b> {v.margin_shift >= 0 ? "zyada" : "kam"} hoga; stock ki kul value aur books same rehti hain, sirf voucher-wise munafa durust hota hai. Audit log me record rahega.</p>
      <ul className="mt-2 max-h-40 space-y-0.5 overflow-auto text-xs">
        {v.vouchers.slice(0, 12).map((x: any) => <li key={String(x.delivery_id)} className="flex justify-between gap-2 tabular-nums"><span>{x.delivery_id ? `BYP-${x.delivery_id}` : "stock se"} · {dt(x.txn_date).slice(0, 11)}</span><span>munafa {pkr(x.old_margin)} → <b>{pkr(x.new_margin)}</b></span></li>)}
        {v.vouchers.length > 12 && <li className="text-slate-500">… aur {v.vouchers.length - 12}</li>}
      </ul>
      <button className="btn-primary mt-3 min-h-10" disabled={busy} onClick={() => run(() => api("/bypass/recost", { body: {} }), "Recost ho gaya").then((ok) => { if (ok) { pre.reload(); onDone(); } })}>Naye rule par recost karein</button>
    </div>
  );
}

export function BypassStockTab() {
  const { data, error, reload } = useApi<any>("/bypass/lots");
  const [voucher, setVoucher] = useState<number | null>(null); // BYP voucher opened from a lot / out row
  const { can } = useAuth();
  const manage = can("wholesale.manage");
  const [deliver, setDeliver] = useState<any>(null); // a lot being delivered to a client
  const [toTank, setToTank] = useState<any>(null);   // a lot being emptied into our tank
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
      <RecostBanner onDone={reload} />
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
              <thead><tr>{manage && <th className="th">Karein</th>}<th className="th">Tareekh</th><th className="th">Delivery</th><th className="th">Supplier (kis se liya)</th><th className="th">Gaari</th><th className="th text-right">Khareeda</th><th className="th text-right">Rate</th><th className="th text-right">Nikla</th><th className="th text-right">Baqi</th><th className="th text-right">Value (cost)</th><th className="th text-right">Din</th></tr></thead>
              <tbody className="tabular-nums">
                {!f.lots.length && <tr><td className="td text-center text-slate-500" colSpan={manage ? 11 : 10}>Is fuel ka koi lot baqi nahi{f.closed_lots ? ` · ${f.closed_lots} lot poore bik / unload ho chuke` : ""}.</td></tr>}
                {f.lots.map((l: any) => (
                  <tr key={l.id} className="border-t">
                    {manage && <td className="td"><div className="flex flex-col gap-1">
                      <button type="button" className="btn-primary min-h-9 whitespace-nowrap !px-2.5 !py-1 text-xs" title="Is lot ka maal client ko dein" onClick={() => setDeliver({ ...l, product: f.product })}><Truck size={14} /> Client ko dein</button>
                      <button type="button" className="btn-secondary min-h-9 whitespace-nowrap !px-2.5 !py-1 text-xs" title="Is lot ka maal apne pump ke tank mein" onClick={() => setToTank({ ...l, product: f.product })}><Fuel size={14} /> Apne tank mein</button>
                    </div></td>}
                    <td className="td whitespace-nowrap">{dt(l.txn_date)}</td>
                    <td className="td">{l.delivery_id ? <button type="button" className="font-mono text-brand-700 underline" title="Bill / voucher kholein" onClick={() => setVoucher(l.delivery_id)}>BYP-{l.delivery_id}</button> : "—"}{l.ref ? <div className="text-xs text-slate-500">{l.ref}</div> : null}</td>
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
              {f.lots.length > 0 && <tfoot><tr className="border-t-2 bg-slate-50 font-semibold tabular-nums">{manage && <td className="td"></td>}<td className="td" colSpan={7}>Kul baqi · {PRODUCTS[f.product] ?? f.product}</td><td className="td text-right">{num(f.lots.reduce((a: number, l: any) => a + l.left, 0))} L</td><td className="td text-right">{pkr(f.value)}</td><td className="td"></td></tr></tfoot>}
            </table>
          </div>
          {f.outs?.length > 0 && (
            <details className="border-t">
              <summary className="cursor-pointer px-4 py-2 text-sm text-slate-600">Nikla hua maal — aakhri {f.outs.length} entries · <Ur>نکلا ہوا مال</Ur></summary>
              <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm">
                <thead><tr><th className="th">Tareekh</th><th className="th">Kahan gaya</th><th className="th">Delivery</th><th className="th text-right">Litre</th><th className="th text-right">Cost rate</th><th className="th text-right">Cost</th><th className="th text-right">Sale</th><th className="th">By</th></tr></thead>
                <tbody className="tabular-nums">{f.outs.map((o: any) => (
                  <tr key={o.id} className="border-t"><td className="td whitespace-nowrap">{dt(o.txn_date)}</td><td className="td">{o.tank ? <>Apna tank · {o.tank}</> : <>Client · {o.client}</>}</td><td className="td">{o.delivery_id ? <button type="button" className="font-mono text-brand-700 underline" onClick={() => setVoucher(o.delivery_id)}>BYP-{o.delivery_id}</button> : "—"}</td>
                    <td className="td text-right">{num(o.litres)} L</td><td className="td text-right">Rs {num(o.unit_cost, 2)}</td><td className="td text-right">{pkr(o.cost_amount)}</td><td className="td text-right">{o.sale_amount ? <>{pkr(o.sale_amount)} <span className="text-xs text-slate-500">@ {num(o.sale_rate, 2)}</span></> : "—"}</td><td className="td text-xs">{o.created_by}</td></tr>
                ))}</tbody>
              </table></div>
            </details>
          )}
        </section>
      ))}
      {voucher != null && <BypassVoucher id={voucher} onClose={() => setVoucher(null)} />}
      {deliver && (
        <Modal open wide onClose={() => setDeliver(null)} title={`Baqi stock client ko · ${PRODUCTS[deliver.product] ?? deliver.product} ${num(deliver.left)} L${deliver.vehicle_no ? ` · ${deliver.vehicle_no}` : ""}`}>
          <p className="mb-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">Is lot ka maal (BYP-{deliver.delivery_id ?? "—"}{deliver.vehicle_no ? `, gaari ${deliver.vehicle_no}` : ""}) client ko: client chunein, litre theek karein aur Save. Ye litre isi gaari ke lot se ghatenge — poora diya to ye line Baqi stock se hat jayegi. · <Ur>اس لاٹ کا مال کلائنٹ کو</Ur></p>
          <BypassDeliveryForm fromHeld preset={{ product: deliver.product, litres: deliver.left, vehicle_no: deliver.vehicles?.[0] ?? deliver.vehicle_no ?? null }} onClose={() => setDeliver(null)} onDone={() => { setDeliver(null); reload(); }} />
        </Modal>
      )}
      {toTank && <LotToTank lot={toTank} onClose={() => setToTank(null)} onDone={() => { setToTank(null); reload(); }} />}
    </div>
  );
}

/** Empty one held lot into our own tank: that tanker's lot, at its own rate. */
function LotToTank({ lot, onClose, onDone }: { lot: any; onClose: () => void; onDone: () => void }) {
  const stations = useApi<any[]>("/stations");
  const tanks = (stations.data ?? []).flatMap((s: any) => (s.tanks ?? []).map((t: any) => ({ ...t, station: s.name }))).filter((t: any) => t.product === lot.product);
  const vehicle = lot.vehicles?.[0] ?? lot.vehicle_no ?? "";
  const [f, setF] = useState({ litres: String(lot.left), tank_id: "", note: "", txn_date: new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10) });
  const litres = Number(f.litres) || 0;
  const quote = useApi<any>(litres > 0 ? `/bypass/to-tank/quote?product=${lot.product}&litres=${litres}${vehicle ? `&tanker_no=${encodeURIComponent(vehicle)}` : ""}` : null);
  const tankId = f.tank_id || String(tanks[0]?.id ?? "");
  const { busy, run } = useAction();
  return (
    <Modal open onClose={onClose} title={`Apne tank mein · ${PRODUCTS[lot.product] ?? lot.product}${vehicle ? ` · ${vehicle}` : ""}`}>
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(() => api("/bypass/to-tank", { body: { product: lot.product, litres, tank_id: Number(tankId), note: f.note || null, txn_date: f.txn_date, tanker_no: vehicle || null } }),
          (x: any) => `${num(x.litres)} L tank mein — Rs ${num(x.unit_cost, 2)}/L · ${pkr(x.cost)}`);
        if (r) onDone();
      }}>
        <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-700">Lot BYP-{lot.delivery_id ?? "—"} · {lot.supplier} · baqi <b>{num(lot.left)} L</b> @ Rs {num(lot.cost_rate, 2)}. Poora daala to ye line Baqi stock se hat jayegi.</p>
        <Field label="Litres · لیٹر"><input className="input py-3 text-2xl" type="number" inputMode="decimal" min={1} step="1" required value={f.litres} onChange={(e) => setF({ ...f, litres: e.target.value })} /></Field>
        <Field label="Kis tank mein · کون سا ٹینک"><select className="input" required value={tankId} onChange={(e) => setF({ ...f, tank_id: e.target.value })}>
          {!tanks.length && <option value="">— is fuel ka tank nahi —</option>}
          {tanks.map((t: any) => <option key={t.id} value={t.id}>{t.name} · {t.station} · {num(t.current_l)} / {num(t.capacity_l)} L</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Date"><input className="input" type="date" value={f.txn_date} onChange={(e) => setF({ ...f, txn_date: e.target.value })} /></Field>
          <Field label="Note (optional)"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        </div>
        {litres > 0 && quote.data && <div className="rounded-xl bg-emerald-50 p-3 text-sm"><div className="flex justify-between"><span>Pump stock</span><b>+{num(litres)} L</b></div><div className="flex justify-between"><span>Cost (lot ka asal rate)</span><span className="tabular-nums">{num(litres)} × {num(quote.data.unit, 2)} = <b>{pkr(quote.data.cost)}</b></span></div></div>}
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !tankId || !(litres > 0)}>Tank mein daalein · <Ur>محفوظ</Ur></button></div>
      </form>
    </Modal>
  );
}
