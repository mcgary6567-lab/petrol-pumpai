import { useEffect, useRef, useState, type ReactNode } from "react";
import { Ban, Lock } from "lucide-react";
import { Field, Modal } from "./ui";

/** What the person typed in the cancel window: the reason and their own 4-digit PIN (sent as x-action-pin). */
export type CancelAnswer = { reason: string; pin: string };
type Ask = { title: string; what: ReactNode; hint?: string; needReason?: boolean; button?: string };
let asker: ((a: Ask) => Promise<CancelAnswer | null>) | null = null;

/**
 * The one "mansookh" window of the app: what is being cancelled, why, and the person's PIN — opened from any void /
 * undo button with `await askCancel({...})`. Resolves null when they close it.
 */
export const askCancel = (a: Ask): Promise<CancelAnswer | null> => (asker ? asker(a) : Promise.resolve(null));
/** Headers that carry the PIN typed in the cancel window. */
export const pinHeader = (a: CancelAnswer) => ({ "x-action-pin": a.pin });

export function CancelHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const done = useRef<((v: CancelAnswer | null) => void) | null>(null);
  useEffect(() => {
    asker = (a) => new Promise((resolve) => { done.current = resolve; setAsk(a); });
    return () => { asker = null; };
  }, []);
  if (!ask) return null;
  return <CancelForm {...ask} onClose={() => { done.current?.(null); setAsk(null); }} onDone={(v) => { done.current?.(v); setAsk(null); }} />;
}

/** The window itself (also used directly by screens that keep their own state). */
export function CancelForm({ title, what, hint, needReason = true, button, onClose, onDone, busy }: Ask & { onClose: () => void; onDone: (v: CancelAnswer) => void; busy?: boolean }) {
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const ok = (!needReason || reason.trim().length >= 3) && /^\d{4}$/.test(pin);
  return (
    <Modal open onClose={onClose} title={title}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (ok) onDone({ reason: reason.trim(), pin }); }}>
        <div className="rounded-xl bg-red-50 p-3 text-sm text-red-900">{what}</div>
        <p className="text-sm text-slate-600">{hint ?? "Entry mansookh ho jayegi: balance, cash/bank aur ledger sab wapas ho jayenge. Audit log me aap ke naam aur wajah ke saath record rahega."}</p>
        {needReason && <Field label="Wajah (kyun mansookh) — zaroori"><input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. galti se double entry ho gayi" /></Field>}
        <div className="rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
          <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-amber-900"><Lock size={15} /> Apna 4-digit PIN daalein · <span lang="ur" className="font-urdu font-normal">اپنا پن کوڈ</span></div>
          <p className="mb-2 text-xs text-amber-800">Mansookh karne ke liye system aap se aap ka PIN maangega — taake koi aur aap ki khuli screen se entry na mita sake. PIN nahi bana to agle qadam par password se bana sakte hain.</p>
          <input className="input text-center text-xl tracking-[0.6em] tabular-nums" type="password" inputMode="numeric" autoComplete="off" maxLength={4} placeholder="••••" aria-label="PIN"
            autoFocus={!needReason} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary !bg-red-600 hover:!bg-red-700" disabled={busy || !ok}><Ban size={15} /> {button ?? "Mansookh karein"}</button>
        </div>
      </form>
    </Modal>
  );
}
