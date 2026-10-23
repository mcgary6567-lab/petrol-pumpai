/**
 * Public self check-in for non-login workers. The pump puts up one printed QR; a worker scans it, types their
 * own 4-digit code, takes a live selfie and their phone's location is captured — no app sign-in. The QR link
 * carries an unguessable per-pump token (/a/:token); the code names the worker.
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";

type Worker = { name: string; pump: string; checked_in: boolean; checked_out: boolean };

// open the phone camera and return the picked photo as a data URL (front camera on phones via capture="user")
function pickSelfie(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/*"; (input as any).capture = "user";
    input.onchange = () => {
      const f = input.files?.[0]; if (!f) return resolve(null);
      const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => resolve(null); r.readAsDataURL(f);
    };
    input.click();
  });
}
const geo = (): Promise<{ lat: number; lng: number; accuracy?: number } | null> =>
  new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null), { enableHighAccuracy: true, timeout: 10_000 });
  });
const t12 = (s?: string) => (s ? new Date(s).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" }) : "");

export default function AttendPublic() {
  const { token = "" } = useParams();
  const [code, setCode] = useState("");
  const [worker, setWorker] = useState<Worker | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ name: string; direction: "in" | "out"; at?: string } | null>(null);

  const resolve = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(""); setBusy(true);
    try { setWorker(await api(`/attend/${token}/resolve`, { body: { code } })); }
    catch (x: any) { setErr(x?.message ?? "Code theek nahi"); }
    finally { setBusy(false); }
  };
  const mark = async (direction: "in" | "out") => {
    setErr(""); setBusy(true);
    try {
      const image = await pickSelfie();
      if (!image) { setErr("Selfie laazmi hai · سیلفی لازمی"); setBusy(false); return; }
      const pos = await geo();
      if (!pos) { setErr("Location on karein · لوکیشن آن کریں"); setBusy(false); return; }
      const r = await api(`/attend/${token}/mark`, { body: { code, direction, image, lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy } });
      setDone({ name: r.name, direction, at: r.at });
    } catch (x: any) { setErr(x?.message ?? "Nahi ho saka"); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <div className="mb-4 text-center">
          <div className="text-2xl font-bold text-emerald-700">Haazri · حاضری</div>
          {worker?.pump && <div className="text-sm text-slate-500">{worker.pump}</div>}
        </div>

        {done ? (
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-3xl">✓</div>
            <div className="text-lg font-semibold">{done.name}</div>
            <div className="mt-1 text-slate-600">{done.direction === "in" ? "Check-in ho gaya" : "Check-out ho gaya"} {done.at ? `· ${t12(done.at)}` : ""}</div>
            <div className="text-xs text-slate-400">{done.direction === "in" ? "آ گئے" : "چلے گئے"}</div>
            <button className="btn-secondary mt-5 w-full" onClick={() => { setDone(null); setWorker(null); setCode(""); }}>Theek hai</button>
          </div>
        ) : !worker ? (
          <form onSubmit={resolve} className="space-y-3">
            <label className="block text-sm font-medium text-slate-700">Apna code daalein<span className="block text-xs font-normal text-slate-400">اپنا کوڈ درج کریں</span></label>
            <input className="input text-center text-2xl tracking-[0.5em]" inputMode="numeric" maxLength={6} autoFocus
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="••••••" />
            {err && <div className="rounded-lg bg-rose-50 p-2 text-sm text-rose-700">{err}</div>}
            <button className="btn-primary w-full" disabled={busy || code.length < 4}>Aage · آگے</button>
          </form>
        ) : (
          <div className="space-y-3 text-center">
            <div className="text-lg font-semibold">Assalam-o-Alaikum,<br />{worker.name}</div>
            {err && <div className="rounded-lg bg-rose-50 p-2 text-sm text-rose-700">{err}</div>}
            {!worker.checked_in ? (
              <button className="btn-primary w-full !py-4 text-lg" disabled={busy} onClick={() => mark("in")}>📷 Selfie le kar Check-in<span className="block text-sm font-normal">حاضری لگائیں</span></button>
            ) : !worker.checked_out ? (
              <button className="btn-primary w-full !bg-rose-600 !py-4 text-lg hover:!bg-rose-700" disabled={busy} onClick={() => mark("out")}>📷 Selfie le kar Check-out<span className="block text-sm font-normal">چھٹی</span></button>
            ) : (
              <div className="rounded-lg bg-slate-50 p-3 text-slate-600">Aaj ki haazri aur chhutti dono lag chuki hai · آج مکمل</div>
            )}
            <button className="btn-secondary w-full" disabled={busy} onClick={() => { setWorker(null); setCode(""); setErr(""); }}>Peeche</button>
            {busy && <div className="text-sm text-slate-500">Ek second… camera aur location allow karein</div>}
          </div>
        )}
      </div>
      <p className="mt-4 max-w-sm text-center text-xs text-slate-400">Selfie aur location record hoti hai — jaali haazri na lagayein. · <span dir="rtl">سیلفی اور لوکیشن محفوظ ہوتی ہے</span></p>
    </div>
  );
}
