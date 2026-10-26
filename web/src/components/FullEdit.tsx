/**
 * CEO full edit of one money entry: party, kism, tareekh, amount (litre × rate), method / bank account, ref, note, gaari, slip.
 * One modal for khata customers, wholesale clients, suppliers, thekedars and the cashier vouchers that mirror them.
 * The server reverses the old row and posts the corrected one (balances, cash book, bank and ledger follow); reason is required.
 */
import { useEffect, useMemo, useState } from "react";
import { Ban, Pencil } from "lucide-react";
import { api, useApi } from "../lib/api";
import { Field, Loading, Modal, useAction } from "./ui";
import { pkr, num } from "../lib/format";
import { useLookups } from "../lib/lookups";

export type FullEditKind = "khata" | "wholesale" | "supplier" | "carriage" | "voucher";
const VOID_URL: Record<string, (id: number | string) => string> = {
  khata: (id) => `/corrections/khata/${id}/void`, wholesale: (id) => `/corrections/wholesale-txn/${id}/void`, supplier: (id) => `/corrections/supplier-txn/${id}/void`,
  carriage: (id) => `/carriage/txns/${id}/void`, voucher: (id) => `/cashier/vouchers/${id}/void`,
};
const dayLabel = (d: string) => (d ? new Date(`${d}T12:00:00+05:00`).toLocaleDateString("en-PK", { day: "2-digit", month: "short", year: "numeric" }) : "—");
/** The sign a kind/type has on the party's balance: + they owe us more (khata charge, supply, purchase = we owe more), − less. */
const effect = (kind: string, type: string, amount: number) => (kind === "khata" ? (type === "credit" ? -amount : amount) : kind === "supplier" ? (type === "payment" ? -amount : amount) : type === "payment" || type === "return" ? -amount : amount);

