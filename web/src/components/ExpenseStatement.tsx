/** Expenses statement (ERP / bank style): pick a range and categories, see every expense grouped by category with a running
 *  total, each category's subtotal and the grand total. Print / PDF, Excel and a WhatsApp summary to the owner. */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Download, Printer, Search, Send, X } from "lucide-react";
import { api, linkToken, useApi } from "../lib/api";
import { Empty, Field, Loading, Stat, useAction } from "./ui";
import { d, newestFirst, pkr } from "../lib/format";
import { PhotoThumb } from "./Capture";
import { Ur } from "./VoiceShell";

const pkDay = (offset = 0) => new Date(Date.now() + 5 * 3600_000 - offset * 86_400_000).toISOString().slice(0, 10);
const monthStart = (m: string) => `${m}-01`;
const monthEnd = (m: string) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const OTHER = "__other__"; // the CEO's "Other entries" expenses, as one group
const catLabel = (c: string) => (c === OTHER ? "Other kharche (CEO)" : c);
const prevMonth = (m: string) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7); };

type Preset = { k: string; label: string; ur: string; range: () => [string, string] };
const PRESETS: Preset[] = [
  { k: "today", label: "Aaj", ur: "آج", range: () => [pkDay(), pkDay()] },
  { k: "yday", label: "Kal", ur: "کل", range: () => [pkDay(1), pkDay(1)] },
  { k: "7", label: "7 din", ur: "۷ دن", range: () => [pkDay(6), pkDay()] },
  { k: "15", label: "15 din", ur: "۱۵ دن", range: () => [pkDay(14), pkDay()] },
  { k: "30", label: "30 din", ur: "۳۰ دن", range: () => [pkDay(29), pkDay()] },
  { k: "month", label: "Is mahina", ur: "اس ماہ", range: () => [monthStart(pkDay().slice(0, 7)), pkDay()] },
  { k: "last", label: "Pichla mahina", ur: "پچھلا ماہ", range: () => { const m = prevMonth(pkDay().slice(0, 7)); return [monthStart(m), monthEnd(m)]; } },
];

