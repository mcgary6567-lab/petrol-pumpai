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
import { AccountPicker } from "../components/BankParts";
import { activeProducts, PRODUCTS, num, pkr } from "../lib/format";
import { Field, IdTag, Loading, Modal, PageHeader, useAction } from "../components/ui";
import { ProofPhotos, resizeImage } from "../components/Capture";

const Ur = ({ children }: { children: React.ReactNode }) => <span lang="ur" dir="rtl" className="font-urdu font-normal">{children}</span>;
const pkToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const dmy = (d: string) => { const [y, m, dd] = d.split("-"); return `${dd}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]}-${y}`; };

type Line = { key: number; parchi_date: string; slip_no: string; vehicle_no: string; kind: "fuel" | "shop"; product: string; item_id: string; qty: string; rate: string; rateTouched: boolean; photos: number[];
  /** typed by a person (an auto-opened line with a copied date / gaari / next slip does not count until then) */ edited: boolean;
  /** the parchi says a money amount: litres = amount ÷ rate */ byAmount: boolean; amount: string };
let seq = 1;
/** next slip no.: 245 → 246, A-099 → A-100; nothing when the last one had no number at the end */
const nextSlip = (s?: string) => { const m = /^(.*?)(\d+)$/.exec((s ?? "").trim()); if (!m) return ""; const n = String(Number(m[2]) + 1); return m[1] + n.padStart(m[2].length, "0"); };
const blank = (from?: Line): Line => ({ key: seq++, parchi_date: from?.parchi_date ?? pkToday(), slip_no: nextSlip(from?.slip_no), vehicle_no: from?.vehicle_no ?? "", kind: from?.kind ?? "fuel",
  product: from?.product ?? activeProducts[0]?.code ?? "PMG", item_id: from?.kind === "shop" ? from.item_id : "", qty: "", rate: "", rateTouched: false, photos: [], edited: false, byAmount: false, amount: "" });
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const slipKey = (s: string) => s.trim().toUpperCase();
const plate = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
function usePhone() {
  const q = "(max-width: 767px)";
  const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const f = () => setM(mq.matches); mq.addEventListener?.("change", f); return () => mq.removeEventListener?.("change", f); }, []);
  return m;
}
const draftKey = (c: string) => `pumpai.parchi.draft.${c}`;
const readDraft = (c: string): { lines: Line[]; note: string; at: string } | null => { try { const d = JSON.parse(localStorage.getItem(draftKey(c)) ?? "null"); return d?.lines?.length ? d : null; } catch { return null; } };
const dropDraft = (c: string) => { try { localStorage.removeItem(draftKey(c)); } catch { /* private mode */ } };

export default function ParchiBilling() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState<"new" | "book" | "milan">(params.get("tab") === "book" ? "book" : params.get("tab") === "milan" ? "milan" : "new");
  const [customer, setCustomer] = useState<string>(params.get("customer") ?? "");
  return (
    <div className="space-y-4">
      <PageHeader title={<span className="flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-500 text-white"><Ticket size={19} /></span>Parchi Billing · <Ur>پرچی بلنگ</Ur></span>}
        subtitle="Parchi aayi — na tail diya, na cash. Har parchi khata customer ke khate mein jati hai." />
      <div className="flex gap-1 rounded-xl bg-slate-100 p-1 sm:w-fit" role="tablist">
        {([["new", "🎫 Nayi parchiyan", "نئی پرچیاں"], ["book", "📒 Parchi Book", "پرچی بک"], ["milan", "🔍 Milan", "ملان"]] as const).map(([k, en, ur]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`min-h-10 flex-1 rounded-lg px-4 text-sm font-semibold sm:flex-none ${tab === k ? "bg-white text-violet-700 shadow" : "text-slate-600"}`}>{en} · <Ur>{ur}</Ur></button>))}
      </div>
      {tab === "new" ? <NewParchis customer={customer} setCustomer={setCustomer} onSaved={() => setTab("book")} />
        : tab === "milan" ? <Milan customer={customer} setCustomer={setCustomer} toForm={() => setTab("new")} />
        : <ParchiBook customer={customer} setCustomer={setCustomer} />}
    </div>
  );
}

function useCustomers() {
  const { data } = useApi<any[]>("/khata");
  return (data ?? []).filter((c) => c.credit_limit > 0 || c.balance > 0).sort((a, b) => a.name.localeCompare(b.name));
}

