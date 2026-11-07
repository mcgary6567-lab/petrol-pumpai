/** CEO edits of the wholesale officer's bypass lines, used from the Bypass page and the supplier's merged statement. */
import { useState } from "react";
import { api, useApi } from "../lib/api";
import { Field, Modal, useAction } from "./ui";
import { AccountPicker } from "./BankParts";
import { PRODUCTS, num, pkr } from "../lib/format";

const PAY = ["Cash", "Bank transfer", "Raast", "JazzCash", "Easypaisa", "Cheque"];
const isCash = (m: string) => /^cash$/i.test(m);

/** Edit one bypass purchase line (litres, cost as rate or full amount, day, ref, note). Supplier payable + bypass stock follow. */
export function EditBypassPurchase({ x, onClose, onDone }: { x: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [litres, setLitres] = useState(String(x.litres ?? ""));
  const [rate, setRate] = useState(String(x.cost_rate ?? ""));
  const [amount, setAmount] = useState(String(x.amount ?? ""));
  const [last, setLast] = useState<"rate" | "amount">("rate");
  const [date, setDate] = useState(String(x.txn_date ?? "").slice(0, 10));
  const [ref, setRef] = useState(x.ref ?? "");
  const [note, setNote] = useState(x.note ?? "");
  const [reason, setReason] = useState("");
  const L = Number(litres) || 0;
  const amt = last === "rate" ? Math.round(L * (Number(rate) || 0) * 100) / 100 : Number(amount) || 0;
  const r = L > 0 ? Math.round((amt / L) * 100) / 100 : 0;
  const save = () => run(() => api(`/bypass/purchases/${x.id}`, { method: "PATCH", body: { reason, litres: L, ...(last === "rate" ? { cost_rate: Number(rate) } : { amount: amt }), txn_date: date || undefined, ref: ref || null, note: note || null } }), "Khareed update — supplier ka hisaab aur stock theek")
    .then((ok) => { if (ok) onDone(); });
  return (
    <Modal open title={`Khareed edit — #${x.id} · ${PRODUCTS[x.product] ?? x.product}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="rounded-xl bg-amber-50 p-2.5 text-xs text-amber-900">Supplier ka "we owe" aur bypass stock is line se khud theek ho jayenge. Jo maal pehle hi clients ko ja chuka hai us se kam litres nahi ho sakte. Audit log me pehle / baad aur wajah rahegi.</p>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Litres"><input className="input" type="number" inputMode="decimal" value={litres} onChange={(e) => setLitres(e.target.value)} /></Field>
          <Field label="Rate (Rs/L)"><input className="input" type="number" inputMode="decimal" step="0.01" value={last === "rate" ? rate : String(r)} onChange={(e) => { setRate(e.target.value); setLast("rate"); }} /></Field>
          <Field label="Kul amount (Rs)"><input className="input" type="number" inputMode="decimal" value={last === "amount" ? amount : String(amt)} onChange={(e) => { setAmount(e.target.value); setLast("amount"); }} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Tareekh"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Ref / invoice"><input className="input" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        </div>
        <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Field label="Wajah (zaroori)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. invoice par rate 251 tha" /></Field>
        <div className="rounded-xl bg-slate-50 p-2.5 text-sm">Naya: <b>{num(L)} L</b> × Rs {r} = <b>{pkr(amt)}</b>{Math.abs(amt - (x.amount ?? 0)) > 0.5 && <span className="text-xs text-slate-500"> (pehle {pkr(x.amount)})</span>}</div>
        <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !(L > 0) || !(amt > 0) || reason.trim().length < 3} onClick={save}>Save</button></div>
        {!x.client_fuel && <ShiftToClient x={x} onDone={onDone} />}
      </div>
    </Modal>
  );
}

/** "Client se maal" came later: a bill that was written on a plain supplier card can be moved onto the wholesale client
 *  it was really bought from. Same books as a fresh client purchase (khata drops by the amount, settlement on the bypass
 *  account); the old supplier's "we owe" falls by the same amount. */
export function ShiftToClient({ x, onDone, url, startOpen = false }: { x: any; onDone: () => void; url?: string; startOpen?: boolean }) {
  const { busy, run } = useAction();
  const clients = useApi<any[]>("/wholesale/clients");
  const [open, setOpen] = useState(startOpen);
  const [client, setClient] = useState("");
  const [reason, setReason] = useState("");
  const [withPay, setWithPay] = useState(false);
  // bypass line: how much of this bill the supplier was already paid (then the payment can travel with it)
  const check = useApi<any>(open && !url ? `/bypass/purchases/${x.id}/to-client/check` : null);
  const paid = Number(check.data?.paid ?? 0);
  const supplierName = check.data?.supplier?.name ?? x.supplier_name;
  const pick = (clients.data ?? []).find((c: any) => String(c.id) === client);
  const khataCut = paid > 0.5 && withPay ? Number(check.data?.unpaid ?? 0) : Number(x.amount ?? 0);
  const shift = () => run(() => api(url ?? `/bypass/purchases/${x.id}/to-client`, { body: { client_id: Number(client), reason, ...(!url && paid > 0.5 ? { with_payment: withPay } : {}) } }), "Client ke khate par shift ho gaya")
    .then((ok) => { if (ok) onDone(); });
  const link = () => {
    if (!pick || !check.data?.supplier?.id) return;
    if (!confirm(`${supplierName} aur ${pick.name} ek hi party hain? Supplier card is client se hamesha ke liye jud jayega. Agar is client ka koi aur supplier card hai to wo isi me mil jayega.`)) return;
    run(() => api(`/suppliers/${check.data.supplier.id}/link-client`, { body: { client_id: pick.id } }), (r: any) => `Jor diya — ${supplierName} ab ${pick.name} ka supplier card hai${r.merged ? ` (${r.merged.name} ka card is me mil gaya)` : ""}. Is bill ko shift karne ki zarurat nahi.`)
      .then((ok) => { if (ok) onDone(); });
  };
  if (!open) return <button type="button" className="text-xs font-semibold text-brand-700 underline" onClick={() => setOpen(true)}>🤝 Ye maal asal me kisi client se liya tha? — client par shift karein</button>;
  return (
    <div className="space-y-2 rounded-xl border border-brand-200 bg-brand-50 p-3">
      <div className="text-sm font-semibold">Client par shift karein · <span className="font-normal text-slate-500">کلائنٹ کے کھاتے پر منتقل</span></div>
      <p className="text-xs text-slate-600">Ye line {supplierName ? <b>{supplierName}</b> : "supplier"} ke card se hat kar us client ke khate par chali jayegi. Litre / rate / tareekh wahi rahenge.</p>
      <Field label="Kis client se liya tha?"><select className="input" value={client} onChange={(e) => setClient(e.target.value)}>
        <option value="">— client —</option>{(clients.data ?? []).filter((c: any) => c.active).map((c: any) => <option key={c.id} value={c.id}>{c.name}{c.city ? ` · ${c.city}` : ""}</option>)}</select></Field>
      {paid > 0.5 && (
        <div className="space-y-1.5 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 ring-1 ring-amber-200">
          <p>Is bill ki <b>{pkr(paid)}</b> adaigi <b>{supplierName}</b> ko ho chuki hai.</p>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5 h-4 w-4" checked={withPay} onChange={(e) => setWithPay(e.target.checked)} />
            <span>Ye adaigi bhi asal me {pick ? <b>{pick.name}</b> : "isi client"} ko gayi thi (dono ek hi party). Bill aur adaigi dono saath shift hongi: supplier ka khata wahi rahega, client ka baqaya sirf baqi hisse se kam hoga.</span></label>
        </div>
      )}
      <Field label="Wajah (zaroori)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. client ka maal tha, option baad me aaya" /></Field>
      {pick && <div className="rounded-lg bg-white p-2 text-xs">{pick.name}: baqaya {pkr(pick.due ?? 0)} → <b>{pkr((pick.due ?? 0) - khataCut)}</b>{paid > 0.5 && withPay ? <span className="text-slate-500"> · {pkr(paid)} ki adaigi bhi client ke card par</span> : null}</div>}
      <div className="flex flex-wrap justify-end gap-2"><button type="button" className="btn-secondary min-h-9" onClick={() => setOpen(false)}>Rehne dein</button>
        <button type="button" className="btn-primary min-h-9" disabled={busy || !client || reason.trim().length < 3 || (paid > 0.5 && !withPay)} onClick={shift}>Shift karein</button></div>
      {!url && pick && check.data?.supplier && !check.data.supplier.client_id && (
        <div className="border-t border-brand-200 pt-2 text-xs text-slate-600">
          <p className="mb-1.5"><b>{supplierName}</b> aur <b>{pick.name}</b> ek hi party hain? Hamesha ke liye jor dein: is supplier ki saari khareed aur adaigi client ke card par aa jayegi, aur aage shift ki zarurat nahi padegi.</p>
          <button type="button" className="btn-secondary min-h-9 text-xs" disabled={busy} onClick={link}>🔗 Supplier ko {pick.name} se jor dein</button>
        </div>
      )}
    </div>
  );
}


/** Edit a bypass supplier payment we made: amount, method / bank, day, ref, note. Client legs are void + re-enter. */
export function EditBypassPayment({ x, onClose, onDone }: { x: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [amount, setAmount] = useState(String(x.amount ?? ""));
  const [method, setMethod] = useState(String(x.method ?? "Bank transfer"));
  const [account, setAccount] = useState<number | null>(x.account_id ?? null);
  const [date, setDate] = useState(String(x.txn_date ?? "").slice(0, 10));
  const [ref, setRef] = useState(x.ref ?? "");
  const [note, setNote] = useState(x.note ?? "");
  const [reason, setReason] = useState("");
  const amt = Number(amount) || 0;
  const save = () => run(() => api(`/bypass/payments/${x.id}`, { method: "PATCH", body: { reason, amount: amt, method, account_id: isCash(method) ? null : account, txn_date: date || undefined, ref: ref || null, note: note || null } }), "Adaigi update — supplier ka hisaab aur bank / cash theek")
    .then((ok) => { if (ok) onDone(); });
  return (
    <Modal open title={`Bypass adaigi edit — #${x.id}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="rounded-xl bg-amber-50 p-2.5 text-xs text-amber-900">Supplier ka "we owe" aur cash / bank book is line se khud theek ho jayenge. Audit log me pehle / baad aur wajah rahegi.</p>
        <Field label="Amount (Rs)"><input className="input text-lg font-semibold" type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Kaise"><div className="flex flex-wrap gap-1.5">{PAY.map((m) => <button key={m} type="button" onClick={() => { setMethod(m); if (isCash(m)) setAccount(null); }} className={`rounded-full px-3 py-1 text-xs font-semibold ${method === m ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600"}`}>{m}</button>)}</div></Field>
        {!isCash(method) && <AccountPicker value={account} onChange={setAccount} method={method} required />}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Tareekh"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Ref / slip"><input className="input" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        </div>
        <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Field label="Wajah (zaroori)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. slip par 26,50,000 tha" /></Field>
        <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !(amt > 0) || reason.trim().length < 3 || (!isCash(method) && !account)} onClick={save}>Save</button></div>
      </div>
    </Modal>
  );
}

/** Supplier statement: this supplier is (or is not) the same party as a wholesale client — link once, CEO only. */
export function SupplierClientLink({ supplier, onDone }: { supplier: any; onDone: () => void }) {
  const { busy, run } = useAction();
  const [open, setOpen] = useState(false);
  const [client, setClient] = useState("");
  const clients = useApi<any[]>(open || supplier.client_id ? "/wholesale/clients" : null);
  const linked = (clients.data ?? []).find((c: any) => c.id === supplier.client_id);
  const pick = (clients.data ?? []).find((c: any) => String(c.id) === client);
  if (supplier.client_id) return (
    <span className="inline-flex min-h-10 items-center gap-2 rounded-full bg-violet-50 px-3 text-xs text-violet-800 ring-1 ring-violet-200">🔗 Client bhi: <b>{linked?.name ?? `#${supplier.client_id}`}</b>
      <button type="button" className="text-slate-500 underline" disabled={busy} onClick={() => { if (confirm("Client se link hata dein? Entries jahan hain wahin rahengi.")) run(() => api(`/suppliers/${supplier.id}/link-client`, { body: { client_id: null } }), "Link hata diya").then((ok) => { if (ok) onDone(); }); }}>hatayen</button></span>
  );
  if (!open) return <button type="button" className="btn-secondary min-h-10 text-xs" onClick={() => setOpen(true)}>🔗 Client se jorein</button>;
  return (
    <Modal open title={`${supplier.name} — kis client ki party hai?`} onClose={() => setOpen(false)}>
      <div className="space-y-3 text-sm">
        <p className="rounded-xl bg-violet-50 p-2.5 text-xs text-violet-900">Agar ye supplier aur ek wholesale client asal me ek hi party hain, to jor dein. Is supplier ki khareed aur hamari adaigi client ke supplier card par aa jayegi, aur aage "client par shift" ki zarurat nahi padegi. Agar client ka pehle se koi supplier card hai to wo is me mil jayega. Hisaab ki raqam nahi badalti.</p>
        <Field label="Client"><select className="input" value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="">— client —</option>{(clients.data ?? []).filter((c: any) => c.active).map((c: any) => <option key={c.id} value={c.id}>{c.name}{c.city ? ` · ${c.city}` : ""}</option>)}</select></Field>
        <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn-primary" disabled={busy || !pick} onClick={() => run(() => api(`/suppliers/${supplier.id}/link-client`, { body: { client_id: pick.id } }), (r: any) => `Jor diya${r.merged ? ` — ${r.merged.name} ka card is me mil gaya` : ""}`).then((ok) => { if (ok) { setOpen(false); onDone(); } })}>🔗 Jor dein</button></div>
      </div>
    </Modal>
  );
}
