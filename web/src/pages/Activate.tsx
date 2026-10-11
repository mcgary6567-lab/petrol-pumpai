import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../App";
import { ErrorBox } from "../components/ui";

/** Shown (in SaaS mode) when a pump's trial is over or it was suspended — until it is activated. */
export default function Activate() {
  const { account, refresh, logout, user } = useAuth();
  const [status, setStatus] = useState<any>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api("/account/status").then(setStatus).catch(() => {}); }, []);

  const activate = async () => {
    if (code.trim().length < 4) { setErr("Activation code daalein"); return; }
    setBusy(true); setErr(null);
    try { await api("/account/activate", { body: { code: code.trim() } }); await refresh(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const sales = status?.sales_phone?.replace(/\D/g, "");
  const suspended = account.status === "suspended";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-900 via-brand-700 to-brand-500 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <div className="text-center">
          <div className="text-5xl">{suspended ? "🔒" : "⏳"}</div>
          <h1 className="mt-2 text-xl font-bold">{status?.name ?? "Aap ka pump"}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {suspended
              ? "Aap ka account abhi band hai. Chalane ke liye activate karwayein."
              : "Aap ka free trial khatam ho gaya hai. Pump chalane ke liye activate karein."}
          </p>
        </div>

        <div className="mt-5">
          <label className="text-sm font-medium">Activation code</label>
          <input className="input mt-1 w-full font-mono uppercase tracking-wider" placeholder="PPAI-XXXX-XXXX"
            value={code} onChange={(e) => setCode(e.target.value)} />
          {err && <div className="mt-2"><ErrorBox error={err} /></div>}
          <button className="btn-primary mt-3 w-full justify-center" disabled={busy} onClick={activate}>
            {busy ? "…" : "Activate karein"}
          </button>
        </div>

        <div className="mt-5 rounded-xl bg-emerald-50 p-3 text-center text-sm text-emerald-900">
          <p className="font-medium">Code nahi hai? Ek-dafa payment par lifetime access.</p>
          {sales
            ? <a className="mt-2 inline-block rounded-xl bg-emerald-600 px-5 py-2 font-semibold text-white" href={`https://wa.me/${sales}?text=${encodeURIComponent(`Assalam-o-Alaikum, mujhe ${status?.name ?? "apne pump"} ke liye Petrol PumpAI activate karwana hai.`)}`} target="_blank" rel="noreferrer">WhatsApp par rabta karein</a>
            : <p className="mt-1 text-emerald-700">Rabta: apne vendor se.</p>}
        </div>

        <p className="mt-4 text-center text-xs text-slate-400">
          {user?.email} · <button className="underline" onClick={logout}>Sign out</button>
        </p>
      </div>
    </div>
  );
}
