/**
 * Parchi Billing · پرچی بلنگ — a khata customer's parchiyan (slips): no fuel and no cash given at the time, each parchi
 * only goes on his khata. Many lines at once; each line has its own date, slip, vehicle and fuel (that day's rate) or a
 * shop item (the item's rate). Save shows a summary first (Confirm / back). The Parchi Book tab lists every parchi with
 * Paid / part / Unpaid (payments clear the oldest charge first) and lets a mistake be cancelled.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Ticket, X, ArrowLeft, Check, Printer, Download } from "lucide-react";
import { api, linkToken, useApi } from "../lib/api";
import { printNow } from "../lib/printNow";
import { WhatsAppDoc } from "../components/WhatsAppDoc";
import { activeProducts, PRODUCTS, num, pkr } from "../lib/format";
import { Field, IdTag, Loading, Modal, PageHeader, useAction } from "../components/ui";
import { ProofPhotos } from "../components/Capture";

const Ur = ({ children }: { children: React.ReactNode }) => <span lang="ur" dir="rtl" className="font-urdu font-normal">{children}</span>;
const pkToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const dmy = (d: string) => { const [y, m, dd] = d.split("-"); return `${dd}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]}-${y}`; };

type Line = { key: number; parchi_date: string; slip_no: string; vehicle_no: string; kind: "fuel" | "shop"; product: string; item_id: string; qty: string; rate: string; rateTouched: boolean; photos: number[] };
let seq = 1;
const blank = (from?: Line): Line => ({ key: seq++, parchi_date: from?.parchi_date ?? pkToday(), slip_no: "", vehicle_no: from?.vehicle_no ?? "", kind: from?.kind ?? "fuel",
  product: from?.product ?? activeProducts[0]?.code ?? "PMG", item_id: from?.kind === "shop" ? from.item_id : "", qty: "", rate: "", rateTouched: false, photos: [] });

export default function ParchiBilling() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState<"new" | "book">(params.get("tab") === "book" ? "book" : "new");
  const [customer, setCustomer] = useState<string>(params.get("customer") ?? "");
  return (
    <div className="space-y-4">
      <PageHeader title={<span className="flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-500 text-white"><Ticket size={19} /></span>Parchi Billing · <Ur>پرچی بلنگ</Ur></span>}
        subtitle="Parchi aayi — na tail diya, na cash. Har parchi khata customer ke khate mein jati hai." />
      <div className="flex gap-1 rounded-xl bg-slate-100 p-1 sm:w-fit" role="tablist">
        {([["new", "🎫 Nayi parchiyan", "نئی پرچیاں"], ["book", "📒 Parchi Book", "پرچی بک"]] as const).map(([k, en, ur]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`min-h-10 flex-1 rounded-lg px-4 text-sm font-semibold sm:flex-none ${tab === k ? "bg-white text-violet-700 shadow" : "text-slate-600"}`}>{en} · <Ur>{ur}</Ur></button>))}
      </div>
      {tab === "new" ? <NewParchis customer={customer} setCustomer={setCustomer} onSaved={() => setTab("book")} /> : <ParchiBook customer={customer} setCustomer={setCustomer} />}
    </div>
  );
}

function useCustomers() {
  const { data } = useApi<any[]>("/khata");
  return (data ?? []).filter((c) => c.credit_limit > 0 || c.balance > 0).sort((a, b) => a.name.localeCompare(b.name));
}

function NewParchis({ customer, setCustomer, onSaved }: { customer: string; setCustomer: (v: string) => void; onSaved: () => void }) {
  const customers = useCustomers();
  const meta = useApi<any>(customer ? `/parchi/meta?customer_id=${customer}` : "/parchi/meta");
  const [lines, setLines] = useState<Line[]>(() => [blank()]);
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [newVeh, setNewVeh] = useState<{ line: number; plate: string; fuel: string } | null>(null);
  const rates = useRef<Record<string, Record<string, number>>>({});
  const { busy, run } = useAction();
  const items: any[] = meta.data?.items ?? [];
  const c = meta.data?.customer;
  const vehicles: any[] = meta.data?.vehicles ?? [];
  if (meta.data?.today && meta.data.rates && !rates.current[meta.data.today]) rates.current[meta.data.today] = meta.data.rates;

  const set = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  // the rate a line should carry: fuel = that day's rate, shop = the item's rate (unless typed by hand)
  const autoRate = async (l: Line): Promise<string> => {
    if (l.kind === "shop") { const it = items.find((i) => String(i.id) === l.item_id); return it ? String(it.price) : ""; }
    if (!rates.current[l.parchi_date]) { try { rates.current[l.parchi_date] = await api(`/parchi/rates?date=${l.parchi_date}`); } catch { return ""; } }
    const r = rates.current[l.parchi_date]?.[l.product]; return r ? String(r) : "";
  };
  useEffect(() => { // fill / refresh rates whenever date, fuel or item changes on a line whose rate was not typed
    let stop = false;
    (async () => { for (const l of lines) if (!l.rateTouched) { const r = await autoRate(l); if (!stop && r !== l.rate) set(l.key, { rate: r }); } })();
    return () => { stop = true; };
  }, [lines.map((l) => `${l.key}|${l.parchi_date}|${l.kind}|${l.product}|${l.item_id}|${l.rateTouched}`).join(","), items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const amt = (l: Line) => Math.round((Number(l.qty) || 0) * (Number(l.rate) || 0) * 100) / 100;
  const filled = (l: Line) => Number(l.qty) > 0 && Number(l.rate) > 0 && (l.kind === "fuel" ? !!l.product : !!l.item_id);
  const started = (l: Line) => !!(l.slip_no || Number(l.qty) > 0); // a fresh auto line (copied date / gaari / item) is not counted until something is typed
  const ready = lines.filter(filled);
  const half = lines.filter((l) => started(l) && !filled(l));
  const future = lines.filter((l) => started(l) && l.parchi_date > pkToday());
  // a finished last line opens the next one by itself (date, vehicle, fuel / item kind copied)
  useEffect(() => { const last = lines[lines.length - 1]; if (last && filled(last)) setLines((ls) => [...ls, blank(last)]); }, [lines]); // eslint-disable-line react-hooks/exhaustive-deps
  const focusSlip = (key: number) => setTimeout(() => (document.querySelector(`[data-slip="${key}"]`) as HTMLInputElement | null)?.focus(), 30);
  const onEnter = (e: React.KeyboardEvent, l: Line) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const i = lines.findIndex((x) => x.key === l.key);
    const next = lines[i + 1];
    if (next) focusSlip(next.key); else if (filled(l)) { const n = blank(l); setLines((ls) => [...ls, n]); focusSlip(n.key); }
  };

  const fuelBy = useMemo(() => { const m: Record<string, { n: number; l: number; a: number }> = {}; for (const l of ready.filter((x) => x.kind === "fuel")) { m[l.product] ??= { n: 0, l: 0, a: 0 }; m[l.product].n++; m[l.product].l += Number(l.qty); m[l.product].a += amt(l); } return m; }, [lines]); // eslint-disable-line react-hooks/exhaustive-deps
  const shopLines = ready.filter((l) => l.kind === "shop");
  const vehBy = useMemo(() => { const m: Record<string, { n: number; a: number }> = {}; for (const l of ready) { const k = l.vehicle_no || "— gaari nahi"; m[k] ??= { n: 0, a: 0 }; m[k].n++; m[k].a += amt(l); } return m; }, [lines]); // eslint-disable-line react-hooks/exhaustive-deps
  const fuelTotal = Object.values(fuelBy).reduce((a, x) => a + x.a, 0), shopTotal = shopLines.reduce((a, l) => a + amt(l), 0);
  const total = Math.round((fuelTotal + shopTotal) * 100) / 100;
  const newBal = c ? c.balance + total : 0;
  const over = c && c.credit_limit > 0 && newBal > c.credit_limit;
  const itemName = (id: string) => items.find((i) => String(i.id) === id)?.name ?? "";

  const save = async () => {
    const r = await run(() => api("/parchi/batch", { body: { customer_id: Number(customer), note: note || null, lines: ready.map((l) => ({
      parchi_date: l.parchi_date, slip_no: l.slip_no || null, vehicle_no: l.vehicle_no || null, kind: l.kind, product: l.kind === "fuel" ? l.product : null,
      item_id: l.kind === "shop" ? Number(l.item_id) : null, qty: Number(l.qty), rate: Number(l.rate), photo_ids: l.photos })) } }),
      (x: any) => `${x.ids.length} parchi khate mein — ${pkr(x.total)}`);
    if (r) { setConfirm(false); setLines([blank()]); setNote(""); meta.reload(); onSaved(); }
  };
  const addVehicle = async () => {
    if (!newVeh || newVeh.plate.trim().length < 3) return;
    const v = await run(() => api(`/customers/${customer}/vehicles`, { body: { plate_no: newVeh.plate.trim(), fuel: newVeh.fuel || null } }), "Gaari save ho gayi");
    if (v) { set(newVeh.line, { vehicle_no: v.plate_no }); setNewVeh(null); meta.reload(); }
  };

  return (
    <div className="card">
      <div className="grid gap-3 border-b border-slate-100 p-4 sm:grid-cols-[1.3fr_1fr]">
        <Field label="Khata customer chunein · کھاتہ گاہک">
          <select className="input text-base font-semibold" value={customer} onChange={(e) => { setCustomer(e.target.value); setLines((ls) => ls.map((l) => ({ ...l, vehicle_no: "" }))); }} aria-label="Khata customer">
            <option value="">— customer chunein —</option>
            {customers.map((x) => <option key={x.id} value={x.id}>{x.name}{x.phone ? ` · ${x.phone}` : ""} · {x.balance < -0.5 ? `advance ${pkr(-x.balance)}` : `${pkr(x.balance)} baqi`}</option>)}
          </select>
        </Field>
        <Field label="Note (sab parchiyon ke liye)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="kis ki parchiyan" /></Field>
      </div>
      {!customer ? <p className="p-6 text-center text-sm text-slate-500">Pehle customer chunein — us ka khata yahan load hoga.</p> : !c ? <Loading /> : (
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[["Khata balance abhi", c.balance < -0.5 ? `Advance ${pkr(-c.balance)}` : pkr(c.balance)], ["Credit limit", c.credit_limit ? pkr(c.credit_limit) : "—"], ["Is mahine", pkr(c.month)],
              ["Aakhri payment", c.last_payment ? `${pkr(c.last_payment.amount)} · ${dmy(new Date(Date.parse(c.last_payment.created_at) + 5 * 3600_000).toISOString().slice(0, 10))}` : "—"]].map(([l, v]) => (
              <div key={l} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">{l}</div><div className="font-bold tabular-nums">{v}</div></div>))}
          </div>
          {c.recent?.length > 0 && <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs text-slate-600"><b className="text-slate-800">Aakhri entries</b>
            {c.recent.map((k: any) => <div key={k.id} className="flex justify-between gap-2"><span className="min-w-0 truncate">{dmy(new Date(Date.parse(k.created_at) + 5 * 3600_000).toISOString().slice(0, 10))} · K-{k.id} · {k.product ? `${PRODUCTS[k.product]} ${num(k.litres, 2)} L` : k.type === "credit" ? "Payment" : k.note}{k.vehicle_no ? ` · ${k.vehicle_no}` : ""}</span><span className={`shrink-0 tabular-nums ${k.type === "credit" ? "text-emerald-700" : ""}`}>{k.type === "credit" ? "− " : ""}{pkr(k.amount)}</span></div>)}</div>}
          <p className="rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-900">Har parchi ki <b>apni tareekh</b>. <b>Fuel:</b> us din ka rate khud lagta hai. <b>Shop:</b> item ka rate (shop stock par asar nahi). Gaari list se chunein ya "＋ Nayi gaari". Line poori hote hi agli line khulti hai — Enter se agli parchi.</p>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1120px]">
              <thead><tr>{["#", "Parchi ki tareekh", "Slip no.", "Gaari", "Kya", "Fuel / item", "Litre / qty", "Rate", "Raqam", "Photo", ""].map((hd) => <th key={hd} className={`th ${["Litre / qty", "Rate", "Raqam"].includes(hd) ? "text-right" : ""}`}>{hd}</th>)}</tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.key} className={filled(l) ? "" : "bg-violet-50/40"}>
                    <td className="td text-center font-semibold text-violet-700">{filled(l) ? <Check size={15} className="inline text-emerald-600" /> : i + 1}</td>
                    <td className="td"><input className="input !py-1.5" type="date" max={pkToday()} value={l.parchi_date} aria-label={`Line ${i + 1} parchi ki tareekh`} onChange={(e) => set(l.key, { parchi_date: e.target.value })} onKeyDown={(e) => onEnter(e, l)} /></td>
                    <td className="td"><input data-slip={l.key} className="input !w-20 !py-1.5" value={l.slip_no} aria-label={`Line ${i + 1} slip no`} onChange={(e) => set(l.key, { slip_no: e.target.value })} onKeyDown={(e) => onEnter(e, l)} /></td>
                    <td className="td"><select className="input !w-32 !py-1.5" value={l.vehicle_no} aria-label={`Line ${i + 1} gaari`} onChange={(e) => e.target.value === "__new__" ? setNewVeh({ line: l.key, plate: "", fuel: l.kind === "fuel" ? l.product : "" }) : set(l.key, { vehicle_no: e.target.value })}>
                      <option value="">— gaari —</option>{vehicles.map((v) => <option key={v.id} value={v.plate_no}>{v.plate_no}{v.fuel ? ` · ${PRODUCTS[v.fuel] ?? v.fuel}` : ""}</option>)}
                      {l.vehicle_no && !vehicles.some((v) => v.plate_no === l.vehicle_no) && <option value={l.vehicle_no}>{l.vehicle_no}</option>}
                      <option value="__new__">＋ Nayi gaari add karein</option></select></td>
                    <td className="td"><div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs font-semibold">{(["fuel", "shop"] as const).map((k) => (
                      <button key={k} type="button" onClick={() => set(l.key, { kind: k, rateTouched: false, item_id: k === "shop" ? l.item_id : "" })} aria-pressed={l.kind === k} className={`rounded-md px-2 py-1.5 ${l.kind === k ? "bg-white text-violet-700 shadow" : "text-slate-500"}`}>{k === "fuel" ? "⛽ Fuel" : "🛒 Shop"}</button>))}</div></td>
                    <td className="td">{l.kind === "fuel"
                      ? <select className="input !w-36 !py-1.5" value={l.product} aria-label={`Line ${i + 1} fuel`} onChange={(e) => set(l.key, { product: e.target.value, rateTouched: false })}>{activeProducts.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
                      : <><select className="input !w-40 !py-1.5" value={l.item_id} aria-label={`Line ${i + 1} shop item`} onChange={(e) => set(l.key, { item_id: e.target.value, rateTouched: false })}><option value="">— item —</option>{items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}</select>
                        <div className="text-[11px] text-amber-700">shop stock par asar nahi</div></>}</td>
                    <td className="td"><input className="input !w-24 !py-1.5 text-right" type="number" inputMode="decimal" step="any" min={0} placeholder={l.kind === "fuel" ? "litre" : "qty"} aria-label={`Line ${i + 1} ${l.kind === "fuel" ? "litre" : "qty"}`} value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value })} onKeyDown={(e) => onEnter(e, l)} /></td>
                    <td className="td"><input className="input !w-24 !py-1.5 text-right" type="number" inputMode="decimal" step="any" min={0} aria-label={`Line ${i + 1} rate`} value={l.rate} onChange={(e) => set(l.key, { rate: e.target.value, rateTouched: true })} onKeyDown={(e) => onEnter(e, l)} />
                      <div className="text-right text-[11px] text-violet-700">{l.rateTouched ? "haath se" : l.kind === "fuel" ? `✓ ${l.parchi_date === pkToday() ? "aaj" : dmy(l.parchi_date).slice(0, 6)} ka rate` : l.item_id ? "✓ item ka rate" : ""}</div></td>
                    <td className="td whitespace-nowrap text-right font-semibold tabular-nums">{amt(l) ? pkr(amt(l)) : "—"}</td>
                    <td className="td"><ProofPhotos value={l.photos} onChange={(p) => set(l.key, { photos: p })} label="" hint="" /></td>
                    <td className="td">{lines.length > 1 && <button type="button" className="rounded p-1 text-rose-600 hover:bg-rose-50" aria-label={`Line ${i + 1} hatayein`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><X size={16} /></button>}</td>
                  </tr>))}
              </tbody>
            </table>
          </div>
          <button type="button" className="inline-flex items-center gap-1 rounded-lg border border-violet-300 bg-violet-50 px-3 py-1.5 text-sm font-semibold text-violet-700" onClick={() => { const n = blank(lines[lines.length - 1]); setLines((ls) => [...ls, n]); focusSlip(n.key); }}><Plus size={15} /> Aur parchi · <Ur>مزید پرچی</Ur></button>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">Fuel · {Object.values(fuelBy).reduce((a, x) => a + x.n, 0)} parchi · {num(Object.values(fuelBy).reduce((a, x) => a + x.l, 0), 2)} L</div><div className="font-bold tabular-nums">{pkr(fuelTotal)}</div></div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">Shop items · {shopLines.length} line</div><div className="font-bold tabular-nums">{pkr(shopTotal)}</div></div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">Khate mein jayega</div><div className="font-bold tabular-nums text-rose-700">{pkr(total)}</div></div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">Balance: {pkr(c.balance)} →</div><div className="font-bold tabular-nums">{pkr(newBal)}</div>{over && <div className="text-xs text-amber-700">⚠ limit {pkr(c.credit_limit)} se zyada</div>}</div>
          </div>
          {(half.length > 0 || future.length > 0) && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{half.length > 0 && <>{half.length} line adhoori hai — litre/qty aur rate likhein (shop mein item chunein), ya line hata dein. </>}{future.length > 0 && <>Aane wali tareekh ki parchi nahi ho sakti.</>}</p>}
          <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
            <span className="mr-auto text-xs text-slate-500">Tank, shop ka stock, salesman ka bag aur bank — kuch nahi hilega. Malik ko alert jayega.</span>
            <button type="button" className="btn-primary !bg-violet-600 hover:!bg-violet-700" disabled={!ready.length || half.length > 0 || future.length > 0} onClick={() => setConfirm(true)}><Ticket size={16} /> Save {ready.length} parchi →</button>
          </div>
        </div>
      )}

      {newVeh && <Modal open onClose={() => setNewVeh(null)} title="Nayi gaari · نئی گاڑی">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Gaari no."><input className="input uppercase" autoFocus value={newVeh.plate} onChange={(e) => setNewVeh({ ...newVeh, plate: e.target.value })} placeholder="LEB-4455" /></Field>
          <Field label="Fuel"><select className="input" value={newVeh.fuel} onChange={(e) => setNewVeh({ ...newVeh, fuel: e.target.value })}><option value="">koi bhi</option>{activeProducts.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
        </div>
        <p className="mt-2 text-xs text-slate-500">Gaari {c?.name} ke khate mein save ho jayegi — agli dafa list mein aayegi.</p>
        <div className="mt-3 flex justify-end gap-2"><button className="btn-secondary" onClick={() => setNewVeh(null)}>Cancel</button><button className="btn-primary" disabled={busy || newVeh.plate.trim().length < 3} onClick={addVehicle}>Add</button></div>
      </Modal>}

      {confirm && c && <Modal open onClose={() => setConfirm(false)} title="Check kar lein · تصدیق">
        <div className="space-y-1 text-sm">
          <div className="text-slate-600">{c.name}{c.phone ? ` · ${c.phone}` : ""} · <b>{ready.length} parchi</b> · {dmy(ready.map((l) => l.parchi_date).sort()[0])} se {dmy(ready.map((l) => l.parchi_date).sort().slice(-1)[0])}</div>
          {Object.keys(fuelBy).length > 0 && <><div className="pt-2 text-xs font-bold uppercase tracking-wide text-slate-500">⛽ Fuel</div>
            {Object.entries(fuelBy).map(([p, x]) => <div key={p} className="flex justify-between border-b border-dashed border-slate-200 py-1"><span>{PRODUCTS[p]} · {x.n} parchi</span><span className="tabular-nums">{num(x.l, 2)} L · <b>{pkr(x.a)}</b></span></div>)}</>}
          {shopLines.length > 0 && <><div className="pt-2 text-xs font-bold uppercase tracking-wide text-slate-500">🛒 Shop items <span className="normal-case">(shop stock par asar nahi)</span></div>
            {shopLines.map((l) => <div key={l.key} className="flex justify-between border-b border-dashed border-slate-200 py-1"><span>{itemName(l.item_id)} × {num(Number(l.qty), 2)}</span><b className="tabular-nums">{pkr(amt(l))}</b></div>)}</>}
          <div className="pt-2 text-xs font-bold uppercase tracking-wide text-slate-500">🚛 Gaariyan</div>
          {Object.entries(vehBy).map(([v, x]) => <div key={v} className="flex justify-between border-b border-dashed border-slate-200 py-1"><span>{v} · {x.n} parchi</span><b className="tabular-nums">{pkr(x.a)}</b></div>)}
          <div className="mt-3 flex items-center justify-between rounded-xl border border-violet-200 bg-violet-50 px-4 py-3"><span><span className="text-xs text-slate-600">Kul raqam — khate mein jayegi</span><br /><span className="text-xs text-slate-500">Fuel {pkr(fuelTotal)} + Shop {pkr(shopTotal)}</span></span><b className="text-2xl tabular-nums text-violet-700">{pkr(total)}</b></div>
          <div className="flex justify-between py-1"><span>Khata balance</span><span className="tabular-nums">{pkr(c.balance)} → <b>{pkr(newBal)}</b></span></div>
          {over && <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">⚠ Naya balance credit limit ({pkr(c.credit_limit)}) se zyada hai.</div>}
        </div>
        <div className="mt-4 flex justify-between gap-2 border-t border-slate-100 pt-3">
          <button className="btn-secondary" onClick={() => setConfirm(false)}><ArrowLeft size={15} /> Wapas · theek karein</button>
          <button className="btn-primary !bg-emerald-600" disabled={busy} onClick={save}><Check size={16} /> Confirm · محفوظ کریں</button>
        </div>
      </Modal>}
    </div>
  );
}

function ParchiBook({ customer, setCustomer }: { customer: string; setCustomer: (v: string) => void }) {
  const customers = useCustomers();
  const [range, setRange] = useState({ from: "", to: "" });
  const blankF = { vehicle: "", slip: "", kind: "", product: "", status: "", q: "", min: "", max: "", by: "", voided: "" };
  const [f, setF] = useState(blankF);
  const [more, setMore] = useState(false);
  const [q, setQ] = useState(""); // typed search, sent after a pause
  useEffect(() => { const id = setTimeout(() => setF((x) => (x.q === q ? x : { ...x, q })), 350); return () => clearTimeout(id); }, [q]);
  const extra = Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as Record<string, string>;
  const qs = new URLSearchParams(Object.entries({ customer_id: customer, ...range, ...extra }).filter(([, v]) => v)).toString();
  const { data, reload } = useApi<any>(`/parchi/book${qs ? `?${qs}` : ""}`);
  const filterJson = Object.keys(extra).length ? JSON.stringify(extra) : "";
  const docQs = new URLSearchParams(Object.entries({ ...range, filter: filterJson }).filter(([, v]) => v)).toString();
  const pdf = `/api/docs/parchi_book/${customer || 0}/pdf?${docQs ? `${docQs}&` : ""}token=${linkToken()}`;
  const nActive = Object.keys(extra).length + (range.from ? 1 : 0) + (range.to ? 1 : 0);
  const quick = (from: string, to = "") => setRange({ from, to });
  const ago = (n: number) => new Date(Date.now() + 5 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);
  const { busy, run } = useAction();
  const [edit, setEdit] = useState<any>(null);
  const voidIt = async (r: any) => {
    const reason = prompt(`PR-${r.id} delete karein? ${pkr(r.amount)} khate se hat jayenge.\nWajah likhein:`);
    if (!reason || reason.trim().length < 3) return;
    if (await run(() => api(`/parchi/${r.id}/void`, { body: { reason } }), `PR-${r.id} delete — khata ${pkr(r.amount)} kam`)) reload();
  };
  const chip = (s: string, r: any) => s === "paid" ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Paid</span>
    : s === "part" ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">{pkr(r.unpaid)} baqi</span>
    : s === "void" ? <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-600" title={r.void_reason ?? ""}>Deleted</span>
    : <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">Unpaid</span>;
  return (
    <div className="card">
      <div className="space-y-3 border-b border-slate-100 p-4 print:hidden">
        <div className="grid gap-3 sm:grid-cols-[1.4fr_1.4fr_1fr_1fr]">
          <Field label="Customer"><select className="input" value={customer} onChange={(e) => setCustomer(e.target.value)} aria-label="Parchi Book customer"><option value="">Sab customers</option>{customers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <Field label="Dhoondein · تلاش"><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="PR-12, slip, gaari, item, naam, raqam…" aria-label="Parchi dhoondein" /></Field>
          <Field label="From (parchi date)"><input className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
          <Field label="To"><input className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {([["Aaj", () => quick(pkToday(), pkToday())], ["7 din", () => quick(ago(6))], ["Is mahine", () => quick(pkToday().slice(0, 8) + "01")], ["Pichla mahina", () => { const d = new Date(pkToday().slice(0, 8) + "01T00:00:00Z"); d.setUTCDate(0); quick(d.toISOString().slice(0, 8) + "01", d.toISOString().slice(0, 10)); }], ["Sab", () => quick("")]] as [string, () => void][]).map(([l, fn]) => (
            <button key={l} type="button" onClick={fn} className="rounded-full border border-slate-200 px-2.5 py-1 font-semibold text-slate-600 hover:bg-slate-50">{l}</button>))}
          <span className="mx-1 text-slate-300">|</span>
          {([["", "Har status"], ["open", "Baqi (unpaid + part)"], ["unpaid", "Unpaid"], ["part", "Thori baqi"], ["paid", "Paid"], ["void", "Deleted"]] as const).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={f.status === k} onClick={() => setF({ ...f, status: k })} className={`rounded-full border px-2.5 py-1 font-semibold ${f.status === k ? "border-violet-400 bg-violet-50 text-violet-700" : "border-slate-200 text-slate-600"}`}>{l}</button>))}
          <button type="button" onClick={() => setMore(!more)} className="ml-auto rounded-full border border-violet-300 px-2.5 py-1 font-semibold text-violet-700">{more ? "▲ Kam filter" : "▼ Mazeed filter"}{nActive ? ` (${nActive})` : ""}</button>
          {nActive > 0 && <button type="button" onClick={() => { setF(blankF); setQ(""); setRange({ from: "", to: "" }); }} className="rounded-full px-2 py-1 font-semibold text-rose-600 underline">Saaf karein</button>}
        </div>
        {more && <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-4">
          <Field label="Gaari no."><input className="input uppercase" value={f.vehicle} onChange={(e) => setF({ ...f, vehicle: e.target.value })} placeholder="LEH-453" /></Field>
          <Field label="Slip no."><input className="input" value={f.slip} onChange={(e) => setF({ ...f, slip: e.target.value })} /></Field>
          <Field label="Kya"><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, product: e.target.value === "fuel" ? f.product : "" })}><option value="">Sab</option><option value="fuel">⛽ Fuel</option><option value="shop">🛒 Shop</option><option value="other">Purani (sirf raqam)</option></select></Field>
          <Field label="Fuel"><select className="input" value={f.product} onChange={(e) => setF({ ...f, product: e.target.value, kind: e.target.value ? "fuel" : f.kind })}><option value="">Sab</option>{activeProducts.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
          <Field label="Raqam se (Rs)"><input className="input text-right" type="number" inputMode="decimal" step="any" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} /></Field>
          <Field label="Raqam tak (Rs)"><input className="input text-right" type="number" inputMode="decimal" step="any" value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} /></Field>
          <Field label="Kis ne likhi"><input className="input" value={f.by} onChange={(e) => setF({ ...f, by: e.target.value })} placeholder="naam" /></Field>
          <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={!!f.voided} onChange={(e) => setF({ ...f, voided: e.target.checked ? "1" : "" })} /> Deleted bhi dikhayein</label>
        </div>}
        <div className="flex flex-wrap justify-end gap-2">
          <WhatsAppDoc kind="parchi_book" id={Number(customer) || 0} from={range.from || undefined} to={range.to || undefined} filter={filterJson || undefined} />
          <a className="btn-secondary" href={pdf} target="_blank" rel="noreferrer"><Download size={15} /> PDF</a>
          <button className="btn-primary" onClick={() => printNow({ title: "Parchi Book", pdf })}><Printer size={15} /> Print · پرنٹ</button>
        </div>
      </div>
      {!data ? <Loading /> : <>
        <div className="hidden p-4 print:block"><div className="text-lg font-bold">Parchi Book</div><div className="text-sm">{customer ? customers.find((x) => String(x.id) === customer)?.name : "Sab customers"} · {range.from || "shuru"} — {range.to || "aaj"}</div></div>
        <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-6">
          {[["Parchiyan", `${data.totals.n}${data.totals.vehicles ? ` · ${data.totals.vehicles} gaari` : ""}`], ["Fuel", `${pkr(data.totals.fuel)} · ${num(data.totals.litres, 2)} L`], ["Shop / other", pkr(data.totals.shop + data.totals.other)], ["Kul", pkr(data.totals.amount)], ["Paid", pkr(data.totals.paid)], ["Baqi", pkr(data.totals.unpaid)]].map(([l, v]) => (
            <div key={l} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">{l}</div><div className="font-bold tabular-nums">{v}</div></div>))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead><tr>{["ID", "Parchi date", "Customer", "Slip", "Gaari", "Hisaab", "Raqam", "Status", "By", ""].map((hd) => <th key={hd} className={`th ${hd === "Raqam" ? "text-right" : ""}`}>{hd}</th>)}</tr></thead>
            <tbody>
              {data.rows.map((r: any) => (
                <tr key={r.id}>
                  <td className="td"><span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-violet-50 px-1.5 py-0.5 font-mono text-xs font-semibold text-violet-700">🎫 PR-{r.id}</span></td>
                  <td className="td whitespace-nowrap text-xs">{dmy(r.parchi_date)}</td><td className="td">{r.customer}</td><td className="td text-xs">{r.slip_no ?? ""}</td><td className="td text-xs">{r.vehicle_no ?? ""}</td>
                  <td className="td text-xs text-slate-600">{r.kind === "fuel" ? `${num(r.qty, 2)} L ${PRODUCTS[r.product] ?? r.product} × ${r.rate}` : r.kind === "shop" ? `🛒 ${r.item_name} × ${num(r.qty, 2)} @ ${r.rate}` : r.item_name}{r.khata_id ? <> · <IdTag id={`K-${r.khata_id}`} /></> : null}</td>
                  <td className="td whitespace-nowrap text-right font-semibold tabular-nums">{pkr(r.amount)}</td><td className="td">{chip(r.status, r)}</td><td className="td text-xs">{r.created_by ?? ""}</td>
                  <td className="td whitespace-nowrap print:hidden">{r.status !== "void" && <><button className="rounded-md border border-violet-200 px-2 py-1 text-xs font-semibold text-violet-700 hover:bg-violet-50" disabled={busy} onClick={() => setEdit(r)} aria-label={`PR-${r.id} edit`}>✏️ Edit</button>{" "}
                    <button className="rounded-md border border-rose-200 px-2 py-1 text-xs font-semibold text-rose-600 hover:bg-rose-50" disabled={busy} onClick={() => voidIt(r)} aria-label={`PR-${r.id} delete`}>🗑 Delete</button></>}</td>
                </tr>))}
              {!data.rows.length && <tr><td className="td py-8 text-center text-slate-500" colSpan={10}>Koi parchi nahi</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="p-4 text-xs text-slate-500">Payment "Khata payment" se aati hai — sab se purani entry pehle Paid hoti hai. "Edit" se gaari, litre, rate, tareekh theek karein — khata aur balance khud update. "Delete" se parchi ki raqam khate se hat jati hai.</p>
      </>}
      {edit && <EditParchi row={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

/** Edit one saved parchi: every field; the khata entry, its date and the customer's balance follow on save. */
function EditParchi({ row, onClose, onDone }: { row: any; onClose: () => void; onDone: () => void }) {
  const customers = useCustomers();
  const [cust, setCust] = useState(String(row.customer_id));
  const meta = useApi<any>(`/parchi/meta?customer_id=${cust}`);
  const moved = cust !== String(row.customer_id);
  const newC = meta.data?.customer;
  const [f, setF] = useState({ parchi_date: row.parchi_date, slip_no: row.slip_no ?? "", vehicle_no: row.vehicle_no ?? "", kind: row.kind as "fuel" | "shop" | "other",
    product: row.product ?? activeProducts[0]?.code ?? "PMG", item_id: row.item_id ? String(row.item_id) : "", qty: String(row.qty ?? 1), rate: String(row.rate ?? row.amount), reason: "" });
  const [touched, setTouched] = useState(true); // rate typed (or kept from the saved parchi) — a change of day / fuel / item re-reads it
  const [photos, setPhotos] = useState<number[]>([]);
  const [newPlate, setNewPlate] = useState<string | null>(null);
  const { busy, run } = useAction();
  const items: any[] = meta.data?.items ?? [], vehicles: any[] = meta.data?.vehicles ?? [];
  const set = (patch: Partial<typeof f>, reRate = false) => { setF((x) => ({ ...x, ...patch })); if (reRate) setTouched(false); };
  useEffect(() => {
    if (touched || f.kind === "other") return;
    let stop = false;
    (async () => {
      let r = "";
      if (f.kind === "shop") { const it = items.find((i) => String(i.id) === f.item_id); r = it ? String(it.price) : ""; }
      else { try { const rs = await api(`/parchi/rates?date=${f.parchi_date}`); r = rs[f.product] ? String(rs[f.product]) : ""; } catch { /* keep */ } }
      if (!stop && r) setF((x) => ({ ...x, rate: r }));
    })();
    return () => { stop = true; };
  }, [f.parchi_date, f.kind, f.product, f.item_id, touched, items.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const amount = Math.round((Number(f.qty) || 0) * (Number(f.rate) || 0) * 100) / 100;
  const okToSave = Number(f.qty) > 0 && Number(f.rate) > 0 && (f.kind !== "shop" || !!f.item_id) && f.parchi_date <= pkToday();
  const save = async () => {
    const r = await run(() => api(`/parchi/${row.id}`, { method: "PATCH", body: { parchi_date: f.parchi_date, slip_no: f.slip_no || null, vehicle_no: f.vehicle_no || null, kind: f.kind,
      product: f.kind === "fuel" ? f.product : null, item_id: f.kind === "shop" ? Number(f.item_id) : null, qty: Number(f.qty), rate: Number(f.rate), photo_ids: photos, reason: f.reason || null,
      ...(moved ? { customer_id: Number(cust) } : {}) } }),
      (x: any) => x.moved ? `PR-${row.id} ab ${x.customer} ke khate mein` : `PR-${row.id} update — ${x.diff ? `khata ${x.diff > 0 ? "+" : "−"}${pkr(Math.abs(x.diff))}` : "raqam wohi"}`);
    if (r) onDone();
  };
  const addPlate = async () => {
    if (!newPlate || newPlate.trim().length < 3) return;
    const v = await run(() => api(`/customers/${cust}/vehicles`, { body: { plate_no: newPlate.trim() } }), "Gaari save ho gayi");
    if (v) { set({ vehicle_no: v.plate_no }); setNewPlate(null); meta.reload(); }
  };
  return (
    <Modal open onClose={onClose} title={`✏️ Edit parchi PR-${row.id} · ${row.customer}`}>
      <Field label="Khata customer · کھاتہ گاہک"><select className="input font-semibold" value={cust} aria-label="Edit customer" onChange={(e) => { setCust(e.target.value); set({ vehicle_no: "" }); }}>
        {!customers.some((x) => String(x.id) === String(row.customer_id)) && <option value={row.customer_id}>{row.customer}</option>}
        {customers.map((x) => <option key={x.id} value={x.id}>{x.name}{x.phone ? ` · ${x.phone}` : ""}</option>)}</select></Field>
      {moved && <p className="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">Parchi <b>{row.customer}</b> ke khate se hat kar <b>{newC?.name ?? "…"}</b> ke khate mein jayegi. {row.customer} ka balance {pkr(row.amount)} kam hoga.{newC?.credit_limit > 0 && newC.balance + amount > newC.credit_limit ? ` ⚠ ${newC.name} ki limit se zyada.` : ""}</p>}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Parchi ki tareekh"><input className="input" type="date" max={pkToday()} value={f.parchi_date} onChange={(e) => set({ parchi_date: e.target.value }, f.kind === "fuel")} /></Field>
        <Field label="Slip no."><input className="input" value={f.slip_no} onChange={(e) => set({ slip_no: e.target.value })} /></Field>
        <Field label="Gaari">{newPlate !== null
          ? <div className="flex gap-1"><input className="input uppercase" autoFocus value={newPlate} onChange={(e) => setNewPlate(e.target.value)} placeholder="LEB-4455" aria-label="Nayi gaari no." /><button type="button" className="btn-primary !px-3" disabled={busy || newPlate.trim().length < 3} onClick={addPlate}>Add</button></div>
          : <select className="input" value={f.vehicle_no} aria-label="Gaari" onChange={(e) => e.target.value === "__new__" ? setNewPlate("") : set({ vehicle_no: e.target.value })}>
              <option value="">— gaari nahi —</option>{vehicles.map((v) => <option key={v.id} value={v.plate_no}>{v.plate_no}</option>)}
              {f.vehicle_no && !vehicles.some((v) => v.plate_no === f.vehicle_no) && <option value={f.vehicle_no}>{f.vehicle_no}</option>}
              <option value="__new__">＋ Nayi gaari add karein</option></select>}</Field>
        <Field label="Kya">{f.kind === "other" ? <div className="input bg-slate-50 text-sm">Purani parchi (sirf raqam)</div>
          : <div className="flex gap-1">{(["fuel", "shop"] as const).map((k) => <button key={k} type="button" aria-pressed={f.kind === k} onClick={() => set({ kind: k }, true)} className={`flex-1 rounded-lg border px-2 py-2 text-sm font-semibold ${f.kind === k ? "border-violet-400 bg-violet-50 text-violet-700" : "border-slate-200 text-slate-500"}`}>{k === "fuel" ? "⛽ Fuel" : "🛒 Shop"}</button>)}</div>}</Field>
        {f.kind === "fuel" && <Field label="Fuel"><select className="input" value={f.product} onChange={(e) => set({ product: e.target.value }, true)}>{activeProducts.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>}
        {f.kind === "shop" && <Field label="Shop item"><select className="input" value={f.item_id} aria-label="Shop item" onChange={(e) => set({ item_id: e.target.value }, true)}><option value="">— item —</option>{items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}</select></Field>}
        <Field label={f.kind === "fuel" ? "Litre" : f.kind === "shop" ? "Qty" : "Qty"}><input className="input text-right" type="number" inputMode="decimal" step="any" min={0} value={f.qty} onChange={(e) => set({ qty: e.target.value })} /></Field>
        <Field label={f.kind === "other" ? "Raqam" : "Rate"}><input className="input text-right" type="number" inputMode="decimal" step="any" min={0} value={f.rate} onChange={(e) => { setTouched(true); set({ rate: e.target.value }); }} /></Field>
      </div>
      <div className="mt-3 flex items-center justify-between rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm">
        <span>Pehle <b className="tabular-nums">{pkr(row.amount)}</b> → ab</span><b className="text-xl tabular-nums text-violet-700">{pkr(amount)}</b>
      </div>
      {!moved && amount !== row.amount && <p className="mt-1 text-xs text-slate-600">Khata balance {amount > row.amount ? "barhega" : "kam hoga"}: {pkr(Math.abs(Math.round((amount - row.amount) * 100) / 100))}</p>}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Wajah (kya ghalat tha)"><input className="input" value={f.reason} onChange={(e) => set({ reason: e.target.value })} placeholder="gaari no. ghalat tha" /></Field>
        <ProofPhotos value={photos} onChange={setPhotos} label="Nayi photo (agar ho)" hint="parchi" />
      </div>
      <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-3">
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary !bg-emerald-600" disabled={busy || !okToSave} onClick={save}><Check size={16} /> Save · محفوظ کریں</button>
      </div>
    </Modal>
  );
}
