/** New server: upload the migration file from the old server (setup code + its password) — the whole install moves here. */
import { useState } from "react";
import { Ur } from "../components/VoiceShell";

const PART = 8 * 1024 * 1024;

export default function Migrate() {
  const [code, setCode] = useState(""), [pw, setPw] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pct, setPct] = useState(0), [stage, setStage] = useState<"idle" | "upload" | "check" | "restart" | "done">("idle");
  const [err, setErr] = useState<string | null>(null);
  const post = async (url: string, body: BodyInit, type: string) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": type, "x-setup-code": code.trim() }, body });
    const d = await res.json().catch(() => null);
    if (!res.ok) throw new Error(d?.error ?? `Error ${res.status}`);
    return d;
  };
  const go = async () => {
    if (!file) return;
    setErr(null); setStage("upload"); setPct(0);
    try {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
      const parts = Math.ceil(file.size / PART);
      for (let i = 0; i < parts; i++) {
        let tries = 0;
        for (;;) {
          try { await post(`/api/migration/upload?id=${id}&part=${i}`, file.slice(i * PART, (i + 1) * PART), "application/octet-stream"); break; }
          catch (e: any) { if (++tries >= 3 || /code|nahi|ghalat/i.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 2000)); }
        }
        setPct(Math.round(((i + 1) / parts) * 100));
      }
      setStage("check");
      await post("/api/migration/finish", JSON.stringify({ id, size: file.size, password: pw }), "application/json");
      setStage("restart");
      // the app restarts with the moved database; wait until it answers again
      await new Promise((r) => setTimeout(r, 4000));
      for (let i = 0; i < 60; i++) {
        try { const r = await fetch("/api/health", { cache: "no-store" }); if (r.ok) break; } catch { /* restarting */ }
        await new Promise((r) => setTimeout(r, 3000));
      }
      setStage("done");
    } catch (e: any) { setErr(e.message); setStage("idle"); }
  };
  const busy = stage !== "idle" && stage !== "done";
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-lg space-y-4 rounded-2xl bg-white p-5 shadow">
        <h1 className="text-xl font-bold">Purane server se data laayein · <Ur>پرانا ڈیٹا لائیں</Ur></h1>
        <p className="text-sm text-slate-600">Purane server par <b>Platform → Backups → "Migration file download"</b> se bani <b>.pumpai</b> file yahan dein. Is server ka data us file se badal jayega (abhi wala data backup ban kar rehta hai), aur app khud restart hoga.</p>
        <label className="block text-sm">Setup code <span className="text-xs text-slate-500">(hPanel → Runtime logs, ya File Manager me pumpai-startup.log me "SETUP CODE")</span>
          <input className="input mt-1 font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} aria-label="Setup code" /></label>
        <label className="block text-sm">Migration file (.pumpai)
          <input className="input mt-1" type="file" accept=".pumpai,application/octet-stream" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} aria-label="Migration file" /></label>
        <label className="block text-sm">Wohi password jo file banate waqt diya tha
          <input className="input mt-1" type="password" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} disabled={busy} aria-label="Migration password" /></label>
        {stage === "upload" && <div className="space-y-1 text-sm"><div className="h-2 overflow-hidden rounded bg-slate-200"><div className="h-2 bg-emerald-600 transition-all" style={{ width: `${pct}%` }} /></div><div>Upload ho rahi hai… {pct}%</div></div>}
        {stage === "check" && <p className="text-sm">File khol kar check ho rahi hai…</p>}
        {stage === "restart" && <p className="text-sm">Data rakh diya — app restart ho raha hai (1–2 minute)…</p>}
        {stage === "done" && <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">✅ Ho gaya! Ab <a className="font-semibold underline" href="/login">login</a> karein — purane email / password se. Phir Admin → Books check par 0 farq dekh lein. Agar app na khule to hPanel se <b>Redeploy</b> dabayein.</div>}
        {err && <p className="rounded-lg bg-rose-50 p-2 text-sm text-rose-800">{err}</p>}
        {stage !== "done" && <button className="btn-primary w-full" disabled={busy || !file || !code.trim() || !pw} onClick={go}>{busy ? "Kaam jari hai…" : "Data laayein"}</button>}
      </div>
    </div>
  );
}
