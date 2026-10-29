import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, Plus, X } from "lucide-react";
import { api, useApi } from "../lib/api";
import { ErrorBox, Loading, Modal, useAction } from "./ui";
import { PRODUCTS, num, pkr } from "../lib/format";
import { useAuth } from "../App";
import { ProofPhotos } from "./Capture";
import { FleetPicker, fleetBody } from "./WholesaleFleet";

const Ur = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => <span lang="ur" dir="rtl" className={`font-urdu ${className}`}>{children}</span>;
const pkToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const amt = (n: number) => num(Math.round(n * 100) / 100, 2);
type Line = { product: string; litres: string; rate: string };

/** ERP supply voucher: header, fuel lines + kiraya, narration and proof — with a live credit check, the journal it will post
 *  and stock / margin, worked out by the server before anything is saved. Ctrl+S posts. */
export function SupplyVoucher() {
  const { can } = useAuth();
  const admin = can("wholesale.rates");
  const nav = useNavigate();
  const [params] = useSearchParams();
  const clients = useApi<any[]>("/wholesale/clients");
  const stations = useApi<any[]>("/stations");
  const [clientId, setClientId] = useState(params.get("client") ?? "");
  const client = (clients.data ?? []).find((c: any) => String(c.id) === clientId);
  const desk = useApi<any>(clientId ? `/wholesale/clients/${clientId}/desk` : null);
  const orders = (desk.data?.orders ?? []).filter((o: any) => o.status === "open" || !o.status);
  const [f, setF] = useState<any>({ station_id: "", txn_date: pkToday(), ref: "", location: "", note: "", order_id: params.get("order") ?? "", tanker_id: "", driver_id: "", vehicle_no: "", carriage: "", override_limit: false });
  const [lines, setLines] = useState<Line[]>([{ product: "HSD", litres: "", rate: "" }]);
  const [photos, setPhotos] = useState<number[]>([]);
  const [preview, setPreview] = useState<any>(null);
  const [pvErr, setPvErr] = useState<string | null>(null);
  const [done, setDone] = useState<any>(null);
  const { busy, run } = useAction();

  useEffect(() => { if (stations.data?.length && !f.station_id) setF((x: any) => ({ ...x, station_id: String(stations.data![0].id) })); }, [stations.data]);
  // a client's own fuels first; their city as the drop place
  useEffect(() => {
    if (!client) return;
    const own = Object.keys(client.rates ?? {});
    setLines((ls) => ls.map((l, i) => (i === 0 && !l.litres && own.length && !own.includes(l.product) ? { ...l, product: own[0] } : l)));
    setF((x: any) => ({ ...x, location: x.location || client.city || "" }));
  }, [client?.id]);
  // picking an order fills its fuel and litres
  useEffect(() => {
    const o = orders.find((x: any) => String(x.id) === String(f.order_id));
    if (o) { setLines([{ product: o.product, litres: String(o.litres), rate: "" }]); setF((x: any) => ({ ...x, location: o.location ?? x.location, note: x.note || o.note || "" })); }
  }, [f.order_id, desk.data]);

  const body = () => ({
    station_id: Number(f.station_id), txn_date: f.txn_date, ref: f.ref || null, location: f.location || null, note: f.note || null,
    order_id: f.order_id ? Number(f.order_id) : null, carriage: Number(f.carriage) || 0, override_limit: f.override_limit || undefined, photo_ids: photos,
    ...fleetBody(f),
    lines: lines.filter((l) => Number(l.litres) > 0).map((l) => ({ product: l.product, litres: Number(l.litres), ...(admin && l.rate ? { rate: Number(l.rate) } : {}) })),
  });
  const ready = clientId && f.station_id && lines.some((l) => Number(l.litres) > 0);
  // live preview (debounced) — the same rules the post uses
  const key = JSON.stringify([clientId, f.station_id, f.carriage, f.override_limit, lines]);
  useEffect(() => {
    if (!ready) { setPreview(null); return; }
    const t = setTimeout(() => {
      api(`/wholesale/clients/${clientId}/voucher/preview`, { body: body() }).then((r) => { setPreview(r); setPvErr(null); }).catch((e) => setPvErr(e.message));
    }, 300);
    return () => clearTimeout(t);
  }, [key]);

  const post = async () => {
    if (!ready || busy) return;
    const r = await run(() => api(`/wholesale/clients/${clientId}/voucher`, { body: body() }), (x: any) => `Voucher ${x.voucher_no} posted · ${pkr(x.total)}`);
    if (r) setDone(r);
  };
  const postRef = useRef(post); postRef.current = post;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); postRef.current(); } };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, []);

  if (clients.error) return <ErrorBox error={clients.error} />;
  if (!clients.data || !stations.data) return <Loading />;
  const setLine = (i: number, p: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const pl = (i: number) => preview?.lines?.[lines.slice(0, i).filter((l) => Number(l.litres) > 0).length];
  const cardRate = (p: string) => client?.rates?.[p];
  const total = preview?.total ?? 0;
  const pct = preview?.credit?.pct;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div>
          <div className="text-xs text-slate-500"><Link to="/wholesale" className="hover:underline">Wholesale</Link> › Supply voucher</div>
          <h1 className="text-xl font-bold text-slate-900">New supply voucher <span className="ml-1 rounded-full bg-slate-100 px-2.5 py-0.5 align-middle text-xs font-semibold text-slate-600">Draft</span> <Ur className="text-base font-normal">سپلائی واؤچر</Ur></h1>
        </div>
        <div className="flex-1" />
        <button className="btn-secondary" onClick={() => nav(-1)}>Cancel</button>
        <button className="btn-primary" disabled={!ready || busy || !!preview?.issues?.length} onClick={post}>Post voucher <span className="hidden text-xs opacity-70 sm:inline">Ctrl+S</span></button>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="flex min-w-0 flex-[999_1_620px] flex-col gap-4">
          <section aria-label="Header" className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="sm:col-span-2"><span className="label">Client *</span>
                <select className="input font-semibold" value={clientId} onChange={(e) => { setClientId(e.target.value); setF((x: any) => ({ ...x, order_id: "", location: "" })); }}>
                  <option value="">— choose client —</option>
                  {clients.data.filter((c: any) => c.active !== 0).map((c: any) => <option key={c.id} value={c.id}>{c.name}{c.city ? ` — ${c.city}` : ""}</option>)}
                </select></label>
              <label><span className="label">Voucher date *</span><input type="date" className="input" max={pkToday()} value={f.txn_date} onChange={(e) => setF({ ...f, txn_date: e.target.value })} /></label>
              <label><span className="label">From station *</span>
                <select className="input" value={f.station_id} onChange={(e) => setF({ ...f, station_id: e.target.value })}>{stations.data.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
              <FleetPicker f={f} setF={setF} />
              <label><span className="label">Bilty / ref no.</span><input className="input" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} /></label>
              <label><span className="label">Against order</span>
                <select className="input" value={f.order_id} onChange={(e) => setF({ ...f, order_id: e.target.value })} disabled={!orders.length}>
                  <option value="">{orders.length ? "— none —" : "No open order"}</option>
                  {orders.map((o: any) => <option key={o.id} value={o.id}>SO-{o.id} · {num(o.litres)} L {PRODUCTS[o.product] ?? o.product}{o.needed_on ? ` · ${o.needed_on}` : ""}</option>)}
                </select></label>
              <label className="sm:col-span-2"><span className="label">Drop location</span><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></label>
            </div>
            <div className="mt-3"><span className="label">Fuel source</span>
              <div className="inline-flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
                <span className="rounded-md bg-white px-3 py-1.5 text-sm font-semibold shadow-sm">Own tank</span>
                <button className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-white/60" onClick={() => nav("/wholesale?tab=trips&do=trip")}>Bypass — direct from depot ↗</button>
              </div>
            </div>
          </section>

          <section aria-label="Items" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="px-4 pb-1 pt-3 font-bold">Items</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-y border-slate-100 bg-slate-50 text-left text-xs font-semibold text-slate-500">
                  <th className="w-8 px-3 py-2">#</th><th className="px-2 py-2">Item</th><th className="px-2 py-2">From tank</th><th className="px-2 py-2 text-right">Litres</th><th className="px-2 py-2 text-right" title={admin ? "Blank = client's rate card" : "Client's rate card"}>Rate / L</th><th className="px-3 py-2 text-right">Amount</th><th className="w-8" />
                </tr></thead>
                <tbody>
                  {lines.map((l, i) => {
                    const p = Number(l.litres) > 0 ? pl(i) : null;
                    const rate = Number(l.rate) || cardRate(l.product) || 0;
                    return (
                      <tr key={i} className="border-b border-slate-100">
                        <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                        <td className="px-2 py-2"><select aria-label={`Fuel ${i + 1}`} className="input min-w-[120px]" value={l.product} onChange={(e) => setLine(i, { product: e.target.value })}>{Object.entries(PRODUCTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                        <td className="whitespace-nowrap px-2 py-2 text-xs text-slate-600">{p?.tank_name ? <>{p.tank_name} · {num(p.stock_before)} L</> : "—"}</td>
                        <td className="px-2 py-2"><input aria-label={`Litres ${i + 1}`} className="input w-28 text-right" type="number" inputMode="decimal" min={0} step="0.01" value={l.litres} onChange={(e) => setLine(i, { litres: e.target.value })} /></td>
                        <td className="px-2 py-2"><input aria-label={`Rate ${i + 1}`} className="input w-28 text-right" type="number" inputMode="decimal" step="0.01" disabled={!admin} placeholder={cardRate(l.product) ? String(cardRate(l.product)) : "no rate"} value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} /></td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums">{amt((Number(l.litres) || 0) * rate)}</td>
                        <td className="px-2">{lines.length > 1 && <button aria-label={`Remove line ${i + 1}`} className="p-1 text-slate-400 hover:text-red-600" onClick={() => setLines(lines.filter((_, j) => j !== i))}><X size={15} /></button>}</td>
                      </tr>
                    );
                  })}
                  <tr className="border-b border-slate-100">
                    <td className="px-3 py-2 text-slate-500">{lines.length + 1}</td>
                    <td className="px-2 py-2 font-medium" colSpan={3}>Carriage / kiraya <span className="text-xs font-normal text-slate-500">(optional — client ke khate mein, income)</span></td>
                    <td className="px-2 py-2"><input aria-label="Kiraya" className="input w-28 text-right" type="number" inputMode="decimal" min={0} step="1" placeholder="0" value={f.carriage} onChange={(e) => setF({ ...f, carriage: e.target.value })} /></td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums">{amt(Number(f.carriage) || 0)}</td><td />
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-start justify-between gap-4 p-4">
              <button className="rounded-lg border border-dashed border-slate-400 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50" disabled={lines.length >= 6} onClick={() => setLines([...lines, { product: lines[lines.length - 1].product, litres: "", rate: "" }])}><Plus size={14} className="mr-1 inline" />Add line</button>
              <div className="w-full max-w-xs space-y-1 text-sm tabular-nums">
                <div className="flex justify-between"><span className="text-slate-500">Litres</span><span>{num(preview?.litres ?? 0)} L</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Fuel sub total</span><span>{amt(preview?.fuel ?? 0)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Kiraya</span><span>{amt(preview?.carriage ?? 0)}</span></div>
                <div className="flex justify-between border-t border-slate-200 pt-2 text-lg font-extrabold"><span>Total</span><span>{pkr(total)}</span></div>
              </div>
            </div>
          </section>

          <section aria-label="Notes" className="grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-2">
            <label><span className="label">Narration</span><textarea className="input" rows={3} maxLength={300} placeholder="e.g. Delivered at depot. Seal no. …" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
            <ProofPhotos value={photos} onChange={setPhotos} label="Attachments" hint="bilty, seal, delivery slip" />
          </section>
        </div>

        <aside aria-label="Checks" className="flex flex-[1_1_300px] flex-col gap-4 lg:max-w-sm">
          {pvErr && <ErrorBox error={pvErr} />}
          {!!preview?.issues?.length && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"><b>Post se pehle theek karein:</b><ul className="mt-1 list-disc pl-5">{preview.issues.map((x: string) => <li key={x}>{x}</li>)}</ul></div>}
          <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
            <div className="mb-2 font-bold">Credit check · <Ur className="font-normal">ادھار حد</Ur></div>
            {!preview ? <p className="text-slate-500">Client, station aur litres bharein — hisaab yahan khud aa jayega.</p> : <>
              <Row l="Current balance" v={`${num(preview.credit.due)} ${preview.credit.due >= 0 ? "Dr" : "Cr"}`} />
              <Row l="This voucher" v={`+ ${num(total)}`} />
              <Row l="After posting" v={`${num(preview.credit.after)} ${preview.credit.after >= 0 ? "Dr" : "Cr"}`} strong />
              {preview.credit.limit > 0 ? <>
                <div className="mb-1.5 mt-3 h-2 rounded bg-slate-100"><div className="h-full rounded" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: pct > 100 ? "#dc2626" : pct >= 75 ? "#f59e0b" : "#0b6e4f" }} /></div>
                <div className={`text-xs ${preview.credit.over ? "font-semibold text-red-700" : pct >= 75 ? "text-amber-700" : "text-emerald-700"}`}>{pct}% of {pkr(preview.credit.limit)} limit — {preview.credit.over ? "over the limit" : "within limit"}</div>
                {preview.credit.over && preview.credit.can_override && <label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={f.override_limit} onChange={(e) => setF({ ...f, override_limit: e.target.checked })} /> CEO: limit se upar allow karein</label>}
              </> : <div className="mt-2 text-xs text-slate-500">No credit limit set</div>}
            </>}
          </section>
          <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
            <div className="mb-2 font-bold">Posting preview · <Ur className="font-normal">کھاتے میں انٹری</Ur></div>
            {!preview ? <p className="text-slate-500">—</p> : <>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 gap-y-1.5 text-xs tabular-nums">
                <span className="text-xs font-semibold text-slate-500">Account</span><span className="text-right text-xs font-semibold text-slate-500">Dr</span><span className="text-right text-xs font-semibold text-slate-500">Cr</span>
                {preview.posting.map((p: any) => <PostRow key={p.account} p={p} />)}
              </div>
              <div className={`mt-2 text-xs ${preview.balanced ? "text-emerald-700" : "text-red-700"}`}>{preview.balanced ? "Balanced ✓" : "Not balanced"} · Dr {num(preview.dr)} = Cr {num(preview.cr)}</div>
            </>}
          </section>
          <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
            <div className="mb-2 font-bold">Stock &amp; margin · <Ur className="font-normal">اسٹاک اور منافع</Ur></div>
            {!preview ? <p className="text-slate-500">—</p> : <>
              {preview.lines.map((l: any, i: number) => l.tank_name && <Row key={i} l={`${l.tank_name} after`} v={`${num(l.stock_after)} L`} warn={l.stock_after < 0} />)}
              {preview.lines.map((l: any, i: number) => l.cost != null && <Row key={`c${i}`} l={`${PRODUCTS[l.product]} avg cost`} v={`Rs ${Number(l.cost).toFixed(2)} / L`} />)}
              <Row l="Margin on this voucher" v={preview.margin == null ? (preview.lines.some((l: any) => !l.rate) ? "—" : "add purchase rates") : pkr(preview.margin)} strong green={preview.margin != null && preview.margin >= 0} />
            </>}
          </section>
        </aside>
      </div>

      {done && <Modal open onClose={() => nav(`/wholesale/ledger?client=${clientId}`)} title={`Voucher ${done.voucher_no} posted`}>
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2 text-emerald-700"><CheckCircle2 size={20} /> <b>{pkr(done.total)}</b> {client?.name} ke khate mein · ab baqaya <b>{pkr(done.due_after)}</b></div>
          <p className="text-slate-600">{done.ids.length} entries ek saath post hui hain (fuel lines{Number(f.carriage) ? " + kiraya" : ""}). Client ko WhatsApp receipt chali gayi agar number hai.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button className="btn-secondary" onClick={() => { setDone(null); setLines([{ product: lines[0].product, litres: "", rate: "" }]); setPhotos([]); setF({ ...f, ref: "", note: "", carriage: "", order_id: "", override_limit: false }); desk.reload?.(); clients.reload?.(); }}>New voucher</button>
            <button className="btn-primary" onClick={() => nav(`/wholesale/ledger?client=${clientId}`)}>Open party ledger</button>
          </div>
        </div>
      </Modal>}
    </div>
  );
}

function Row({ l, v, strong, warn, green }: { l: string; v: string; strong?: boolean; warn?: boolean; green?: boolean }) {
  return <div className={`flex justify-between gap-3 py-1 tabular-nums ${strong ? "font-bold" : ""} ${warn ? "text-red-700" : green ? "text-emerald-700" : ""}`}><span className={strong ? "" : "text-slate-500"}>{l}</span><span>{v}</span></div>;
}
function PostRow({ p }: { p: any }) {
  return <>
    <span className={p.cr ? "pl-3" : ""}>{p.account}</span>
    <span className="text-right">{p.dr ? num(p.dr) : ""}</span>
    <span className="text-right">{p.cr ? num(p.cr) : ""}</span>
  </>;
}
