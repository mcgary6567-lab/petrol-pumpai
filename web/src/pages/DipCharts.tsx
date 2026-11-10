import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Camera, Check, ChevronDown, Copy, Download, FileSpreadsheet, Fuel, Pencil, Plus, Printer, Ruler, Search, Trash2, Upload, WandSparkles, X } from "lucide-react";
import { api, linkToken, useApi } from "../lib/api";
import { Badge, Empty, Field, Loading, Modal, PageHeader, useAction, useToast } from "../components/ui";
import { resizeImage } from "../components/Capture";
import { Ur } from "../components/VoiceShell";
import { PRODUCTS, PRODUCT_COLORS, PRODUCT_UR, num } from "../lib/format";

type Row = { depth_mm: number; litres: number };
type Chart = { id: number; name: string; product: string | null; capacity_l: number | null; length_mm: number | null; diameter_mm: number | null; source: string | null; notes: string | null; template_key: string | null; rows: number; min_mm: number; max_mm: number; max_l: number; updated_at: string; updated_by: string | null; tanks: { id: number; name: string; product: string; station: string }[] };

/**
 * Dip charts: one calibration table per tank model, assigned to tanks, edited in a grid.
 * New chart from: built-in template, a photo of the printed sheet (AI), pasted text / CSV, or the cylinder formula.
 */
export default function DipCharts() {
  const list = useApi<{ charts: Chart[]; tanks: any[]; templates: any[]; ai: boolean }>("/dip-charts");
  const { busy, run } = useAction();
  const [params, setParams] = useSearchParams();
  const sel = Number(params.get("chart")) || null;
  const tankParam = Number(params.get("tank")) || null;
  const [creating, setCreating] = useState<false | "pick" | "template" | "photo" | "paste" | "formula">(false);
  const select = (id: number | null) => setParams(id ? { chart: String(id) } : {});
  const charts = list.data?.charts ?? [];
  // opened from a tank's "Dip chart" button: jump to its chart, or offer to make one
  useEffect(() => {
    if (!list.data || !tankParam) return;
    const tk = list.data.tanks.find((t) => t.id === tankParam);
    if (tk?.dip_chart_id) select(tk.dip_chart_id);
    else setCreating("pick");
  }, [list.data, tankParam]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list.data) return <Loading />;
  const current = charts.find((c) => c.id === sel) ?? null;
  const unassigned = list.data.tanks.filter((t) => !t.dip_chart_id && !t.legacy_rows);
  const legacy = list.data.tanks.filter((t) => !t.dip_chart_id && t.legacy_rows);
  // a tank on another fuel's chart (e.g. Diesel tank on the Petrol chart) reads the wrong litres
  const wrong = list.data.tanks.filter((t) => t.dip_chart_id && t.chart_product && t.chart_product !== t.product);
  const tplFor = (p: string) => list.data!.templates.find((x) => x.product === p);
  const fixTank = (tk: any) => { const tp = tplFor(tk.product); if (tp) run(() => api(`/tanks/${tk.id}/dip-chart/template`, { body: { template_key: tp.key } }), `${tk.name}: ${tp.name}`).then((r: any) => { if (r) { list.reload(); select(r.id); } }); };
  return (
    <div className="space-y-4">
      <PageHeader title="Dip charts · ڈپ چارٹ" subtitle="Oil company's calibration table per tank: dip (mm) → litres. One chart can serve every tank of the same size."
        actions={<button className="btn-primary" onClick={() => setCreating("pick")}><Plus size={16} /> New chart</button>} />
      {unassigned.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <b>{unassigned.length} tank{unassigned.length > 1 ? "s" : ""} without a chart:</b> {unassigned.map((t) => `${t.name} (${t.product})`).join(", ")}. Dip in cm/mm cannot be turned into litres for them until a chart is assigned · <Ur>ان ٹینکوں پر چارٹ لگائیں</Ur>
      </div>}
      {wrong.length > 0 && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
        <div className="font-semibold">Ghalat chart · <Ur>غلط چارٹ</Ur> — in tanks par doosre fuel ka dip chart laga hai, litre ghalat banenge:</div>
        <ul className="mt-2 space-y-2">{wrong.map((t) => { const tp = tplFor(t.product); return (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-white/70 p-2">
            <span><b>{t.name}</b> ({PRODUCTS[t.product] ?? t.product} tank) · abhi: {t.chart_name} ({PRODUCTS[t.chart_product] ?? t.chart_product})</span>
            {tp ? <button className="btn-primary min-h-10 text-sm" disabled={busy} onClick={() => fixTank(t)}>{PRODUCTS[t.product] ?? t.product} ka chart lagayein</button> : <span className="text-xs">"New chart" se {PRODUCTS[t.product] ?? t.product} ka chart banayein</span>}
          </li>); })}</ul>
      </div>}
      {legacy.length > 0 && <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
        {legacy.map((t) => t.name).join(", ")}: abhi purani cm wali table par hain — kaam karti hai, lekin yahan chart laga dein to table dekhna, theek karna aur doosre tank par lagana aasaan ho jayega.
      </div>}
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <div className="space-y-2">
          {charts.length === 0 && <div className="card p-4 text-sm text-slate-500">No chart yet. Start from the built-in template, a photo of your printed sheet, or paste the rows.</div>}
          {charts.map((c) => (
            <button key={c.id} onClick={() => select(c.id)} className={`card w-full overflow-hidden p-3 text-left ${c.id === sel ? "ring-2 ring-brand-500" : "hover:bg-slate-50"}`} style={{ borderLeft: `5px solid ${c.product ? PRODUCT_COLORS[c.product] ?? "#64748b" : "#64748b"}` }}>
              <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: c.product ? PRODUCT_COLORS[c.product] ?? "#64748b" : "#64748b" }}>{c.product ? PRODUCTS[c.product] ?? c.product : "Koi bhi fuel"}</div>
              <div className="font-semibold leading-snug">{c.name}</div>
              <div className="mt-1 text-xs text-slate-500 tabular-nums">Poora: <b className="text-slate-700">{num(c.max_l)} L</b> @ {num(c.max_mm)} mm · {num(c.rows)} lines</div>
              <div className="mt-1.5 flex flex-wrap gap-1">{c.tanks.length ? c.tanks.map((t) => <Badge key={t.id} tone={c.product && t.product !== c.product ? "red" : "green"}>{t.name}{c.product && t.product !== c.product ? " ⚠" : ""}</Badge>) : <Badge tone="amber">kisi tank par nahi</Badge>}</div>
            </button>
          ))}
        </div>
        {current ? <Editor key={current.id} id={current.id} tanks={list.data.tanks} onChanged={() => list.reload()} onDeleted={() => { select(null); list.reload(); }} /> : <div className="card p-8 text-center text-sm text-slate-500">Baayen taraf se chart chunein, ya "New chart" se naya banayein · <Ur>چارٹ چنیں</Ur></div>}
      </div>
      {creating && <NewChart mode={creating} setMode={setCreating} templates={list.data.templates} tanks={list.data.tanks} ai={list.data.ai} presetTank={tankParam}
        onClose={() => { setCreating(false); if (tankParam) setParams({}); }} onDone={(c) => { setCreating(false); list.reload(); select(c.id); }} />}
    </div>
  );
}

