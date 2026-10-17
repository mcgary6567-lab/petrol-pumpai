/**
 * "Export · Import" buttons for a master list (khata customers, wholesale clients, suppliers, shop items, thekedars).
 * Export = CSV that opens in Excel. Import = paste from Excel or pick a .csv / .txt file → preview (new / update / skip / error
 * per line) → apply. Re-importing the same sheet never doubles a party (matched by phone / barcode / name).
 */
import { useEffect, useRef, useState } from "react";
import { Download, Upload, FileSpreadsheet, Check, AlertTriangle } from "lucide-react";
import { api, linkToken } from "../lib/api";
import { Modal, Badge, useAction } from "./ui";

export type IoKind = "customers" | "wholesale" | "suppliers" | "shop" | "thekedars";
type Preview = { label: string; mapped: string[]; unknown: string[]; total: number; summary: { new: number; update: number; skip: number; error: number }; rows: { line: number; status: "new" | "update" | "skip" | "error"; message: string; rec: Record<string, any> }[] };

export function ImportExport({ kind, canImport = true, onDone, className = "" }: { kind: IoKind; canImport?: boolean; onDone?: () => void; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      <a className="btn-secondary" href={`/api/io/${kind}.csv?token=${linkToken()}`} title="Excel / CSV download"><Download size={15} /> Export</a>
      {canImport && <button type="button" className="btn-secondary" onClick={() => setOpen(true)} title="Excel se paste karein ya CSV file"><Upload size={15} /> Import</button>}
      {open && <ImportModal kind={kind} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onDone?.(); }} />}
    </div>
  );
}

function ImportModal({ kind, onClose, onDone }: { kind: IoKind; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"add" | "upsert">("add");
  const [cols, setCols] = useState<{ key: string; label: string; required?: boolean }[]>([]);
  const [label, setLabel] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<{ added: number; updated: number; skipped: number; errors: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { api(`/io/${kind}/columns`).then((r: any) => { setCols(r.cols); setLabel(r.label); }).catch(() => {}); }, [kind]);
  // typing / pasting re-runs the preview after a short pause, so the user always sees what WILL happen before pressing Import
  useEffect(() => {
    if (!text.trim()) { setPreview(null); return; }
    const t = setTimeout(() => { api(`/io/${kind}/preview`, { body: { text, mode } }).then(setPreview).catch((e) => setPreview({ label, mapped: [], unknown: [], total: 0, summary: { new: 0, update: 0, skip: 0, error: 1 }, rows: [{ line: 1, status: "error", message: e.message, rec: {} }] })); }, 400);
    return () => clearTimeout(t);
  }, [text, mode, kind, label]);
  const readFile = async (f: File | undefined) => { if (!f) return; setText(await f.text()); };
  const doImport = async () => {
    const r = await run(() => api<any>(`/io/${kind}/import`, { body: { text, mode } }), (r: any) => `${r.added} naye · ${r.updated} update`);
    if (r) { setResult(r); if (!r.errors.length) setTimeout(onDone, 900); }
  };
  const tone = { new: "green", update: "blue", skip: "slate", error: "red" } as const;
  const word = { new: "Naya", update: "Update", skip: "Pehle se", error: "Error" } as const;
  const shown = cols.filter((c) => preview?.mapped.includes(c.label)).slice(0, 6);
  return (
    <Modal open onClose={onClose} title={`Import — ${label || kind}`} wide>
      {result ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-emerald-800"><Check size={20} /> <b>{result.added}</b> naye add · <b>{result.updated}</b> update · {result.skipped} pehle se the</div>
          {result.errors.length > 0 && <div className="rounded-xl bg-red-50 p-3 text-sm text-red-700"><div className="mb-1 font-medium">{result.errors.length} lines skip hui:</div><ul className="list-disc pl-5">{result.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}</ul></div>}
          <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>Band karein</button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <a className="btn-secondary !py-1 text-xs" href={`/api/io/${kind}/template.csv?token=${linkToken()}`}><FileSpreadsheet size={14} /> Template (CSV)</a>
            <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => fileRef.current?.click()}><Upload size={14} /> CSV / text file chunein</button>
            <input ref={fileRef} type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" className="hidden" onChange={(e) => readFile(e.target.files?.[0])} />
            <span className="text-xs text-slate-500">ya Excel me rows select karke copy karein aur neeche paste kar dein (pehli line headings).</span>
          </div>
          <div className="text-xs text-slate-500">Columns: {cols.map((c) => <span key={c.key} className={`mr-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 ${c.required ? "font-semibold text-slate-800" : ""}`}>{c.label}{c.required ? " *" : ""}</span>)}</div>
          <textarea className="input min-h-32 w-full font-mono text-xs" placeholder={"Name\tPhone\tType\tCity\tCredit limit\nAli Traders\t03001234567\tfleet\tLahore\t200000"} value={text} onChange={(e) => setText(e.target.value)}
            onDrop={(e) => { e.preventDefault(); readFile(e.dataTransfer.files?.[0]); }} onDragOver={(e) => e.preventDefault()} />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-slate-600">Jo pehle se mojood hain:</span>
            {(["add", "upsert"] as const).map((m) => <button key={m} type="button" onClick={() => setMode(m)} className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${mode === m ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-slate-600 ring-slate-300"}`}>{m === "add" ? "Chhor do (sirf naye add)" : "Update kar do (naam, limit, city…)"}</button>)}
            <span className="text-[11px] text-slate-400">Opening balance sirf naye par lagta hai; purani party ka hisaab kabhi nahi badalta.</span>
          </div>
          {preview && (
            <div className="rounded-xl border border-slate-200">
              <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm">
                <b>{preview.total} rows</b>
                <Badge tone="green">{preview.summary.new} naye</Badge>
                {preview.summary.update > 0 && <Badge tone="blue">{preview.summary.update} update</Badge>}
                {preview.summary.skip > 0 && <Badge tone="slate">{preview.summary.skip} pehle se</Badge>}
                {preview.summary.error > 0 && <Badge tone="red">{preview.summary.error} error</Badge>}
                {preview.unknown.length > 0 && <span className="flex items-center gap-1 text-xs text-amber-700"><AlertTriangle size={13} /> Ignored columns: {preview.unknown.join(", ")}</span>}
              </div>
              <div className="max-h-72 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-50 text-left text-slate-500"><tr><th className="px-2 py-1">#</th><th className="px-2 py-1">Status</th>{shown.map((c) => <th key={c.key} className="px-2 py-1">{c.label}</th>)}</tr></thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.line} className={`border-t border-slate-100 ${r.status === "error" ? "bg-red-50" : ""}`}>
                        <td className="px-2 py-1 text-slate-400">{r.line}</td>
                        <td className="px-2 py-1"><Badge tone={tone[r.status]}>{word[r.status]}</Badge>{r.message && <div className="text-[11px] text-slate-500">{r.message}</div>}</td>
                        {shown.map((c) => <td key={c.key} className="max-w-[12rem] truncate px-2 py-1">{r.rec[c.key] ?? ""}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={busy || !preview || preview.summary.new + preview.summary.update === 0} onClick={doImport}>
              <Upload size={15} /> Import {preview ? `(${preview.summary.new + preview.summary.update})` : ""}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
