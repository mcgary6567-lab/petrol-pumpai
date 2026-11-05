import { useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { useAuth } from "../App";
import { Field, Modal, useAction } from "./ui";
import { Ur } from "./VoiceShell";

const NAMES: Record<string, string> = { PMG: "Petrol", HOBC: "Hi-Octane", HSD: "Diesel" };
const cardOf = (a: any): Record<string, { mode: string; value: number }> => { if (a?.rates) return a.rates; try { return a?.khata_rates ? JSON.parse(a.khata_rates) : {}; } catch { return {}; } };

/** CEO: the "⛽ Sab khata rates" button + form (like the wholesale "sab clients ka rate badlo"). */
export function KhataBulkRateButton({ onDone }: { onDone?: () => void }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  if (!can("credit.set_limit")) return null;
  return <>
    <button className="btn-secondary" onClick={() => setOpen(true)}>⛽ Sab khata rates · <Ur>سب کا ریٹ</Ur></button>
    {open && <KhataBulkRateModal onClose={() => setOpen(false)} onDone={() => { setOpen(false); onDone?.(); }} />}
  </>;
}

function KhataBulkRateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const prices = useApi<any>("/prices");
  const accts = useApi<any[]>("/pos/khata-accounts");
  const pump: Record<string, any> = prices.data?.current ?? {};
  const prods = Object.keys(pump).length ? Object.keys(pump) : Object.keys(NAMES);
  const [mode, setMode] = useState<"delta" | "set">("delta");
  const [scope, setScope] = useState<"carded" | "all">("carded");
  const [delta, setDelta] = useState<Record<string, string>>({});
  const [cards, setCards] = useState<Record<string, { mode: string; value: string; clear?: boolean }>>({});
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const { busy, run } = useAction();

  // how many khata customers each fuel's change would touch, from the accounts list
  const carded = useMemo(() => {
    const n: Record<string, number> = {};
    for (const a of accts.data ?? []) for (const p of Object.keys(cardOf(a))) n[p] = (n[p] ?? 0) + 1;
    return n;
  }, [accts.data]);
  const total = accts.data?.length ?? 0;

  const body = mode === "delta"
    ? { mode, deltas: Object.fromEntries(Object.entries(delta).filter(([, v]) => v !== "" && Number(v) !== 0).map(([k, v]) => [k, Number(v)])) }
    : { mode, scope, cards: Object.fromEntries(Object.entries(cards).filter(([, v]) => v.clear || Number(v.value) > 0).map(([k, v]) => [k, v.clear ? null : { mode: v.mode === "minus" ? "minus" : "fixed", value: Number(v.value) }])) };
  const any = Object.keys((body as any).deltas ?? (body as any).cards ?? {}).length > 0;
  const setC = (p: string, patch: any) => setCards((c) => ({ ...c, [p]: { mode: c[p]?.mode ?? "minus", value: c[p]?.value ?? "", ...patch } }));

  return (
    <Modal open onClose={onClose} title="Sab khata customers ka rate · سب کھاتوں کا ریٹ">
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(() => api("/customers/khata-rates/bulk", { body: { ...body, note: note || null, notify } }),
          (x: any) => `Ho gaya — ${x.customers} customer${x.customers === 1 ? "" : "s"} ka rate badla` + (notify ? ` · ${x.notified ?? 0} ko WhatsApp bheja` : ""));
        if (r) onDone();
      }}>
        <div role="tablist" className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
          {([["delta", "Rate +/− karo", "سب کا ریٹ بڑھائیں/گھٹائیں"], ["set", "Sab ko ek rate do", "سب کو ایک ریٹ"]] as const).map(([k, l, u]) => (
            <button key={k} type="button" role="tab" aria-selected={mode === k} onClick={() => setMode(k)} className={`flex-1 rounded-md px-2 py-1.5 ${mode === k ? "bg-white font-semibold shadow-sm" : "text-slate-600"}`}>{l}<Ur className="block text-xs">{u}</Ur></button>
          ))}
        </div>

        {mode === "delta" ? <>
          <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">Rate barhe to <b>+2</b>, kam ho to <b>-1.5</b> likhein. Ye sirf un khata customers par lagega jin ka <b>special rate</b> laga hai. Fixed rate wale ka rate utna barh/kam jayega. "Pump − X" wale pump ke saath chalte rahenge aur un ka effective rate bhi utna hi move karega. Jin ka special rate nahi wo pehle se pump rate par hain, unhein kuch nahi karna.</p>
          {prods.map((p) => (
            <Field key={p} label={`${NAMES[p] ?? p} · Rs/L change · ${carded[p] ?? 0} customer`}>
              <input className="input" type="number" inputMode="decimal" step="0.01" placeholder="e.g. +2 ya -1.5" value={delta[p] ?? ""} onChange={(e) => setDelta({ ...delta, [p]: e.target.value })} />
            </Field>
          ))}
        </> : <>
          <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">Ek hi rate sab ko: <b>Fixed</b> (har litre itne ka) ya <b>Pump − X</b> (pump rate se X kam, pump ke saath khud badalta rahe). Pump rate se zyada kabhi bill nahi hota. "Pump rate par wapas" special rate hata deta hai.</p>
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-1.5"><input type="radio" name="scope" checked={scope === "carded"} onChange={() => setScope("carded")} /> Sirf jin ka special rate laga hai</label>
            <label className="flex items-center gap-1.5"><input type="radio" name="scope" checked={scope === "all"} onChange={() => setScope("all")} /> Sab khata customers ({total})</label>
          </div>
          {prods.map((p) => (
            <div key={p} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-20 font-medium">{NAMES[p] ?? p}</span>
              <select className="input min-h-9 w-auto !py-1" aria-label={`${p} rate mode`} value={cards[p]?.clear ? "clear" : cards[p]?.mode ?? "minus"} onChange={(e) => e.target.value === "clear" ? setC(p, { clear: true }) : setC(p, { mode: e.target.value, clear: false })}>
                <option value="minus">Pump − X</option><option value="fixed">Fixed rate</option><option value="clear">Pump rate par wapas</option>
              </select>
              {!cards[p]?.clear && <input className="input min-h-9 w-24 !py-1" type="number" min={0} step="0.01" inputMode="decimal" placeholder="—" aria-label={`${p} rate value`} value={cards[p]?.value ?? ""} onChange={(e) => setC(p, { value: e.target.value })} />}
              <span className="text-xs text-slate-500">Pump {pump[p]?.price ?? "—"}{!cards[p]?.clear && Number(cards[p]?.value) > 0 ? <> → <b className="tabular-nums">{Math.min(pump[p]?.price ?? Infinity, cards[p]?.mode === "fixed" ? Number(cards[p].value) : Math.round(((pump[p]?.price ?? 0) - Number(cards[p].value)) * 100) / 100)}</b></> : null}</span>
            </div>
          ))}
        </>}

        <Field label="Note (optional)"><input className="input" placeholder="jaise: 8-Nov price increase" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Har customer ko naya rate WhatsApp par bhejein · <Ur>واٹس ایپ پر اطلاع</Ur></label>
        <p className="text-xs text-slate-500">Naya rate aage ki khata entries par lagega. Pehle se bani entries ka rate nahi badalta, aur purani tareekh ki nayi entry par us waqt wala rate lagta hai.</p>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !any}>Sab par lagao</button></div>
      </form>
    </Modal>
  );
}