/* ---------------- editor ---------------- */
function Editor({ id, tanks, onChanged, onDeleted }: { id: number; tanks: any[]; onChanged: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [c, setC] = useState<(Chart & { rows: Row[] }) | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [check, setCheck] = useState<any>(null);
  const [q, setQ] = useState("");
  const [look, setLook] = useState("");
  const [lookR, setLookR] = useState<any>(null);
  const [addRange, setAddRange] = useState<{ from: string; to: string; step: string } | null>(null);
  const [assign, setAssign] = useState(false);
  const [showTable, setShowTable] = useState(false); // 400+ lines: closed until asked for
  const load = () => api(`/dip-charts/${id}`).then((d) => { setC(d); setMeta({ name: d.name, product: d.product ?? "", capacity_l: d.capacity_l ?? "", length_mm: d.length_mm ?? "", diameter_mm: d.diameter_mm ?? "", source: d.source ?? "", notes: d.notes ?? "" }); setRows(d.rows); setDirty(false); setCheck(null); });
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  // live validation while editing (debounced): duplicates, falling litres, gaps, suspicious jumps
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => api("/dip-charts/check", { body: { rows: rows.filter((r) => Number.isFinite(r.depth_mm) && Number.isFinite(r.litres)) } }).then(setCheck).catch(() => null), 400);
    return () => clearTimeout(t);
  }, [rows, dirty]);
  useEffect(() => {
    if (!look || !c) { setLookR(null); return; }
    const t = setTimeout(() => api(`/dip-charts/${id}/lookup?mm=${Number(look)}`).then(setLookR).catch((e) => setLookR({ error: e.message })), 250);
    return () => clearTimeout(t);
  }, [look, id, c]);
  // warn before leaving with unsaved edits
  useEffect(() => { if (!dirty) return; const f = (e: BeforeUnloadEvent) => { e.preventDefault(); }; window.addEventListener("beforeunload", f); return () => window.removeEventListener("beforeunload", f); }, [dirty]);
  if (!c || !meta) return <Loading />;

  const problemAt = new Map<number, string>();
  for (const p of check?.problems ?? []) problemAt.set(p.depth_mm, p.message);
  const jumpAt = new Set<number>((check?.jumps ?? []).map((j: any) => j.depth_mm));
  const edit = (i: number, k: keyof Row, v: string) => { const next = rows.slice(); next[i] = { ...next[i], [k]: v === "" ? NaN : Number(v) }; setRows(next); setDirty(true); };
  const del = (i: number) => { setRows(rows.filter((_, j) => j !== i)); setDirty(true); };
  const addRows = () => {
    if (!addRange) return;
    const from = Number(addRange.from), to = Number(addRange.to), step = Number(addRange.step) || 5;
    if (!(to >= from) || step <= 0) return toast("err", "Check from / to / step");
    const have = new Set(rows.map((r) => r.depth_mm));
    const add: Row[] = [];
    for (let m = from; m <= to + 1e-9; m = Math.round((m + step) * 100) / 100) if (!have.has(m)) add.push({ depth_mm: m, litres: NaN });
    if ((rows.length + add.length) > 5000) return toast("err", "Too many rows");
    setRows([...rows, ...add].sort((a, b) => a.depth_mm - b.depth_mm)); setDirty(true); setAddRange(null);
  };
  const save = async () => {
    const clean = rows.filter((r) => Number.isFinite(r.depth_mm) && Number.isFinite(r.litres));
    if (clean.length !== rows.length && !confirm(`${rows.length - clean.length} row(s) have an empty depth or litres and will be dropped. Save anyway?`)) return;
    const body = { ...meta, product: meta.product || null, capacity_l: meta.capacity_l === "" ? null : Number(meta.capacity_l), length_mm: meta.length_mm === "" ? null : Number(meta.length_mm), diameter_mm: meta.diameter_mm === "" ? null : Number(meta.diameter_mm), source: meta.source || null, notes: meta.notes || null, rows: clean };
    const r = await run(() => api(`/dip-charts/${id}`, { method: "PUT", body }), (x: any) => `Saved: ${num(x.rows.length)} rows, full = ${num(x.max_l)} L`);
    if (r) { setC(r); setRows(r.rows); setDirty(false); setCheck(null); onChanged(); }
  };
  const fill = async () => {
    const s = prompt("Fill the chart every how many mm? (straight line between the rows you have)", "5");
    if (!s) return;
    if (dirty && !confirm("Unsaved edits will be lost. Continue?")) return;
    const r = await run(() => api(`/dip-charts/${id}/fill`, { body: { step_mm: Number(s) } }), (x: any) => `Chart now has ${num(x.rows)} rows`);
    if (r) { load(); onChanged(); }
  };
  const copy = async () => {
    const name = prompt("Name for the copy", `${c.name} (copy)`);
    if (!name) return;
    const r = await run(() => api(`/dip-charts/${id}/copy`, { body: { name } }), "Copied");
    if (r) onChanged();
  };
  const remove = async () => {
    if (!confirm(`Delete "${c.name}" with all ${num(rows.length)} rows? Tanks using it will have no chart.`)) return;
    const r = await run(() => api(`/dip-charts/${id}?force=1`, { method: "DELETE" }), "Chart deleted");
    if (r) onDeleted();
  };
  const filtered = rows.map((r, i) => ({ r, i })).filter(({ r }) => !q || String(r.depth_mm).startsWith(q) || String(r.litres).startsWith(q));
  const third = Math.ceil(filtered.length / 3);
  const cols = [filtered.slice(0, third), filtered.slice(third, 2 * third), filtered.slice(2 * third)];
  const unit = (v: number) => Number.isFinite(v) ? String(v) : "";

  const fuelName = (p?: string | null) => (p ? PRODUCTS[p] ?? p : "Koi bhi fuel");
  const fuelColor = (p?: string | null) => (p ? PRODUCT_COLORS[p] ?? "#64748b" : "#64748b");
  const good = rows.filter((r) => Number.isFinite(r.depth_mm) && Number.isFinite(r.litres));
  const fullL = good.length ? good[good.length - 1].litres : 0, fullMm = good.length ? good[good.length - 1].depth_mm : 0;
  const step = good.length > 2 ? Math.round((good[2].depth_mm - good[1].depth_mm) * 10) / 10 : null;
  const capN = Number(meta.capacity_l) || 0;
  const capOff = capN > 0 && fullL > 0 && Math.abs(capN - fullL) / fullL > 0.03; // capacity typed ≠ what the chart says when full
  const wrongTanks = c.tanks.filter((t) => c.product && t.product !== c.product);
  const setM = (k: string, v: string) => { setMeta({ ...meta, [k]: v }); setDirty(true); };
  // % full against the chart's own full mark, so "% bhara" and "khali jagah" always agree
  const pct = lookR?.litres != null && fullL > 0 ? Math.max(0, Math.min(100, Math.round((lookR.litres / fullL) * 1000) / 10)) : null;

  return (
    <div className="space-y-4 pb-20">
      {/* ---- 1. what this chart is, in one look ---- */}
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 p-4" style={{ borderLeft: `6px solid ${fuelColor(meta.product)}` }}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full px-2.5 py-0.5 text-xs font-bold text-white" style={{ background: fuelColor(meta.product) }}>{fuelName(meta.product)} · {meta.product ? <span className="font-urdu">{PRODUCT_UR[meta.product] ?? ""}</span> : ""}</span>
              {c.template_key && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">Tayyar chart (template)</span>}
            </div>
            <h2 className="mt-1 text-xl font-bold leading-tight">{c.name}</h2>
            <p className="mt-0.5 text-xs text-slate-500">{c.source || "—"}{c.updated_by ? ` · aakhri edit: ${c.updated_by}` : ""}</p>
          </div>
          <div className="flex flex-wrap gap-2 print:hidden">
            <button className="btn-primary min-h-11" onClick={() => setAssign(true)}><Fuel size={16} /> Tank chunein ({c.tanks.length})</button>
            <a className="btn-secondary min-h-11" href={`/api/dip-charts/${id}/export.csv?token=${linkToken()}`} title="Excel / CSV"><Download size={16} /> Excel</a>
            <button className="btn-secondary min-h-11" onClick={() => window.print()} title="Print"><Printer size={16} /> Print</button>
            <button className="btn-secondary min-h-11" onClick={copy} disabled={busy} title="Is chart ki copy banayein"><Copy size={16} /> Copy</button>
            <button className="btn-secondary min-h-11 text-red-600" onClick={remove} disabled={busy} title="Chart delete karein" aria-label="Delete chart"><Trash2 size={16} /></button>
          </div>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-slate-100 sm:grid-cols-4 sm:divide-y-0">
          <div className="p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Kin tankon par · <Ur>ٹینک</Ur></div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">{c.tanks.length ? c.tanks.map((t) => (
              <span key={t.id} className={`rounded-lg px-2 py-1 text-sm font-semibold ${c.product && t.product !== c.product ? "bg-rose-100 text-rose-800 ring-1 ring-rose-300" : "bg-emerald-50 text-emerald-800"}`} title={c.product && t.product !== c.product ? `${t.name} ${fuelName(t.product)} ka tank hai — ye chart ${fuelName(c.product)} ka hai` : undefined}>{t.name}{c.product && t.product !== c.product ? " ⚠" : ""}</span>
            )) : <span className="text-sm font-semibold text-amber-700">Abhi kisi tank par nahi</span>}</div>
          </div>
          <div className="p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Poora bhara · <Ur>مکمل</Ur></div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{num(fullL)} L</div>
            <div className="text-xs text-slate-500">{num(fullMm)} mm dip par</div>
          </div>
          <div className="p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Chart ki lines · <Ur>لائنیں</Ur></div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{num(rows.length)}</div>
            <div className="text-xs text-slate-500">{step ? `har ${step} mm par ek line` : "—"}</div>
          </div>
          <div className="p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tank size · <Ur>سائز</Ur></div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{capN ? `${num(capN)} L` : "—"}</div>
            <div className="text-xs text-slate-500">{[meta.length_mm && `lambai ${num(Number(meta.length_mm))} mm`, meta.diameter_mm && `golai ${num(Number(meta.diameter_mm))} mm`].filter(Boolean).join(" · ") || "lambai / golai nahi likhi"}</div>
          </div>
        </div>
        {(wrongTanks.length > 0 || capOff) && <div className="space-y-1 border-t border-rose-100 bg-rose-50 px-4 py-2.5 text-sm text-rose-900 print:hidden">
          {wrongTanks.length > 0 && <div>⚠ <b>{wrongTanks.map((t) => t.name).join(", ")}</b> {fuelName(wrongTanks[0].product)} ka tank hai, lekin ye chart <b>{fuelName(c.product)}</b> ka hai. "Tank chunein" se hata kar sahi chart lagayein.</div>}
          {capOff && <div>⚠ Tank size <b>{num(capN)} L</b> likha hai, lekin chart poora bhar kar <b>{num(fullL)} L</b> deta hai. Agar aap ka tank {num(capN)} L ka hai to ye chart us tank ka nahi — sahi sheet lagayein. <button type="button" className="font-semibold underline" onClick={() => setM("capacity_l", String(Math.round(fullL)))}>Size {num(Math.round(fullL))} L kar dein</button></div>}
        </div>}
      </div>

      {/* ---- 2. the everyday use: dip → litres ---- */}
      <div className="card p-4 print:hidden">
        <div className="mb-2 flex items-center gap-2 font-semibold"><Ruler size={18} className="text-brand-600" /> Dip se litre nikalein · <Ur>ڈپ لکھیں، لیٹر دیکھیں</Ur></div>
        <div className="grid items-center gap-4 sm:grid-cols-[auto_1fr]">
          <label className="relative block">
            <input className="input h-16 w-full py-3 pr-14 text-3xl font-bold tabular-nums sm:w-56" type="number" inputMode="decimal" placeholder="0" value={look} onChange={(e) => setLook(e.target.value)} aria-label="Dip in mm" />
            <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-lg font-semibold text-slate-400">mm</span>
          </label>
          <div className="min-w-0">
            {!look && <p className="text-sm text-slate-500">Dip ki lakdi par jo mm aaye wo likhein — litre foran aa jayenge. (cm ho to ×10 karein: 45 cm = 450 mm)</p>}
            {lookR?.error && <p className="text-sm font-medium text-red-600">{lookR.error}</p>}
            {lookR?.litres != null && <>
              <div className="flex flex-wrap items-baseline gap-x-3"><span className="text-4xl font-bold tabular-nums text-slate-900">{num(lookR.litres)} L</span>{pct != null && <span className="text-lg font-semibold text-slate-500">{pct}% bhara</span>}</div>
              {pct != null && <div className="mt-2 h-4 overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200"><div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: fuelColor(meta.product) }} /></div>}
              <div className="mt-1 text-xs text-slate-500">{lookR.step_mm} mm kam = {lookR.down != null ? `${num(lookR.down)} L` : "—"} · {lookR.step_mm} mm zyada = {lookR.up != null ? `${num(lookR.up)} L` : "—"}{fullL ? ` · khali jagah ${num(Math.max(0, fullL - lookR.litres))} L` : ""}</div>
            </>}
          </div>
        </div>
      </div>

      {/* ---- 3. details: only when they need changing ---- */}
      <details className="card group print:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-4 font-semibold">
          <span className="flex items-center gap-2"><Pencil size={16} className="text-slate-500" /> Chart ki tafseel badlein · <Ur>تفصیل</Ur> <span className="text-sm font-normal text-slate-500">naam, fuel, size, sheet</span></span>
          <ChevronDown size={18} className="text-slate-400 transition-transform group-open:rotate-180" />
        </summary>
        <div className="grid gap-3 border-t border-slate-100 p-4 md:grid-cols-3">
          <div className="md:col-span-2"><Field label="Chart ka naam"><input className="input" value={meta.name} onChange={(e) => setM("name", e.target.value)} /></Field></div>
          <Field label="Kis fuel ka"><select className="input" value={meta.product} onChange={(e) => setM("product", e.target.value)}><option value="">Koi bhi</option>{Object.entries(PRODUCTS).map(([k, v]) => <option key={k} value={k}>{v} ({k})</option>)}</select></Field>
          <Field label="Tank size (litre)"><input className="input" type="number" inputMode="decimal" value={meta.capacity_l} onChange={(e) => setM("capacity_l", e.target.value)} /></Field>
          <Field label="Andar ki lambai (mm)"><input className="input" type="number" inputMode="decimal" value={meta.length_mm} onChange={(e) => setM("length_mm", e.target.value)} /></Field>
          <Field label="Andar ki golai / diameter (mm)"><input className="input" type="number" inputMode="decimal" value={meta.diameter_mm} onChange={(e) => setM("diameter_mm", e.target.value)} /></Field>
          <div className="md:col-span-3"><Field label="Sheet kahan se (company, tareekh)"><input className="input" value={meta.source} onChange={(e) => setM("source", e.target.value)} /></Field></div>
          <div className="md:col-span-3"><Field label="Note"><textarea className="input min-h-[64px]" value={meta.notes} onChange={(e) => setM("notes", e.target.value)} /></Field></div>
        </div>
      </details>

      {/* grid */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <h3 className="mr-auto font-semibold">Poori table · <Ur>ٹیبل</Ur> <span className="text-sm font-normal text-slate-500">({num(rows.length)} lines) · dip mm → litre — sheet se mila kar check karein</span></h3>
          <input className="input w-32" placeholder="mm dhoondein…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn-secondary" onClick={() => setAddRange({ from: String((rows[rows.length - 1]?.depth_mm ?? 0) + (check?.step_mm ?? 5)), to: "", step: String(check?.step_mm ?? 5) })}><Plus size={15} /> Add rows</button>
          <button className="btn-secondary" onClick={fill} disabled={busy}><WandSparkles size={15} /> Fill steps</button>
          {dirty && <button className="btn-secondary" onClick={load}>Discard</button>}
          <button className="btn-primary" onClick={save} disabled={busy || !dirty}><Check size={15} /> Save{dirty ? " changes" : "d"}</button>
        </div>
        {addRange && <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3 text-sm">
          <Field label="From (mm)"><input className="input w-28" type="number" inputMode="decimal" value={addRange.from} onChange={(e) => setAddRange({ ...addRange, from: e.target.value })} /></Field>
          <Field label="To (mm)"><input className="input w-28" type="number" inputMode="decimal" value={addRange.to} onChange={(e) => setAddRange({ ...addRange, to: e.target.value })} /></Field>
          <Field label="Step (mm)"><input className="input w-24" type="number" inputMode="decimal" value={addRange.step} onChange={(e) => setAddRange({ ...addRange, step: e.target.value })} /></Field>
          <button className="btn-primary" onClick={addRows}>Add empty rows</button><button className="btn-secondary" onClick={() => setAddRange(null)}>Cancel</button>
        </div>}
        {check && (check.problems.length > 0 || check.gaps.length > 0 || check.jumps.length > 0) && <div className="mt-3 space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 print:hidden">
          {check.problems.slice(0, 5).map((p: any) => <div key={`p${p.depth_mm}`}>⛔ {p.message}</div>)}
          {check.problems.length > 5 && <div>… {check.problems.length - 5} more problems</div>}
          {check.gaps.length > 0 && <div>⚠ Missing steps ({check.step_mm} mm): {check.gaps.slice(0, 12).join(", ")}{check.gaps.length > 12 ? " …" : ""}</div>}
          {check.jumps.slice(0, 5).map((j: any) => <div key={`j${j.depth_mm}`}>⚠ {j.depth_mm} mm: jump of {num(j.delta)} L where nearby steps are about {num(j.typical)} L — check the digits</div>)}
        </div>}
        {rows.length > 0 && !showTable && !q && <button type="button" className="mt-3 w-full rounded-xl border-2 border-dashed border-slate-300 py-4 text-sm font-semibold text-slate-600 hover:border-brand-400 hover:text-brand-700 print:hidden" onClick={() => setShowTable(true)}><ChevronDown size={16} className="mr-1 inline" /> Poori table kholein ({num(rows.length)} lines) — dekhne ya number theek karne ke liye</button>}
        {rows.length === 0 ? <Empty>Koi line nahi — "Add rows" se daalein.</Empty> : (
          <div className={`mt-3 gap-x-6 md:grid-cols-3 ${showTable || q ? "grid" : "hidden print:grid"}`}>
            {cols.map((col, ci) => (
              <table key={ci} className="w-full text-sm">
                <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1">mm</th><th className="py-1">Litres</th><th className="w-8 print:hidden" /></tr></thead>
                <tbody>
                  {col.map(({ r, i }) => {
                    const bad = problemAt.get(r.depth_mm), warn = jumpAt.has(r.depth_mm);
                    return (
                      <tr key={i} className={bad ? "bg-red-50" : warn ? "bg-amber-50" : ""} title={bad}>
                        <td className="py-0.5 pr-1"><input className="input px-2 py-1 tabular-nums print:border-0 print:p-0" type="number" inputMode="decimal" step="0.5" value={unit(r.depth_mm)} onChange={(e) => edit(i, "depth_mm", e.target.value)} /></td>
                        <td className="py-0.5 pr-1"><input className={`input px-2 py-1 tabular-nums print:border-0 print:p-0 ${!Number.isFinite(r.litres) ? "border-amber-400" : ""}`} type="number" inputMode="decimal" value={unit(r.litres)} onChange={(e) => edit(i, "litres", e.target.value)} /></td>
                        <td className="print:hidden"><button className="p-1 text-slate-300 hover:text-red-600" onClick={() => del(i)} aria-label="Remove row"><X size={14} /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ))}
          </div>
        )}
        <Curve rows={rows.filter((r) => Number.isFinite(r.depth_mm) && Number.isFinite(r.litres))} capacity={Number(meta.capacity_l) || null} />
      </div>
      {dirty && <div className="fixed inset-x-0 bottom-0 z-30 border-t border-amber-200 bg-amber-50/95 px-4 py-3 shadow-lg backdrop-blur print:hidden">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-semibold text-amber-900">Tabdeeli save nahi hui · <Ur>محفوظ نہیں ہوا</Ur></span>
          <div className="flex gap-2"><button className="btn-secondary min-h-11" onClick={load} disabled={busy}>Wapas lo</button><button className="btn-primary min-h-11" onClick={save} disabled={busy}><Check size={16} /> Save karein</button></div>
        </div>
      </div>}
      {assign && <AssignModal chart={c} tanks={tanks} onClose={() => setAssign(false)} onDone={() => { setAssign(false); load(); onChanged(); }} />}
    </div>
  );
}

/** Depth → litres curve: a smooth S means a clean chart; a kink shows a misread row. */
function Curve({ rows, capacity }: { rows: Row[]; capacity: number | null }) {
  if (rows.length < 3) return null;
  const W = 600, H = 160, maxM = rows[rows.length - 1].depth_mm, maxL = Math.max(rows[rows.length - 1].litres, capacity ?? 0) || 1;
  const pts = rows.map((r) => `${((r.depth_mm / maxM) * (W - 10) + 5).toFixed(1)},${(H - 5 - (r.litres / maxL) * (H - 10)).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-4 h-40 w-full rounded-lg bg-slate-50 text-brand-600" preserveAspectRatio="none" aria-label="Depth to litres curve">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={2} />
      {capacity && <line x1={0} x2={W} y1={H - 5 - (capacity / maxL) * (H - 10)} y2={H - 5 - (capacity / maxL) * (H - 10)} stroke="#f59e0b" strokeDasharray="4 4" />}
    </svg>
  );
}

function AssignModal({ chart, tanks, onClose, onDone }: { chart: Chart; tanks: any[]; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [ids, setIds] = useState<number[]>(chart.tanks.map((t) => t.id));
  const save = () => run(() => api(`/dip-charts/${chart.id}/tanks`, { method: "PUT", body: { tank_ids: ids } }), "Tanks updated").then((r) => r && onDone());
  return (
    <Modal open onClose={onClose} title={`Ye chart kin tankon par lagega? · ${chart.name}`}>
      <div className="space-y-2">
        {tanks.map((t) => {
          const other = t.dip_chart_id && t.dip_chart_id !== chart.id;
          return (
            <label key={t.id} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3">
              <input type="checkbox" className="h-5 w-5" checked={ids.includes(t.id)} onChange={(e) => setIds(e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id))} />
              <span className="flex-1"><b>{t.name}</b> · {t.product} · {num(t.capacity_l)} L <span className="text-xs text-slate-500">{t.station}</span>{other && <span className="ml-2 text-xs text-amber-700">(now on another chart — will move)</span>}</span>
              {chart.product && t.product !== chart.product && <Badge tone="amber">{t.product} ≠ {chart.product}</Badge>}
            </label>
          );
        })}
        {tanks.length === 0 && <Empty>No tanks yet — add tanks in Settings.</Empty>}
        <div className="flex justify-end gap-2 pt-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={save} disabled={busy}>Save</button></div>
      </div>
    </Modal>
  );
}

/* ---------------- new chart ---------------- */
function NewChart({ mode, setMode, templates, tanks, ai, presetTank, onClose, onDone }: { mode: "pick" | "template" | "photo" | "paste" | "formula"; setMode: (m: any) => void; templates: any[]; tanks: any[]; ai: boolean; presetTank: number | null; onClose: () => void; onDone: (c: Chart) => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [product, setProduct] = useState("");
  const [cap, setCap] = useState("");
  const [len, setLen] = useState(""); const [dia, setDia] = useState("");
  const [source, setSource] = useState("");
  const [tpl, setTpl] = useState<string>(templates[0]?.key ?? "");
  const [text, setText] = useState(""); const [unit, setUnit] = useState<"mm" | "cm">("mm");
  const [read, setRead] = useState<any>(null); const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [assignIds, setAssignIds] = useState<number[]>(presetTank ? [presetTank] : []);
  const tplObj = templates.find((t) => t.key === tpl);
  useEffect(() => { if (mode === "template" && tplObj && !name) { setName(tplObj.name); setProduct(tplObj.product ?? ""); setCap(String(tplObj.capacity_l ?? "")); setLen(String(tplObj.length_mm ?? "")); setDia(String(tplObj.diameter_mm ?? "")); setSource(tplObj.source ?? ""); } }, [mode, tplObj]); // eslint-disable-line react-hooks/exhaustive-deps
  // pasted text → checked rows preview
  useEffect(() => {
    if (mode !== "paste" || !text.trim()) { setPreview(null); return; }
    const t = setTimeout(() => api("/dip-charts/check", { body: { rows: [], text, unit } }).then(setPreview).catch(() => null), 400);
    return () => clearTimeout(t);
  }, [text, unit, mode]);
  const onPhoto = async (f?: File) => {
    if (!f) return;
    setReading(true); setRead(null);
    try {
      const image = await resizeImage(f, 2400, true);
      const r = await api("/dip-charts/read-photo", { body: { image } });
      setRead(r);
      if (r.header?.title && !name) setName(r.header.title);
      if (r.header?.length_mm) setLen(String(r.header.length_mm));
      if (r.header?.diameter_mm) setDia(String(r.header.diameter_mm));
      if (r.header?.capacity_hsd_l && !cap) setCap(String(r.header.capacity_hsd_l));
      setText(r.rows.map((x: Row) => `${x.depth_mm} ${x.litres}`).join("\n")); setUnit("mm");
      toast("ok", `Read ${r.rows.length} rows (${r.confidence} confidence)${r.problems.length ? ` — ${r.problems.length} to check` : ""}`);
      setMode("paste");
    } catch (e: any) { toast("err", e.message); } finally { setReading(false); }
  };
  const meta = { name: name.trim(), product: product || null, capacity_l: cap === "" ? null : Number(cap), length_mm: len === "" ? null : Number(len), diameter_mm: dia === "" ? null : Number(dia), source: source || null, assign_tank_ids: assignIds };
  const create = (extra: any) => run(() => api("/dip-charts", { body: { ...meta, ...extra } }), (c: any) => `Chart "${c.name}" saved with ${num(c.rows)} rows`).then((c) => c && onDone(c));
  const MetaFields = (
    <div className="grid gap-3 md:grid-cols-3">
      <div className="md:col-span-2"><Field label="Chart name"><input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. HSD U/G tank 14,370 L" /></Field></div>
      <Field label="Product"><select className="input" value={product} onChange={(e) => setProduct(e.target.value)}><option value="">Any</option>{Object.entries(PRODUCTS).map(([k, v]) => <option key={k} value={k}>{k} — {v}</option>)}</select></Field>
      <Field label="Capacity (L)"><input className="input" type="number" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
      <Field label="Internal length (mm)"><input className="input" type="number" inputMode="decimal" value={len} onChange={(e) => setLen(e.target.value)} /></Field>
      <Field label="Internal diameter (mm)"><input className="input" type="number" inputMode="decimal" value={dia} onChange={(e) => setDia(e.target.value)} /></Field>
      <div className="md:col-span-3"><Field label="Source (which oil company sheet, date)"><input className="input" value={source} onChange={(e) => setSource(e.target.value)} /></Field></div>
      {tanks.length > 0 && <div className="md:col-span-3"><Field label="Use for these tanks (can change later)">
        <div className="flex flex-wrap gap-2">{tanks.map((t) => <label key={t.id} className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm ${assignIds.includes(t.id) ? "border-brand-500 bg-brand-50" : "border-slate-300"}`}><input type="checkbox" className="h-4 w-4" checked={assignIds.includes(t.id)} onChange={(e) => setAssignIds(e.target.checked ? [...assignIds, t.id] : assignIds.filter((x) => x !== t.id))} />{t.name} · {t.product}</label>)}</div>
      </Field></div>}
    </div>
  );
  return (
    <Modal open onClose={onClose} title="New dip chart · نیا ڈپ چارٹ" wide>
      {mode === "pick" && (
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ["template", <FileSpreadsheet size={22} />, "Built-in template", `Standard OMC charts (${templates.length}) — pick, check, done · تیار چارٹ`],
            ["photo", <Camera size={22} />, "Photo of the printed sheet", ai ? "AI reads every row; you check and save · شیٹ کی تصویر" : "Needs the AI key (Settings → Integrations)"],
            ["paste", <Upload size={22} />, "Paste / type / CSV", "From Excel, WhatsApp or the keyboard: mm litres per line · پیسٹ کریں"],
            ["formula", <Ruler size={22} />, "Approximate (no sheet yet)", "Horizontal round tank from diameter and capacity · اندازے سے"],
          ].map(([k, icon, title, sub]: any) => (
            <button key={k} disabled={k === "photo" && !ai} className="card flex items-start gap-3 p-4 text-left hover:bg-slate-50 disabled:opacity-50" onClick={() => setMode(k)}>
              <span className="text-brand-600">{icon}</span><span><b>{title}</b><br /><span className="text-sm text-slate-500">{sub}</span></span>
            </button>
          ))}
        </div>
      )}
      {mode === "template" && (
        <div className="space-y-4">
          <Field label="Template"><select className="input" value={tpl} onChange={(e) => { setTpl(e.target.value); setName(""); }}>{templates.map((t) => <option key={t.key} value={t.key}>{t.name} — {num(t.rows)} rows</option>)}</select></Field>
          {tplObj && <p className="text-sm text-slate-600">{tplObj.source}. Every row up to {num(tplObj.max_mm)} mm. After saving you can edit any value.</p>}
          {MetaFields}
          <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setMode("pick")}>Back</button><button className="btn-primary" disabled={busy || !name.trim()} onClick={() => create({ template_key: tpl })}>Create from template</button></div>
        </div>
      )}
      {mode === "photo" && (
        <div className="space-y-4 text-sm">
          <p>Photograph or scan the oil company's calibration sheet — flat, bright, all columns in the frame. The AI reads every row into a list you check before saving. <Ur>شیٹ کی صاف تصویر لیں</Ur></p>
          <input ref={file} type="file" accept="image/*" className="hidden" onChange={(e) => onPhoto(e.target.files?.[0])} />
          <button className="btn-primary" disabled={reading} onClick={() => file.current?.click()}><Camera size={16} /> {reading ? "Reading the sheet…" : "Choose photo"}</button>
          <div className="flex justify-end"><button className="btn-secondary" onClick={() => setMode("pick")}>Back</button></div>
        </div>
      )}
      {mode === "paste" && (
        <div className="space-y-4">
          {read && <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
            Read from photo: <b>{read.rows.length} rows</b>, confidence {read.confidence}.{read.unclear_mm?.length ? <> Unclear at: {read.unclear_mm.join(", ")} mm.</> : null}{read.problems.length ? <> {read.problems.length} rows need a look (shown below).</> : null} Compare with the sheet, fix below, then save.
          </div>}
          <div className="grid gap-4 md:grid-cols-[1fr_260px]">
            <Field label={`One row per line: depth litres (several pairs per line are fine) · unit ${unit}`}>
              <textarea className="input h-72 font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder={"5 4\n10 9\n15 14\n…"} />
            </Field>
            <div className="space-y-3 text-sm">
              <Field label="Depth unit on the sheet"><div className="flex gap-2">{(["mm", "cm"] as const).map((u) => <button key={u} className={u === unit ? "btn-primary" : "btn-secondary"} onClick={() => setUnit(u)}>{u}</button>)}</div></Field>
              {preview && <div className="rounded-lg bg-slate-50 p-3">
                <div><b>{num(preview.count)}</b> rows{preview.step_mm ? `, every ${preview.step_mm} mm` : ""}</div>
                {preview.max_mm != null && <div>up to {num(preview.max_mm)} mm = <b>{num(preview.max_l)} L</b></div>}
                {preview.problems.length > 0 && <div className="mt-1 text-red-700">⛔ {preview.problems.length} problem(s): {preview.problems[0].message}</div>}
                {preview.gaps.length > 0 && <div className="mt-1 text-amber-700">⚠ missing: {preview.gaps.slice(0, 8).join(", ")}{preview.gaps.length > 8 ? " …" : ""}</div>}
                {preview.jumps.length > 0 && <div className="mt-1 text-amber-700">⚠ odd jump at {preview.jumps.slice(0, 6).map((j: any) => j.depth_mm).join(", ")} mm</div>}
              </div>}
            </div>
          </div>
          {MetaFields}
          <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setMode("pick")}>Back</button><button className="btn-primary" disabled={busy || !name.trim() || !text.trim() || (preview && preview.problems.length > 0)} onClick={() => create({ text, unit, photo_id: read?.photo_id })}>Save chart</button></div>
          {preview?.problems?.length > 0 && <p className="text-right text-xs text-red-700">Fix the problems first (a depth twice, or litres going down).</p>}
        </div>
      )}
      {mode === "formula" && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">Approximate chart for a horizontal round tank, every 10 mm, from the inside diameter and capacity. Replace it with the oil company's sheet when you have it — the real tank has dished ends and is never exactly a cylinder.</p>
          {MetaFields}
          <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setMode("pick")}>Back</button><button className="btn-primary" disabled={busy || !name.trim() || !dia || !cap} onClick={() => create({ diameter_mm: Number(dia), capacity_l: Number(cap), source: source || null })}>Make chart</button></div>
        </div>
      )}
    </Modal>
  );
}
