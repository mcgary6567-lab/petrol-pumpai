import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Camera, CheckCircle2, LogIn, LogOut, QrCode, Printer, RefreshCw } from "lucide-react";
import { api, useApi } from "../lib/api";
import { PageHeader, Loading, Empty, useToast, useAction } from "../components/ui";
import { LiveSelfie } from "../components/LiveSelfie";

const Ur = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => <span lang="ur" dir="rtl" className={`font-urdu ${className}`}>{children}</span>;
const ROLE: Record<string, string> = { salesman: "Salesman", manager: "Manager", wholesale: "Wholesale", cashier: "Cashier", staff: "Staff" };
const t = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" }) : "—");

/**
 * Attendance kiosk on the shared pump tablet: whoever is signed in marks attendance for any person
 * at the pump — helper, cleaner, driver, guard, salesman — with a live selfie + location, check-in
 * and check-out both. Aim the camera at the person and tap.
 */
export default function Kiosk() {
  const { data, reload } = useApi<any[]>("/attendance/kiosk", 30_000);
  const [act, setAct] = useState<null | { user: any; kind: "in" | "out" }>(null);
  const toast = useToast();
  const mark = async (p: { photo_id: number; lat: number; lng: number; accuracy: number }) => {
    if (!act) return;
    // throws on failure so the camera stays open with the message
    await api(`/attendance/kiosk/check-${act.kind}`, { body: { user_id: act.user.id, ...p } });
    const name = act.user.name, kind = act.kind;
    setAct(null);
    toast("ok", kind === "in" ? `${name} ki haaziri lag gayi · حاضری` : `${name} check-out ho gaya · چھٹی`);
    reload();
  };
  return (
    <div className="space-y-4">
      <PageHeader title="Staff attendance · حاضری" subtitle="Manager har salesman aur staff (helper, cleaner, driver, guard) ki selfie + location se haaziri lagaye — aana aur jaana dono. Cashier, wholesale aur manager khud shaamil nahi." />
      <QrAttendance />
      {!data ? <Loading /> : !data.length ? <Empty>Koi staff nahi. Staff page se add karein.</Empty> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((u) => (
            <div key={u.id} className={`card p-4 ${u.checked_out ? "opacity-70" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{u.name}</div>
                  <div className="text-xs text-slate-500">{u.job_title || ROLE[u.role] || u.role}{u.duty_start ? ` · duty ${u.duty_start}` : ""}</div>
                </div>
                {u.checked_out ? <CheckCircle2 size={20} className="shrink-0 text-slate-400" /> : u.checked_in ? <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">On duty</span> : null}
              </div>
              <div className="mt-2 text-xs text-slate-500">{u.checked_in ? `Aaya ${t(u.check_in)}` : "Abhi nahi aaya"}{u.checked_out ? ` · Gaya ${t(u.check_out)}` : ""}</div>
              <div className="mt-3">
                {!u.checked_in ? (
                  <button className="btn-primary w-full !py-3 text-base" onClick={() => setAct({ user: u, kind: "in" })}><LogIn size={18} /> Check in · <Ur>آمد</Ur></button>
                ) : !u.checked_out ? (
                  <button className="btn-secondary w-full !py-3 text-base" onClick={() => setAct({ user: u, kind: "out" })}><LogOut size={18} /> Check out · <Ur>رخصت</Ur></button>
                ) : (
                  <div className="flex items-center justify-center gap-1 rounded-xl bg-slate-50 py-3 text-sm text-slate-500"><CheckCircle2 size={16} /> Poora din darj</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-slate-500"><Camera size={13} className="mr-1 inline" /> Har check-in aur check-out par us bande ki live selfie aur location record hoti hai — baad me Staff → Attendance par dekh sakte hain.</p>
      <LiveSelfie open={!!act} title={act ? `${act.user.name} — ${act.kind === "in" ? "check in" : "check out"} · selfie + location` : ""} onClose={() => setAct(null)} onDone={mark} />
    </div>
  );
}

/**
 * QR self check-in: one printed QR for the whole pump, and each worker's own 4-digit code. The worker scans
 * the QR, types their code, takes a selfie — no app login. Manager still has the kiosk above as a fallback.
 */
function QrAttendance() {
  const { data, reload } = useApi<any>("/attendance/qr", 0);
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState("");
  const { busy, run } = useAction();
  useEffect(() => { if (data?.url) QRCode.toDataURL(data.url, { margin: 1, width: 300 }).then(setSrc); }, [data?.url]);
  const newCode = (id: number) => run(() => api(`/attendance/workers/${id}/code`, { body: {} }), "Naya code ban gaya").then(reload);
  const rotate = () => { if (!confirm("Naya QR banayein? Purana chaspa kiya hua QR foran band ho jayega — naya print karna hoga.")) return; run(() => api("/attendance/qr/rotate", { body: {} }), "Naya QR ban gaya — ab print karein").then(reload); };
  const [faceFor, setFaceFor] = useState<number | null>(null);
  const enrollFace = async (id: number, p: { photo_id: number }) => { setFaceFor(null); await run(() => api(`/attendance/workers/${id}/face`, { body: { photo_id: p.photo_id } }), "Chehra save ho gaya"); reload(); };
  const clearFace = (id: number) => { if (confirm("Is bande ka saved chehra hata dein?")) run(() => api(`/attendance/workers/${id}/face`, { body: { photo_id: null } }), "Chehra hata diya").then(reload); };
  const print = () => {
    const w = window.open("", "_blank"); if (!w || !src) return;
    w.document.write(`<html><head><title>Haazri QR</title><style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px;color:#0f172a}h1{margin:0 0 4px}.ur{direction:rtl;font-size:20px;color:#334155}img{width:320px;height:320px;margin:16px auto}ol{display:inline-block;text-align:right;direction:rtl;font-size:20px;line-height:2}</style></head><body>
      <h1>${data?.pump ?? "Haazri · حاضری"}</h1><div class="ur">حاضری لگانے کے لیے یہ QR اسکین کریں</div>
      <img src="${src}"/>
      <ol><li>موبائل کیمرہ سے یہ QR اسکین کریں</li><li>اپنا کوڈ درج کریں</li><li>سیلفی لیں — حاضری لگ جائے گی</li></ol>
      <p style="color:#0f172a;margin-top:16px;font-weight:700;font-size:18px">${data?.pump ?? ""}</p></body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  };
  if (!data) return null;
  return (
    <div className="card p-4">
      <button className="flex w-full items-center justify-between font-semibold" onClick={() => setOpen(!open)}>
        <span className="flex items-center gap-2"><QrCode size={18} className="text-emerald-600" /> QR se khud haazri · <Ur className="text-slate-500">کیو آر سے حاضری</Ur></span>
        <span className="text-sm font-normal text-slate-500">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-3 grid gap-4 sm:grid-cols-[300px_1fr]">
          <div className="text-center">
            {src ? <img src={src} alt="Attendance QR" className="mx-auto w-full max-w-[260px] rounded-xl ring-1 ring-slate-200" /> : <div className="py-10 text-slate-400">QR ban raha hai…</div>}
            <button className="btn-primary mt-3 w-full" onClick={print}><Printer size={15} /> QR print karein</button>
            <button className="btn-secondary mt-2 w-full" disabled={busy} onClick={rotate}><RefreshCw size={14} /> Naya QR banayein (purana band)</button>
            <p className="mt-1 text-[11px] text-slate-400">Ye QR office/gate par chaspa karein. Worker scan kare → apna code → selfie. QR leak ho ya banda chala jaye to naya QR banayein.</p>
          </div>
          <div>
            <div className="mb-1 text-sm font-medium text-slate-700">Har bande ka apna code · <Ur className="text-slate-500">کوڈ</Ur></div>
            <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
              {data.workers.map((w: any) => (
                <li key={w.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0"><span className="font-medium">{w.name}</span><span className="block text-xs text-slate-500">{w.job_title || ROLE[w.role] || w.role}{w.checked_in ? " · on duty" : ""}</span></span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="rounded-lg bg-slate-100 px-2 py-1 font-mono text-base tracking-widest">{w.attend_code ?? "— — — —"}</span>
                    <button className="btn-secondary !px-2 !py-1 text-xs" disabled={busy} onClick={() => newCode(w.id)} title={w.attend_code ? "Naya code" : "Code banayein"}><RefreshCw size={13} /></button>
                    <button className={`!px-2 !py-1 text-xs ${w.face_ref_photo_id ? "btn-primary" : "btn-secondary"}`} disabled={busy} onClick={() => (w.face_ref_photo_id ? clearFace(w.id) : setFaceFor(w.id))} title={w.face_ref_photo_id ? "Chehra saved — hatane ke liye dabayein" : "Chehra save karein (selfie match)"}><Camera size={13} />{w.face_ref_photo_id ? " ✓" : ""}</button>
                  </span>
                </li>
              ))}
              {!data.workers.length && <li className="px-3 py-4 text-center text-sm text-slate-500">Koi staff nahi. Staff page se add karein.</li>}
            </ul>
            <p className="mt-1 text-[11px] text-slate-400">Har bande ko uska code bata dein. Code badalна ho to 🔄 dabayein. 📷 = chehra save (selfie match on karne par).</p>
          </div>
        </div>
      )}
      <LiveSelfie open={faceFor !== null} title="Reference chehra — saaf selfie lein" onClose={() => setFaceFor(null)} onDone={(p) => enrollFace(faceFor!, p)} />
    </div>
  );
}
