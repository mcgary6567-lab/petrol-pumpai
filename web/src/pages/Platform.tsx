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


const PLAN_LABEL: Record<string, string> = { lifetime: "Lifetime", yearly: "Yearly", monthly: "Monthly" };
const fmtN = (n: number) => Math.round(n).toLocaleString("en-IN");
const rs = (n: number) => `Rs ${n >= 1e7 ? `${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `${(n / 1e5).toFixed(1)} Lac` : fmtN(n)}`;
const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const agoShort = (iso?: string | null) => {
  if (!iso) return "—";
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "abhi"; if (m < 60) return `${m} min`; const h = Math.floor(m / 60); if (h < 24) return `${h} h`; const d = Math.floor(h / 24); return d < 30 ? `${d} din` : `${Math.floor(d / 30)} mah`;
};
/** "Plan" badge text for one pump row. */
function planText(t: any) {
  if (t.status === "trial") return t.locked ? "Trial khatam" : `Trial · ${t.days_left} din`;
  if (t.status === "suspended") return "Suspended";
  if (t.lifetime) return "Lifetime ♾";
  if (t.plan && t.paid_until) return `${PLAN_LABEL[t.plan] ?? t.plan} · ${t.plan_expired ? "khatam" : `${t.days_left} din`} (${t.paid_until})`;
  return "Active · no plan";
}
const planTone = (t: any) => t.locked ? "bg-rose-100 text-rose-700" : t.lifetime ? "bg-violet-100 text-violet-700" : t.status === "trial" ? "bg-amber-100 text-amber-700" : t.status === "suspended" ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700";

function Panel({ onLogout }: { onLogout: () => void }) {
  const [ov, setOv] = useState<any>(null);
  const [codes, setCodes] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "trial" | "suspended" | "lifetime" | "locked" | "attention">("all");
  const [tab, setTab] = useState<"pumps" | "codes" | "backups">("pumps");
  const load = useCallback(async () => {
    try { setOv(await pfetch("/platform/overview")); setCodes((await pfetch("/platform/codes")).codes); setErr(null); }
    catch (e: any) { setErr(e.message); if (/login|401/i.test(e.message)) onLogout(); }
  }, [onLogout]);
  useEffect(() => { load(); const id = setInterval(load, 60_000); return () => clearInterval(id); }, [load]);

  const act = async (id: number, action: string) => { await pfetch(`/platform/tenants/${id}/${action}`, {}).then(load).catch((e) => setErr(e.message)); };
  const toggleModule = async (id: number, on: boolean) => { await pfetch(`/platform/tenants/${id}/module`, { module: "wholesale", on }).then(load).catch((e) => setErr(e.message)); };
  const [codePlan, setCodePlan] = useState("lifetime");
  const makeCode = async () => { const r = await pfetch("/platform/codes", { count: 1, plan: codePlan }).catch((e) => setErr(e.message)); if (r) { setMade(r.codes); load(); } };
  const [resetFor, setResetFor] = useState<any>(null);
  const [deleteFor, setDeleteFor] = useState<any>(null);
  const [planFor, setPlanFor] = useState<any>(null);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [testReport, setTestReport] = useState<any>(null);
  const [testBusy, setTestBusy] = useState(false);
  // a fresh pump with every role + one entry of every kind, each with its hand-worked figure — for checking the arithmetic
  const makeTestPump = async () => { setTestBusy(true); setErr(null); try { setTestReport(await pfetch("/platform/test-pump", {})); load(); } catch (e: any) { setErr(e.message); } finally { setTestBusy(false); } };

  if (!ov) return <div className="min-h-screen bg-slate-100 p-8 text-center text-slate-500">Loading… {err && <ErrorBox error={err} />}</div>;
  const k = ov.kpis;
  const attentionIds = new Set((ov.attention as any[]).map((a) => a.tenant_id));
  const tenants: any[] = (ov.tenants as any[]).filter((t) => {
    if (filter === "lifetime" && !t.lifetime) return false;
    if (filter === "locked" && !t.locked) return false;
    if (filter === "attention" && !attentionIds.has(t.id)) return false;
    if (["active", "trial", "suspended"].includes(filter) && t.status !== filter) return false;
    const s = q.trim().toLowerCase();
    return !s || [t.name, t.slug, t.owner_name, t.owner_phone, t.admin_email].some((x) => String(x ?? "").toLowerCase().includes(s));
  });
  const unused = codes.filter((c) => !c.used_by_tenant);
  const maxSign = Math.max(1, ...ov.months.map((m: any) => m.signups));
  const Kpi = ({ label, value, sub, tone = "" }: { label: string; value: string | number; sub?: string; tone?: string }) => (
    <div className={`rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200 ${tone}`}><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div><div className="mt-0.5 text-xl font-bold tabular-nums">{value}</div>{sub && <div className="text-xs text-slate-500">{sub}</div>}</div>
  );
  const Chip = ({ k: key, label, n }: { k: typeof filter; label: string; n?: number }) => (
    <button onClick={() => setFilter(key)} className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${filter === key ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}>{label}{n != null ? ` · ${n}` : ""}</button>
  );
  const Actions = ({ t }: { t: any }) => (
    <div className="flex flex-wrap gap-1">
      <button className="rounded-lg bg-violet-600 px-2 py-1 text-xs font-semibold text-white" onClick={() => { setMenuFor(null); setPlanFor(t); }}>Plan / Lifetime</button>
      {t.status !== "active" && <button className="rounded-lg bg-emerald-600 px-2 py-1 text-xs font-semibold text-white" onClick={() => act(t.id, "activate")}>Activate</button>}
      {t.status !== "suspended" && <button className="rounded-lg bg-rose-600 px-2 py-1 text-xs font-semibold text-white" onClick={() => { if (confirm(`${t.name} suspend? Pump band ho jayega.`)) act(t.id, "suspend"); }}>Suspend</button>}
      <button className={`rounded-lg px-2 py-1 text-xs font-semibold ${t.module_wholesale ? "bg-indigo-600 text-white" : "border border-indigo-300 text-indigo-700"}`} title="Wholesale & carriage module (paid add-on)" onClick={() => toggleModule(t.id, !t.module_wholesale)}>Wholesale {t.module_wholesale ? "ON" : "OFF"}</button>
      <button className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700" title="CEO ka email / phone / password / PIN reset" onClick={() => setResetFor(t)}>CEO login</button>
      <button className="rounded-lg border border-rose-300 px-2 py-1 text-xs font-semibold text-rose-700" title="Pump aur uska poora data delete (pehle backup banta hai)" onClick={() => setDeleteFor(t)}>Delete</button>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-100 pb-16">
      {/* top bar */}
      <div className="sticky top-0 z-20 bg-slate-900 text-white shadow">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
          <div className="min-w-0"><div className="truncate text-base font-bold leading-tight">Petrol PumpAI · Platform</div><div className="text-[11px] text-slate-400">Super admin · {k.pumps} pumps · {k.online} online abhi · updated {agoShort(ov.now)}</div></div>
          <div className="flex shrink-0 gap-1.5">
            <button className="rounded-lg bg-white/10 px-2.5 py-1.5 text-xs font-semibold hover:bg-white/20" disabled={testBusy} onClick={makeTestPump} title="Har role, har kism ki ek entry, expected vs system">{testBusy ? "…" : "Test pump"}</button>
            <button className="rounded-lg bg-white/10 px-2.5 py-1.5 text-xs font-semibold hover:bg-white/20" onClick={onLogout}>Sign out</button>
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl gap-1 px-3 sm:px-4">
          {([["pumps", "Pumps"], ["codes", `Codes${unused.length ? ` · ${unused.length}` : ""}`], ["backups", "Backups"]] as const).map(([key, l]) => (
            <button key={key} onClick={() => setTab(key)} className={`border-b-2 px-3 py-1.5 text-sm ${tab === key ? "border-emerald-400 font-semibold text-white" : "border-transparent text-slate-400"}`}>{l}</button>
          ))}
        </div>
      </div>

      <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4">
        {err && <ErrorBox error={err} />}

        {tab === "pumps" && (<>
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
            <Kpi label="Pumps" value={k.pumps} sub={`+${k.new_this_month} is mahine`} />
            <Kpi label="Active" value={k.active} sub={`${k.lifetime} lifetime`} tone="ring-emerald-200" />
            <Kpi label="Trial" value={k.trial} sub={`${(ov.attention as any[]).filter((a) => a.kind.startsWith("trial")).length} khatam / qareeb`} tone="ring-amber-200" />
            <Kpi label="Locked" value={k.locked} sub={`${k.suspended} suspended`} tone={k.locked ? "ring-rose-300" : ""} />
            <Kpi label="Users" value={k.users} sub={`${k.online} online (15 min)`} />
            <Kpi label="Sales aaj" value={rs(k.sales_today)} sub={`${fmtN(k.litres_today)} L · saare pumps`} />
            <Kpi label="Sales 30 din" value={rs(k.sales_30d)} sub="saare pumps" />
            <Kpi label="Database" value={mb(k.db_bytes)} sub={k.last_backup ? `backup ${k.last_backup.replace(/^pumpai-|\.db$/g, "").slice(0, 16)}` : "koi backup nahi"} tone={k.backups ? "" : "ring-rose-300"} />
          </div>

          {/* attention + signups */}
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200 lg:col-span-2">
              <div className="mb-2 flex items-center justify-between"><div className="font-semibold">Dhyan do · <span className="text-xs font-normal text-slate-500">jahan aap ka action chahiye</span></div>{ov.attention.length > 0 && <button className="text-xs text-brand-700 underline" onClick={() => setFilter("attention")}>filter karein</button>}</div>
              {ov.attention.length === 0 ? <div className="text-sm text-emerald-700">Sab theek — koi pump nahi atka.</div> : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {(ov.attention as any[]).slice(0, 8).map((a, i) => (
                    <li key={i} className="flex items-center justify-between gap-2 py-1.5">
                      <div className="min-w-0"><span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${/over|expired/.test(a.kind) ? "bg-rose-500" : a.kind === "silent" ? "bg-slate-400" : "bg-amber-500"}`} /><b>{a.name}</b> <span className="text-slate-600">— {a.text}</span></div>
                      <button className="shrink-0 rounded-lg bg-violet-600 px-2 py-1 text-xs font-semibold text-white" onClick={() => setPlanFor((ov.tenants as any[]).find((t) => t.id === a.tenant_id))}>Plan</button>
                    </li>
                  ))}
                  {ov.attention.length > 8 && <li className="py-1 text-xs text-slate-500">+{ov.attention.length - 8} aur</li>}
                </ul>
              )}
            </div>
            <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
              <div className="mb-2 font-semibold">Naye pumps · 6 mahine</div>
              <div className="flex h-24 items-end gap-1.5">
                {ov.months.map((m: any) => (
                  <div key={m.month} className="flex flex-1 flex-col items-center gap-0.5">
                    <div className="text-[10px] tabular-nums text-slate-600">{m.signups}</div>
                    <div className="w-full rounded-t bg-emerald-500/80" style={{ height: `${Math.max(3, (m.signups / maxSign) * 64)}px` }} />
                    <div className="text-[10px] text-slate-400">{new Date(m.month + "-01").toLocaleString("en", { month: "short" })}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* pumps list */}
          <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
            <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
              <input className="input min-h-10 flex-1" placeholder="Pump, owner, phone, email dhoondein…" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 sm:mx-0 sm:px-0">
                <Chip k="all" label="Sab" n={ov.tenants.length} /><Chip k="active" label="Active" n={k.active} /><Chip k="trial" label="Trial" n={k.trial} /><Chip k="lifetime" label="Lifetime" n={k.lifetime} /><Chip k="locked" label="Locked" n={k.locked} /><Chip k="suspended" label="Suspended" n={k.suspended} />
              </div>
            </div>
            {/* phone: cards */}
            <ul className="divide-y divide-slate-100 md:hidden">
              {tenants.map((t) => (
                <li key={t.id} className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{t.name}</div>
                      <div className="truncate text-xs text-slate-500">{t.owner_name}{t.owner_phone ? ` · ${t.owner_phone}` : ""}</div>
                      {t.pump_url && <a className="font-mono text-[11px] text-brand-700 underline" href={t.pump_url} target="_blank" rel="noreferrer">/p/{t.slug}</a>}
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${planTone(t)}`}>{planText(t)}</span>
                  </div>
                  <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[11px]">
                    <div className="rounded-lg bg-slate-50 p-1"><div className="font-bold tabular-nums">{t.users}</div>users</div>
                    <div className="rounded-lg bg-slate-50 p-1"><div className="font-bold tabular-nums">{t.stations}</div>station</div>
                    <div className="rounded-lg bg-slate-50 p-1"><div className="font-bold tabular-nums">{rs(t.sales_30d)}</div>30 din</div>
                    <div className="rounded-lg bg-slate-50 p-1"><div className="font-bold tabular-nums">{agoShort(t.last_activity)}</div>activity</div>
                  </div>
                  <button className="mt-2 w-full rounded-lg border border-slate-200 py-1.5 text-xs font-semibold text-slate-700" onClick={() => setMenuFor(menuFor === t.id ? null : t.id)}>{menuFor === t.id ? "Band karein" : "Actions ▾"}</button>
                  {menuFor === t.id && <div className="mt-2"><Actions t={t} /></div>}
                </li>
              ))}
              {tenants.length === 0 && <li className="p-6 text-center text-sm text-slate-500">Koi pump nahi mila</li>}
            </ul>
            {/* desktop: table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-500"><tr>
                  <th className="p-2">Pump</th><th>Owner</th><th>Plan / status</th><th className="text-right">Users</th><th className="text-right">Sales 30d</th><th className="text-right">Aaj</th><th>Activity</th><th className="p-2">Action</th>
                </tr></thead>
                <tbody>
                  {tenants.map((t) => (
                    <tr key={t.id} className={`border-t border-slate-100 ${attentionIds.has(t.id) ? "bg-amber-50/40" : ""}`}>
                      <td className="p-2"><div className="font-medium">{t.name}</div><div className="text-xs text-slate-400">{t.admin_email} · {t.stations} station · banaya {String(t.created_at).slice(0, 10)}</div>
                        {t.pump_url && <div className="mt-0.5 flex items-center gap-1 text-[11px]"><a className="font-mono text-brand-700 underline" href={t.pump_url} target="_blank" rel="noreferrer">/p/{t.slug}</a><button type="button" className="rounded border border-slate-200 px-1 text-[10px]" onClick={() => navigator.clipboard?.writeText(t.pump_url)}>copy</button></div>}</td>
                      <td className="text-xs">{t.owner_name}<div className="text-slate-400">{t.owner_phone}</div></td>
                      <td><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${planTone(t)}`}>{planText(t)}</span>{t.note && <div className="max-w-[12rem] truncate text-[11px] text-slate-400" title={t.note}>{t.note}</div>}</td>
                      <td className="text-right tabular-nums">{t.users}{t.online ? <span className="ml-1 text-[10px] text-emerald-600">●{t.online}</span> : null}</td>
                      <td className="text-right tabular-nums">{rs(t.sales_30d)}</td>
                      <td className="text-right tabular-nums">{rs(t.sales_today)}</td>
                      <td className="text-xs text-slate-500">{agoShort(t.last_activity)}</td>
                      <td className="p-2"><Actions t={t} /></td>
                    </tr>
                  ))}
                  {tenants.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-sm text-slate-500">Koi pump nahi mila</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>)}

        {tab === "codes" && (
          <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
            <div className="flex flex-wrap items-center gap-2">
              <select className="input min-h-10 w-36" value={codePlan} onChange={(e) => setCodePlan(e.target.value)}><option value="lifetime">Lifetime</option><option value="yearly">Yearly</option><option value="monthly">Monthly</option></select>
              <button className="btn-primary min-h-10" onClick={makeCode}>+ Naya activation code</button>
              <span className="text-sm text-slate-500">{unused.length} unused</span>
              {made.length > 0 && <span className="rounded-lg bg-emerald-50 px-3 py-1 font-mono text-sm text-emerald-800">{made.join(", ")}</span>}
            </div>
            <p className="mt-2 text-xs text-slate-500">Code pump ka CEO apne account me "Activate" par likhta hai; pump active ho jata hai aur code ka plan lag jata hai. Lifetime seedha "Plan / Lifetime" button se bhi de sakte hain.</p>
            <ul className="mt-3 divide-y divide-slate-100 text-sm">
              {codes.slice(0, 50).map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span className="font-mono">{c.code}</span>
                  <span className="text-xs text-slate-500">{c.plan ?? "—"} · {c.used_by_tenant ? `used ${String(c.used_at).slice(0, 10)} (pump #${c.used_by_tenant})` : "unused"} · {String(c.created_at).slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {tab === "backups" && (
          <BackupsPanel title="Backups — saare pumps (poora database)" base="/platform/backups" request={(p, i) => pfetch(p, i?.body, i?.method)} downloadUrl={(n) => `/api/platform/backups/${n}?token=${getTok() ?? ""}`} />
        )}
      </div>

      {resetFor && <AdminResetModal t={resetFor} onClose={() => setResetFor(null)} onDone={() => { setResetFor(null); load(); }} />}
      {planFor && <PlanModal t={planFor} onClose={() => setPlanFor(null)} onDone={() => { setPlanFor(null); load(); }} />}
      {testReport && <TestPumpModal r={testReport} onClose={() => setTestReport(null)} />}
      {deleteFor && <DeletePumpModal t={deleteFor} onClose={() => setDeleteFor(null)} onDone={() => { setDeleteFor(null); load(); }} />}
    </div>
  );
}

/** Give a pump its plan: lifetime (never expires), yearly / monthly till a date, or back to trial. */
function PlanModal({ t, onClose, onDone }: { t: any; onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = useState<"lifetime" | "yearly" | "monthly" | "trial">(t.lifetime ? "lifetime" : (t.plan as any) || "lifetime");
  const [until, setUntil] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setErr("");
    try { await pfetch(`/platform/tenants/${t.id}/plan`, { plan, paid_until: plan === "yearly" || plan === "monthly" ? (until || undefined) : undefined, note: note.trim() || undefined }); onDone(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const Opt = ({ v, title, sub }: { v: typeof plan; title: string; sub: string }) => (
    <button type="button" onClick={() => setPlan(v)} className={`rounded-xl border p-3 text-left ${plan === v ? "border-violet-500 bg-violet-50 ring-1 ring-violet-400" : "border-slate-200"}`}><div className="font-semibold">{title}</div><div className="text-xs text-slate-500">{sub}</div></button>
  );
  return (
    <Modal open onClose={onClose} title={`Plan — ${t.name}`}>
      <div className="space-y-3 text-sm">
        {err && <ErrorBox error={err} />}
        <div className="text-xs text-slate-500">Abhi: <b>{planText(t)}</b>{t.paid_until ? ` · paid till ${t.paid_until}` : ""}</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Opt v="lifetime" title="Lifetime ♾" sub="Ek baar; kabhi expire nahi hota" />
          <Opt v="yearly" title="Yearly" sub="Aaj se 1 saal (ya tareekh chunein); chal raha ho to aage barhta hai" />
          <Opt v="monthly" title="Monthly" sub="Aaj se 1 mahina (ya tareekh chunein)" />
          <Opt v="trial" title="Wapas trial" sub={`Naya ${7}-din trial shuru`} />
        </div>
        {(plan === "yearly" || plan === "monthly") && <Field label="Paid till (khali = khud hisaab)"><input className="input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></Field>}
        <Field label="Note (optional: raqam, raseed, kis ne di)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Rs 60,000 cash · 18 Oct" /></Field>
        <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary !bg-violet-600 hover:!bg-violet-700" disabled={busy} onClick={go}>{busy ? "…" : plan === "lifetime" ? "Lifetime access dein" : plan === "trial" ? "Trial par lagayein" : `${PLAN_LABEL[plan]} lagayein`}</button></div>
      </div>
    </Modal>
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
/** The test-pump report: logins for every role and each entry's expected figure next to what the system shows. */
function TestPumpModal({ r, onClose }: { r: any; onClose: () => void }) {
  return (
    <Modal open wide onClose={onClose} title={`Test pump — ${r.pump.name}`}>
      <div className="space-y-3 text-sm">
        <div className={`rounded-xl p-3 ${r.summary.failed ? "bg-rose-50 text-rose-900" : "bg-emerald-50 text-emerald-800"}`}>
          <b>{r.summary.ok}/{r.steps.length} hisaab match</b>{r.summary.failed ? ` · ${r.summary.failed} farq` : " · sab theek"}
          {r.pump.url && <div className="mt-1 text-xs">Pump link: <a className="font-mono underline" href={r.pump.url} target="_blank" rel="noreferrer">{r.pump.url}</a></div>}
        </div>
        <div className="rounded-xl bg-slate-50 p-3">
          <div className="mb-1 font-semibold">Logins (password sab ka <span className="font-mono">{r.logins[0]?.password}</span>)</div>
          <table className="w-full text-xs"><tbody>
            {r.logins.map((l: any) => <tr key={l.email}><td className="py-0.5 pr-2 font-medium">{l.role}</td><td className="font-mono">{l.email}</td><td className="pl-2 font-mono">PIN {l.pin}</td></tr>)}
          </tbody></table>
        </div>
        <div className="max-h-[50vh] overflow-y-auto rounded-xl ring-1 ring-slate-200">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white text-left text-slate-500"><tr><th className="p-2">#</th><th className="p-2">Entry</th><th className="p-2">Expected (haath se)</th><th className="p-2">System</th></tr></thead>
            <tbody>
              {r.steps.map((s: any) => (
                <tr key={s.n} className={`border-t border-slate-100 align-top ${s.ok ? "" : "bg-rose-50"}`}>
                  <td className="p-2">{s.ok ? "✅" : "❌"} {s.n}</td>
                  <td className="p-2"><div className="font-medium">{s.title}</div><div className="text-slate-500">{s.entry}</div></td>
                  <td className="p-2">{s.expect}</td>
                  <td className="p-2 font-mono">{s.actual}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end"><button className="btn-primary" onClick={onClose}>Band karein</button></div>
      </div>
    </Modal>
  );
}

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
