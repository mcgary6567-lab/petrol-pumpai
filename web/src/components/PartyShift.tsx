import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, useApi } from "../lib/api";
import { useAuth } from "../App";
import { pkr, dt } from "../lib/format";
import { Modal } from "./ui";

/** Same person, two accounts: who may link them and shift a payment across. */
export function useCanShift() {
  const { can } = useAuth();
  return can("entries.edit") || can("khata.manage");
}

/** Which of these ledger rows may be shifted to the other side: { id: null } = yes, else the reason it cannot. */
export function useMovable(side: "khata" | "wholesale", ids: (number | string)[], key = 0) {
  const ok = useCanShift();
  const list = useMemo(() => ids.map(Number).filter((n) => n > 0).slice(0, 500).join(","), [ids]);
  const [movable, setMovable] = useState<Record<number, string | null>>({});
  useEffect(() => {
    if (!ok || !list) { setMovable({}); return; }
    let live = true;
    api<any>(`/party-shift/movable?side=${side}&ids=${list}`).then((r) => { if (live) setMovable(r.movable ?? {}); }).catch(() => { if (live) setMovable({}); });
    return () => { live = false; };
  }, [ok, side, list, key]);
  return movable;
}

/** The 🔁 button on a payment row: confirm, then move it to the linked account on the same date. */
export function ShiftPaymentButton({ side, row, onDone, small }: { side: "khata" | "wholesale"; row: any; onDone: () => void; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const to = side === "khata" ? "Wholesale" : "Khata";
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      await api(side === "khata" ? `/party-shift/khata/${row.id}/to-wholesale` : `/party-shift/wholesale/${row.id}/to-khata`, { body: {} });
      setOpen(false); onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" className={small ? "btn-secondary !px-2 !py-1 text-xs" : "text-xs text-brand-700 hover:underline"} title={`${to} par shift karein`} aria-label={`${to} par shift`} onClick={() => setOpen(true)}>🔁 {to}</button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title={`Payment ${to} par shift karein`}>
          <div className="space-y-3 text-sm">
            <p><b>{pkr(row.amount)}</b> · {row.method ?? row.ref ?? ""} · {dt(row.txn_date ?? row.created_at)}</p>
            <p className="text-slate-600">Ye payment {side === "khata" ? "khata se hat kar isi bande ke wholesale khate" : "wholesale se hat kar isi bande ke khata"} mein usi tareekh aur waqt par chali jayegi. Cash aur bank mein koi farq nahi, sirf party badlegi. Wapas bhi isi tarah shift ho sakti hai.</p>
            {err && <p className="rounded bg-red-50 px-2 py-1 text-red-700">{err}</p>}
            <div className="flex gap-2"><button className="btn-primary" disabled={busy} onClick={go}>Shift karein</button><button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button></div>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Wholesale client page: link this client to the same person's khata account (once). */
export function KhataLink({ clientId, onChange }: { clientId: number; onChange?: () => void }) {
  const ok = useCanShift();
  const link = useApi<any>(ok ? `/party-shift/link?client_id=${clientId}` : null);
  const [pick, setPick] = useState(false);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const accts = useApi<any[]>(pick ? "/pos/khata-accounts" : null);
  if (!ok || !link.data) return null;
  const save = async (customer_id: number | null) => {
    setErr(null);
    try { await api("/party-shift/link", { body: { client_id: clientId, customer_id } }); setPick(false); link.reload(); onChange?.(); }
    catch (e: any) { setErr(e.message); }
  };
  const k = link.data.customer;
  const shown = (accts.data ?? []).filter((a) => !q || `${a.name} ${a.phone ?? ""}`.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs print:hidden">
      {k ? <>
        <span className="rounded-full bg-violet-50 px-2 py-1 text-violet-800 ring-1 ring-violet-200">🔗 Khata bhi: <Link className="font-semibold hover:underline" to={`/customers/${k.id}`}>{k.name}</Link></span>
        <button className="text-slate-500 hover:underline" onClick={() => { if (confirm("Khata se link hata dein?")) save(null); }}>link hatayen</button>
      </> : <button className="btn-secondary !py-1 text-xs" onClick={() => setPick(true)}>🔗 Khata se jorein</button>}
      {err && <span className="text-red-700">{err}</span>}
      {pick && (
        <Modal open onClose={() => setPick(false)} title="Isi bande ka khata account chunein">
          <input className="input mb-2" placeholder="Naam / phone…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <ul className="max-h-80 divide-y divide-slate-100 overflow-auto">
            {shown.map((a) => <li key={a.id}><button className="flex w-full justify-between px-2 py-2 text-left text-sm hover:bg-slate-50" onClick={() => save(a.id)}><span>{a.name}</span><span className="text-xs text-slate-500">{a.phone ?? ""}</span></button></li>)}
            {accts.data && !shown.length && <li className="px-2 py-3 text-sm text-slate-500">Koi khata nahi mila</li>}
          </ul>
          <p className="mt-2 text-xs text-slate-500">Jorne ke baad dono taraf ki payment par "🔁" button aata hai jis se galat khate wali payment doosri taraf shift hoti hai.</p>
        </Modal>
      )}
    </div>
  );
}

/** Customer page: which wholesale client this khata is linked to (read-only chip). */
export function LinkedClientChip({ customerId }: { customerId: number }) {
  const ok = useCanShift();
  const { can } = useAuth();
  const link = useApi<any>(ok ? `/party-shift/link?customer_id=${customerId}` : null);
  const c = link.data?.client;
  if (!c) return null;
  return <span className="rounded-full bg-violet-50 px-2 py-1 text-xs text-violet-800 ring-1 ring-violet-200 print:hidden">🔗 Wholesale bhi: {can("wholesale.view") ? <Link className="font-semibold hover:underline" to={`/wholesale/${c.id}`}>{c.name}</Link> : <b>{c.name}</b>}</span>;
}
