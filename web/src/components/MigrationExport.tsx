/** Old server: download one encrypted file with the whole database + login secret, to move the install to a new server. */
import { useState } from "react";
import { Ur } from "./VoiceShell";

export function MigrationExport({ url, token }: { url: string; token: () => string | null }) {
  const [pw, setPw] = useState(""), [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ok = pw.length >= 10 && pw === pw2;
  const go = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api${url}`, { method: "POST", headers: { "content-type": "application/json", ...(token() ? { authorization: `Bearer ${token()}` } : {}) }, body: JSON.stringify({ password: pw }) });
      if (!res.ok) { const d = await res.json().catch(() => null); throw new Error(d?.error ?? `Error ${res.status}`); }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "pumpai-migration.pumpai";
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      setMsg({ ok: true, text: `File download ho gayi (${(blob.size / 1048576).toFixed(1)} MB): ${name}. Naye server par /migrate kholein aur yahi file + password dein.` });
    } catch (e: any) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  return (
    <div className="card space-y-3 p-4">
      <div>
        <h3 className="font-semibold">🚚 Naye server par le jane ki file · <Ur>نئے سرور پر منتقلی</Ur></h3>
        <p className="mt-1 text-xs text-slate-600">Poora database (saare pumps, khate, photos) aur login secret ek file me, aap ke password se band. Naye server ke <b>/migrate</b> page par ye file aur wohi password dene se sab kuch waise hi chal parega — users ke login, PIN aur customers ke links bhi. Ye file kisi ko na dein.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className="input" type="password" autoComplete="new-password" placeholder="Password (kam se kam 10 harf)" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Migration password" />
        <input className="input" type="password" autoComplete="new-password" placeholder="Password dobara" value={pw2} onChange={(e) => setPw2(e.target.value)} aria-label="Migration password dobara" />
      </div>
      {pw2 && pw !== pw2 && <p className="text-xs text-rose-700">Dono password ek jaise nahi</p>}
      <button className="btn-primary" disabled={!ok || busy} onClick={go}>{busy ? "File ban rahi hai…" : "Migration file download karein"}</button>
      {msg && <p className={`rounded-lg p-2 text-xs ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>{msg.text}</p>}
      <p className="text-xs text-slate-500">Yaad rahe: file banne ke baad yahan ki nayi entries us me nahi hongi. Shift ke waqt entries band rakhein, phir purana server band kar dein.</p>
    </div>
  );
}
