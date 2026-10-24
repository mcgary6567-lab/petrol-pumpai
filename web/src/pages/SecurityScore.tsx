import { Link } from "react-router-dom";
import { CheckCircle2, AlertTriangle, XCircle, ShieldCheck, RefreshCw } from "lucide-react";
import { useApi } from "../lib/api";
import { Loading, PageHeader } from "../components/ui";

const Ur = ({ children }: { children: React.ReactNode }) => <span lang="ur" dir="rtl" className="font-urdu">{children}</span>;

const RING: Record<string, string> = { green: "#059669", amber: "#d97706", red: "#dc2626" };
const ICON = {
  ok: <CheckCircle2 className="text-emerald-600" size={20} />,
  warn: <AlertTriangle className="text-amber-600" size={20} />,
  off: <XCircle className="text-rose-600" size={20} />,
};

/** Security score: a plain-language checklist of how locked-down the pump is, with one-tap guidance to Settings. */
export default function SecurityScore() {
  const { data, reload } = useApi<any>("/security/score", 0);
  if (!data) return <Loading />;
  const { score, grade, core, extras } = data;
  const ring = RING[grade.tone] ?? "#059669";
  const circ = 2 * Math.PI * 52;
  return (
    <div className="space-y-5">
      <PageHeader title="Security score" subtitle="Aap ka pump kitna mehfooz hai — aur agla qadam"
        actions={<button className="btn-secondary" onClick={() => reload()}><RefreshCw size={15} /> Refresh</button>} />

      <div className="card flex flex-col items-center gap-4 p-5 sm:flex-row sm:gap-6">
        <div className="relative shrink-0" style={{ width: 128, height: 128 }}>
          <svg width="128" height="128" viewBox="0 0 128 128" className="-rotate-90">
            <circle cx="64" cy="64" r="52" fill="none" stroke="#e2e8f0" strokeWidth="12" />
            <circle cx="64" cy="64" r="52" fill="none" stroke={ring} strokeWidth="12" strokeLinecap="round"
              strokeDasharray={circ} strokeDashoffset={circ * (1 - score / 100)} style={{ transition: "stroke-dashoffset .6s ease" }} />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-3xl font-extrabold tabular-nums" style={{ color: ring }}>{score}</span>
            <span className="text-xs text-slate-500">/ 100</span>
          </div>
        </div>
        <div className="min-w-0 flex-1 text-center sm:text-left">
          <div className="flex items-center justify-center gap-2 sm:justify-start">
            <ShieldCheck size={22} style={{ color: ring }} />
            <span className="text-xl font-bold" style={{ color: ring }}>{grade.label}</span>
            <span className="text-sm text-slate-500">· {grade.en}</span>
          </div>
          <p className="mt-1 text-sm text-slate-600">Neeche har cheez ko ✓ karein — score 90+ laana target rakhein. Zyada tar Settings → Safety / Backups se theek hota hai.</p>
        </div>
      </div>

      <div className="card divide-y divide-slate-100">
        <h2 className="p-4 pb-2 font-semibold">Zaroori checks · <Ur>ضروری چیکس</Ur></h2>
        {core.map((c: any) => (
          <div key={c.key} className="flex items-start gap-3 p-4">
            <span className="mt-0.5 shrink-0">{ICON[c.status as keyof typeof ICON]}</span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{c.en} · <Ur>{c.ur}</Ur> <span className="text-xs text-slate-400">({c.weight})</span></div>
              <div className="text-sm text-slate-600">{c.detail}</div>
              {c.status !== "ok" && c.fix && <div className="mt-1 text-sm text-amber-700">→ {c.fix}</div>}
            </div>
          </div>
        ))}
      </div>

      <div className="card p-4">
        <h2 className="mb-2 font-semibold">Extra hardening (optional) · <Ur>اضافی حفاظت</Ur></h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {extras.map((x: any) => (
            <li key={x.key} className="flex items-start gap-2 rounded-lg ring-1 ring-slate-100 p-2.5 text-sm">
              {x.on ? <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-600" size={18} /> : <XCircle className="mt-0.5 shrink-0 text-slate-300" size={18} />}
              <span className="min-w-0"><span className="font-medium">{x.en}</span> · <Ur>{x.ur}</Ur>
                {!x.on && x.fix && <span className="block text-xs text-slate-500">{x.fix}</span>}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link className="btn-secondary" to="/settings">Settings → Safety</Link>
          <Link className="btn-secondary" to="/settings">Backups</Link>
          <Link className="btn-secondary" to="/audit">Audit log</Link>
          <Link className="btn-secondary" to="/alerts">Alerts</Link>
        </div>
      </div>
    </div>
  );
}
