/** Whole-voucher reversal (tanker trip / bypass delivery): preview every leg that will come back, the blockers that stop
 *  it, then PIN + reason and one call takes all of it back together. */
import { useState } from "react";
import { Ban, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api, useApi } from "../lib/api";
import { Loading, Modal, useAction } from "./ui";
import { askCancel, pinHeader } from "./CancelEntry";
import { useAuth } from "../App";
import { Ur } from "./VoiceShell";
import { dt, num, pkr } from "../lib/format";

const TONE: Record<string, string> = { khata: "bg-amber-50 text-amber-900", supplier: "bg-sky-50 text-sky-900", stock: "bg-slate-50 text-slate-800", tank: "bg-emerald-50 text-emerald-900", cash: "bg-rose-50 text-rose-900", other: "bg-slate-50 text-slate-700" };

export function VoucherVoidButton({ kind, id, onDone, voided }: { kind: "trip" | "bypass"; id: number; onDone: () => void; voided?: boolean }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  if (!can("wholesale.void")) return null;
  if (voided) return <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-3 py-1 text-xs font-semibold text-rose-800"><Ban size={13} /> Poora voucher mansookh</span>;
  return (
    <>
      <button type="button" className="btn-secondary !text-rose-700" onClick={() => setOpen(true)}><Ban size={15} /> Poora voucher mansookh · <Ur>منسوخ</Ur></button>
      {open && <VoucherVoidModal kind={kind} id={id} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onDone(); }} />}
    </>
  );
}

function VoucherVoidModal({ kind, id, onClose, onDone }: { kind: "trip" | "bypass"; id: number; onClose: () => void; onDone: () => void }) {
  const { data: plan, error } = useApi<any>(`/vouchers/${kind}/${id}/plan`);
  const { busy, run } = useAction();
  const go = async () => {
    const a = await askCancel({ title: `${plan.title} — poora mansookh`, what: <>{plan.summary.clients} client · {num(plan.summary.litres)} L · {plan.legs.length} legs</>, hint: "Upar di gayi har line wapas hogi. Statements me ye entries kati hui (struck) dikhti rahengi, wajah ke saath. Apna PIN likhein." });
    if (a) run(() => api(`/vouchers/${kind}/${id}/void`, { body: { reason: a.reason }, headers: pinHeader(a) }), "Voucher poora mansookh ho gaya — sab khate update").then((r) => { if (r) onDone(); });
  };
  return (
    <Modal open onClose={onClose} title={plan ? `${plan.title} mansookh karein?` : "Mansookh karein?"} wide>
      {error ? <p className="text-sm text-rose-700">{String(error)}</p> : !plan ? <Loading /> : (
        <div className="space-y-3 text-sm">
          <p className="rounded-xl bg-slate-50 p-3 text-slate-700"><b>{dt(plan.date).slice(0, 11)}</b> · Ye sab ek saath wapas hoga, ya kuch bhi nahi. Chhoti galti (litre / rate / tareekh) ho to line-wise Edit behtar hai.</p>
          <ul className="space-y-1.5">
            {plan.legs.map((l: any, i: number) => (
              <li key={i} className={`flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 ${TONE[l.tone] ?? TONE.other}`}>
                <span className="min-w-0">{l.party ? <b>{l.party}: </b> : null}{l.what}</span>
                <span className="shrink-0 tabular-nums text-xs font-semibold">{l.amount != null && l.amount !== 0 ? <span>{l.amount > 0 ? "+" : "−"}{pkr(Math.abs(l.amount))}</span> : null}{l.litres != null && l.litres !== 0 ? <span className="ml-2">{l.litres > 0 ? "+" : "−"}{num(Math.abs(l.litres))} L</span> : null}</span>
              </li>))}
          </ul>
          {plan.blockers.length > 0 && (
            <div className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-rose-900">
              <div className="mb-1 flex items-center gap-2 font-semibold"><AlertTriangle size={16} /> Abhi mansookh nahi ho sakta — pehle ye theek karein:</div>
              <ul className="list-disc space-y-0.5 pl-5">{plan.blockers.map((b: string, i: number) => <li key={i}>{b}</li>)}</ul>
            </div>
          )}
          {plan.voided && <p className="text-rose-700">Ye voucher pehle hi mansookh hai.</p>}
          {plan.ok && <p className="flex items-center gap-2 text-emerald-800"><CheckCircle2 size={16} /> Koi rukawat nahi — har khata, stock aur tank is voucher se pehle wali halat me chala jayega.</p>}
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={onClose}>Rehne dein</button>
            <button className="btn-danger" disabled={!plan.ok || busy} onClick={go}><Ban size={15} /> Mansookh karein</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