export function ExpenseStatement({ categories, stations, onVoucher }: { categories: { id: number; name: string }[]; stations: any[]; onVoucher: (line: any) => void }) {
  const [preset, setPreset] = useState("7");
  const [[from, to], setRange] = useState<[string, string]>(PRESETS[2].range());
  const [cats, setCats] = useState<string[]>([]);
  const [station, setStation] = useState("");
  const [pay, setPay] = useState<"all" | "cash" | "bank">("all");
  const { busy, run } = useAction();
  const params = useMemo(() => {
    const p: Record<string, string> = { from, to, pay };
    if (cats.length) p.categories = cats.join(",");
    if (station) p.station_id = station;
    return p;
  }, [from, to, cats, station, pay]);
  const qs = new URLSearchParams(params).toString();
  const { data, error } = useApi<any>(`/expenses/statement?${qs}`);
  // remembered once known, so the "Other kharche" row does not vanish (and shift the list) while the next filter loads
  const [seeOther, setSeeOther] = useState(false);
  useEffect(() => { if (data?.can_see_other) setSeeOther(true); }, [data?.can_see_other]);
  const pick = (p: Preset) => { setPreset(p.k); setRange(p.range()); };
  const toggleCat = (name: string) => setCats((c) => (c.includes(name) ? c.filter((x) => x !== name) : [...c, name]));
  const rangeText = from === to ? d(from) : `${d(from)} se ${d(to)}`;

  return (
    <div className="space-y-4">
      {/* ---- filters ---- */}
      <div className="card p-0 print:hidden">
        {/* period: one segmented bar (scrolls sideways on a phone) */}
        <div className="flex items-center gap-3 overflow-x-auto border-b border-slate-100 px-4 py-3">
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Muddat</span>
          <div role="group" aria-label="Muddat" className="inline-flex shrink-0 rounded-lg bg-slate-100 p-0.5">
            {[...PRESETS.map((p) => ({ k: p.k, label: p.label, go: () => pick(p) })), { k: "custom", label: "Apni tareekh", go: () => setPreset("custom") }].map((p) => (
              <button key={p.k} type="button" onClick={p.go} aria-pressed={preset === p.k}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition ${preset === p.k ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:text-slate-900"}`}>{p.label}</button>
            ))}
          </div>
        </div>
        {/* the rest of the filters in one row */}
        <div className="grid grid-cols-2 items-end gap-3 px-4 py-3 sm:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
          <Field label="Se · سے"><input className="input" type="date" value={from} max={to} onChange={(e) => { setPreset("custom"); setRange([e.target.value || from, to]); }} /></Field>
          <Field label="Tak · تک"><input className="input" type="date" value={to} min={from} max={pkDay()} onChange={(e) => { setPreset("custom"); setRange([from, e.target.value || to]); }} /></Field>
          {stations.length > 1 && <Field label="Station"><select className="input" value={station} onChange={(e) => setStation(e.target.value)}><option value="">Sab stations</option>{stations.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
          <Field label="Tareeqa · طریقہ"><select className="input" value={pay} onChange={(e) => setPay(e.target.value as any)}><option value="all">Cash + bank</option><option value="cash">Sirf cash</option><option value="bank">Bank / online</option></select></Field>
          <div className="col-span-2 sm:col-span-1"><CategoryPicker categories={categories} withOther={seeOther} value={cats} onChange={setCats} /></div>
        </div>
        {(cats.length > 0 || (station && data?.can_see_other)) && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 px-4 py-2.5">
            {cats.map((c) => (
              <span key={c} className={`inline-flex items-center gap-1 rounded-md py-0.5 pl-2 pr-1 text-xs font-medium ring-1 ${c === OTHER ? "bg-violet-50 text-violet-800 ring-violet-200" : "bg-slate-50 text-slate-700 ring-slate-200"}`}>
                {catLabel(c)}<button type="button" aria-label={`${catLabel(c)} hatayen`} onClick={() => toggleCat(c)} className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"><X size={12} /></button>
              </span>
            ))}
            {cats.length > 0 && <button type="button" className="ml-1 text-xs font-medium text-brand-700 hover:underline" onClick={() => setCats([])}>Sab saaf karein</button>}
            {station && data?.can_see_other && <span className="text-xs text-violet-800">Other kharche (CEO) kisi station ke nahi hote — station chunne par shamil nahi.</span>}
          </div>
        )}
      </div>

      {error ? <p className="text-sm text-rose-700">{String(error)}</p> : !data ? <Loading /> : (
        <>
          {/* ---- print header ---- */}
          <div className="hidden border-b border-slate-300 pb-2 print:block">
            <div className="text-lg font-bold">Kharchon ki statement · {rangeText}</div>
            <div className="text-xs text-slate-600">{cats.length ? `Categories: ${cats.map(catLabel).join(", ")}` : "Sab categories"}{pay !== "all" ? ` · ${pay === "cash" ? "Sirf cash" : "Bank / online"}` : ""}{station ? ` · ${stations.find((s: any) => String(s.id) === station)?.name ?? ""}` : ""}</div>
          </div>

          {/* ---- the two books side by side ---- */}
          {data.can_see_other && data.parts.other.included && (
            <div className="grid grid-cols-3 overflow-hidden rounded-xl ring-1 ring-slate-200">
              <div className="bg-white p-3"><div className="text-xs text-slate-500">Kharche · <Ur>اخراجات</Ur></div><div className="text-lg font-bold tabular-nums">{pkr(data.parts.expenses.total)}</div><div className="text-[11px] text-slate-400">{data.parts.expenses.n} entries</div></div>
              <div className="bg-violet-50 p-3"><div className="text-xs text-violet-700">+ Other kharche (CEO)</div><div className="text-lg font-bold tabular-nums text-violet-900">{pkr(data.parts.other.total)}</div><div className="text-[11px] text-violet-500">{data.parts.other.n} entries</div></div>
              <div className="bg-rose-50 p-3"><div className="text-xs text-rose-700">= Kul kharcha · <Ur>کل</Ur></div><div className="text-lg font-bold tabular-nums text-rose-900">{pkr(data.total)}</div><div className="text-[11px] text-rose-500">{data.n} entries</div></div>
            </div>
          )}

          {/* ---- summary ---- */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={`Kul kharcha · ${data.days} din`} value={pkr(data.total)} tone="red"
              hint={data.previous.change_pct != null ? `Pichle ${data.days} din se ${data.previous.change_pct > 0 ? "+" : ""}${data.previous.change_pct}% (${pkr(data.previous.total)})` : `${data.n} entries`} />
            <Stat label="Roz ka average" value={pkr(data.per_day)} hint={`${data.n} entries`} />
            <Stat label="Cash se" value={pkr(data.cash)} hint={`Bank / online ${pkr(data.bank)}${data.on_account > 0 ? ` · Party khate se ${pkr(data.on_account)}` : ""}`} />
            <Stat label="Manzoori baqi" value={data.pending.n} tone={data.pending.n ? "amber" : "slate"} hint={data.pending.n ? `${pkr(data.pending.amount)} — kul me shamil nahi` : "Kuch pending nahi"} />
          </div>

          <div className="flex flex-wrap gap-2 print:hidden">
            <button className="btn-secondary" onClick={() => window.print()}><Printer size={15} /> Print / PDF</button>
            <a className="btn-secondary" href={`/api/expenses/statement.csv?${qs}&token=${linkToken()}`}><Download size={15} /> Excel / CSV</a>
            <button className="btn-secondary" disabled={busy} onClick={() => run(() => api("/expenses/statement/whatsapp", { body: params }), "Khulasa owner ko WhatsApp par bhej diya")}><Send size={15} /> WhatsApp khulasa</button>
          </div>

          {!data.n ? <Empty>Is waqt mein koi kharcha nahi · <Ur>کوئی خرچہ نہیں</Ur></Empty> : (
            <>
              {/* ---- category summary ---- */}
              <div className="card overflow-x-auto">
                <h2 className="px-4 pt-3 font-semibold">Category ka khulasa · <Ur>کیٹیگری خلاصہ</Ur></h2>
                <table className="mt-2 w-full text-sm">
                  <thead><tr><th className="th">Category</th><th className="th text-right">Entries</th><th className="th text-right">Raqam</th><th className="th hidden w-1/3 sm:table-cell print:table-cell">%</th></tr></thead>
                  <tbody>
                    {data.categories.map((g: any) => (<Fragment key={g.category}>
                      {g.source === "other" && data.parts.expenses.n > 0 && (
                        <tr className="bg-slate-50 text-sm font-semibold"><td className="td">Kharche ka total</td><td className="td text-right tabular-nums">{data.parts.expenses.n}</td><td className="td whitespace-nowrap text-right tabular-nums">{pkr(data.parts.expenses.total)}</td><td className="td hidden sm:table-cell print:table-cell" /></tr>
                      )}
                      <tr>
                        <td className="td"><a className="font-medium text-brand-700 hover:underline print:text-slate-900" href={`#cat-${encodeURIComponent(g.category)}`}>{g.category}</a></td>
                        <td className="td text-right tabular-nums">{g.n}</td>
                        <td className="td whitespace-nowrap text-right font-semibold tabular-nums">{pkr(g.total)}</td>
                        <td className="td hidden sm:table-cell print:table-cell"><div className="flex items-center gap-2"><div className="h-2 flex-1 rounded-full bg-slate-100"><div className={`h-2 rounded-full ${g.source === "other" ? "bg-violet-500" : "bg-rose-500"}`} style={{ width: `${g.pct}%` }} /></div><span className="w-12 text-right text-xs tabular-nums">{g.pct}%</span></div></td>
                      </tr>
                    </Fragment>))}
                  </tbody>
                  <tfoot><tr className="bg-slate-50 font-bold"><td className="td">Kul jama · <Ur>کل</Ur></td><td className="td text-right tabular-nums">{data.n}</td><td className="td whitespace-nowrap text-right tabular-nums">{pkr(data.total)}</td><td className="td hidden sm:table-cell print:table-cell" /></tr></tfoot>
                </table>
              </div>

              {/* ---- statement ---- */}
              <div className="card overflow-hidden">
                <h2 className="px-4 pt-3 font-semibold">Statement · <Ur>تفصیل</Ur> <span className="text-sm font-normal text-slate-500">{rangeText}</span></h2>
                {data.categories.map((g: any) => (
                  <section key={g.category} id={`cat-${encodeURIComponent(g.category)}`} className="mt-3 break-inside-avoid-page">
                    <div className={`sticky top-0 z-10 flex items-center justify-between px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-white print:static ${g.source === "other" ? "bg-violet-800" : "bg-slate-800"}`}>
                      <span>{g.category}</span><span className="text-xs font-normal normal-case">{g.n} entries · {g.pct}%</span>
                    </div>
                    {/* phone: one card per entry */}
                    <ul className="divide-y divide-slate-100 sm:hidden print:hidden">
                      {newestFirst(g.lines).map((l: any) => (
                        <li key={l.id} className="flex items-start justify-between gap-3 px-4 py-2">
                          <div className="min-w-0 text-sm">
                            <div className="font-medium">{l.paid_to || g.category}</div>
                            <div className="text-xs text-slate-500">{d(l.day)} · {l.source === "other" ? <span>{l.voucher}</span> : <button type="button" className="text-brand-700 underline" onClick={() => onVoucher(l)}>{l.voucher}</button>} · {l.method}{l.from_shift ? " · shift" : ""}</div>
                            {l.note && <div className="text-xs text-slate-600">{l.note}</div>}
                          </div>
                          <div className="shrink-0 text-right"><div className="font-semibold tabular-nums">{pkr(l.amount)}</div><div className="text-[11px] text-slate-400 tabular-nums">{pkr(l.running)}</div></div>
                        </li>
                      ))}
                    </ul>
                    <table className="hidden w-full table-fixed text-sm sm:table print:table">
                      <thead><tr><th className="th w-[11%]">Tareekh</th><th className="th w-[12%]">Voucher</th><th className="th w-[22%]">Kis ko diya</th><th className="th w-[11%]">Tareeqa</th><th className="th">Note</th><th className="th w-[13%] text-right">Raqam</th><th className="th w-[13%] text-right">Running</th></tr></thead>
                      <tbody>
                        {newestFirst(g.lines).map((l: any) => (
                          <tr key={l.id}>
                            <td className="td whitespace-nowrap">{d(l.day)}</td>
                            <td className="td whitespace-nowrap">{l.source === "other" ? <span className="font-mono text-xs text-violet-800" title="Other entries (CEO)">{l.voucher}</span> : <button type="button" className="font-mono text-xs text-brand-700 underline print:text-slate-900 print:no-underline" onClick={() => onVoucher(l)}>{l.voucher}</button>}</td>
                            <td className="td">{l.paid_to || "—"}{l.station_name ? <span className="block text-[11px] text-slate-400">{l.station_name}</span> : null}</td>
                            <td className="td whitespace-nowrap capitalize">{l.method}{l.from_shift ? <span className="block text-[11px] text-slate-400">shift se</span> : null}</td>
                            <td className="td text-xs text-slate-600"><span className="flex items-center gap-2">{l.note}{l.receipt_ref ? ` · #${l.receipt_ref}` : ""}{l.photo_id ? <span className="print:hidden"><PhotoThumb id={l.photo_id} size={8} /></span> : null}</span></td>
                            <td className="td text-right tabular-nums">{pkr(l.amount)}</td>
                            <td className="td text-right tabular-nums text-slate-500">{pkr(l.running)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="flex justify-between border-t-2 border-slate-300 bg-slate-50 px-4 py-2 text-sm font-semibold"><span>{g.category} ka total</span><span className="tabular-nums">{pkr(g.total)}</span></div>
                  </section>
                ))}
                {data.parts.other.n > 0 && data.parts.expenses.n > 0 && (
                  <div className="mt-3 space-y-1 px-4 text-sm">
                    <div className="flex justify-between"><span>Kharche ({data.parts.expenses.n})</span><span className="tabular-nums">{pkr(data.parts.expenses.total)}</span></div>
                    <div className="flex justify-between text-violet-800"><span>+ Other kharche (CEO) ({data.parts.other.n})</span><span className="tabular-nums">{pkr(data.parts.other.total)}</span></div>
                  </div>
                )}
                <div className="mt-3 flex justify-between border-y-4 border-double border-slate-700 bg-rose-50 px-4 py-3 text-base font-bold">
                  <span>KUL KHARCHA · <Ur>کل خرچہ</Ur> <span className="text-sm font-normal">({rangeText})</span></span><span className="tabular-nums">{pkr(data.total)}</span>
                </div>
                <div className="hidden px-4 py-6 text-xs print:flex print:justify-between"><span>Banaya: ____________</span><span>Check kiya: ____________</span><span>Manzoor: ____________</span></div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Multi-select for categories: a field-sized button opening a searchable checklist (instead of a wall of chips). */
function CategoryPicker({ categories, withOther, value, onChange }: { categories: { id: number; name: string }[]; withOther: boolean; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [open]);
  const all = useMemo(() => [...(withOther ? [OTHER] : []), ...categories.map((c) => c.name).sort((a, b) => a.localeCompare(b))], [categories, withOther]);
  const shown = all.filter((c) => !q || catLabel(c).toLowerCase().includes(q.toLowerCase()));
  const toggle = (c: string) => onChange(value.includes(c) ? value.filter((x) => x !== c) : [...value, c]);
  const label = !value.length ? "Sab categories" : value.length === 1 ? catLabel(value[0]) : `${value.length} categories chuni`;
  return (
    <div ref={box} className="relative">
      <span className="label">Category · <Ur>کیٹیگری</Ur></span>
      <button type="button" className="input flex w-full items-center justify-between gap-2 text-left" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`truncate ${value.length ? "font-medium text-slate-900" : "text-slate-600"}`}>{label}</span>
        <span className="flex shrink-0 items-center gap-1">{value.length > 0 && <span className="rounded bg-brand-600 px-1.5 text-[11px] font-semibold text-white">{value.length}</span>}<ChevronDown size={16} className={`text-slate-400 transition ${open ? "rotate-180" : ""}`} /></span>
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-full min-w-[260px] overflow-hidden rounded-xl bg-white shadow-xl ring-1 ring-slate-200 sm:w-80">
          <div className="border-b border-slate-100 p-2">
            <div className="relative"><Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
              <input autoFocus className="input min-h-9 !py-1.5 pl-8 text-sm" placeholder="Category dhoondhein…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Category dhoondhein" /></div>
          </div>
          <div className="flex items-center justify-between px-3 py-1.5 text-xs">
            <span className="text-slate-500">{value.length ? `${value.length} / ${all.length} chuni` : `${all.length} categories`}</span>
            <span className="flex gap-3">
              <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => onChange(Array.from(new Set([...value, ...shown])))}>Sab chunein</button>
              <button type="button" className="font-medium text-slate-600 hover:underline" onClick={() => onChange([])}>Saaf</button>
            </span>
          </div>
          <ul role="listbox" aria-multiselectable="true" className="max-h-72 overflow-y-auto border-t border-slate-100 py-1">
            {shown.map((c) => {
              const on = value.includes(c);
              return (
                <li key={c} role="option" aria-selected={on}>
                  <button type="button" onClick={() => toggle(c)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-slate-50">
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white"}`}>{on && <Check size={12} strokeWidth={3} />}</span>
                    <span className="min-w-0 flex-1 truncate">{catLabel(c)}</span>
                    {c === OTHER && <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 ring-1 ring-violet-200">CEO</span>}
                  </button>
                </li>
              );
            })}
            {!shown.length && <li className="px-3 py-4 text-center text-sm text-slate-500">Koi category nahi mili</li>}
          </ul>
          <div className="border-t border-slate-100 p-2 text-right"><button type="button" className="btn-primary min-h-9 !px-4 !py-1.5 text-sm" onClick={() => setOpen(false)}>Theek hai</button></div>
        </div>
      )}
    </div>
  );
}
