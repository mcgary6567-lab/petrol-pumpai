import { useEffect, useState, useCallback } from "react";
import { ErrorBox } from "../components/ui";
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
                <td className="p-2"><div className="font-medium">{t.name}</div><div className="text-xs text-slate-400">{t.admin_email} · {t.users} users</div></td>
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
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* whole-database backups: every pump in one file, kept on the volume + Google Drive / Dropbox */}
      <div className="mt-4">
        <BackupsPanel title="Backups — saare pumps (poora database)" base="/platform/backups" request={(p, i) => pfetch(p, i?.body, i?.method)} downloadUrl={(n) => `/api/platform/backups/${n}?token=${getTok() ?? ""}`} />
      </div>
    </div>
  );
}
