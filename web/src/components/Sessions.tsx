import { MonitorSmartphone, LogOut } from "lucide-react";
import { api, useApi } from "../lib/api";
import { ErrorBox, useAction } from "./ui";
import { ago } from "../lib/format";
import { ROLE_LABEL } from "../App";

/** Every signed-in device on the pump (last 7 days): who, which phone/browser, from where, last active — and a sign-out per device. */
export function Sessions() {
  const { data, error, reload } = useApi<any>("/security/sessions", 60_000);
  const { busy, run } = useAction();
  if (error) return <ErrorBox error={error} />;
  const rows: any[] = data?.sessions ?? [];
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <MonitorSmartphone size={20} className="shrink-0 text-slate-600" />
        <div className="min-w-0 flex-1 text-sm"><b>Logged-in devices · <span lang="ur" className="font-urdu">کون کہاں لاگ ان ہے</span></b>
          <span className="block text-slate-500">Har phone / browser jahan koi staff is waqt sign in hai. Shak ho to us device ko yahin se sign out karein; agli request par wo bahar ho jayega.</span></div>
        <span className="text-xs text-slate-500">{rows.length} device</span>
      </div>
      {rows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500"><tr><th className="py-1 pr-2">Kaun</th><th className="pr-2">Device</th><th className="pr-2">IP</th><th className="pr-2">Sign in</th><th className="pr-2">Aakhri activity</th><th></th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="py-1.5 pr-2"><div className="font-medium">{s.name}</div><div className="text-xs text-slate-500">{(ROLE_LABEL as any)[s.role] ?? s.role}</div></td>
                  <td className="pr-2">{s.device}{s.current && <span className="ml-1 rounded-full bg-emerald-100 px-1.5 text-[10px] font-semibold text-emerald-800">ye device</span>}</td>
                  <td className="pr-2 font-mono text-xs text-slate-500">{s.ip ?? "—"}</td>
                  <td className="pr-2 text-xs text-slate-500">{ago(s.created_at)}{s.how ? ` · ${s.how}` : ""}</td>
                  <td className="pr-2 text-xs text-slate-500">{ago(s.last_seen_at)}</td>
                  <td className="text-right"><button className="btn-secondary min-h-8 !px-2 !py-1 !text-xs !text-rose-700" disabled={busy} onClick={() => { if (confirm(`${s.name} ko is device (${s.device}) se sign out karein?`)) run(() => api(`/security/sessions/${s.id}`, { method: "DELETE" }), "Sign out ho gaya").then(() => reload()); }}><LogOut size={13} /> Sign out</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