export function FullEditEntry({ kind, id, onClose, onDone }: { kind: FullEditKind; id: number | string; onClose: () => void; onDone: () => void }) {
  const { data, error } = useApi<any>(`/corrections/entry/${kind}/${id}`);
  const methods = useLookups("payment_method");
  const { busy, run } = useAction();
  const [f, setF] = useState<any>(null);
  const [reason, setReason] = useState("");
  const [voiding, setVoiding] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => { if (data?.entry && !f) setF({ party_id: data.entry.party_id, type: data.entry.type, day: data.entry.day, amount: String(data.entry.amount ?? ""), litres: String(data.entry.litres ?? ""), rate: String(data.entry.rate ?? ""), product: data.entry.product ?? "", method: data.entry.method ?? "Cash", account_id: data.entry.account_id ?? null, ref: data.entry.ref ?? "", note: data.entry.note ?? "", vehicle_no: data.entry.vehicle_no ?? "", slip_no: data.entry.slip_no ?? "" }); }, [data, f]);
  const e = data?.entry;
  const realKind: string = data?.kind ?? kind;
  const withLitres = useMemo(() => !!f && realKind !== "khata" && ["supply", "return", "purchase", "carriage"].includes(f.type), [f, realKind]);
  // a khata payment (credit) and a khata "advance wapas" refund (debit) both move cash/bank → show the method + account
  const moneyRow = !!f && ((realKind === "khata" && (f.type === "credit" || (data?.entry?.is_refund && f.type === "debit"))) || f.type === "payment");
  const amount = useMemo(() => { if (!f) return 0; const l = Number(f.litres), r = Number(f.rate); return withLitres && realKind !== "carriage" && l > 0 && r > 0 && (f.amountTouched !== true) ? Math.round(l * r * 100) / 100 : Number(f.amount) || 0; }, [f, withLitres, realKind]);
  const party = data?.parties?.find((p: any) => p.id === f?.party_id);
  const shownParties = useMemo(() => (data?.parties ?? []).filter((p: any) => !q || `${p.name} ${p.sub}`.toLowerCase().includes(q.toLowerCase())).slice(0, 60), [data, q]);
  const isCash = !f?.method || /^cash$/i.test(f.method);
  const methodOptions = useMemo(() => { const base = methods.list.map((m) => m.label); const set = new Set(["Cash", ...base, ...(e?.method ? [e.method] : [])]); return [...set].filter((m) => !/cheque/i.test(m)); }, [methods.list, e]);
  if (error) return <Modal open onClose={onClose} title="Edit entry"><div className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{String(error)}</div></Modal>;
  if (!data || !f) return <Modal open onClose={onClose} title="Edit entry"><Loading /></Modal>;
  if (data.locked) return (
    <Modal open onClose={onClose} title="Ye entry yahan se nahi badalti">
      <div className="space-y-3"><div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{data.locked}</div><div className="flex justify-end"><button className="btn-secondary" onClick={onClose}>Theek hai</button></div></div>
    </Modal>
  );
  const changed = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const typeLabel = (k: string) => data.types.find((t: any) => t[0] === k)?.[1] ?? k;
  // "asar": balance moves, from the old row coming off and the new one going on
  const oldEff = effect(realKind, e.type, e.amount), newEff = effect(realKind, f.type, amount);
  const samePartyDelta = f.party_id === e.party_id ? newEff - oldEff : null;
  const owesWord = realKind === "supplier" ? "hum dete hain" : "hamein dena";
  const save = () => run(() => api(`/corrections/entry/${kind}/${id}/full-edit`, { body: {
    reason: reason.trim(), party_id: f.party_id, type: f.type, day: f.day, amount, litres: withLitres ? Number(f.litres) || null : null, rate: withLitres && realKind !== "carriage" ? Number(f.rate) || null : null,
    product: withLitres ? f.product || null : null, method: moneyRow ? f.method : null, account_id: moneyRow && !isCash ? f.account_id : null,
    ref: f.ref || null, note: f.note || null, vehicle_no: f.vehicle_no || null, slip_no: f.slip_no || null,
  } }), "Entry theek ho gayi — poore system me update, books tally").then((r) => { if (r) { onDone(); onClose(); } });
  // a bypass drop is voided through the bypass flow (its litres go back to the bypass stock)
  const voidUrl = data?.bypass_drop ? `/bypass/drops/${data.id}/void` : VOID_URL[kind](id);
  const doVoid = () => run(() => api(voidUrl, { body: { reason: reason.trim() } }), "Entry void ho gayi — books tally").then((r) => { if (r) { onDone(); onClose(); } });
  const canSave = reason.trim().length >= 3 && (f.type === "adjustment" ? amount !== 0 : amount > 0) && !!party;
  return (
    <Modal open onClose={onClose} title={`Entry poori edit karein — CEO`} wide>
      <div className="space-y-3">
        <div className="text-xs text-slate-500">{data.party_label} {e.type} #{e.x_id ?? id}{data.voucher ? ` · voucher ${data.voucher.no}` : ""}{data.created_by ? ` · banaya: ${data.created_by}` : ""}</div>
        {data.bypass_drop && <div className="rounded-xl bg-blue-50 p-2.5 text-xs text-blue-900">Ye <b>Bypass delivery #{data.bypass_drop.delivery_id}</b> ki drop hai — client, tareekh, litre, rate, gaari sab yahin se badlein. Fuel aur kism nahi badalti. Litre badhane ki gunjaish: bypass stock me {data.bypass_drop.stock_litres} L.</div>}
        {/* before → after */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
          <div className="text-slate-500"><b className="block text-[13px] text-slate-700">Pehle</b>{e.party_name} · {typeLabel(e.type)} · {pkr(e.amount)}<br />{dayLabel(e.day)}{e.method ? ` · ${e.method}` : ""}{e.ref ? ` · ref ${e.ref}` : ""}</div>
          <div className="text-lg text-slate-400">→</div>
          <div className="text-emerald-800"><b className="block text-[13px]">Ab</b>{party?.name ?? "—"} · {typeLabel(f.type)} · {pkr(amount)}<br />{dayLabel(f.day)}{moneyRow ? ` · ${f.method}` : ""}{f.ref ? ` · ref ${f.ref}` : ""}</div>
        </div>
        {/* party */}
        <Field label={`${data.party_label} (kis ke khate me) · کس کے کھاتے میں`}>
          <div className={`rounded-xl border p-2 ${f.party_id !== e.party_id ? "border-emerald-500 bg-emerald-50/40" : "border-slate-200"}`}>
            <div className="flex items-center gap-2 text-sm"><Pencil size={13} className="text-slate-400" /><b className="truncate">{party?.name ?? "—"}</b><span className="truncate text-xs text-slate-500">{party?.sub}</span>{party && <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-slate-500">baqaya {pkr(party.balance)}</span>}</div>
            <input className="input mt-2" placeholder="Doosra naam dhoondein… · نام تلاش" value={q} onChange={(ev) => setQ(ev.target.value)} />
            {q && <ul className="mt-1 max-h-40 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200 bg-white text-sm">
              {shownParties.map((p: any) => <li key={p.id}><button type="button" className={`flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-slate-50 ${p.id === f.party_id ? "font-semibold" : ""}`} onClick={() => { changed("party_id", p.id); setQ(""); }}><span className="truncate">{p.name} <span className="text-xs text-slate-500">{p.sub}</span></span><span className="text-xs tabular-nums text-slate-500">{pkr(p.balance)}</span></button></li>)}
              {!shownParties.length && <li className="px-3 py-2 text-xs text-slate-500">Kuch nahi mila</li>}
            </ul>}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">Galat bande par lagi entry yahan se sahi bande par chali jati hai: pehle wale ka balance wapas, naye wale par lag jata hai.</p>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Kism · قسم"><select className="input" disabled={!!data.bypass_drop} value={f.type} onChange={(ev) => changed("type", ev.target.value)}>{data.types.map((t: any) => <option key={t[0]} value={t[0]}>{t[1]}</option>)}</select></Field>
          <Field label="Tareekh · تاریخ"><input className={`input ${f.day !== e.day ? "border-emerald-500 bg-emerald-50/40" : ""}`} type="date" max={new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10)} value={f.day} onChange={(ev) => changed("day", ev.target.value)} /></Field>
        </div>
        {withLitres && (
          <div className="grid grid-cols-3 gap-2">
            <Field label="Fuel"><select className="input" disabled={!!data.bypass_drop} value={f.product} onChange={(ev) => changed("product", ev.target.value)}><option value="">—</option>{data.products.map((p: any) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
            <Field label="Litres"><input className="input" type="number" inputMode="decimal" value={f.litres} onChange={(ev) => setF((x: any) => ({ ...x, litres: ev.target.value, amountTouched: false }))} /></Field>
            {realKind !== "carriage" && <Field label="Rate (Rs/L)"><input className="input" type="number" inputMode="decimal" value={f.rate} onChange={(ev) => setF((x: any) => ({ ...x, rate: ev.target.value, amountTouched: false }))} /></Field>}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Amount (Rs) · رقم"><input className={`input text-lg font-semibold ${amount !== e.amount ? "border-emerald-500 bg-emerald-50/40" : ""}`} type="number" inputMode="decimal" value={f.amountTouched === true || !withLitres ? f.amount : String(amount)} onChange={(ev) => setF((x: any) => ({ ...x, amount: ev.target.value, amountTouched: true }))} />
            {withLitres && realKind !== "carriage" && <span className="text-[11px] text-slate-500">litre × rate = {pkr((Number(f.litres) || 0) * (Number(f.rate) || 0))}</span>}</Field>
          {moneyRow ? (
            <Field label="Method · طریقہ">
              <select className="input" value={f.method} onChange={(ev) => changed("method", ev.target.value)}>{methodOptions.map((m) => <option key={m}>{m}</option>)}</select>
              {!isCash && <select className="input mt-1" value={f.account_id ?? ""} onChange={(ev) => changed("account_id", ev.target.value ? Number(ev.target.value) : null)}><option value="">Bank account chunein…</option>{data.accounts.map((a: any) => <option key={a.id} value={a.id}>{a.label}</option>)}</select>}
            </Field>
          ) : <div />}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Reference / slip"><input className="input" value={f.ref} onChange={(ev) => changed("ref", ev.target.value)} /></Field>
          <Field label="Note"><input className="input" value={f.note} onChange={(ev) => changed("note", ev.target.value)} /></Field>
        </div>
        {(realKind === "khata" || realKind === "wholesale" || realKind === "carriage") && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Gaari no (optional)"><input className="input" value={f.vehicle_no} onChange={(ev) => changed("vehicle_no", ev.target.value)} /></Field>
            {realKind === "khata" && <Field label="Slip / parchi no (optional)"><input className="input" value={f.slip_no} onChange={(ev) => changed("slip_no", ev.target.value)} /></Field>}
          </div>
        )}
        {/* asar */}
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
          <b>Asar:</b>{" "}
          {samePartyDelta != null
            ? <>{party?.name} ka {owesWord} {samePartyDelta === 0 ? "wahi rahega" : <><b>{samePartyDelta > 0 ? "+" : "−"}{pkr(Math.abs(samePartyDelta))}</b> {samePartyDelta > 0 ? "barhega" : "kam hoga"}</>}</>
            : <>{e.party_name} ka {owesWord} <b>{-oldEff > 0 ? "+" : "−"}{pkr(Math.abs(oldEff))}</b> wapas · {party?.name} ka {owesWord} <b>{newEff > 0 ? "+" : "−"}{pkr(Math.abs(newEff))}</b></>}
          {moneyRow && <> · {isCash ? "office cash" : "bank"} {amount !== e.amount || (isCash !== /^cash$/i.test(e.method ?? "Cash")) ? "update" : "wahi"}</>}
          {f.day !== e.day && <> · entry {dayLabel(f.day)} ki books me jayegi</>}. Audit log me purani/nayi dono values + wajah.
        </div>
        <Field label="Wajah (kyun badla) — zaroori"><input className="input" value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="e.g. galat customer par lag gayi thi, 52 lakh ki jagah 52 hazar" /></Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {!voiding ? <button type="button" className="btn-secondary !text-red-700" disabled={busy} onClick={() => setVoiding(true)}><Ban size={15} /> Void (poori hatao)</button>
            : <button type="button" className="btn-primary !bg-red-600 hover:!bg-red-700" disabled={busy || reason.trim().length < 3} onClick={doVoid} title="Wajah likh kar confirm"><Ban size={15} /> Confirm void</button>}
          <div className="flex gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !canSave} onClick={save}>Save — sab update</button></div>
        </div>
        {voiding && reason.trim().length < 3 && <p className="text-xs text-red-700">Void ke liye bhi wajah likhein.</p>}
        <p className="text-[11px] text-slate-400">{num(data.parties?.length ?? 0)} {data.party_label.toLowerCase()}s · pehle banaya {e.created_by ?? "—"}</p>
      </div>
    </Modal>
  );
}
