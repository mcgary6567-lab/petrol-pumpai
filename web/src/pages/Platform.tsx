import { useEffect, useState, useCallback } from "react";
import { ErrorBox, Field, Modal } from "../components/ui";
import { BackupsPanel } from "../components/BackupsPanel";

/** Platform owner (super-admin) panel: every pump, activate / suspend, and one-time activation codes. Separate login. */
const KEY = "pp_platform_token";
const getTok = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const setTok = (t: string | null) => { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* */ } };

async function pfetch(path: string, body?: unknown, method?: string) {
  const res = await fetch(`/api${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(getTok() ? { authorization: `Bearer ${getTok()}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
  return data;
}

export default function Platform() {
  const [authed, setAuthed] = useState(Boolean(getTok()));
  if (!authed) return <PlatformLogin onDone={() => setAuthed(true)} />;
  return <Panel onLogout={() => { setTok(null); setAuthed(false); }} />;
}

function PlatformLogin({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { const r = await pfetch("/platform/login", { email, password }); setTok(r.token); onDone(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <h1 className="text-center text-lg font-bold">Petrol PumpAI — Platform</h1>
        <p className="mb-4 text-center text-xs text-slate-500">Owner (super-admin) login</p>
        <input className="input mb-2 w-full" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input w-full" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        {err && <div className="mt-2"><ErrorBox error={err} /></div>}
        <button className="btn-primary mt-3 w-full justify-center" disabled={busy} onClick={submit}>{busy ? "…" : "Sign in"}</button>
      </div>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = { active: "bg-emerald-100 text-emerald-700", trial: "bg-amber-100 text-amber-700", suspended: "bg-rose-100 text-rose-700" };

function Panel({ onLogout }: { onLogout: () => void }) {
  const [tenants, setTenants] = useState<any[] | null>(null);
  const [codes, setCodes] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<string[]>([]);
  const load = useCallback(async () => {
    try { setTenants((await pfetch("/platform/tenants")).tenants); setCodes((await pfetch("/platform/codes")).codes); }
    catch (e: any) { setErr(e.message); if (/login/i.test(e.message)) onLogout(); }
  }, [onLogout]);
  useEffect(() => { load(); }, [load]);

  const act = async (id: number, action: string) => { await pfetch(`/platform/tenants/${id}/${action}`, {}).then(load).catch((e) => setErr(e.message)); };
  const toggleModule = async (id: number, on: boolean) => { await pfetch(`/platform/tenants/${id}/module`, { module: "wholesale", on }).then(load).catch((e) => setErr(e.message)); };
  const makeCode = async () => { const r = await pfetch("/platform/codes", { count: 1, plan: "lifetime" }).catch((e) => setErr(e.message)); if (r) { setMade(r.codes); load(); } };
  const [resetFor, setResetFor] = useState<any>(null);
  const [deleteFor, setDeleteFor] = useState<any>(null);

  if (!tenants) return <div className="p-8 text-center text-slate-500">Loading… {err && <ErrorBox error={err} />}</div>;
  const unused = codes.filter((c) => !c.used_by_tenant);
  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">Platform — saare pumps</h1>
        <button className="btn-secondary" onClick={onLogout}>Sign out</button>
      </div>
      {err && <div className="mb-3"><ErrorBox error={err} /></div>}

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <button className="btn-primary" onClick={makeCode}>+ Naya activation code</button>
        <span className="text-sm text-slate-500">{unused.length} code unused</span>
        {made.length > 0 && <span className="rounded-lg bg-emerald-50 px-3 py-1 font-mono text-sm text-emerald-800">{made.join(", ")}</span>}
      </div>

      <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500"><tr>
            <th className="p-2">Pump</th><th>Owner</th><th>Status</th><th>Banaya</th><th className="p-2">Action</th>
          </tr></thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={t.id} className="border-t border-slate-100">
                <td className="p-2"><div className="font-medium">{t.name}</div><div className="text-xs text-slate-400">{t.admin_email} · {t.users} users</div>
                  {t.pump_url && <div className="mt-0.5 flex items-center gap-1 text-[11px]"><a className="font-mono text-brand-700 underline" href={t.pump_url} target="_blank" rel="noreferrer">/p/{t.slug}</a><button type="button" className="rounded border border-slate-200 px-1 text-[10px]" onClick={() => navigator.clipboard?.writeText(t.pump_url)}>copy</button></div>}</td>
                <td className="text-xs">{t.owner_name}<div className="text-slate-400">{t.owner_phone}</div></td>
                <td><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[t.status] ?? "bg-slate-100"}`}>{t.status}</span>
                  {t.status === "trial" && t.trial_ends_at && <div className="text-[11px] text-slate-400">till {String(t.trial_ends_at).slice(0, 10)}</div>}</td>
                <td className="text-xs text-slate-400">{String(t.created_at).slice(0, 10)}</td>
                <td className="p-2">
                  <div className="flex flex-wrap gap-1">
                    {t.status !== "active" && <button className="rounded-lg bg-emerald-600 px-2 py-1 text-xs font-semibold text-white" onClick={() => act(t.id, "activate")}>Activate</button>}
                    {t.status !== "suspended" && <button className="rounded-lg bg-rose-600 px-2 py-1 text-xs font-semibold text-white" onClick={() => act(t.id, "suspend")}>Suspend</button>}
                    <button className={`rounded-lg px-2 py-1 text-xs font-semibold ${t.module_wholesale ? "bg-indigo-600 text-white" : "border border-indigo-300 text-indigo-700"}`}
                      title="Wholesale & carriage module (extra paid add-on)"
                      onClick={() => toggleModule(t.id, !t.module_wholesale)}>Wholesale {t.module_wholesale ? "ON" : "OFF"}</button>
                    <button className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700" title="CEO ka email / phone / password / PIN reset" onClick={() => setResetFor(t)}>CEO login</button>
                    <button className="rounded-lg border border-rose-300 px-2 py-1 text-xs font-semibold text-rose-700" title="Pump aur uska poora data delete (pehle backup banta hai)" onClick={() => setDeleteFor(t)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {resetFor && <AdminResetModal t={resetFor} onClose={() => setResetFor(null)} onDone={() => { setResetFor(null); load(); }} />}
      {deleteFor && <DeletePumpModal t={deleteFor} onClose={() => setDeleteFor(null)} onDone={() => { setDeleteFor(null); load(); }} />}
      {/* whole-database backups: every pump in one file, kept on the volume + Google Drive / Dropbox */}
      <div className="mt-4">
        <BackupsPanel title="Backups — saare pumps (poora database)" base="/platform/backups" request={(p, i) => pfetch(p, i?.body, i?.method)} downloadUrl={(n) => `/api/platform/backups/${n}?token=${getTok() ?? ""}`} />
      </div>
    </div>
  );
}

/** Super admin resets a pump's CEO login: email, phone, password, PIN (the CEO is signed out everywhere and unlocked). */
function AdminResetModal({ t, onClose, onDone }: { t: any; onClose: () => void; onDone: () => void }) {
  const [admins, setAdmins] = useState<any[] | null>(null);
  const [uid, setUid] = useState<number | null>(null);
  const [f, setF] = useState({ email: "", phone: "", password: "", pin: "", name: "" });
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false); const [done, setDone] = useState<any>(null);
  useEffect(() => { pfetch(`/platform/tenants/${t.id}/admins`).then((r) => { setAdmins(r.admins); setUid(r.admins[0]?.id ?? null); }).catch((e) => setErr(e.message)); }, [t.id]);
  const u = admins?.find((a) => a.id === uid);
  const save = async () => {
    setBusy(true); setErr("");
    try {
      const body: any = { user_id: uid };
      if (f.email.trim()) body.email = f.email.trim(); if (f.phone.trim()) body.phone = f.phone.trim(); if (f.password) body.password = f.password; if (f.pin) body.pin = f.pin; if (f.name.trim()) body.name = f.name.trim();
      const r = await pfetch(`/platform/tenants/${t.id}/admin-reset`, body); setDone(r.user);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`CEO login reset — ${t.name}`}>
      {done ? (
        <div className="space-y-3 text-sm">
          <div className="rounded-xl bg-emerald-50 p-3 text-emerald-800">Ho gaya. <b>{done.name}</b> · {done.email}{done.phone ? ` · ${done.phone}` : ""}{done.has_pin ? " · PIN set" : ""}. CEO sab devices se sign-out ho gaya hai; naye login se wapas aayega.</div>
          <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>Band karein</button></div>
        </div>
      ) : (
        <div className="space-y-3">
          {err && <ErrorBox error={err} />}
          {!admins ? <div className="text-sm text-slate-500">Loading…</div> : (
            <Field label="Kaun sa CEO user"><select className="input" value={uid ?? ""} onChange={(e) => setUid(Number(e.target.value))}>{admins.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.email}{a.phone ? ` · ${a.phone}` : ""}{a.active ? "" : " · (band)"}</option>)}</select></Field>
          )}
          {u && <p className="text-xs text-slate-500">Abhi: {u.email}{u.phone ? ` · ${u.phone}` : ""} · PIN {u.has_pin ? "set hai" : "nahi"}. Jo khali chhorein wo waisa hi rahega.</p>}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Naya email"><input className="input" type="email" placeholder={u?.email ?? ""} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Naya phone"><input className="input" placeholder={u?.phone ?? "03xx…"} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
            <Field label="Naya password (8+)"><input className="input" type="text" autoComplete="off" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
            <Field label="Naya PIN (4 hindse)"><input className="input" inputMode="numeric" maxLength={4} value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, "") })} /></Field>
          </div>
          <Field label="Naam (optional)"><input className="input" placeholder={u?.name ?? ""} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={busy || !uid || !(f.email || f.phone || f.password || f.pin || f.name)} onClick={save}>{busy ? "…" : "Reset karein"}</button></div>
        </div>
      )}
    </Modal>
  );
}

/** Super admin deletes a pump: a whole-database backup is taken first, then every row of that pump goes. The exact name must be typed. */
function DeletePumpModal({ t, onClose, onDone }: { t: any; onClose: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false); const [done, setDone] = useState<any>(null);
  const ok = typed.trim().toLowerCase() === String(t.name).trim().toLowerCase();
  const go = async () => { setBusy(true); setErr(""); try { setDone(await pfetch(`/platform/tenants/${t.id}`, { confirm: typed.trim() }, "DELETE")); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  return (
    <Modal open onClose={onClose} title={`Pump delete — ${t.name}`}>
      {done ? (
        <div className="space-y-3 text-sm">
          <div className="rounded-xl bg-emerald-50 p-3 text-emerald-800"><b>{done.deleted.name}</b> delete ho gaya ({done.rows.toLocaleString()} rows). Pehle backup bana: <span className="font-mono">{done.backup.name}</span> (platform backups me mojood).</div>
          <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>Band karein</button></div>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          {err && <ErrorBox error={err} />}
          <div className="rounded-xl bg-rose-50 p-3 text-rose-900"><b>Ye wapas nahi hota.</b> {t.name} ke sab users, sales, khata, wholesale, suppliers, stock, reports, photos — sab hat jayenge. Pehle poore database ka backup khud ban jayega (Platform → Backups), zaroorat par usi se wapas aa sakta hai.</div>
          <div className="text-xs text-slate-500">{t.users} users · {t.admin_email} · banaya {String(t.created_at).slice(0, 10)}{t.pump_url ? ` · /p/${t.slug}` : ""}</div>
          <Field label={`Confirm ke liye pump ka naam likhein: "${t.name}"`}><input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t.name} /></Field>
          <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary !bg-rose-600 hover:!bg-rose-700" disabled={busy || !ok} onClick={go}>{busy ? "Delete ho raha…" : "Backup banao aur pump delete karo"}</button></div>
        </div>
      )}
    </Modal>
  );
}
