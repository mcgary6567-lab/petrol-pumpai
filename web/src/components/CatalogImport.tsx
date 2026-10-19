import { useEffect, useMemo, useState } from "react";
import { BookOpen, Check } from "lucide-react";
import { api } from "../lib/api";
import { ErrorBox, Modal, useAction } from "./ui";
import { pkr } from "../lib/format";

/**
 * Pull items from the platform's master shop catalog into this station's shop: tick what the pump stocks, fix a price
 * where the catalog has none (or a different one), and import. Items already in the shop are shown but not re-made.
 */
export function CatalogImportButton({ stationId, onDone }: { stationId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)} title="Master catalog se filters, oils waghaira ek click me"><BookOpen size={15} /> Catalog se items lein</button>
      {open && <CatalogImportModal stationId={stationId} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onDone(); }} />}
    </>
  );
}

function CatalogImportModal({ stationId, onClose, onDone }: { stationId: number; onClose: () => void; onDone: () => void }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [sel, setSel] = useState<Record<number, boolean>>({});
  const [price, setPrice] = useState<Record<number, string>>({});
  const { busy, run } = useAction();
  useEffect(() => { api<any>(`/catalog?station_id=${stationId}`).then((r) => setItems(r.items)).catch((e) => setErr(e.message)); }, [stationId]);
  const cats = useMemo(() => [...new Set((items ?? []).map((x) => x.category))], [items]);
  const shown = (items ?? []).filter((x) => (!cat || x.category === cat) && (!q || `${x.name} ${x.brand ?? ""} ${x.sku ?? ""}`.toLowerCase().includes(q.toLowerCase())));
  const pickable = shown.filter((x) => !x.in_shop);
  const chosen = (items ?? []).filter((x) => sel[x.id] && !x.in_shop);
  const priceOf = (x: any) => (price[x.id] !== undefined ? Number(price[x.id]) : Number(x.price)) || 0;
  const missing = chosen.filter((x) => priceOf(x) <= 0).length;
  const go = async () => {
    const r: any = await run(() => api("/catalog/import", { body: { station_id: stationId, rows: chosen.map((x) => ({ id: x.id, price: priceOf(x) || undefined })) } }),
      (x: any) => `${x.added} items shop me aa gaye${x.skipped ? ` · ${x.skipped} pehle se the` : ""}${x.no_price ? ` · ${x.no_price} ka price nahi tha (skip)` : ""}`);
    if (r) onDone();
  };
  return (
    <Modal open wide onClose={onClose} title="Catalog se items lein · کیٹلاگ سے آئٹم">
      <div className="space-y-3 text-sm">
        {err && <ErrorBox error={err} />}
        <p className="text-xs text-slate-600">Jo cheezein aap ki shop me bikti hain unhein tick karein. Price catalog ki default hai; apni likh sakte hain (0 wali ko price dena zaroori hai). Stock 0 se shuru hota hai, phir "Stock in" se quantity dalein.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input className="input min-h-10 flex-1" placeholder="Naam / brand dhoondein…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="-mx-1 flex gap-1 overflow-x-auto px-1">
            <button className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${!cat ? "bg-slate-900 text-white" : "bg-slate-100"}`} onClick={() => setCat("")}>Sab</button>
            {cats.map((c) => <button key={c} className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${cat === c ? "bg-slate-900 text-white" : "bg-slate-100"}`} onClick={() => setCat(c)}>{c}</button>)}
          </div>
        </div>
        <div className="flex items-center justify-between text-xs text-slate-600">
          <span>{shown.length} items · {pickable.length} naye · {chosen.length} chune</span>
          <span className="flex gap-2"><button className="underline" onClick={() => setSel({ ...sel, ...Object.fromEntries(pickable.map((x) => [x.id, true])) })}>Sab chunein</button><button className="underline" onClick={() => setSel({})}>Clear</button></span>
        </div>
        <div className="max-h-[50vh] overflow-y-auto rounded-xl ring-1 ring-slate-200">
          {!items ? <div className="p-4 text-slate-500">Loading…</div> : (
            <ul className="divide-y divide-slate-100">
              {shown.map((x) => (
                <li key={x.id} className={`flex items-center gap-2 px-2 py-1.5 ${x.in_shop ? "opacity-50" : ""}`}>
                  <input type="checkbox" className="h-5 w-5" disabled={x.in_shop} checked={!!sel[x.id] && !x.in_shop} onChange={(e) => setSel({ ...sel, [x.id]: e.target.checked })} aria-label={x.name} />
                  <div className="min-w-0 flex-1"><div className="truncate font-medium">{x.name}</div><div className="text-[11px] text-slate-500">{[x.category, x.brand, x.sku].filter(Boolean).join(" · ")}{x.in_shop ? " · pehle se shop me" : x.cost ? ` · cost ${pkr(x.cost)}` : ""}</div></div>
                  <div className="relative"><input className={`input min-h-9 w-28 pr-9 text-right tabular-nums ${sel[x.id] && priceOf(x) <= 0 ? "!border-rose-400" : ""}`} type="number" inputMode="decimal" min={0} disabled={x.in_shop} value={price[x.id] ?? (x.price || "")} placeholder="price" onChange={(e) => setPrice({ ...price, [x.id]: e.target.value })} aria-label={`${x.name} price`} />
                    <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-slate-400">Rs</span></div>
                </li>
              ))}
              {shown.length === 0 && <li className="p-4 text-slate-500">Kuch nahi mila</li>}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {missing > 0 && <span className="text-xs text-rose-700">{missing} chune hue items ka price 0 hai — price likhein warna skip honge</span>}
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || chosen.length === 0} onClick={go}><Check size={15} /> {chosen.length} items shop me dalein</button>
        </div>
      </div>
    </Modal>
  );
}