function NewParchis({ customer, setCustomer, onSaved }: { customer: string; setCustomer: (v: string) => void; onSaved: () => void }) {
  const customers = useCustomers();
  const phone = usePhone();
  const meta = useApi<any>(customer ? `/parchi/meta?customer_id=${customer}` : "/parchi/meta");
  const [lines, setLines] = useState<Line[]>(() => [blank()]);
  const [note, setNote] = useState("");
  const [tag, setTag] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [newVeh, setNewVeh] = useState<{ line: number; plate: string; fuel: string; limit?: string } | null>(null);
  const [active, setActive] = useState<number | null>(null); // the line the gaari buttons fill
  const [vq, setVq] = useState(""); // gaari quick search
  const [draft, setDraft] = useState<ReturnType<typeof readDraft>>(null);
  const [allDate, setAllDate] = useState(pkToday());
  const [photoBusy, setPhotoBusy] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState<{ id: number; n: number; total: number; balance: number } | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [tplOpen, setTplOpen] = useState(false);
  const [photoDup, setPhotoDup] = useState<Record<number, string>>({});
  const [vday, setVday] = useState<Record<string, number>>({});
  const rates = useRef<Record<string, Record<string, number>>>({}); // `${customer}|${date}` → his rate (card applied)
  const boards = useRef<Record<string, Record<string, number>>>({}); // date → pump board rate
  const { busy, run } = useAction();
  const items: any[] = meta.data?.items ?? [];
  const c = meta.data?.customer;
  const vehicles: any[] = meta.data?.vehicles ?? [];
  if (meta.data?.today && meta.data.rates && meta.data.customer && !rates.current[`${customer}|${meta.data.today}`]) { rates.current[`${customer}|${meta.data.today}`] = meta.data.rates; boards.current[meta.data.today] = meta.data.board_rates; }

  /** change a line; a person's change marks it edited; a line written as an amount keeps its litres = amount ÷ rate */
  const set = (key: number, patch: Partial<Line>, byUser = true) => setLines((ls) => ls.map((l) => {
    if (l.key !== key) return l;
    const n = { ...l, ...patch, edited: l.edited || byUser };
    // a saved gaari with its fuel: choosing the gaari chooses the fuel too (can still be changed)
    if (patch.vehicle_no && n.kind === "fuel") { const v = vehicles.find((x) => plate(x.plate_no) === plate(patch.vehicle_no!)); if (v?.fuel && v.fuel !== n.product && activeProducts.some((p) => p.code === v.fuel)) { n.product = v.fuel; if (!n.rateTouched) n.rate = ""; } }
    if (n.byAmount && Number(n.rate) > 0 && Number(n.amount) > 0) n.qty = String(r3(Number(n.amount) / Number(n.rate)));
    return n;
  }));
  // the rate a line should carry: fuel = that day's rate, shop = the item's rate (unless typed by hand)
  const autoRate = async (l: Line): Promise<string> => {
    if (l.kind === "shop") { const it = items.find((i) => String(i.id) === l.item_id); return it ? String(it.price) : ""; }
    const k = `${customer}|${l.parchi_date}`;
    if (!rates.current[k]) { try { const [mine, board] = await Promise.all([api(`/parchi/rates?date=${l.parchi_date}&customer_id=${customer}`), boards.current[l.parchi_date] ?? api(`/parchi/rates?date=${l.parchi_date}`)]); rates.current[k] = mine; boards.current[l.parchi_date] = board; } catch { return ""; } }
    const r = rates.current[k]?.[l.product]; return r ? String(r) : "";
  };
  useEffect(() => { // fill / refresh rates whenever date, fuel or item changes on a line whose rate was not typed
    let stop = false;
    (async () => { for (const l of lines) if (!l.rateTouched) { const r = await autoRate(l); if (!stop && r !== l.rate) set(l.key, { rate: r }, false); } })();
    return () => { stop = true; };
  }, [lines.map((l) => `${l.key}|${l.parchi_date}|${l.kind}|${l.product}|${l.item_id}|${l.rateTouched}`).join(","), items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const amt = (l: Line) => l.byAmount ? Math.round((Number(l.amount) || 0) * 100) / 100 : Math.round((Number(l.qty) || 0) * (Number(l.rate) || 0) * 100) / 100;
  const filled = (l: Line) => Number(l.qty) > 0 && Number(l.rate) > 0 && (l.kind === "fuel" ? !!l.product : !!l.item_id);
  const started = (l: Line) => l.edited && !!(l.slip_no || Number(l.qty) > 0 || Number(l.amount) > 0);
  const ready = lines.filter(filled);
  const half = lines.filter((l) => started(l) && !filled(l));
  const future = lines.filter((l) => started(l) && l.parchi_date > pkToday());
  // a finished last line opens the next one by itself (date, gaari, fuel / item copied, next slip no.)
  // (the new line is made outside the state update: React may re-run an update, and a fresh key each time would never settle)
  useEffect(() => { const last = lines[lines.length - 1]; if (last && filled(last)) { const n = blank(last); setLines((ls) => (ls[ls.length - 1]?.key === last.key ? [...ls, n] : ls)); } }, [lines]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- draft: kept on this device while typing, offered back if the page closes before Save ---- */
  useEffect(() => { setDraft(customer ? readDraft(customer) : null); }, [customer]);
  useEffect(() => {
    if (!customer) return;
    const id = setTimeout(() => { try { if (lines.some(started)) localStorage.setItem(draftKey(customer), JSON.stringify({ lines, note, at: new Date().toISOString() })); } catch { /* storage full / private */ } }, 600);
    return () => clearTimeout(id);
  }, [lines, note, customer]); // eslint-disable-line react-hooks/exhaustive-deps
  /* ---- 32: the same photo twice (in this list, or already on a parchi) ---- */
  const photoKey = lines.flatMap((l) => l.photos).join(",");
  useEffect(() => {
    if (!photoKey) { setPhotoDup({}); return; }
    const id = setTimeout(() => { api<any[]>("/parchi/photo-check", { body: { photo_ids: photoKey.split(",").map(Number) } }).then((r) => setPhotoDup(Object.fromEntries(r.map((x) => [x.photo_id, x.dup])))).catch(() => {}); }, 400);
    return () => clearTimeout(id);
  }, [photoKey]);
  /* ---- 17: litres already on each gaari that day (khata + parchi), for the daily limit ---- */
  const dayKey = customer ? [...new Set(lines.filter((l) => l.vehicle_no).map((l) => l.parchi_date))].sort().join(",") : "";
  useEffect(() => {
    if (!dayKey) { setVday({}); return; }
    const id = setTimeout(() => { api<Record<string, number>>(`/parchi/vehicle-day?customer_id=${customer}&dates=${dayKey}`).then(setVday).catch(() => {}); }, 400);
    return () => clearTimeout(id);
  }, [dayKey, customer, meta.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const overLimit = (l: Line): string | null => {
    if (!l.vehicle_no || l.kind !== "fuel" || !(Number(l.qty) > 0)) return null;
    const v = vehicles.find((x) => plate(x.plate_no) === plate(l.vehicle_no));
    if (!(v?.daily_limit_l > 0)) return null;
    const mine = lines.filter((x) => x.kind === "fuel" && plate(x.vehicle_no) === plate(l.vehicle_no) && x.parchi_date === l.parchi_date).reduce((a, x) => a + (Number(x.qty) || 0), 0);
    const total = Math.round(((vday[`${plate(l.vehicle_no)}|${l.parchi_date}`] ?? 0) + mine) * 100) / 100;
    return total > v.daily_limit_l + 0.01 ? `${v.plate_no}: ${dmy(l.parchi_date).slice(0, 6)} ko ${total} L — limit ${v.daily_limit_l} L` : null;
  };
  const restore = () => { if (!draft) return; setLines(draft.lines.map((l) => ({ ...l, key: seq++ }))); setNote(draft.note ?? ""); setDraft(null); };

  /* ---- same slip twice: in this batch, or already on the khata ---- */
  const oldSlips = useMemo(() => { const m = new Map<string, { ref: string; date: string }>(); for (const x of (meta.data?.slips ?? []) as any[]) if (!m.has(slipKey(x.slip))) m.set(slipKey(x.slip), x); return m; }, [meta.data]);
  const batchCount = useMemo(() => { const m = new Map<string, number>(); for (const l of lines) if (started(l) && l.slip_no.trim()) m.set(slipKey(l.slip_no), (m.get(slipKey(l.slip_no)) ?? 0) + 1); return m; }, [lines]); // eslint-disable-line react-hooks/exhaustive-deps
  const dupOf = (l: Line): string | null => {
    if (!started(l) || !l.slip_no.trim()) return null;
    const k = slipKey(l.slip_no);
    if ((batchCount.get(k) ?? 0) > 1) return `Slip ${l.slip_no} is list mein ${batchCount.get(k)} dafa`;
    const o = oldSlips.get(k); return o ? `Slip ${l.slip_no} pehle khate mein: ${o.ref} · ${dmy(o.date)}` : null;
  };
  const dups = ready.filter((l) => dupOf(l));

  /* ---- keyboard: Enter = Slip → Litre → next line's Slip ---- */
  // focus at once when the field is already there (a fast typist's next keys land in it), else right after the new line renders
  const focus = (f: string, key: number) => {
    const go = () => { const el = document.querySelector(`[data-f="${f}-${key}"]`) as HTMLInputElement | null; if (!el) return false; el.focus(); el.select?.(); return true; };
    if (!go()) setTimeout(go, 30);
  };
  const onEnter = (e: React.KeyboardEvent, l: Line, field: "date" | "slip" | "qty" | "rate" | "amount") => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (field === "date") return focus("slip", l.key);
    if (field === "slip") return focus(l.byAmount ? "amount" : "qty", l.key);
    // the next line's slip — the line may have opened by itself a moment ago, so look for it on the page, not in this render
    const after = () => { const all = [...document.querySelectorAll<HTMLInputElement>('[data-f^="slip-"]')]; const el = all[all.findIndex((x) => x.dataset.f === `slip-${l.key}`) + 1]; if (!el) return false; el.focus(); el.select(); return true; };
    if (after()) return;
    if (filled(l)) { const n = blank(l); setLines((ls) => (ls[ls.length - 1]?.key === l.key ? [...ls, n] : ls)); }
    setTimeout(after, 40);
  };

  /* ---- gaari buttons: most used first, and the ones already in this list ---- */
  const target = active ?? [...lines].reverse().find((l) => !filled(l))?.key ?? lines[lines.length - 1]?.key;
  const chips = useMemo(() => {
    const seen = new Set<string>(), out: string[] = [];
    for (const v of [...lines.map((l) => l.vehicle_no).filter(Boolean).reverse(), ...vehicles.map((v) => v.plate_no)]) { const k = plate(v); if (k && !seen.has(k)) { seen.add(k); out.push(v); } }
    const q = plate(vq);
    return (q ? out.filter((v) => plate(v).includes(q)) : out).slice(0, 12);
  }, [lines, vehicles, vq]);
  const pickVehicle = (v: string) => { if (target != null) set(target, { vehicle_no: v }); setVq(""); };

  const fuelBy = useMemo(() => { const m: Record<string, { n: number; l: number; a: number }> = {}; for (const l of ready.filter((x) => x.kind === "fuel")) { m[l.product] ??= { n: 0, l: 0, a: 0 }; m[l.product].n++; m[l.product].l += Number(l.qty); m[l.product].a += amt(l); } return m; }, [lines]); // eslint-disable-line react-hooks/exhaustive-deps
  const shopLines = ready.filter((l) => l.kind === "shop");
  const vehBy = useMemo(() => { const m: Record<string, { n: number; a: number }> = {}; for (const l of ready) { const k = l.vehicle_no || "— gaari nahi"; m[k] ??= { n: 0, a: 0 }; m[k].n++; m[k].a += amt(l); } return m; }, [lines]); // eslint-disable-line react-hooks/exhaustive-deps
  const fuelTotal = Object.values(fuelBy).reduce((a, x) => a + x.a, 0), shopTotal = shopLines.reduce((a, l) => a + amt(l), 0);
  const fuelL = Object.values(fuelBy).reduce((a, x) => a + x.l, 0);
  const total = Math.round((fuelTotal + shopTotal) * 100) / 100;
  const newBal = c ? c.balance + total : 0;
  const over = c && c.credit_limit > 0 && newBal > c.credit_limit;
  const room = c && c.credit_limit > 0 ? c.credit_limit - newBal : null;
  const itemName = (id: string) => items.find((i) => String(i.id) === id)?.name ?? "";
  const blocked = !ready.length || half.length > 0 || future.length > 0;
  const overs = [...new Set(ready.map(overLimit).filter(Boolean))] as string[];
  const dupPhotos = ready.filter((l) => l.photos.some((id) => photoDup[id]));

  const save = async () => {
    const r = await run(() => api("/parchi/batch", { body: { customer_id: Number(customer), note: note || null, tag: tag.trim() || null, lines: ready.map((l) => ({
      parchi_date: l.parchi_date, slip_no: l.slip_no || null, vehicle_no: l.vehicle_no || null, kind: l.kind, product: l.kind === "fuel" ? l.product : null,
      item_id: l.kind === "shop" ? Number(l.item_id) : null, qty: Number(l.qty), rate: Number(l.rate), amount: l.byAmount ? Number(l.amount) : null, photo_ids: l.photos })) } }),
      (x: any) => `${x.ids.length} parchi khate mein — ${pkr(x.total)}`);
    if (r) { dropDraft(customer); setConfirm(false); setLines([blank()]); setNote(""); meta.reload(); setDone({ id: r.ids[0], n: r.ids.length, total: r.total, balance: r.balance }); }
  };
  /** keep what was typed, drop the empty auto line at the end, then add these lines */
  const appendLines = (add: Line[]) => { const keep = lines.filter((l) => started(l) || filled(l)); const all = [...keep, ...add]; setLines(all.length ? all : [blank()]); };
  // 11: photos first — one parchi line per photo, filled in after
  const fromPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files).slice(0, 100);
    const made: Line[] = [];
    let prev: Line | undefined = [...lines].reverse().find((l) => started(l) || filled(l)) ?? lines[lines.length - 1];
    try {
      for (let i = 0; i < list.length; i++) {
        setPhotoBusy(`${i + 1}/${list.length}`);
        const r = await api("/ai/read-photo", { body: { kind: "proof", image: await resizeImage(list[i], 1600, true) } });
        const n: Line = { ...blank(prev), parchi_date: allDate || prev?.parchi_date || pkToday(), photos: [r.photo_id], edited: true };
        made.push(n); prev = n;
      }
    } catch (e: any) { alert(`Photo upload ruk gaya: ${e.message}`); }
    finally { setPhotoBusy(null); if (photoInput.current) photoInput.current.value = ""; }
    if (made.length) { appendLines(made); focus("slip", made[0].key); }
  };
  const addVehicle = async () => {
    if (!newVeh || newVeh.plate.trim().length < 3) return;
    const v = await run(() => api(`/customers/${customer}/vehicles`, { body: { plate_no: newVeh.plate.trim(), fuel: newVeh.fuel || null, ...(Number(newVeh.limit) > 0 ? { daily_limit_l: Number(newVeh.limit) } : {}) } }), "Gaari save ho gayi");
    if (v) { set(newVeh.line, { vehicle_no: v.plate_no }); setNewVeh(null); meta.reload(); }
  };

  /** one line's fields — laid out as a table row on a computer and as a card on a phone */
  const F = (l: Line, i: number) => {
    const dup = dupOf(l);
    const big = phone ? "!py-2.5 text-base" : "!py-1.5";
    return {
      no: filled(l) ? <Check size={15} className="inline text-emerald-600" /> : <>{i + 1}</>,
      date: <input data-f={`date-${l.key}`} className={`input ${big}`} type="date" max={pkToday()} value={l.parchi_date} aria-label={`Line ${i + 1} parchi ki tareekh`} onChange={(e) => set(l.key, { parchi_date: e.target.value })} onKeyDown={(e) => onEnter(e, l, "date")} />,
      slip: <><input data-f={`slip-${l.key}`} className={`input ${phone ? "" : "!w-20"} ${big} ${dup ? "!border-rose-400 !bg-rose-50" : ""}`} inputMode="numeric" value={l.slip_no} aria-label={`Line ${i + 1} slip no`} onChange={(e) => set(l.key, { slip_no: e.target.value })} onKeyDown={(e) => onEnter(e, l, "slip")} />
        {dup && <div className="mt-0.5 max-w-[11rem] text-[11px] leading-tight text-rose-700">⚠ {dup}</div>}
        {overLimit(l) && <div className="mt-0.5 max-w-[11rem] text-[11px] leading-tight text-amber-700">⛽ {overLimit(l)}</div>}</>,
      gaari: <select className={`input ${phone ? "" : "!w-32"} ${big}`} value={l.vehicle_no} aria-label={`Line ${i + 1} gaari`} onChange={(e) => e.target.value === "__new__" ? setNewVeh({ line: l.key, plate: "", fuel: l.kind === "fuel" ? l.product : "" }) : set(l.key, { vehicle_no: e.target.value })}>
        <option value="">— gaari —</option>{vehicles.map((v) => <option key={v.id} value={v.plate_no}>{v.plate_no}{v.fuel ? ` · ${PRODUCTS[v.fuel] ?? v.fuel}` : ""}</option>)}
        {l.vehicle_no && !vehicles.some((v) => v.plate_no === l.vehicle_no) && <option value={l.vehicle_no}>{l.vehicle_no}</option>}
        <option value="__new__">＋ Nayi gaari add karein</option></select>,
      kind: <div className={`inline-flex rounded-lg bg-slate-100 p-0.5 font-semibold ${phone ? "w-full text-sm" : "text-xs"}`}>{(["fuel", "shop"] as const).map((k) => (
        <button key={k} type="button" onClick={() => set(l.key, { kind: k, rateTouched: false, item_id: k === "shop" ? l.item_id : "" })} aria-pressed={l.kind === k} className={`rounded-md ${phone ? "flex-1 py-2.5" : "px-2 py-1.5"} ${l.kind === k ? "bg-white text-violet-700 shadow" : "text-slate-500"}`}>{k === "fuel" ? "⛽ Fuel" : "🛒 Shop"}</button>))}</div>,
      item: l.kind === "fuel"
        ? <select className={`input ${phone ? "" : "!w-36"} ${big}`} value={l.product} aria-label={`Line ${i + 1} fuel`} onChange={(e) => set(l.key, { product: e.target.value, rateTouched: false })}>{activeProducts.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
        : <><select className={`input ${phone ? "" : "!w-40"} ${big}`} value={l.item_id} aria-label={`Line ${i + 1} shop item`} onChange={(e) => set(l.key, { item_id: e.target.value, rateTouched: false })}><option value="">— item —</option>{items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}</select>
          <div className="text-[11px] text-amber-700">shop stock par asar nahi</div></>,
      qty: <input data-f={`qty-${l.key}`} className={`input ${phone ? "" : "!w-24"} ${big} text-right ${l.byAmount ? "!bg-slate-50 text-slate-500" : ""}`} type="number" inputMode="decimal" step="any" min={0} placeholder={l.kind === "fuel" ? "litre" : "qty"} aria-label={`Line ${i + 1} ${l.kind === "fuel" ? "litre" : "qty"}`}
        value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value, byAmount: false, amount: "" })} onKeyDown={(e) => onEnter(e, l, "qty")} />,
      rate: <><input data-f={`rate-${l.key}`} className={`input ${phone ? "" : "!w-24"} ${big} text-right`} type="number" inputMode="decimal" step="any" min={0} aria-label={`Line ${i + 1} rate`} value={l.rate} onChange={(e) => set(l.key, { rate: e.target.value, rateTouched: true })} onKeyDown={(e) => onEnter(e, l, "rate")} />
        <div className="text-right text-[11px] text-violet-700">{l.rateTouched ? "haath se" : l.kind === "fuel" ? (() => { const b = boards.current[l.parchi_date]?.[l.product]; const off = b && Number(l.rate) ? Math.round((b - Number(l.rate)) * 100) / 100 : 0;
          return off > 0.004 ? `✓ customer rate (−${off})` : `✓ ${l.parchi_date === pkToday() ? "aaj" : dmy(l.parchi_date).slice(0, 6)} ka rate`; })() : l.item_id ? "✓ item ka rate" : ""}</div></>,
      amount: <><input data-f={`amount-${l.key}`} className={`input ${phone ? "" : "!w-28"} ${big} text-right font-semibold ${l.byAmount ? "!border-violet-400" : ""}`} type="number" inputMode="decimal" step="any" min={0} placeholder="Rs" aria-label={`Line ${i + 1} raqam`}
        value={l.byAmount ? l.amount : amt(l) ? String(amt(l)) : ""} onChange={(e) => e.target.value === "" ? set(l.key, { byAmount: false, amount: "", qty: "" }) : set(l.key, { byAmount: true, amount: e.target.value })} onKeyDown={(e) => onEnter(e, l, "amount")} />
        <div className="text-right text-[11px] text-violet-700">{l.byAmount ? "raqam se litre" : ""}</div></>,
      photo: <><ProofPhotos value={l.photos} onChange={(p) => set(l.key, { photos: p })} label="" hint="" />
        {l.photos.filter((id) => photoDup[id]).map((id) => <div key={id} className="max-w-[12rem] text-[11px] leading-tight text-rose-700">⚠ {photoDup[id]}</div>)}</>,
      remove: lines.length > 1 ? <button type="button" className="rounded p-1.5 text-rose-600 hover:bg-rose-50" aria-label={`Line ${i + 1} hatayein`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><X size={16} /></button> : null,
    };
  };

  return (
    <div className="card">
      <div className="grid gap-3 border-b border-slate-100 p-4 sm:grid-cols-[1.3fr_1fr]">
        <Field label="Khata customer chunein · کھاتہ گاہک">
          <select className="input text-base font-semibold" value={customer} onChange={(e) => { setCustomer(e.target.value); setLines([blank()]); setNote(""); setActive(null); }} aria-label="Khata customer">
            <option value="">— customer chunein —</option>
            {customers.map((x) => <option key={x.id} value={x.id}>{x.name}{x.phone ? ` · ${x.phone}` : ""} · {x.balance < -0.5 ? `advance ${pkr(-x.balance)}` : `${pkr(x.balance)} baqi`}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Note (sab parchiyon ke liye)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="kis ki parchiyan" /></Field>
          <Field label="🏷 Tag (project / site)"><input className="input" list="parchi-tags" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Nov · Site B" aria-label="Batch tag" />
            <datalist id="parchi-tags">{((meta.data?.tags ?? []) as string[]).map((x) => <option key={x} value={x} />)}</datalist></Field>
        </div>
      </div>
      {!customer ? <p className="p-6 text-center text-sm text-slate-500">Pehle customer chunein — us ka khata yahan load hoga.</p> : !c ? <Loading /> : (
        <div className="space-y-3 p-4">
          {draft && <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <span className="mr-auto">📝 Adhoori entry mili: <b>{draft.lines.filter((l) => l.edited).length} parchi</b> · {new Date(draft.at).toLocaleString("en-PK", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} — save nahi hui thi.</span>
            <button type="button" className="btn-primary !bg-amber-600 !py-1.5" onClick={restore}>Wapas laayein</button>
            <button type="button" className="btn-secondary !py-1.5" onClick={() => { dropDraft(customer); setDraft(null); }}>Hata dein</button>
          </div>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[["Khata balance abhi", c.balance < -0.5 ? `Advance ${pkr(-c.balance)}` : pkr(c.balance)], ["Credit limit", c.credit_limit ? pkr(c.credit_limit) : "—"], ["Is mahine", pkr(c.month)],
              ["Aakhri payment", c.last_payment ? `${pkr(c.last_payment.amount)} · ${dmy(new Date(Date.parse(c.last_payment.created_at) + 5 * 3600_000).toISOString().slice(0, 10))}` : "—"]].map(([l, v]) => (
              <div key={l} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">{l}</div><div className="font-bold tabular-nums">{v}</div></div>))}
          </div>
          {c.recent?.length > 0 && <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs text-slate-600"><b className="text-slate-800">Aakhri entries</b>
            {c.recent.map((k: any) => <div key={k.id} className="flex justify-between gap-2"><span className="min-w-0 truncate">{dmy(new Date(Date.parse(k.created_at) + 5 * 3600_000).toISOString().slice(0, 10))} · K-{k.id} · {k.product ? `${PRODUCTS[k.product]} ${num(k.litres, 2)} L` : k.type === "credit" ? "Payment" : k.note}{k.vehicle_no ? ` · ${k.vehicle_no}` : ""}</span><span className={`shrink-0 tabular-nums ${k.type === "credit" ? "text-emerald-700" : ""}`}>{k.type === "credit" ? "− " : ""}{pkr(k.amount)}</span></div>)}</div>}
          <p className="rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-900"><b>Enter</b>: Slip → Litre → agli parchi. Slip no. khud agla aata hai. Parchi par sirf raqam ho to <b>Raqam</b> mein likhein — litre khud. Upar ke button se gaari ek tap mein. Likha hua is device par khud save hota rehta hai.</p>

          {/* 6: one date for all · 11: photos first · 13: from Excel */}
          <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2">
            <label className="text-xs font-semibold text-slate-500">📅 Sab parchiyon ki tareekh
              <input type="date" className="input mt-0.5 !w-40 !py-1.5" max={pkToday()} value={allDate} onChange={(e) => setAllDate(e.target.value)} aria-label="Sab parchiyon ki tareekh" /></label>
            <button type="button" className="btn-secondary !py-1.5 text-sm" disabled={!allDate || allDate > pkToday()} onClick={() => setLines((ls) => ls.map((l) => ({ ...l, parchi_date: allDate })))}>Sab par lagayein</button>
            <span className="mx-1 hidden h-8 w-px bg-slate-200 sm:block" />
            <input ref={photoInput} type="file" accept="image/*" multiple className="hidden" onChange={(e) => fromPhotos(e.target.files)} />
            <button type="button" className="btn-secondary !py-1.5 text-sm" disabled={!!photoBusy} onClick={() => photoInput.current?.click()} title="Saari parchiyon ki photos ek saath — har photo ki ek line ban jayegi, phir litre / raqam bharein">📷 {photoBusy ? `Photo ${photoBusy}…` : "Photos se parchiyan"}</button>
            <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={() => setImporting(true)} title="Excel se copy-paste ya CSV file">📥 Excel se</button>
            <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={() => setTplOpen(true)} title="Roz aane wali gaariyon ki lines ek click mein">📋 Template</button>
          </div>

          {/* gaari quick pick: fills the line being typed */}
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 bg-white p-2">
            <span className="text-xs font-semibold text-slate-500">🚛 Gaari{lines.findIndex((l) => l.key === target) >= 0 ? ` → line ${lines.findIndex((l) => l.key === target) + 1}` : ""}:</span>
            <input className="input !w-28 !py-1 text-sm uppercase" value={vq} onChange={(e) => setVq(e.target.value)} placeholder="453…" aria-label="Gaari dhoondein"
              onKeyDown={(e) => { if (e.key === "Enter" && chips[0]) { e.preventDefault(); pickVehicle(chips[0]); } }} />
            {chips.map((v) => { const on = target != null && plate(lines.find((l) => l.key === target)?.vehicle_no ?? "") === plate(v);
              return <button key={v} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pickVehicle(v)} className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${on ? "border-violet-500 bg-violet-600 text-white" : "border-slate-200 text-slate-700 hover:bg-violet-50"}`}>{v}</button>; })}
            {!chips.length && <span className="text-xs text-slate-400">{vq ? "nahi mili — line mein ＋ Nayi gaari" : "koi gaari save nahi"}</span>}
          </div>

          {phone ? (
            <div className="space-y-2">
              {lines.map((l, i) => { const f = F(l, i); return (
                <div key={l.key} onFocusCapture={() => setActive(l.key)} className={`rounded-xl border p-3 ${filled(l) ? "border-emerald-200 bg-white" : active === l.key ? "border-violet-400 bg-violet-50/40" : "border-slate-200 bg-violet-50/20"}`}>
                  <div className="mb-2 flex items-center justify-between"><span className="font-bold text-violet-700">#{i + 1} {filled(l) && <Check size={15} className="inline text-emerald-600" />}</span><span className="font-bold tabular-nums">{amt(l) ? pkr(amt(l)) : ""}</span>{f.remove}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-xs text-slate-500">Tareekh{f.date}</label><label className="text-xs text-slate-500">Slip no.{f.slip}</label>
                    <label className="col-span-2 text-xs text-slate-500">Gaari{f.gaari}</label>
                    <div className="col-span-2">{f.kind}</div>
                    <label className="col-span-2 text-xs text-slate-500">{l.kind === "fuel" ? "Fuel" : "Shop item"}{f.item}</label>
                    <label className="text-xs text-slate-500">{l.kind === "fuel" ? "Litre" : "Qty"}{f.qty}</label><label className="text-xs text-slate-500">Rate{f.rate}</label>
                    <label className="text-xs text-slate-500">Raqam (Rs){f.amount}</label><div className="text-xs text-slate-500">Photo<div>{f.photo}</div></div>
                  </div>
                </div>); })}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1160px]">
                <thead><tr>{["#", "Parchi ki tareekh", "Slip no.", "Gaari", "Kya", "Fuel / item", "Litre / qty", "Rate", "Raqam", "Photo", ""].map((hd) => <th key={hd} className={`th ${["Litre / qty", "Rate", "Raqam"].includes(hd) ? "text-right" : ""}`}>{hd}</th>)}</tr></thead>
                <tbody>
                  {lines.map((l, i) => { const f = F(l, i); return (
                    <tr key={l.key} onFocusCapture={() => setActive(l.key)} className={filled(l) ? "" : active === l.key ? "bg-violet-100/50" : "bg-violet-50/40"}>
                      <td className="td text-center font-semibold text-violet-700">{f.no}</td><td className="td">{f.date}</td><td className="td align-top">{f.slip}</td><td className="td">{f.gaari}</td>
                      <td className="td">{f.kind}</td><td className="td">{f.item}</td><td className="td">{f.qty}</td><td className="td">{f.rate}</td><td className="td">{f.amount}</td><td className="td">{f.photo}</td><td className="td">{f.remove}</td>
                    </tr>); })}
                </tbody>
              </table>
            </div>
          )}
          <button type="button" className="inline-flex items-center gap-1 rounded-lg border border-violet-300 bg-violet-50 px-3 py-1.5 text-sm font-semibold text-violet-700" onClick={() => { const n = blank(lines[lines.length - 1]); setLines((ls) => [...ls, n]); focus("slip", n.key); }}><Plus size={15} /> Aur parchi · <Ur>مزید پرچی</Ur></button>
          {(half.length > 0 || future.length > 0) && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{half.length > 0 && <>{half.length} line adhoori hai — litre/qty ya raqam likhein (shop mein item chunein), ya line hata dein. </>}{future.length > 0 && <>Aane wali tareekh ki parchi nahi ho sakti.</>}</p>}
          {overs.length > 0 && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">⛽ Gaari ki rozana limit se zyada: {overs.join(" · ")}</p>}
          {dupPhotos.length > 0 && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">⚠ {dupPhotos.length} parchi ki photo pehle bhi lagi hai — kahin wohi parchi dobara to nahi.</p>}
          {dups.length > 0 && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">⚠ {dups.length} parchi ka slip no. dobara hai — check kar lein, kahin ek parchi do dafa to nahi chadh rahi.</p>}
        </div>
      )}

      {/* always in sight while scrolling 100 parchiyan: the running total and Save */}
      {customer && c && <div className="sticky bottom-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-b-xl border-t border-violet-200 bg-white/95 px-4 py-2.5 shadow-[0_-6px_16px_rgba(15,23,42,.08)] backdrop-blur dark:bg-slate-900/95">
        <span className="text-sm"><b className="tabular-nums">{ready.length}</b> parchi</span>
        <span className="text-sm tabular-nums">{num(fuelL, 2)} L</span>
        <span className="text-sm">Kul <b className="tabular-nums text-violet-700">{pkr(total)}</b></span>
        <span className="hidden text-xs text-slate-500 sm:inline">Balance {pkr(c.balance)} → <b>{pkr(newBal)}</b></span>
        {room != null && <span className={`text-xs ${over ? "font-semibold text-amber-700" : "text-slate-500"}`}>{over ? `⚠ limit se ${pkr(-room)} zyada` : `limit mein ${pkr(room)} baqi`}</span>}
        <button type="button" className="btn-primary ml-auto !bg-violet-600 hover:!bg-violet-700" disabled={blocked} onClick={() => setConfirm(true)}><Ticket size={16} /> Save {ready.length} →</button>
      </div>}

      {tplOpen && <Templates customerId={Number(customer)} current={lines.filter((l) => started(l) || filled(l))} onClose={() => setTplOpen(false)}
        onUse={(tl) => { setTplOpen(false); let prev: Line | undefined = [...lines].reverse().find((l) => started(l) || filled(l)); const add = tl.map((x: any) => { const n: Line = { ...blank(prev), parchi_date: allDate || pkToday(), vehicle_no: x.vehicle_no ?? "", kind: x.kind, product: x.product ?? (prev?.product ?? "PMG"), item_id: x.item_id ? String(x.item_id) : "", qty: x.qty ? String(x.qty) : "", edited: true }; prev = n; return n; }); appendLines(add); if (add[0]) focus("slip", add[0].key); }} />}
      {importing && <ExcelImport items={items} defDate={allDate || pkToday()} onClose={() => setImporting(false)} onAdd={(add) => { setImporting(false); appendLines(add); }} />}

      {done && <Modal open onClose={() => setDone(null)} title="✓ Parchiyan khate mein · محفوظ">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center">
          <div className="text-3xl font-bold tabular-nums text-emerald-700">{pkr(done.total)}</div>
          <div className="mt-1 text-sm text-emerald-900"><b>{done.n} parchi</b> {c?.name} ke khate mein · naya balance <b>{pkr(done.balance)}</b></div>
        </div>
        <p className="mt-3 text-sm text-slate-600">Customer ko <b>Parchi receipt</b> dein — har parchi, kul raqam aur naya balance:</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <WhatsAppDoc kind="parchi_receipt" id={done.id} />
          <a className="btn-secondary" href={`/api/docs/parchi_receipt/${done.id}/pdf?token=${linkToken()}`} target="_blank" rel="noreferrer"><Download size={15} /> PDF</a>
          <button className="btn-secondary" onClick={() => printNow({ title: "Parchi receipt", pdf: `/api/docs/parchi_receipt/${done.id}/pdf?token=${linkToken()}` })}><Printer size={15} /> Print</button>
        </div>
        <div className="mt-4 flex justify-between gap-2 border-t border-slate-100 pt-3">
          <button className="btn-secondary" onClick={() => { setDone(null); onSaved(); }}>📒 Parchi Book</button>
          <button className="btn-primary !bg-violet-600" onClick={() => { setDone(null); focus("slip", lines[0]?.key ?? 0); }}><Plus size={15} /> Aur parchiyan</button>
        </div>
      </Modal>}

      {newVeh && <Modal open onClose={() => setNewVeh(null)} title="Nayi gaari · نئی گاڑی">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Gaari no."><input className="input uppercase" autoFocus value={newVeh.plate} onChange={(e) => setNewVeh({ ...newVeh, plate: e.target.value })} placeholder="LEB-4455" /></Field>
          <Field label="Rozana limit (litre, agar ho)"><input className="input" type="number" inputMode="decimal" step="any" min={0} value={newVeh.limit ?? ""} onChange={(e) => setNewVeh({ ...newVeh, limit: e.target.value })} placeholder="200" /></Field>
          <Field label="Fuel"><select className="input" value={newVeh.fuel} onChange={(e) => setNewVeh({ ...newVeh, fuel: e.target.value })}><option value="">koi bhi</option>{activeProducts.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
        </div>
        <p className="mt-2 text-xs text-slate-500">Gaari {c?.name} ke khate mein save ho jayegi — agli dafa list mein aayegi.</p>
        <div className="mt-3 flex justify-end gap-2"><button className="btn-secondary" onClick={() => setNewVeh(null)}>Cancel</button><button className="btn-primary" disabled={busy || newVeh.plate.trim().length < 3} onClick={addVehicle}>Add</button></div>
      </Modal>}

      {confirm && c && <Modal open onClose={() => setConfirm(false)} title="Check kar lein · تصدیق">
        <div className="space-y-1 text-sm">
          <div className="text-slate-600">{c.name}{c.phone ? ` · ${c.phone}` : ""} · <b>{ready.length} parchi</b> · {dmy(ready.map((l) => l.parchi_date).sort()[0])} se {dmy(ready.map((l) => l.parchi_date).sort().slice(-1)[0])}</div>
          {overs.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">⛽ Limit se zyada: {overs.join(" · ")}</div>}
          {dupPhotos.length > 0 && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">⚠ {dupPhotos.length} parchi ki photo pehle bhi lagi hai.</div>}
          {dups.length > 0 && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">⚠ Slip dobara: {dups.slice(0, 6).map((l) => dupOf(l)).join(" · ")}{dups.length > 6 ? ` … +${dups.length - 6}` : ""}</div>}
          {Object.keys(fuelBy).length > 0 && <><div className="pt-2 text-xs font-bold uppercase tracking-wide text-slate-500">⛽ Fuel</div>
            {Object.entries(fuelBy).map(([p, x]) => <div key={p} className="flex justify-between border-b border-dashed border-slate-200 py-1"><span>{PRODUCTS[p]} · {x.n} parchi</span><span className="tabular-nums">{num(x.l, 2)} L · <b>{pkr(x.a)}</b></span></div>)}</>}
          {shopLines.length > 0 && <><div className="pt-2 text-xs font-bold uppercase tracking-wide text-slate-500">🛒 Shop items <span className="normal-case">(shop stock par asar nahi)</span></div>
            {shopLines.map((l) => <div key={l.key} className="flex justify-between border-b border-dashed border-slate-200 py-1"><span>{itemName(l.item_id)} × {num(Number(l.qty), 2)}</span><b className="tabular-nums">{pkr(amt(l))}</b></div>)}</>}
          <div className="pt-2 text-xs font-bold uppercase tracking-wide text-slate-500">🚛 Gaariyan</div>
          <div className="max-h-48 overflow-auto">{Object.entries(vehBy).map(([v, x]) => <div key={v} className="flex justify-between border-b border-dashed border-slate-200 py-1"><span>{v} · {x.n} parchi</span><b className="tabular-nums">{pkr(x.a)}</b></div>)}</div>
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

/** Payment for chosen parchiyan: a new khata payment (the usual one: cash / bank / receipt on WhatsApp) tied to them,
 *  or an earlier payment's untied money put on them. The khata balance moves only for a new payment. */
function PayParchis({ mode, customerId, name, rows, due, onClose, onDone }: { mode: "new" | "old"; customerId: number; name: string; rows: any[]; due: number; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(String(due));
  const [method, setMethod] = useState("Cash");
  const [account, setAccount] = useState<number | null>(null);
  const [notify, setNotify] = useState(true);
  const [pick, setPick] = useState<number | null>(null);
  const pays = useApi<any[]>(mode === "old" ? `/parchi/payments?customer_id=${customerId}` : null);
  const { busy, run } = useAction();
  const ids = rows.map((r) => r.id);
  const label = `Parchi payment: ${ids.slice(0, 8).map((i) => `PR-${i}`).join(", ")}${ids.length > 8 ? ` +${ids.length - 8}` : ""}`;
  const take = async () => {
    const p = await run(() => api(`/customers/${customerId}/khata`, { body: { type: "credit", amount: Number(amount), method, note: label, notify, account_id: /^cash$/i.test(method) ? null : account } }), "Payment mil gayi");
    if (!p) return;
    if (!p.khata_id || p.cheque_pending) { alert("Cheque register mein chala gaya. Clear hone par yahan \"🔗 Purani payment se jorein\" se in parchiyon par lagayein."); onDone(); return; }
    await run(() => api("/parchi/allocate", { body: { customer_id: customerId, khata_id: p.khata_id, parchi_ids: ids } }), (x: any) => `${x.allocated.length} parchi Paid${x.left > 0.5 ? ` · ${pkr(x.left)} baqi purani entries par` : ""}`);
    onDone();
  };
  const tie = async () => {
    if (!pick) return;
    if (await run(() => api("/parchi/allocate", { body: { customer_id: customerId, khata_id: pick, parchi_ids: ids } }), (x: any) => `${x.allocated.length} parchi K-${pick} se Paid`)) onDone();
  };
  const untie = async (k: number) => { if (confirm(`K-${k} ko parchiyon se alag karein? Woh parchiyan phir sab se purani pehle wale hisaab par aa jayengi.`) && await run(() => api(`/parchi/allocate/${k}/clear`, { body: {} }), "Alag kar diya")) pays.reload(); };
  return (
    <Modal open onClose={onClose} title={mode === "new" ? `💰 Payment lein · ${name}` : `🔗 Purani payment se jorein · ${name}`}>
      <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm"><b>{rows.length} parchi</b> · baqi <b className="tabular-nums">{pkr(due)}</b>
        <div className="mt-1 max-h-24 overflow-auto text-xs text-slate-600">{rows.map((r) => <div key={r.id}>PR-{r.id} · {dmy(r.parchi_date)}{r.vehicle_no ? ` · ${r.vehicle_no}` : ""} · {pkr(r.unpaid)}</div>)}</div></div>
      {mode === "new" ? <>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="Raqam · رقم"><input className="input text-right text-lg font-semibold" type="number" inputMode="decimal" step="any" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Method · طریقہ"><select className="input" value={method} onChange={(e) => { setMethod(e.target.value); setAccount(null); }}>{["Cash", "JazzCash", "Easypaisa", "Raast", "Bank transfer", "Cheque"].map((m) => <option key={m}>{m}</option>)}</select></Field>
        </div>
        {!/^cash$/i.test(method) && <div className="mt-2"><AccountPicker method={method} value={account} onChange={setAccount} /></div>}
        <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Customer ko WhatsApp receipt</label>
        {Number(amount) > due + 0.5 && <p className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">Chuni parchiyon se {pkr(Number(amount) - due)} zyada — yeh baqi purani entries par lagega (ya advance).</p>}
        {Number(amount) > 0 && Number(amount) < due - 0.5 && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">Kam raqam: pehle sab se purani chuni parchi Paid hogi, aakhri wali thori baqi rahegi.</p>}
        <p className="mt-2 text-xs text-slate-500">Yeh aam khata payment hai — cash / bank, khata balance aur receipt sab wahi. Sirf yeh chuni parchiyan Paid hongi.</p>
        <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-3"><button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary !bg-emerald-600" disabled={busy || !(Number(amount) > 0)} onClick={take}><Check size={16} /> {pkr(Number(amount) || 0)} wasool</button></div>
      </> : <>
        <p className="mt-3 text-sm text-slate-600">Kaunsi payment in parchiyon ki thi? (sirf jis ki raqam abhi kisi parchi par nahi lagi)</p>
        {!pays.data ? <Loading /> : <div className="mt-2 max-h-64 space-y-1 overflow-auto">
          {pays.data.map((x) => (
            <div key={x.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${pick === x.id ? "border-emerald-400 bg-emerald-50" : "border-slate-200"}`}>
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"><input type="radio" name="pay" disabled={x.free <= 0.5} checked={pick === x.id} onChange={() => setPick(x.id)} />
                <span className="min-w-0 truncate">K-{x.id} · {new Date(Date.parse(x.created_at) + 5 * 3600_000).toISOString().slice(0, 10)} · {x.method ?? ""} · <b>{pkr(x.amount)}</b>{x.tied > 0.5 ? <span className="text-xs text-slate-500"> · {pkr(x.tied)} parchiyon par</span> : null}</span></label>
              <span className="text-xs tabular-nums text-emerald-700">{x.free > 0.5 ? `${pkr(x.free)} khali` : "poori lagi"}</span>
              {x.tied > 0.5 && <button type="button" className="text-xs text-rose-600 underline" onClick={() => untie(x.id)}>alag</button>}
            </div>))}
          {!pays.data.length && <p className="p-4 text-center text-sm text-slate-500">Is customer ki koi payment nahi</p>}
        </div>}
        <p className="mt-2 text-xs text-slate-500">Paisa aur balance nahi badalte — sirf yeh payment in parchiyon ki maani jayegi.</p>
        <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-3"><button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary !bg-emerald-600" disabled={busy || !pick} onClick={tie}>🔗 Jorein</button></div>
      </>}
    </Modal>
  );
}

/**
 * 27: Milan · ملان — the customer's own list of parchiyan (Excel / CSV) against his khata here, for a date range. Every line
 * is matched by slip no. (else by date + gaari + amount): ✓ same, ≠ different (litre / amount / date / gaari), only in his
 * list (missed here — can go straight into the form), only here (not in his list). Print / CSV of the result.
 */
type MRow = { line: number; date: string | null; slip: string; gaari: string; item: string; litres: number; amount: number };
function parseTheirs(text: string): { rows: MRow[]; errors: string[] } {
  const raw = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (!raw.length) return { rows: [], errors: [] };
  const sep = raw[0].includes("\t") ? "\t" : (raw[0].split(";").length > raw[0].split(",").length ? ";" : ",");
  let order: (keyof Row)[] = ["date", "slip", "gaari", "item", "qty", "rate", "amount"], start = 0;
  const head = splitRow(raw[0], sep).map((h) => h.toLowerCase());
  if (head.some((h) => /[a-z]/.test(h)) && !readDate(head[0] ?? "") && head.filter((h) => COLS.some(([, re]) => re.test(h))).length >= 2) {
    const used = new Set<string>();
    order = head.map((h) => { const hit = COLS.find(([k, re]) => !used.has(k) && re.test(h)); if (hit) used.add(hit[0]); return (hit?.[0] ?? "") as keyof Row; });
    start = 1;
  }
  const rows: MRow[] = [], errors: string[] = [];
  for (let i = start; i < raw.length; i++) {
    const cells = splitRow(raw[i], sep); const r = {} as Row; order.forEach((k, j) => { if (k) r[k] = cells[j] ?? ""; });
    const date = r.date ? readDate(r.date) : null;
    if (r.date && !date) { errors.push(`Line ${i + 1}: tareekh "${r.date}"`); continue; }
    const litres = numOf(r.qty), amount = numOf(r.amount) || (litres && numOf(r.rate) ? Math.round(litres * numOf(r.rate) * 100) / 100 : 0);
    if (!litres && !amount) { errors.push(`Line ${i + 1}: litre / raqam nahi`); continue; }
    rows.push({ line: i + 1, date, slip: (r.slip ?? "").trim(), gaari: (r.gaari ?? "").toUpperCase(), item: r.item ?? "", litres, amount });
  }
  return { rows, errors };
}
function Milan({ customer, setCustomer, toForm }: { customer: string; setCustomer: (v: string) => void; toForm: () => void }) {
  const customers = useCustomers();
  const [range, setRange] = useState({ from: pkToday().slice(0, 8) + "01", to: pkToday() });
  const [text, setText] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const qs = new URLSearchParams(Object.entries({ customer_id: customer, ...range }).filter(([, v]) => v)).toString();
  const ours = useApi<any>(customer ? `/parchi/book?${qs}` : null);
  const theirs = useMemo(() => parseTheirs(text), [text]);
  const res = useMemo(() => {
    const mine: any[] = (ours.data?.rows ?? []).filter((r: any) => r.status !== "void");
    const used = new Set<number>();
    const same: any[] = [], diff: any[] = [], onlyTheirs: MRow[] = [];
    for (const t of theirs.rows) {
      let m = t.slip ? mine.find((r) => !used.has(r.id) && slipKey(String(r.slip_no ?? "")) === slipKey(t.slip)) : undefined;
      if (!m) m = mine.find((r) => !used.has(r.id) && (!t.date || r.parchi_date === t.date) && (!t.gaari || plate(r.vehicle_no ?? "") === plate(t.gaari)) && (t.amount ? Math.abs(r.amount - t.amount) < 1 : Math.abs((r.qty ?? 0) - t.litres) < 0.05));
      if (!m) { onlyTheirs.push(t); continue; }
      used.add(m.id);
      const why: string[] = [];
      if (t.amount && Math.abs(m.amount - t.amount) >= 1) why.push(`raqam ${pkr(t.amount)} vs ${pkr(m.amount)}`);
      if (t.litres && m.kind === "fuel" && Math.abs(m.qty - t.litres) >= 0.05) why.push(`litre ${t.litres} vs ${m.qty}`);
      if (t.date && m.parchi_date !== t.date) why.push(`tareekh ${dmy(t.date)} vs ${dmy(m.parchi_date)}`);
      if (t.gaari && plate(m.vehicle_no ?? "") !== plate(t.gaari)) why.push(`gaari ${t.gaari} vs ${m.vehicle_no ?? "—"}`);
      (why.length ? diff : same).push({ t, m, why });
    }
    const onlyOurs = mine.filter((r) => !used.has(r.id));
    // a line of his with litres but no amount counts at our amount for the parchi it matched (else it adds nothing)
    const theirsTotal = [...same, ...diff].reduce((a, x) => a + (x.t.amount || (x.t.litres && x.m.kind === "fuel" ? Math.round(x.t.litres * x.m.rate * 100) / 100 : x.m.amount)), 0) + onlyTheirs.reduce((a, t) => a + t.amount, 0);
    const noAmount = theirs.rows.filter((t) => !t.amount).length;
    return { same, diff, onlyTheirs, onlyOurs, theirsTotal, oursTotal: mine.reduce((a, r) => a + r.amount, 0), noAmount };
  }, [theirs, ours.data]);
  const addMissing = () => {
    let prev: Line | undefined;
    const lines = res.onlyTheirs.map((t) => {
      const it = t.item.toLowerCase();
      const code = activeProducts.find((p) => p.code.toLowerCase() === it || p.name.toLowerCase() === it)?.code ?? FUEL_ALIAS.find(([re]) => re.test(it))?.[1] ?? prev?.product ?? activeProducts[0]?.code ?? "PMG";
      const n: Line = { ...blank(prev), parchi_date: t.date && t.date <= pkToday() ? t.date : pkToday(), slip_no: t.slip, vehicle_no: t.gaari, kind: "fuel", product: code, qty: t.litres ? String(t.litres) : "", edited: true,
        byAmount: !t.litres && t.amount > 0, amount: !t.litres && t.amount ? String(t.amount) : "" };
      prev = n; return n;
    });
    try { localStorage.setItem(draftKey(customer), JSON.stringify({ lines, note: "Milan se — customer ki list mein thi", at: new Date().toISOString() })); } catch { /* storage */ }
    toForm();
  };
  const csv = () => {
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const out = [["Natija", "Customer list line", "Slip", "Tareekh", "Gaari", "Litre", "Raqam", "Hamari parchi", "Farq"].join(",")];
    res.same.forEach((x) => out.push([q("Same"), x.t.line, q(x.t.slip), q(x.t.date ?? ""), q(x.t.gaari), x.t.litres, x.t.amount, q(`PR-${x.m.id}`), q("")].join(",")));
    res.diff.forEach((x) => out.push([q("Farq"), x.t.line, q(x.t.slip), q(x.t.date ?? ""), q(x.t.gaari), x.t.litres, x.t.amount, q(`PR-${x.m.id}`), q(x.why.join("; "))].join(",")));
    res.onlyTheirs.forEach((t) => out.push([q("Sirf customer ki list mein"), t.line, q(t.slip), q(t.date ?? ""), q(t.gaari), t.litres, t.amount, q(""), q("")].join(",")));
    res.onlyOurs.forEach((m: any) => out.push([q("Sirf hamare khate mein"), "", q(m.slip_no ?? ""), q(m.parchi_date), q(m.vehicle_no ?? ""), m.kind === "fuel" ? m.qty : "", m.amount, q(`PR-${m.id}`), q("")].join(",")));
    const a = document.createElement("a"); a.href = `data:text/csv;charset=utf-8,${encodeURIComponent("\ufeff" + out.join("\n"))}`; a.download = "parchi-milan.csv"; a.click();
  };
  const name = customers.find((x) => String(x.id) === customer)?.name ?? "";
  const Box = ({ tone, title, n, amt, children }: { tone: string; title: string; n: number; amt?: number; children?: React.ReactNode }) => (
    <div className={`rounded-xl border p-3 ${tone}`}><div className="flex justify-between gap-2"><b className="text-sm">{title}</b><span className="text-sm tabular-nums">{n}{amt != null ? ` · ${pkr(amt)}` : ""}</span></div>{children}</div>);
  return (
    <div className="card p-4">
      <div className="grid gap-3 print:hidden sm:grid-cols-[1.4fr_1fr_1fr]">
        <Field label="Customer"><select className="input" value={customer} onChange={(e) => setCustomer(e.target.value)} aria-label="Milan customer"><option value="">— customer chunein —</option>{customers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="From (parchi date)"><input className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To"><input className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
      </div>
      <p className="mt-3 text-sm text-slate-600 print:hidden">Customer ki apni parchi list (Excel se copy-paste ya CSV): <b>Date, Slip, Gaari, Fuel, Litre, Raqam</b>. System har line ko hamare khate se milata hai — slip no. se, warna tareekh + gaari + raqam se.</p>
      <div className="mt-2 flex flex-wrap gap-2 print:hidden">
        <input ref={file} type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
        <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={() => file.current?.click()}>📄 CSV file</button>
      </div>
      <textarea className="input mt-2 h-32 font-mono text-xs print:hidden" value={text} onChange={(e) => setText(e.target.value)} placeholder={"Date\tSlip\tGaari\tLitre\tRaqam\n24-11-2026\t245\tLEH-453\t50\t13445"} aria-label="Customer ki list" />
      {!customer ? <p className="p-4 text-center text-sm text-slate-500">Pehle customer chunein.</p> : !ours.data ? <Loading /> : text.trim() && <div className="mt-4 space-y-3">
        <div className="hidden print:block"><div className="text-lg font-bold">Parchi milan — {name}</div><div className="text-sm">{dmy(range.from)} — {dmy(range.to)}</div></div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">Customer ki list</div><div className="font-bold tabular-nums">{theirs.rows.length} · {pkr(res.theirsTotal)}</div>{res.noAmount > 0 && <div className="text-[11px] text-slate-500">{res.noAmount} line bina raqam — un ke litre × hamara rate</div>}</div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">Hamara khata (parchi)</div><div className="font-bold tabular-nums">{(ours.data.rows ?? []).filter((r: any) => r.status !== "void").length} · {pkr(res.oursTotal)}</div></div>
          <div className={`col-span-2 rounded-lg border px-3 py-2 ${Math.abs(res.theirsTotal - res.oursTotal) < 1 ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}><div className="text-xs text-slate-600">Farq</div><div className="font-bold tabular-nums">{Math.abs(res.theirsTotal - res.oursTotal) < 1 ? "✓ Barabar" : `${pkr(Math.abs(res.theirsTotal - res.oursTotal))} — ${res.theirsTotal > res.oursTotal ? "customer ki list zyada" : "hamara khata zyada"}`}</div></div>
        </div>
        {theirs.errors.length > 0 && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">{theirs.errors.length} line samajh nahi aayi: {theirs.errors.slice(0, 6).join(" · ")}</p>}
        <Box tone="border-emerald-200" title="✓ Dono mein, same" n={res.same.length} amt={res.same.reduce((a, x) => a + x.m.amount, 0)} />
        <Box tone="border-amber-300 bg-amber-50/40" title="≠ Dono mein, lekin farq" n={res.diff.length}>
          {res.diff.map((x, i) => <div key={i} className="mt-1 text-xs">Line {x.t.line} · slip {x.t.slip || "—"} ↔ <b>PR-{x.m.id}</b>: {x.why.join(" · ")}</div>)}</Box>
        <Box tone="border-rose-300 bg-rose-50/40" title="Sirf customer ki list mein (hamare khate mein nahi)" n={res.onlyTheirs.length} amt={res.onlyTheirs.reduce((a, t) => a + t.amount, 0)}>
          {res.onlyTheirs.map((t) => <div key={t.line} className="mt-1 text-xs">Line {t.line} · {t.date ? dmy(t.date) : "—"} · slip {t.slip || "—"} · {t.gaari || "—"} · {t.litres ? `${t.litres} L` : ""} {t.amount ? pkr(t.amount) : ""}</div>)}
          {res.onlyTheirs.length > 0 && <button type="button" className="btn-primary mt-2 !bg-violet-600 !py-1.5 text-sm print:hidden" onClick={addMissing}>🎫 Yeh {res.onlyTheirs.length} parchi form mein daalein →</button>}</Box>
        <Box tone="border-sky-300 bg-sky-50/40" title="Sirf hamare khate mein (customer ki list mein nahi)" n={res.onlyOurs.length} amt={res.onlyOurs.reduce((a: number, m: any) => a + m.amount, 0)}>
          {res.onlyOurs.map((m: any) => <div key={m.id} className="mt-1 text-xs">PR-{m.id} · {dmy(m.parchi_date)} · slip {m.slip_no || "—"} · {m.vehicle_no || "—"} · {pkr(m.amount)}</div>)}</Box>
        <div className="flex flex-wrap justify-end gap-2 print:hidden">
          <button type="button" className="btn-secondary" onClick={csv}><Download size={15} /> Excel / CSV</button>
          <button type="button" className="btn-primary" onClick={() => printNow({ title: `Parchi milan — ${name}` })}><Printer size={15} /> Print</button>
        </div>
      </div>}
    </div>
  );
}

/** 31: a customer's saved line sets — use one, save the lines on screen as one, delete one. */
function Templates({ customerId, current, onClose, onUse }: { customerId: number; current: Line[]; onClose: () => void; onUse: (lines: any[]) => void }) {
  const { data, reload } = useApi<any[]>(`/parchi/templates?customer_id=${customerId}`);
  const [name, setName] = useState("");
  const [withQty, setWithQty] = useState(false);
  const { busy, run } = useAction();
  const save = async () => {
    const lines = current.map((l) => ({ vehicle_no: l.vehicle_no || null, kind: l.kind, product: l.kind === "fuel" ? l.product : null, item_id: l.kind === "shop" && l.item_id ? Number(l.item_id) : null, qty: withQty && Number(l.qty) > 0 ? Number(l.qty) : null }));
    if (await run(() => api("/parchi/templates", { body: { customer_id: customerId, name: name.trim(), lines } }), "Template save ho gaya")) { setName(""); reload(); }
  };
  return (
    <Modal open onClose={onClose} title="📋 Template · روز کی پرچیاں">
      {!data ? <Loading /> : data.length ? <div className="space-y-1.5">{data.map((t) => (
        <div key={t.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate"><b>{t.name}</b> · {t.lines.length} line · <span className="text-xs text-slate-500">{t.lines.map((x: any) => x.vehicle_no).filter(Boolean).slice(0, 4).join(", ")}</span></span>
          <button type="button" className="btn-primary !px-3 !py-1.5 text-sm" onClick={() => onUse(t.lines)}>Lagayein</button>
          <button type="button" className="text-xs text-rose-600 underline" onClick={async () => { if (confirm(`"${t.name}" template hatayein?`) && await run(() => api(`/parchi/templates/${t.id}`, { method: "DELETE" }), "Hata diya")) reload(); }}>hatayein</button>
        </div>))}</div> : <p className="text-sm text-slate-500">Is customer ka koi template nahi.</p>}
      <div className="mt-4 rounded-xl bg-slate-50 p-3">
        <div className="text-sm font-semibold">Abhi wali {current.length} line ko template banayein</div>
        <div className="mt-2 flex flex-wrap items-end gap-2"><Field label="Naam"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Site B ki gaariyan" /></Field>
          <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={withQty} onChange={(e) => setWithQty(e.target.checked)} /> Litre bhi yaad rakhein</label>
          <button type="button" className="btn-secondary" disabled={busy || name.trim().length < 2 || !current.length} onClick={save}>💾 Save</button></div>
        <p className="mt-1 text-xs text-slate-500">Gaari aur fuel / item yaad rehte hain. Slip aur tareekh har dafa nayi.</p>
      </div>
    </Modal>
  );
}

/** 28: change many parchiyan at once — date / tag / gaari, or delete (PIN, like any cancel). */
function BulkChange({ mode, rows, tags, onClose, onDone }: { mode: "date" | "tag" | "vehicle" | "delete"; rows: any[]; tags: string[]; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState(mode === "date" ? pkToday() : "");
  const { busy, run } = useAction();
  const ids = rows.map((r) => r.id);
  const go = async () => {
    const ok = mode === "delete"
      ? await run(() => api("/parchi/bulk/void", { body: { ids, reason: v } }), (x: any) => `${x.deleted} parchi delete — khata ${pkr(x.amount)} kam`)
      : await run(() => api("/parchi/bulk", { body: { ids, field: mode, value: v.trim() || null } }), (x: any) => `${x.changed} parchi badli`);
    if (ok) onDone();
  };
  const title = { date: "📅 Tareekh badlein", tag: "🏷 Tag lagayein", vehicle: "🚛 Gaari badlein", delete: "🗑 Delete karein" }[mode];
  return (
    <Modal open onClose={onClose} title={`${title} · ${rows.length} parchi`}>
      <div className="max-h-28 overflow-auto rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{rows.map((r) => <div key={r.id}>PR-{r.id} · {dmy(r.parchi_date)} · {r.customer}{r.vehicle_no ? ` · ${r.vehicle_no}` : ""} · {pkr(r.amount)}</div>)}</div>
      <div className="mt-3">
        {mode === "date" && <Field label="Nayi tareekh"><input className="input" type="date" max={pkToday()} value={v} onChange={(e) => setV(e.target.value)} /></Field>}
        {mode === "tag" && <Field label="Tag (khaali = tag hata dein)"><input className="input" list="bulk-tags" value={v} onChange={(e) => setV(e.target.value)} placeholder="Nov · Site B" /><datalist id="bulk-tags">{tags.map((x) => <option key={x} value={x} />)}</datalist></Field>}
        {mode === "vehicle" && <Field label="Gaari no. (khaali = gaari hata dein)"><input className="input uppercase" value={v} onChange={(e) => setV(e.target.value)} placeholder="LEH-453" /></Field>}
        {mode === "delete" && <Field label="Wajah"><input className="input" value={v} onChange={(e) => setV(e.target.value)} placeholder="ghalat customer / do dafa chadhi" /></Field>}
      </div>
      <p className="mt-2 text-xs text-slate-500">{mode === "date" ? "Rate wohi rahega (sirf tareekh badlegi). Naya rate chahiye to Edit karein." : mode === "delete" ? `Kul ${pkr(rows.reduce((a, r) => a + r.amount, 0))} khate se hat jayega. PIN maanga jayega.` : "Khata entry bhi saath badlegi."}</p>
      <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-3"><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className={`btn-primary ${mode === "delete" ? "!bg-rose-600" : ""}`} disabled={busy || (mode === "date" && !v) || (mode === "delete" && v.trim().length < 3)} onClick={go}>{mode === "delete" ? `Delete ${rows.length}` : "Save"}</button></div>
    </Modal>
  );
}

/** 29: one parchi's history — made, changed (before → after), payment tied, deleted. */
function ParchiHistory({ id, onClose }: { id: number; onClose: () => void }) {
  const { data } = useApi<any>(`/parchi/${id}/history`);
  const fmt = (v: unknown) => v == null || v === "" ? "—" : typeof v === "number" ? String(v) : String(v);
  const diff = (d: any) => {
    if (!d) return null;
    if (d.before && d.after && typeof d.before === "object") return Object.keys(d.after).filter((k) => fmt(d.before[k]) !== fmt(d.after[k]) && d.after[k] !== undefined).map((k) => <div key={k}><b>{k}</b>: {fmt(d.before[k])} → {fmt(d.after[k])}</div>);
    if (d.field) return <div><b>{d.field}</b>: {fmt(d.before)} → {fmt(d.after)}</div>;
    return Object.entries(d).filter(([, v]) => v != null && typeof v !== "object").map(([k, v]) => <div key={k}><b>{k}</b>: {fmt(v)}</div>);
  };
  return (
    <Modal open onClose={onClose} title={`🕓 History · PR-${id}`}>
      {!data ? <Loading /> : <ol className="space-y-2">
        {data.events.map((e: any, i: number) => (
          <li key={i} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <div className="flex flex-wrap justify-between gap-2"><b>{e.what}</b><span className="text-xs text-slate-500">{new Date(e.at).toLocaleString("en-PK", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}{e.by ? ` · ${e.by}` : ""}</span></div>
            <div className="mt-1 text-xs text-slate-600">{diff(e.data)}</div>
          </li>))}
      </ol>}
    </Modal>
  );
}

/** 33: the customer's rate card changed — put today's card on his earlier fuel parchiyan (chosen ones), khata and balance follow. */
function RateReview({ customerId, name, onClose, onDone }: { customerId: number; name: string; onClose: () => void; onDone: () => void }) {
  const [range, setRange] = useState({ from: pkToday().slice(0, 8) + "01", to: "" });
  const qs = new URLSearchParams(Object.entries({ customer_id: String(customerId), ...range }).filter(([, v]) => v)).toString();
  const { data } = useApi<any>(`/parchi/rate-review?${qs}`);
  const [pick, setPick] = useState<Set<number> | null>(null);
  useEffect(() => { if (data) setPick(new Set(data.rows.map((r: any) => r.id))); }, [data]);
  const { busy, run } = useAction();
  const rows: any[] = data?.rows ?? [];
  const diff = Math.round(rows.filter((r) => pick?.has(r.id)).reduce((a, r) => a + r.diff, 0) * 100) / 100;
  const go = async () => { if (pick && await run(() => api("/parchi/reprice", { body: { ids: [...pick] } }), (x: any) => `${x.changed} parchi par naya rate · khata ${x.diff >= 0 ? "+" : "−"}${pkr(Math.abs(x.diff))}`)) onDone(); };
  return (
    <Modal open onClose={onClose} title={`♻ Naya rate check · ${name}`} wide>
      <p className="text-sm text-slate-600">Customer ka <b>aaj ka rate card</b> purani fuel parchiyon par lagane se kya badlega. Sirf jin ka rate farq hai woh dikhti hain.</p>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:w-96"><Field label="From"><input className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To"><input className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field></div>
      {!data ? <Loading /> : !rows.length ? <p className="p-6 text-center text-sm text-slate-500">Sab parchiyan pehle se aaj ke rate card par hain.</p> : <>
        <div className="mt-2 max-h-72 overflow-auto"><table className="w-full text-sm"><thead><tr>{["", "PR", "Tareekh", "Gaari", "Litre", "Rate", "Naya rate", "Farq"].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td className="td"><input type="checkbox" checked={!!pick?.has(r.id)} onChange={() => setPick((x) => { const n = new Set(x ?? []); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} /></td>
            <td className="td font-mono text-xs">PR-{r.id}</td><td className="td text-xs">{dmy(r.parchi_date)}</td><td className="td text-xs">{r.vehicle_no ?? ""}</td><td className="td tabular-nums">{num(r.qty, 2)} {PRODUCTS[r.product] ?? r.product}</td>
            <td className="td tabular-nums">{r.rate}</td><td className="td font-semibold tabular-nums text-violet-700">{r.new_rate}</td><td className={`td tabular-nums ${r.diff < 0 ? "text-emerald-700" : "text-rose-700"}`}>{r.diff < 0 ? "−" : "+"}{pkr(Math.abs(r.diff))}</td></tr>)}</tbody></table></div>
        <p className="mt-2 text-sm">Chuni {pick?.size ?? 0} parchi · khata {diff >= 0 ? "barhega" : "kam hoga"} <b>{pkr(Math.abs(diff))}</b></p>
      </>}
      <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-3"><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy || !pick?.size} onClick={go}>♻ Naya rate lagayein ({pick?.size ?? 0})</button></div>
    </Modal>
  );
}

/* ---- 13: parchiyan from Excel (copy-paste) or a CSV file — read here, put in the form, then the usual summary / Confirm ---- */
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** 24-11-2026, 24/11/26, 2026-11-24, 24-Nov-2026, 24 Nov 2026 → 2026-11-24 */
function readDate(v: string): string | null {
  const s = v.trim().toLowerCase();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})[-/. ](\d{1,2}|[a-z]{3})[a-z]*[-/. ,]+(\d{2,4})$/.exec(s);
  if (!m) return null;
  const mon = /^\d+$/.test(m[2]) ? Number(m[2]) : MON.indexOf(m[2]) + 1;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  if (!(mon >= 1 && mon <= 12) || Number(m[1]) < 1 || Number(m[1]) > 31) return null;
  return `${y}-${String(mon).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}
const numOf = (v: string) => { const n = Number(String(v ?? "").replace(/rs\.?|pkr|,|\s/gi, "")); return Number.isFinite(n) && n > 0 ? n : 0; };
function splitRow(line: string, sep: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === sep) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
const COLS: [keyof Row, RegExp][] = [["date", /date|tareekh|tarikh|din/], ["slip", /slip|parchi|no\b|number/], ["gaari", /gaari|gari|gadi|vehicle|truck|plate/],
  ["item", /fuel|item|product|cheez|kya/], ["qty", /lit|qty|quantity|miqdar/], ["rate", /rate|price|qeemat/], ["amount", /amount|raqam|rs|total/]];
type Row = { date: string; slip: string; gaari: string; item: string; qty: string; rate: string; amount: string };
const FUEL_ALIAS: [RegExp, string][] = [[/hi[- ]?oct|hobc|high ?oct/, "HOBC"], [/diesel|hsd|dsl/, "HSD"], [/petrol|pmg|super|gasoline/, "PMG"]];

function parseSheet(text: string, items: any[], defDate: string) {
  const raw = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (!raw.length) return { lines: [] as Line[], errors: [] as string[] };
  const sep = raw[0].includes("\t") ? "\t" : (raw[0].split(";").length > raw[0].split(",").length ? ";" : ",");
  let order: (keyof Row)[] = ["date", "slip", "gaari", "item", "qty", "rate", "amount"];
  let start = 0;
  const head = splitRow(raw[0], sep).map((h) => h.toLowerCase());
  if (head.some((h) => /[a-z]/.test(h)) && !readDate(head[0] ?? "") && head.filter((h) => COLS.some(([, re]) => re.test(h))).length >= 2) {
    const used = new Set<string>();
    order = head.map((h) => { const hit = COLS.find(([k, re]) => !used.has(k) && re.test(h)); if (hit) used.add(hit[0]); return (hit?.[0] ?? "") as keyof Row; });
    start = 1;
  }
  const lines: Line[] = [], errors: string[] = [];
  let prev: Line | undefined;
  for (let i = start; i < raw.length; i++) {
    const cells = splitRow(raw[i], sep);
    const r = {} as Row; order.forEach((k, j) => { if (k) r[k] = cells[j] ?? ""; });
    const n = `Line ${i + 1}`;
    const date = r.date ? readDate(r.date) : defDate;
    if (!date) { errors.push(`${n}: tareekh samajh nahi aayi "${r.date}"`); continue; }
    if (date > pkToday()) { errors.push(`${n}: aane wali tareekh ${r.date}`); continue; }
    const it = (r.item ?? "").trim().toLowerCase();
    let kind: "fuel" | "shop" = "fuel", product = prev?.product ?? activeProducts[0]?.code ?? "PMG", item_id = "";
    if (it) {
      const code = activeProducts.find((p) => p.code.toLowerCase() === it || p.name.toLowerCase() === it || p.short.toLowerCase() === it)?.code ?? FUEL_ALIAS.find(([re]) => re.test(it))?.[1];
      const shop = code ? null : items.find((x) => x.name.toLowerCase() === it) ?? items.find((x) => x.name.toLowerCase().includes(it));
      if (code && activeProducts.some((p) => p.code === code)) product = code;
      else if (shop) { kind = "shop"; item_id = String(shop.id); }
      else { errors.push(`${n}: "${r.item}" na fuel hai na shop item`); continue; }
    }
    const qty = numOf(r.qty), rate = numOf(r.rate), amount = numOf(r.amount);
    if (!qty && !amount) { errors.push(`${n}: litre / qty ya raqam nahi`); continue; }
    const byAmount = !qty && amount > 0;
    const l: Line = { ...blank(prev), parchi_date: date, slip_no: r.slip ?? "", vehicle_no: (r.gaari ?? "").toUpperCase(), kind, product, item_id,
      qty: qty ? String(qty) : rate ? String(r3(amount / rate)) : "", rate: rate ? String(rate) : "", rateTouched: rate > 0, edited: true, byAmount, amount: byAmount ? String(amount) : "", photos: [] };
    lines.push(l); prev = l;
  }
  return { lines, errors };
}

function ExcelImport({ items, defDate, onClose, onAdd }: { items: any[]; defDate: string; onClose: () => void; onAdd: (l: Line[]) => void }) {
  const [text, setText] = useState("");
  const parsed = useMemo(() => parseSheet(text, items, defDate), [text, items, defDate]);
  const file = useRef<HTMLInputElement>(null);
  const template = `data:text/csv;charset=utf-8,${encodeURIComponent("Date,Slip,Gaari,Fuel/Item,Litre,Rate,Raqam\n24-11-2026,245,LEH-453,Diesel,50,,\n24-11-2026,246,LES-1234,Petrol,,,5000\n")}`;
  const total = parsed.lines.reduce((a, l) => a + (l.byAmount ? Number(l.amount) : (Number(l.qty) || 0) * (Number(l.rate) || 0)), 0);
  return (
    <Modal open onClose={onClose} title="📥 Excel se parchiyan · ایکسل" wide>
      <p className="text-sm text-slate-600">Excel mein columns select kar ke <b>copy</b> karein aur neeche <b>paste</b> karein — ya CSV file chunein. Columns: <b>Date, Slip, Gaari, Fuel/Item, Litre, Rate, Raqam</b> (pehli line mein naam hon to tarteeb koi bhi). Rate khaali = us din ka rate. Litre khaali aur Raqam ho = raqam se litre.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <a className="btn-secondary !py-1.5 text-sm" href={template} download="parchi-template.csv"><Download size={14} /> Template (CSV)</a>
        <input ref={file} type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
        <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={() => file.current?.click()}>📄 CSV file chunein</button>
      </div>
      <textarea className="input mt-2 h-40 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={"Date\tSlip\tGaari\tFuel\tLitre\n24-11-2026\t245\tLEH-453\tDiesel\t50"} aria-label="Excel se paste" />
      {text.trim() && <div className="mt-2 space-y-1 text-sm">
        <div className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900"><b>{parsed.lines.length} parchi</b> theek · takreeban {pkr(total)}{parsed.lines.some((l) => !l.rate) ? " (+ jin ka rate us din ka lagega)" : ""}</div>
        {parsed.errors.length > 0 && <div className="max-h-32 overflow-auto rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">{parsed.errors.length} line chhod di: {parsed.errors.slice(0, 20).map((e) => <div key={e}>{e}</div>)}</div>}
      </div>}
      <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-3">
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary !bg-violet-600" disabled={!parsed.lines.length} onClick={() => onAdd(parsed.lines)}>Form mein daalein ({parsed.lines.length}) →</button>
      </div>
    </Modal>
  );
}


function ParchiBook({ customer, setCustomer }: { customer: string; setCustomer: (v: string) => void }) {
  const customers = useCustomers();
  const [range, setRange] = useState({ from: "", to: "" });
  const blankF = { vehicle: "", slip: "", kind: "", product: "", status: "", q: "", min: "", max: "", by: "", voided: "", tag: "", older: "" };
  const tagsList = useApi<any>("/parchi/meta");
  const aging = useApi<any>(`/parchi/aging${customer ? `?customer_id=${customer}` : ""}`);
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
  const [sel, setSel] = useState<Set<number>>(new Set()); // parchiyan chosen for a payment
  const [payMode, setPayMode] = useState<"new" | "old" | null>(null);
  useEffect(() => { setSel(new Set()); }, [customer]);
  const openRows = (data?.rows ?? []).filter((r: any) => r.status === "unpaid" || r.status === "part");
  const chosen = openRows.filter((r: any) => sel.has(r.id)).sort((a: any, b: any) => a.parchi_date.localeCompare(b.parchi_date) || a.id - b.id);
  const chosenDue = Math.round(chosen.reduce((a: number, r: any) => a + r.unpaid, 0) * 100) / 100;
  const liveRows = (data?.rows ?? []).filter((r: any) => r.status !== "void");
  const picked = liveRows.filter((r: any) => sel.has(r.id));
  const [bulk, setBulk] = useState<"date" | "tag" | "vehicle" | "delete" | null>(null);
  const [hist, setHist] = useState<number | null>(null);
  const [review, setReview] = useState(false);
  const toggle = (id: number) => setSel((x) => { const n = new Set(x); if (n.has(id)) n.delete(id); else n.add(id); return n; });
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
          <Field label="🏷 Tag"><select className="input" value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} aria-label="Tag filter"><option value="">Sab</option>{((tagsList.data?.tags ?? []) as string[]).map((x) => <option key={x} value={x}>{x}</option>)}</select></Field>
          <Field label="⏳ Kitni purani baqi"><select className="input" value={f.older} onChange={(e) => setF({ ...f, older: e.target.value })} aria-label="Purani baqi"><option value="">Sab</option><option value="30">30 din se zyada</option><option value="60">60 din se zyada</option><option value="90">90 din se zyada</option></select></Field>
          <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={!!f.voided} onChange={(e) => setF({ ...f, voided: e.target.checked ? "1" : "" })} /> Deleted bhi dikhayein</label>
        </div>}
        <div className="flex flex-wrap justify-end gap-2">
          {customer && <button type="button" className="btn-secondary" onClick={() => setReview(true)} title="Customer ka rate card badla ho to purani fuel parchiyon par naya rate">♻ Naya rate check</button>}
          <WhatsAppDoc kind="parchi_book" id={Number(customer) || 0} from={range.from || undefined} to={range.to || undefined} filter={filterJson || undefined} />
          <a className="btn-secondary" href={pdf} target="_blank" rel="noreferrer"><Download size={15} /> PDF</a>
          <button className="btn-primary" onClick={() => printNow({ title: "Parchi Book", pdf })}><Printer size={15} /> Print · پرنٹ</button>
        </div>
      </div>
      {!data ? <Loading /> : <>
        {aging.data && aging.data.unpaid > 0.5 && <div className="m-4 mb-0 rounded-xl border border-slate-200 p-3 print:hidden">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><b className="text-sm">⏳ Parchi aging · <Ur>پرانی باقی</Ur></b><span className="text-xs text-slate-500">baqi {pkr(aging.data.unpaid)} · {aging.data.n} parchi — tap karein to wohi dikhengi</span></div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {([["0–30 din", "d0_30", "", "border-slate-200"], ["31–60 din", "d31_60", "30", "border-amber-200 bg-amber-50/50"], ["61–90 din", "d61_90", "60", "border-orange-300 bg-orange-50"], ["90+ din", "d90", "90", "border-rose-300 bg-rose-50 text-rose-800"]] as const).map(([l, k, older, cls]) => (
              <button key={k} type="button" onClick={() => setF({ ...f, older, status: older ? f.status : "open" })} className={`rounded-lg border px-3 py-2 text-left ${cls} ${f.older === older && (older || f.status === "open") ? "ring-2 ring-violet-400" : ""}`}>
                <div className="text-xs opacity-80">{l}</div><div className="font-bold tabular-nums">{pkr(aging.data.buckets[k])}</div></button>))}
          </div>
          {!customer && aging.data.customers.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5 text-xs">{aging.data.customers.slice(0, 8).map((x: any) => (
            <button key={x.id} type="button" onClick={() => setCustomer(String(x.id))} className={`rounded-full border px-2.5 py-1 ${x.oldest_days > 90 ? "border-rose-300 bg-rose-50 font-semibold text-rose-700" : x.oldest_days > 60 ? "border-amber-300 bg-amber-50 text-amber-800" : "border-slate-200 text-slate-600"}`}>
              {x.name} · {pkr(x.unpaid)} · {x.oldest_days} din</button>))}</div>}
        </div>}
        <div className="hidden p-4 print:block"><div className="text-lg font-bold">Parchi Book</div><div className="text-sm">{customer ? customers.find((x) => String(x.id) === customer)?.name : "Sab customers"} · {range.from || "shuru"} — {range.to || "aaj"}</div></div>
        <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-6">
          {[["Parchiyan", `${data.totals.n}${data.totals.vehicles ? ` · ${data.totals.vehicles} gaari` : ""}`], ["Fuel", `${pkr(data.totals.fuel)} · ${num(data.totals.litres, 2)} L`], ["Shop / other", pkr(data.totals.shop + data.totals.other)], ["Kul", pkr(data.totals.amount)], ["Paid", pkr(data.totals.paid)], ["Baqi", pkr(data.totals.unpaid)]].map(([l, v]) => (
            <div key={l} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">{l}</div><div className="font-bold tabular-nums">{v}</div></div>))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead><tr>{["☐", "ID", "Parchi date", "Customer", "Slip", "Gaari", "Hisaab", "Raqam", "Status", "Tag", "By", ""].map((hd, hi) => hi === 0 ? <th key="sel" className="th w-8 print:hidden">{liveRows.length > 0 && <input type="checkbox" aria-label="Sab parchiyan chunein" checked={liveRows.every((r: any) => sel.has(r.id))} onChange={(e) => setSel(e.target.checked ? new Set(liveRows.map((r: any) => r.id)) : new Set())} />}</th> : <th key={hd} className={`th ${hd === "Raqam" ? "text-right" : ""}`}>{hd}</th>)}</tr></thead>
            <tbody>
              {data.rows.map((r: any) => (
                <tr key={r.id} className={sel.has(r.id) ? "bg-emerald-50/60" : ""}>
                  <td className="td print:hidden">{r.status !== "void" && <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`PR-${r.id} chunein`} />}</td>
                  <td className="td"><span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-violet-50 px-1.5 py-0.5 font-mono text-xs font-semibold text-violet-700">🎫 PR-{r.id}</span></td>
                  <td className="td whitespace-nowrap text-xs">{dmy(r.parchi_date)}</td><td className="td">{r.customer}</td><td className="td text-xs">{r.slip_no ?? ""}</td><td className="td text-xs">{r.vehicle_no ?? ""}</td>
                  <td className="td text-xs text-slate-600">{r.kind === "fuel" ? `${num(r.qty, 2)} L ${PRODUCTS[r.product] ?? r.product} × ${r.rate}` : r.kind === "shop" ? `🛒 ${r.item_name} × ${num(r.qty, 2)} @ ${r.rate}` : r.item_name}{r.khata_id ? <> · <IdTag id={`K-${r.khata_id}`} /></> : null}</td>
                  <td className="td whitespace-nowrap text-right font-semibold tabular-nums">{pkr(r.amount)}</td><td className="td">{chip(r.status, r)}{r.paid_by && <div className="mt-0.5 whitespace-nowrap text-[11px] text-emerald-700">🔗 {r.paid_by} se</div>}{r.age != null && <div className={`mt-0.5 whitespace-nowrap text-[11px] ${r.age > 90 ? "font-semibold text-rose-700" : r.age > 60 ? "text-amber-700" : "text-slate-500"}`}>{r.age === 0 ? "aaj ki" : `${r.age} din purani`}</div>}</td>
                  <td className="td text-xs">{r.tag ? <span className="whitespace-nowrap rounded-full bg-sky-50 px-2 py-0.5 text-sky-800">🏷 {r.tag}</span> : ""}</td><td className="td text-xs">{r.created_by ?? ""}</td>
                  <td className="td whitespace-nowrap print:hidden"><button className="mr-1 rounded-md border border-slate-200 px-1.5 py-1 text-xs text-slate-600 hover:bg-slate-50" onClick={() => setHist(r.id)} aria-label={`PR-${r.id} history`} title="History">🕓</button>{r.status !== "void" && <><button className="rounded-md border border-violet-200 px-2 py-1 text-xs font-semibold text-violet-700 hover:bg-violet-50" disabled={busy} onClick={() => setEdit(r)} aria-label={`PR-${r.id} edit`}>✏️ Edit</button>{" "}
                    <button className="rounded-md border border-rose-200 px-2 py-1 text-xs font-semibold text-rose-600 hover:bg-rose-50" disabled={busy} onClick={() => voidIt(r)} aria-label={`PR-${r.id} delete`}>🗑 Delete</button></>}</td>
                </tr>))}
              {!data.rows.length && <tr><td className="td py-8 text-center text-slate-500" colSpan={12}>Koi parchi nahi</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="p-4 text-xs text-slate-500">Payment "Khata payment" se aati hai — sab se purani entry pehle Paid hoti hai, ya parchiyan tick kar ke "💰 Payment lein" se wohi parchiyan Paid. "Edit" se gaari, litre, rate, tareekh theek karein — khata aur balance khud update. "Delete" se parchi ki raqam khate se hat jati hai.</p>
      </>}
      {edit && <EditParchi row={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
      {!customer && data?.rows?.some((r: any) => r.status !== "paid" && r.status !== "void") && <p className="px-4 pb-4 text-xs text-violet-700 print:hidden">💰 Kisi khaas parchi ki payment lagani ho to upar <b>Customer</b> chunein — phir parchiyan tick karein.</p>}
      {sel.size > 0 && <div className="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 rounded-b-xl border-t border-emerald-200 bg-white/95 px-4 py-2.5 shadow-[0_-6px_16px_rgba(15,23,42,.08)] backdrop-blur print:hidden dark:bg-slate-900/95">
        <span className="text-sm"><b>{picked.length}</b> parchi chuni · {pkr(picked.reduce((a: number, r: any) => a + r.amount, 0))}{chosen.length > 0 && <> · baqi <b className="tabular-nums text-emerald-700">{pkr(chosenDue)}</b></>}</span>
        <button type="button" className="text-xs text-slate-500 underline" onClick={() => setSel(new Set())}>Saaf</button>
        <span className="flex flex-wrap gap-1.5 text-sm">
          <button type="button" className="btn-secondary !px-2.5 !py-1.5" onClick={() => setBulk("date")}>📅 Tareekh</button>
          <button type="button" className="btn-secondary !px-2.5 !py-1.5" onClick={() => setBulk("tag")}>🏷 Tag</button>
          <button type="button" className="btn-secondary !px-2.5 !py-1.5" onClick={() => setBulk("vehicle")}>🚛 Gaari</button>
          <button type="button" className="btn-secondary !px-2.5 !py-1.5 !text-rose-600" onClick={() => setBulk("delete")}>🗑 Delete</button>
        </span>
        {customer && chosen.length > 0 && <span className="ml-auto flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => setPayMode("old")}>🔗 Purani payment se jorein</button>
          <button type="button" className="btn-primary !bg-emerald-600" onClick={() => setPayMode("new")}>💰 Payment lein · {pkr(chosenDue)}</button>
        </span>}
      </div>}
      {bulk && <BulkChange mode={bulk} rows={picked} tags={(tagsList.data?.tags ?? []) as string[]} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setSel(new Set()); reload(); aging.reload(); }} />}
      {hist && <ParchiHistory id={hist} onClose={() => setHist(null)} />}
      {review && customer && <RateReview customerId={Number(customer)} name={customers.find((x) => String(x.id) === customer)?.name ?? ""} onClose={() => setReview(false)} onDone={() => { setReview(false); reload(); aging.reload(); }} />}
      {payMode && customer && <PayParchis mode={payMode} customerId={Number(customer)} name={customers.find((x) => String(x.id) === customer)?.name ?? ""} rows={chosen} due={chosenDue}
        onClose={() => setPayMode(null)} onDone={() => { setPayMode(null); setSel(new Set()); reload(); aging.reload(); }} />}
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
    product: row.product ?? activeProducts[0]?.code ?? "PMG", item_id: row.item_id ? String(row.item_id) : "", qty: String(row.qty ?? 1), rate: String(row.rate ?? row.amount), reason: "", tag: row.tag ?? "" });
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
      product: f.kind === "fuel" ? f.product : null, item_id: f.kind === "shop" ? Number(f.item_id) : null, qty: Number(f.qty), rate: Number(f.rate), photo_ids: photos, reason: f.reason || null, tag: f.tag.trim() || null,
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
        <Field label="🏷 Tag"><input className="input" value={f.tag} onChange={(e) => set({ tag: e.target.value })} placeholder="Nov · Site B" /></Field>
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
