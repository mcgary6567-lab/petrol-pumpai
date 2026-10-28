import { useEffect, useRef, useState } from "react";
import { api, setPinAsker, type PinCode } from "../lib/api";
import { Modal } from "./ui";

/**
 * Asks for the person's own 4-digit PIN whenever they cancel (void / undo / delete) an entry. If they have no PIN yet, it
 * lets them set one with their password first. Mounted once; every cancel button in the app goes through it via api().
 */
export function PinPrompt() {
  const [ask, setAsk] = useState<{ code: PinCode; message: string } | null>(null);
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const done = useRef<((v: string | null) => void) | null>(null);
  useEffect(() => {
    setPinAsker((code, message) => new Promise((resolve) => { done.current = resolve; setPin(""); setPassword(""); setErr(""); setAsk({ code, message }); }));
    return () => setPinAsker(null);
  }, []);
  const finish = (v: string | null) => { done.current?.(v); done.current = null; setAsk(null); };
  if (!ask) return null;
  const setting = ask.code === "pin_not_set";
  const submit = async () => {
    if (!/^\d{4}$/.test(pin)) { setErr("PIN 4 digits ka ho"); return; }
    if (setting) {
      setBusy(true);
      try { await api("/me/pin", { body: { password, pin } }); } catch (e: any) { setErr(e.message); setBusy(false); return; }
      setBusy(false);
    }
    finish(pin);
  };
  return (
    <Modal open onClose={() => finish(null)} title={setting ? "🔐 Apna PIN banayein" : "🔐 PIN se tasdeeq karein"}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <p className={`rounded-xl p-2.5 text-sm ${ask.code === "pin_wrong" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-900"}`}>{ask.message}</p>
        {setting && <>
          <p className="text-sm text-slate-600">Entry mansookh karne ke liye har user ka apna 4-digit PIN zaroori hai. Tasdeeq ke liye apna password daalein aur naya PIN chunein.</p>
          <input className="input" type="password" autoComplete="current-password" placeholder="Apna password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </>}
        <input className="input text-center text-2xl tracking-[0.6em] tabular-nums" type="password" inputMode="numeric" autoComplete="off" maxLength={4} autoFocus
          placeholder="••••" aria-label="PIN" value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setErr(""); }} />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => finish(null)}>Cancel</button>
          <button className="btn-primary !bg-red-600 hover:!bg-red-700" disabled={busy || pin.length !== 4 || (setting && !password)}>{setting ? "PIN banayein aur mansookh karein" : "Mansookh karein"}</button>
        </div>
      </form>
    </Modal>
  );
}
