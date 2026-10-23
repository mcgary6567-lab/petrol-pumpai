import { useEffect, useState, useCallback } from "react";
import { ErrorBox, Field, Modal, Pager, usePaged } from "../components/ui";
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
  const [tab, setTab] = useState<"pumps" | "codes" | "backups" | "server" | "catalog" | "integrations">("pumps");
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

  const attentionIds = new Set(((ov?.attention ?? []) as any[]).map((a) => a.tenant_id));
  const tenants: any[] = ((ov?.tenants ?? []) as any[]).filter((t) => {
    if (filter === "lifetime" && !t.lifetime) return false;
    if (filter === "locked" && !t.locked) return false;
    if (filter === "attention" && !attentionIds.has(t.id)) return false;
    if (["active", "trial", "suspended"].includes(filter) && t.status !== filter) return false;
    const s = q.trim().toLowerCase();
    return !s || [t.name, t.slug, t.owner_name, t.owner_phone, t.admin_email].some((x) => String(x ?? "").toLowerCase().includes(s));
  });
  const paged = usePaged(tenants, 10);
  if (!ov) return <div className="min-h-screen bg-slate-100 p-8 text-center text-slate-500">Loading… {err && <ErrorBox error={err} />}</div>;
  const k = ov.kpis;
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
          {([["pumps", "Pumps"], ["server", "Server"], ["catalog", "Catalog"], ["codes", `Codes${unused.length ? ` · ${unused.length}` : ""}`], ["backups", "Backups"], ["integrations", "Integrations"]] as const).map(([key, l]) => (
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
              {paged.slice.map((t) => (
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
                  {paged.slice.map((t) => (
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
            <Pager {...paged} />
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

        {tab === "server" && <ServerTab />}
        {tab === "catalog" && <CatalogTab tenants={ov.tenants} />}

        {tab === "backups" && (
          <BackupsPanel title="Backups — saare pumps (poora database)" base="/platform/backups" request={(p, i) => pfetch(p, i?.body, i?.method)} downloadUrl={(n) => `/api/platform/backups/${n}?token=${getTok() ?? ""}`} />
        )}
        {tab === "integrations" && <IntegrationsTab />}
      </div>

      {resetFor && <AdminResetModal t={resetFor} onClose={() => setResetFor(null)} onDone={() => { setResetFor(null); load(); }} />}
      {planFor && <PlanModal t={planFor} onClose={() => setPlanFor(null)} onDone={() => { setPlanFor(null); load(); }} />}
      {testReport && <TestPumpModal r={testReport} onClose={() => setTestReport(null)} />}
      {deleteFor && <DeletePumpModal t={deleteFor} onClose={() => setDeleteFor(null)} onDone={() => { setDeleteFor(null); load(); }} />}
    </div>
  );
}

/* ================= Catalog tab: the master shop list every pump can pull from ================= */
function CatalogTab({ tenants }: { tenants: any[] }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [q, setQ] = useState(""); const [cat, setCat] = useState("");
  const [edit, setEdit] = useState<any>(null);
  const [paste, setPaste] = useState(""); const [showPaste, setShowPaste] = useState(false);
  const [fromPump, setFromPump] = useState("");
  const [pushCat, setPushCat] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setItems((await pfetch("/platform/catalog")).items); setErr(null); } catch (e: any) { setErr(e.message); } }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (fn: () => Promise<any>, done: (r: any) => string) => { setBusy(true); setErr(null); setMsg(null); try { const r = await fn(); setMsg(done(r)); if (r?.items) setItems(r.items); else load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const cats = [...new Set((items ?? []).map((x) => x.category))];
  const shown = (items ?? []).filter((x) => (!cat || x.category === cat) && (!q || `${x.name} ${x.brand ?? ""}`.toLowerCase().includes(q.toLowerCase())));
  const uploadBackup = async (f: File) => act(async () => {
    const res = await fetch("/api/platform/catalog/from-backup", { method: "POST", headers: { authorization: `Bearer ${getTok() ?? ""}`, "content-type": "application/octet-stream" }, body: f });
    const d = await res.json().catch(() => null); if (!res.ok) throw new Error(d?.error || `Error ${res.status}`); return d;
  }, (r) => `Backup se ${r.rows} items parhe: ${r.added} naye, ${r.updated} update`);
  return (
    <div className="space-y-3">
      {err && <ErrorBox error={err} />}
      {msg && <div className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">{msg}</div>}
      <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <div className="font-semibold">Master shop catalog · <span className="text-xs font-normal text-slate-500">filters, oils, brake oil… har pump Shop → "Catalog se items lein" se yahin se uthata hai</span></div>
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          <div className="rounded-xl bg-slate-50 p-2.5 text-sm">
            <div className="font-medium">Purani PumpAI app ka backup (.db)</div>
            <div className="text-xs text-slate-500">Purani app → Settings → Backups → Download; phir yahan upload. Us ke shop items master me aa jate hain (purani app ko kuch nahi hota).</div>
            <label className="btn-secondary mt-2 inline-flex min-h-9 cursor-pointer">{busy ? "…" : "Backup file chunein"}<input type="file" accept=".db,application/octet-stream" className="hidden" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadBackup(f); e.target.value = ""; }} /></label>
          </div>
          <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50/40 p-2.5 text-sm">
            <div className="font-medium">Catalog → pump ki shop me dalein</div>
            <div className="text-xs text-slate-500">Chune hue pump ki shop me catalog ke sab priced items (ya ek category) ban jate hain, stock 0 se. Jo pehle se hon wo chhor diye jate hain.</div>
            <div className="mt-2 flex flex-wrap gap-1">
              <select className="input min-h-9 flex-1" value={fromPump} onChange={(e) => setFromPump(e.target.value)}><option value="">Pump chunein…</option>{tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
              <select className="input min-h-9 w-32" value={pushCat} onChange={(e) => setPushCat(e.target.value)}><option value="">Sab categories</option>{cats.map((c) => <option key={c} value={c}>{c}</option>)}</select>
              <button className="btn-primary min-h-9" disabled={busy || !fromPump} onClick={() => { const t = tenants.find((x) => String(x.id) === fromPump); if (!confirm(`Catalog ke ${pushCat ? pushCat : "sab"} priced items "${t?.name}" ki shop me dalein?`)) return; act(() => pfetch(`/platform/catalog/to-tenant/${fromPump}`, { category: pushCat || null }), (r) => `${r.pump} (${r.station}): ${r.added} items shop me gaye${r.skipped ? `, ${r.skipped} pehle se the` : ""}${r.unpriced ? `, ${r.unpriced} bina price (skip)` : ""}`); }}>Shop me dalein →</button>
            </div>
            <details className="mt-2 text-xs text-slate-500"><summary className="cursor-pointer">Ulta: pump ki shop ke items master catalog me lana</summary>
              <button className="btn-secondary mt-1 min-h-8 !py-1 !text-xs" disabled={busy || !fromPump} onClick={() => act(() => pfetch(`/platform/catalog/from-tenant/${fromPump}`, {}), (r) => `${r.pump}: ${r.rows} items — ${r.added} naye, ${r.updated} update`)}>← Pump se master me copy</button></details>
          </div>
          <div className="rounded-xl bg-slate-50 p-2.5 text-sm">
            <div className="font-medium">Excel se paste</div>
            <div className="text-xs text-slate-500">Columns: name, category, cost, price, brand, unit (header row ho to behtar).</div>
            <button className="btn-secondary mt-2 min-h-9" onClick={() => setShowPaste(!showPaste)}>{showPaste ? "Band karein" : "Paste box kholein"}</button>
          </div>
        </div>
        {showPaste && <div className="mt-2"><textarea className="input min-h-32 w-full font-mono text-xs" placeholder={"name\tcategory\tcost\tprice\tbrand\nShell Helix HX5 4L\tlubricant\t5200\t5800\tShell"} value={paste} onChange={(e) => setPaste(e.target.value)} />
          <div className="mt-1 flex justify-end"><button className="btn-primary min-h-9" disabled={busy || paste.trim().length < 3} onClick={() => act(() => pfetch("/platform/catalog/bulk", { text: paste }), (r) => `${r.rows} rows — ${r.added} naye, ${r.updated} update`).then(() => setPaste(""))}>Import karein</button></div></div>}
      </div>

      <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
          <input className="input min-h-10 flex-1" placeholder="Item dhoondein…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 sm:mx-0 sm:px-0">
            <button onClick={() => setCat("")} className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${!cat ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}>Sab · {items?.length ?? 0}</button>
            {cats.map((c) => <button key={c} onClick={() => setCat(c)} className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${cat === c ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}>{c} · {items!.filter((x) => x.category === c).length}</button>)}
          </div>
          <button className="btn-primary min-h-10" onClick={() => setEdit({ name: "", category: cat || "other", brand: "", unit: "pc", cost: 0, price: 0 })}>+ Item</button>
        </div>
        <ul className="divide-y divide-slate-100">
          {shown.map((x) => (
            <li key={x.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{x.name}</div><div className="text-[11px] text-slate-500">{[x.category, x.brand, x.unit, x.sku].filter(Boolean).join(" · ")} · {x.source ?? "manual"}</div></div>
              <div className="text-right tabular-nums"><div className={x.price ? "" : "text-rose-600"}>{x.price ? `Rs ${fmtN(x.price)}` : "price nahi"}</div>{x.cost ? <div className="text-[11px] text-slate-500">cost {fmtN(x.cost)}</div> : null}</div>
              <button className="rounded-lg border border-slate-200 px-2 py-1 text-xs" onClick={() => setEdit({ ...x })}>Edit</button>
              <button className="rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-700" onClick={() => { if (confirm(`${x.name} catalog se hatayein? (pumps ki shops par asar nahi)`)) act(() => pfetch(`/platform/catalog/${x.id}`, undefined, "DELETE"), () => "Hata diya"); }}>✕</button>
            </li>
          ))}
          {items && shown.length === 0 && <li className="p-6 text-center text-sm text-slate-500">Kuch nahi mila</li>}
        </ul>
      </div>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? `Edit — ${edit.name}` : "Naya catalog item"}>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="col-span-2"><Field label="Naam"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field></div>
            <Field label="Category"><input className="input" list="catcats" value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} /><datalist id="catcats">{["lubricant", "filter", "coolant", "tyre", "battery", "tuck", "service", "other", ...cats].filter((v, i, a) => a.indexOf(v) === i).map((c) => <option key={c} value={c} />)}</datalist></Field>
            <Field label="Brand"><input className="input" value={edit.brand ?? ""} onChange={(e) => setEdit({ ...edit, brand: e.target.value })} /></Field>
            <Field label="Cost (Rs)"><input className="input" type="number" min={0} value={edit.cost ?? 0} onChange={(e) => setEdit({ ...edit, cost: Number(e.target.value) })} /></Field>
            <Field label="Price (Rs)"><input className="input" type="number" min={0} value={edit.price ?? 0} onChange={(e) => setEdit({ ...edit, price: Number(e.target.value) })} /></Field>
            <Field label="Unit"><input className="input" value={edit.unit ?? "pc"} onChange={(e) => setEdit({ ...edit, unit: e.target.value })} /></Field>
            <Field label="SKU"><input className="input" value={edit.sku ?? ""} onChange={(e) => setEdit({ ...edit, sku: e.target.value })} /></Field>
          </div>
          <div className="mt-3 flex justify-end gap-2"><button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button>
            <button className="btn-primary" disabled={busy || !edit.name?.trim()} onClick={() => { const body = { name: edit.name.trim(), category: (edit.category || "other").toLowerCase(), brand: edit.brand || null, unit: edit.unit || "pc", cost: Number(edit.cost) || 0, price: Number(edit.price) || 0, sku: edit.sku || null }; act(() => (edit.id ? pfetch(`/platform/catalog/${edit.id}`, body, "PUT") : pfetch("/platform/catalog", body)), () => "Save ho gaya").then(() => setEdit(null)); }}>Save</button></div>
        </Modal>
      )}
    </div>
  );
}

/* ================= Server tab: the Fly machine, volume, traffic, health and error log ================= */
const gb = (b: number) => `${(b / 1e9).toFixed(2)} GB`;
const upFor = (s: number) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
function Bar({ pct, tone }: { pct: number; tone?: string }) {
  const p = Math.max(0, Math.min(100, pct));
  return <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${tone ?? (p > 85 ? "bg-rose-500" : p > 65 ? "bg-amber-500" : "bg-emerald-500")}`} style={{ width: `${p}%` }} /></div>;
}
function Row({ k, v, mono }: { k: string; v: any; mono?: boolean }) { return <div className="flex justify-between gap-3 py-0.5 text-sm"><span className="text-slate-500">{k}</span><span className={`text-right ${mono ? "font-mono text-xs" : "font-medium"}`}>{v ?? "—"}</span></div>; }

function ServerTab() {
  const [s, setS] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [level, setLevel] = useState<"all" | "error" | "warn">("all");
  const [open, setOpen] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { const [st, lg] = await Promise.all([pfetch("/platform/server"), pfetch(`/platform/server/logs?level=${level}&limit=200`)]); setS(st); setLogs(lg.logs); setErr(null); }
    catch (e: any) { setErr(e.message); }
  }, [level]);
  useEffect(() => { load(); const id = setInterval(load, 30_000); return () => clearInterval(id); }, [load]);
  if (!s) return <div className="rounded-2xl bg-white p-6 text-center text-slate-500 shadow-sm ring-1 ring-slate-200">Server status la rahe hain… {err && <ErrorBox error={err} />}</div>;
  const m = s.machine, c = s.cpu, me = s.memory, d = s.disk, r = s.requests;
  const vol = d.volume;
  const maxReq = Math.max(1, ...r.per_minute.map((x: any) => x.requests));
  const Card = ({ title, children, className = "" }: { title: string; children: any; className?: string }) => <div className={`rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200 ${className}`}><div className="mb-2 font-semibold">{title}</div>{children}</div>;
  return (
    <div className="space-y-3">
      {err && <ErrorBox error={err} />}
      {/* headline */}
      <div className={`flex flex-wrap items-center gap-3 rounded-2xl p-3 shadow-sm ring-1 ${s.healthy ? "bg-emerald-50 ring-emerald-200" : "bg-rose-50 ring-rose-200"}`}>
        <div className={`h-3 w-3 rounded-full ${s.healthy ? "bg-emerald-500" : "bg-rose-500"}`} />
        <div className="min-w-0 flex-1"><div className="font-semibold">{s.healthy ? "Server theek chal raha hai" : "Server par dhyan chahiye"} · {m.app ?? "local"}{m.region ? ` · ${m.region}` : ""}</div>
          <div className="text-xs text-slate-600">Up {upFor(m.process_uptime_s)} · Node {m.node} · {r.last_5min.requests} requests / 5 min · avg {r.last_5min.avg_ms} ms · updated {agoShort(s.now)}</div></div>
        <div className="flex gap-1.5">
          <button className="rounded-lg bg-white px-2.5 py-1.5 text-xs font-semibold ring-1 ring-slate-200" onClick={load}>Refresh</button>
          {m.app && <a className="rounded-lg bg-white px-2.5 py-1.5 text-xs font-semibold ring-1 ring-slate-200" href={`https://fly.io/apps/${m.app}`} target="_blank" rel="noreferrer">Fly.io ↗</a>}
        </div>
      </div>

      {/* health checks */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {s.checks.map((ck: any) => (
          <div key={ck.name} className={`rounded-xl bg-white p-2.5 ring-1 ${ck.ok ? "ring-slate-200" : "ring-rose-300 bg-rose-50"}`}>
            <div className="flex items-center gap-1.5 text-sm font-semibold"><span className={`h-2 w-2 rounded-full ${ck.ok ? "bg-emerald-500" : "bg-rose-500"}`} />{ck.name}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-slate-600">{ck.detail}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Card title="CPU · load">
          <div className="mb-1 flex items-baseline justify-between"><span className="text-2xl font-bold tabular-nums">{c.percent}%</span><span className="text-xs text-slate-500">{c.cores} core</span></div>
          <Bar pct={c.percent} />
          <div className="mt-2"><Row k="Load 1 / 5 / 15 min" v={`${c.load_1.toFixed(2)} / ${c.load_5.toFixed(2)} / ${c.load_15.toFixed(2)}`} /><Row k="Event loop lag" v={`${c.event_loop_lag_ms} ms`} /><Row k="CPU" v={c.model} /></div>
        </Card>
        <Card title="Memory · RAM">
          <div className="mb-1 flex items-baseline justify-between"><span className="text-2xl font-bold tabular-nums">{mb(me.used)}</span><span className="text-xs text-slate-500">of {mb(me.total)} ({Math.round((me.used / me.total) * 100)}%)</span></div>
          <Bar pct={(me.used / me.total) * 100} />
          <div className="mt-2"><Row k="App process (RSS)" v={mb(me.rss)} /><Row k="Heap used / total" v={`${mb(me.heap_used)} / ${mb(me.heap_total)}`} /><Row k="Free" v={mb(me.free)} /></div>
        </Card>
        <Card title="Disk · data volume">
          {vol ? (<>
            <div className="mb-1 flex items-baseline justify-between"><span className="text-2xl font-bold tabular-nums">{gb(vol.used)}</span><span className="text-xs text-slate-500">of {gb(vol.total)} ({Math.round((vol.used / vol.total) * 100)}%) · {gb(vol.free)} free</span></div>
            <Bar pct={(vol.used / vol.total) * 100} />
          </>) : <div className="text-sm text-slate-500">Volume info nahi mili</div>}
          <div className="mt-2"><Row k="Mount" v={d.mount} mono /><Row k="Data folder" v={mb(d.data_bytes)} /><Row k="Database" v={`${mb(d.db_bytes)} + WAL ${mb(d.wal_bytes)}`} /><Row k="Backups" v={`${d.backups} files · ${mb(d.backups_bytes)}`} /><Row k="Aakhri backup" v={d.latest_backup ? `${agoShort(d.latest_backup.at)} pehle · ${mb(d.latest_backup.bytes)}` : "—"} /></div>
        </Card>
        <Card title="Machine">
          <Row k="App" v={m.app} /><Row k="Region" v={m.region} /><Row k="Machine ID" v={m.machine_id} mono /><Row k="Image" v={m.image} mono /><Row k="Public IP" v={m.public_ip} mono />
          <Row k="Node / PID" v={`${m.node} · ${m.pid}`} /><Row k="App up" v={`${upFor(m.process_uptime_s)} (since ${new Date(m.started_at).toLocaleString("en-PK")})`} /><Row k="OS up" v={upFor(m.os_uptime_s)} /><Row k="Platform" v={m.platform} mono /><Row k="Mode · TZ" v={`${m.env} · ${m.timezone}`} />
        </Card>
        <Card title="Traffic · last hour">
          <div className="grid grid-cols-4 gap-1 text-center text-[11px]">
            <div className="rounded-lg bg-slate-50 p-1.5"><div className="text-base font-bold tabular-nums">{r.last_hour.requests}</div>requests</div>
            <div className="rounded-lg bg-slate-50 p-1.5"><div className="text-base font-bold tabular-nums">{r.last_hour.avg_ms}</div>avg ms</div>
            <div className={`rounded-lg p-1.5 ${r.last_hour.s4xx ? "bg-amber-50" : "bg-slate-50"}`}><div className="text-base font-bold tabular-nums">{r.last_hour.s4xx}</div>4xx</div>
            <div className={`rounded-lg p-1.5 ${r.last_hour.s5xx ? "bg-rose-50" : "bg-slate-50"}`}><div className="text-base font-bold tabular-nums">{r.last_hour.s5xx}</div>5xx</div>
          </div>
          <div className="mt-2 flex h-16 items-end gap-px" title="requests per minute (laal = 5xx)">
            {r.per_minute.map((x: any) => <div key={x.t} className={`flex-1 rounded-t ${x.s5xx ? "bg-rose-500" : "bg-sky-500/80"}`} style={{ height: `${Math.max(2, (x.requests / maxReq) * 60)}px` }} title={`${new Date(x.t).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" })}: ${x.requests} req · avg ${x.avg_ms} ms · max ${x.max_ms} ms${x.s5xx ? ` · ${x.s5xx} errors` : ""}`} />)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">Since start: {r.total_since_start.toLocaleString()} requests · avg {r.avg_ms_since_start} ms · {r.last_hour.slow} slow (&gt;1 s) is ghante</div>
        </Card>
        <Card title="Database">
          <Row k="Pumps / users" v={`${s.db.tenants} / ${s.db.users}`} /><Row k="Sales rows" v={Number(s.db.sales).toLocaleString()} /><Row k="Audit rows" v={Number(s.db.audit_rows).toLocaleString()} /><Row k="Live sessions" v={s.db.sessions_live} /><Row k="Journal" v={s.db.journal_mode} /><Row k="Errors 24h / 7d" v={`${s.errors.last_24h} / ${s.errors.last_7d}`} />
        </Card>
      </div>

      {/* Fly machines API */}
      <Card title="Fly.io machines & volumes">
        {!s.fly.configured ? (
          <div className="text-sm text-slate-600">Machine state, size aur volume ki tafseel Fly se seedha lene ke liye ek read-only token lagayein (ek baar):
            <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-2 text-[11px] text-slate-100">fly tokens create readonly -a {m.app ?? "petrol-pumpai"} --expiry 8760h{"\n"}fly secrets set FLY_API_TOKEN="&lt;token&gt;" -a {m.app ?? "petrol-pumpai"}</pre>
            <div className="mt-1 text-xs text-slate-500">Baqi sab (CPU, RAM, disk, traffic, errors) bina token ke yahin se aata hai.</div></div>
        ) : s.fly.error ? <ErrorBox error={`Fly API: ${s.fly.error}`} /> : (
          <div className="grid gap-2 md:grid-cols-2">
            {s.fly.machines.map((x: any) => (
              <div key={x.id} className="rounded-xl bg-slate-50 p-2.5 text-sm">
                <div className="flex items-center justify-between"><b>{x.name ?? x.id}</b><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${x.state === "started" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>{x.state}</span></div>
                <div className="text-xs text-slate-600">{x.region} · {x.cpu_kind} {x.cpus} vCPU · {x.memory_mb} MB · <span className="font-mono">{x.id}</span></div>
                {x.checks?.length > 0 && <div className="mt-1 text-xs">{x.checks.map((ck: any) => <span key={ck.name} className={`mr-2 ${ck.status === "passing" ? "text-emerald-700" : "text-rose-700"}`}>● {ck.name} {ck.status}</span>)}</div>}
              </div>
            ))}
            {s.fly.volumes.map((v: any) => (
              <div key={v.id} className="rounded-xl bg-slate-50 p-2.5 text-sm">
                <div className="flex items-center justify-between"><b>Volume {v.name}</b><span className="text-xs">{v.size_gb} GB · {v.state}</span></div>
                <div className="text-xs text-slate-600">{v.region} · {v.encrypted ? "encrypted" : "not encrypted"} · <span className="font-mono">{v.id}</span> · attached {v.attached_machine_id ?? "—"}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* error log */}
      <Card title="Error log">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {(["all", "error", "warn"] as const).map((l) => <button key={l} onClick={() => setLevel(l)} className={`rounded-full px-3 py-1 text-xs font-semibold ${level === l ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}>{l === "all" ? "Sab" : l === "error" ? "Errors" : "Warnings (slow)"}</button>)}
          <span className="text-xs text-slate-500">{logs.length} rows (aakhri 1,000 rakhe jate hain; restart par bhi rehte hain)</span>
          <button className="ml-auto rounded-lg border border-rose-300 px-2 py-1 text-xs font-semibold text-rose-700" disabled={busy || !logs.length} onClick={async () => { if (!confirm("Poora error log saaf karein?")) return; setBusy(true); try { await pfetch("/platform/server/logs/clear", {}); await load(); } finally { setBusy(false); } }}>Clear</button>
        </div>
        {logs.length === 0 ? <div className="text-sm text-emerald-700">Koi error nahi 🎉</div> : (
          <ul className="divide-y divide-slate-100 text-sm">
            {logs.map((l) => (
              <li key={l.id} className="py-1.5">
                <button className="flex w-full flex-wrap items-start gap-2 text-left" onClick={() => setOpen(open === l.id ? null : l.id)}>
                  <span className={`mt-0.5 shrink-0 rounded px-1.5 text-[10px] font-bold uppercase ${l.level === "error" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}`}>{l.level}</span>
                  <span className="min-w-0 flex-1 break-words font-mono text-xs">{l.message}</span>
                  <span className="shrink-0 text-[11px] text-slate-500">{l.method ? `${l.method} ${l.path}${l.status ? ` → ${l.status}` : ""} · ` : ""}{new Date(l.created_at).toLocaleString("en-PK", { dateStyle: "short", timeStyle: "medium" })}</span>
                </button>
                {open === l.id && l.stack && <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-slate-900 p-2 text-[11px] leading-snug text-slate-100">{l.stack}</pre>}
              </li>
            ))}
          </ul>
        )}
      </Card>
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

/* ================= Integrations tab: install-wide keys (WhatsApp shared number + cloud OAuth apps) ================= */
function IntegrationsTab() {
  const [data, setData] = useState<any>(null);
  const [v, setV] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => { pfetch("/platform/integrations").then((d) => { setData(d); setV(d.values); }).catch((e) => setMsg(e.message)); }, []);
  const inp = (k: string, label: string, ph = "", secret = false) => v && (
    <label className="block text-sm">
      <span className="text-slate-600">{label}</span>
      <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs" type={secret ? "password" : "text"} autoComplete="off" placeholder={ph}
        value={v[k] ?? ""} onFocus={(e) => secret && e.target.value.startsWith("•") && setV({ ...v, [k]: "" })} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
    </label>
  );
  const save = async () => { setBusy(true); setMsg(""); try { await pfetch("/platform/integrations", v, "PUT"); const d = await pfetch("/platform/integrations"); setData(d); setV(d.values); setMsg("Saved — sab pumps par chalu (restart ki zaroorat nahi)"); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); } };
  if (!data || !v) return <div className="text-slate-400">{msg || "Loading…"}</div>;
  const base = String(data.webhook_url || "").replace(/\/webhooks\/whatsapp$/, "");
  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white p-4 text-slate-900 ring-1 ring-slate-200">
        <h3 className="mb-1 font-semibold">WhatsApp — shared number (saare pumps)</h3>
        <p className="mb-2 text-sm text-slate-600">Ek PumpAI number ka token + phone number ID. Webhook: <span className="break-all font-mono text-xs">{data.webhook_url}</span> · verify token neeche · utility template (1 body variable) banayein.</p>
        <div className="grid gap-2 sm:grid-cols-2">{inp("wa_token", "Access token", "EAAG…", true)}{inp("wa_phone_number_id", "Phone number ID")}{inp("wa_verify_token", "Verify token")}{inp("wa_app_secret", "App secret", "", true)}{inp("wa_template", "Template name")}{inp("public_url", "Public address of this app", "https://…")}</div>
      </div>
      <div className="rounded-2xl bg-white p-4 text-slate-900 ring-1 ring-slate-200">
        <h3 className="mb-1 font-semibold">Cloud backup apps — Google Drive / Dropbox</h3>
        <p className="mb-2 text-sm text-slate-600">Ek dafa OAuth app creds daalein. Phir har pump Settings → Backups se <b>ek click</b> mein apni Drive/Dropbox connect kar lega.</p>
        <div className="grid gap-2 sm:grid-cols-2">{inp("google_client_id", "Google OAuth client ID", "…apps.googleusercontent.com")}{inp("google_client_secret", "Google OAuth client secret", "", true)}{inp("dropbox_app_key", "Dropbox app key")}{inp("dropbox_app_secret", "Dropbox app secret", "", true)}</div>
        <p className="mt-2 text-[11px] text-slate-500">Google OAuth redirect URI: <span className="break-all font-mono">{base}/api/cloud/google/callback</span> · Dropbox: Scoped app (App folder) → key & secret.</p>
      </div>
      <div className="flex items-center gap-3"><button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy} onClick={save}>Save</button>{msg && <span className="text-sm text-slate-600">{msg}</span>}</div>
    </div>
  );
}
