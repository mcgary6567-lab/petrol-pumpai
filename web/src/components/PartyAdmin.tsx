import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Trash2, Merge } from "lucide-react";
import { api, useApi } from "../lib/api";
import { ErrorBox, Modal, useAction } from "./ui";
import { useAuth } from "../App";

export type PartyKind = "customer" | "client" | "supplier" | "thekedar";
const LABEL: Record<PartyKind, string> = { customer: "customer", client: "client", supplier: "supplier", thekedar: "thekedar" };

/**
 * CEO-only buttons on a party's page: Delete (only when the party has no entries) and Merge duplicate (every entry and
 * the balance move to the party kept, this one goes). Shows what the party is used in so the owner knows why delete is refused.
 */
export function PartyAdmin({ kind, id, name, backTo, onDone, className = "" }: { kind: PartyKind; id: number; name: string; backTo: string; onDone?: () => void; className?: string }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<null | "delete" | "merge">(null);
  if (!can("corrections.manage")) return null;
  const finish = () => { setMode(null); onDone?.(); nav(backTo); };
  return (
    <>
      <button type="button" className={`btn-secondary !text-rose-700 ${className}`} title="Ghalti se bana party delete (sirf jab koi entry na ho)" onClick={() => setMode("delete")}><Trash2 size={15} /> Delete</button>
      <button type="button" className={`btn-secondary ${className}`} title="Duplicate hai? Is ki saari entries asal wale me mila dein" onClick={() => setMode("merge")}><Merge size={15} /> Merge duplicate</button>
      {mode === "delete" && <DeleteModal kind={kind} id={id} name={name} onClose={() => setMode(null)} onMerge={() => setMode("merge")} onDone={finish} />}
      {mode === "merge" && <MergeModal kind={kind} id={id} name={name} onClose={() => setMode(null)} onDone={finish} />}
    </>
  );
}

function Usage({ u }: { u: any }) {
  if (!u) return <div className="text-sm text-slate-500">Dekh rahe hain…</div>;
  return (
    <div className="rounded-xl bg-slate-50 p-3 text-sm">
      {u.total === 0 && !u.opening_balance ? <div className="text-emerald-700">Is par koi entry nahi — sirf naam/phone hai.</div> : (
        <>
          <div className="font-medium">{u.name} in me istemal hua hai:</div>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {u.entries.map((e: any) => <li key={e.table} className="rounded-full bg-white px-2 py-0.5 text-xs ring-1 ring-slate-200">{e.n} {e.label}</li>)}
            {u.opening_balance ? <li className="rounded-full bg-white px-2 py-0.5 text-xs ring-1 ring-slate-200">opening balance Rs {Math.round(u.opening_balance).toLocaleString("en-IN")}</li> : null}
          </ul>
        </>
      )}
      {u.setup?.length > 0 && <div className="mt-1 text-xs text-slate-500">Saath jayega: {u.setup.map((e: any) => `${e.n} ${e.label}`).join(", ")}</div>}
    </div>
  );
}

function DeleteModal({ kind, id, name, onClose, onMerge, onDone }: { kind: PartyKind; id: number; name: string; onClose: () => void; onMerge: () => void; onDone: () => void }) {
  const { data: u, error } = useApi<any>(`/parties/${kind}/${id}/usage`);
  const { busy, run } = useAction();
  const [typed, setTyped] = useState("");
  const okName = typed.trim().toLowerCase() === name.trim().toLowerCase();
  return (
    <Modal open onClose={onClose} title={`Delete ${LABEL[kind]} — ${name}`}>
      <div className="space-y-3 text-sm">
        {error && <ErrorBox error={error} />}
        <Usage u={u} />
        {u && !u.deletable && (
          <div className="rounded-xl bg-amber-50 p-3 text-amber-900">
            Entries wala {LABEL[kind]} delete nahi hota (hisaab toot jata). Agar ye <b>duplicate</b> hai to asal wale me <b>merge</b> karein — saari entries aur balance wahan chale jayenge. Warna <b>archive / deactivate</b> karein, history rehti hai.
            <div className="mt-2"><button className="btn-primary min-h-9" onClick={onMerge}><Merge size={14} /> Merge duplicate</button></div>
          </div>
        )}
        {u?.deletable && (
          <>
            <div className="rounded-xl bg-rose-50 p-3 text-rose-900">Ye wapas nahi hota. Confirm ke liye naam likhein: <b>{name}</b></div>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={name} aria-label="Confirm name" />
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary !bg-rose-600 hover:!bg-rose-700" disabled={busy || !okName} onClick={async () => { if (await run(() => api(`/parties/${kind}/${id}`, { method: "DELETE" }), `${name} delete ho gaya`)) onDone(); }}><Trash2 size={15} /> Delete karein</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function MergeModal({ kind, id, name, onClose, onDone }: { kind: PartyKind; id: number; name: string; onClose: () => void; onDone: () => void }) {
  const { data: u } = useApi<any>(`/parties/${kind}/${id}/usage`);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const { busy, run } = useAction();
  useEffect(() => { let live = true; api<any[]>(`/parties/${kind}/search?q=${encodeURIComponent(q)}&not=${id}`).then((r) => { if (live) setRows(r); }).catch(() => {}); return () => { live = false; }; }, [kind, id, q]);
  return (
    <Modal open onClose={onClose} title={`Merge duplicate — ${name}`}>
      <div className="space-y-3 text-sm">
        <div className="rounded-xl bg-blue-50 p-3 text-blue-900"><b>{name}</b> ki saari entries (sales, khata, payments, cheques, trips…) aur balance us {LABEL[kind]} me chale jayenge jo aap neeche chunein ge. Phir <b>{name}</b> khatam ho jayega. Hisaab me koi raqam nahi badalti, sirf naam ek ho jata hai.</div>
        <Usage u={u} />
        <div>
          <div className="mb-1 font-medium">Kis me milana hai? · <span lang="ur" className="font-urdu">اصل والا چنیں</span></div>
          <input className="input" value={q} onChange={(e) => { setQ(e.target.value); setPick(null); }} placeholder="Naam ya phone likhein…" aria-label="Search party" />
          <ul className="mt-2 max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-xl ring-1 ring-slate-200">
            {rows.length === 0 && <li className="p-3 text-xs text-slate-500">Koi nahi mila</li>}
            {rows.map((r) => (
              <li key={r.id}><button type="button" className={`flex w-full items-center justify-between px-3 py-2 text-left hover:bg-slate-50 ${pick?.id === r.id ? "bg-brand-50 ring-1 ring-inset ring-brand-400" : ""}`} onClick={() => setPick(r)}>
                <span><span className="font-medium">{r.name}</span>{r.sub && <span className="ml-1 text-xs text-slate-500">{r.sub}</span>}</span>
                {!r.active && <span className="text-[10px] uppercase text-slate-400">archived</span>}
              </button></li>
            ))}
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !pick} onClick={async () => {
            if (!pick || !confirm(`"${name}" ko "${pick.name}" me merge karein? "${name}" khatam ho jayega, saari entries "${pick.name}" ke naam ho jayengi.`)) return;
            const r: any = await run(() => api(`/parties/${kind}/${id}/merge`, { body: { into: pick.id } }), (x: any) => `${x.total} entries "${x.into.name}" me chali gayin`);
            if (r) onDone();
          }}><Merge size={15} /> Merge karein{pick ? ` → ${pick.name}` : ""}</button>
        </div>
      </div>
    </Modal>
  );
}
