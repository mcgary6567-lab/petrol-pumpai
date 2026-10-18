import { useState } from "react";
import { ShieldAlert, Check, X } from "lucide-react";
import { api, useApi } from "../lib/api";
import { ErrorBox, useAction } from "./ui";
import { ago, pkr } from "../lib/format";

/**
 * Payments above the owner's limit: staff see their held requests, the CEO approves / rejects and sets the limit.
 * Nothing is booked until approval; a rejected request moves no money.
 */
export function PaymentApprovals() {
  const { data, error, reload } = useApi<any>("/payment-requests", 60_000);
  const { busy, run } = useAction();
  const [limit, setLimit] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const pending: any[] = data.pending ?? [];
  if (!data.can_decide && !pending.length && !data.recent?.length) return null;
  const decide = (r: any, approve: boolean) => {
    if (!confirm(approve ? `${pkr(r.amount)} approve karein? Entry ${r.requested_name} ke naam se abhi ban jayegi.` : `${pkr(r.amount)} reject karein? Kuch nahi badlega.`)) return;
    run(() => api(`/payment-requests/${r.id}/decide`, { body: { approve } }), approve ? "Approve — entry ban gayi" : "Reject ho gaya").then(() => reload());
  };
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <ShieldAlert size={20} className="shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1 text-sm"><b>Bari payment ki CEO approval · <span lang="ur" className="font-urdu">بڑی ادائیگی کی منظوری</span></b>
          <span className="block text-slate-500">{data.limit > 0 ? `Staff ki ${pkr(data.limit)} se bari payment (supplier, staff advance, other) CEO ki approval tak ruki rehti hai. Kharche ki apni limit alag hai.` : "Limit 0 = band. Limit rakhein to staff ki us se bari payment CEO ki approval tak rukegi."}</span></div>
        {data.can_decide && (
          <form className="flex items-center gap-1" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api("/payment-requests/limit", { method: "PUT", body: { limit: Number(limit) || 0 } }), "Limit save ho gayi")) { setLimit(null); reload(); } }}>
            <input className="input min-h-9 w-32 text-right tabular-nums" type="number" min={0} step={1000} value={limit ?? String(data.limit)} onChange={(e) => setLimit(e.target.value)} aria-label="Payment approval limit" />
            <button className="btn-secondary min-h-9" disabled={busy || limit === null}>Save</button>
          </form>
        )}
      </div>
      {pending.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 rounded-xl ring-1 ring-amber-200">
          {pending.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 bg-amber-50/50 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1"><b className="tabular-nums">{pkr(r.amount)}</b> · {r.summary}<div className="text-xs text-slate-500">{r.requested_name} · {ago(r.created_at)} · #{r.id}</div></div>
              {data.can_decide ? (
                <div className="flex gap-1">
                  <button className="btn-primary min-h-9 !px-3" disabled={busy} onClick={() => decide(r, true)}><Check size={15} /> Approve</button>
                  <button className="btn-secondary min-h-9 !px-3 !text-rose-700" disabled={busy} onClick={() => decide(r, false)}><X size={15} /> Reject</button>
                </div>
              ) : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">CEO approval baqi</span>}
            </li>
          ))}
        </ul>
      )}
      {data.recent?.length > 0 && (
        <details className="mt-2 text-xs text-slate-500"><summary className="cursor-pointer">Pichli requests ({data.recent.length})</summary>
          <ul className="mt-1 space-y-0.5">{data.recent.map((r: any) => <li key={r.id}>#{r.id} · {pkr(r.amount)} · {r.summary} · <b className={r.status === "approved" ? "text-emerald-700" : "text-rose-700"}>{r.status}</b>{r.decided_by ? ` by ${r.decided_by}` : ""}{r.error ? ` — ${r.error}` : ""}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
