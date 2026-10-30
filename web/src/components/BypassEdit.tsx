/** CEO edits of the wholesale officer's bypass lines, used from the Bypass page and the supplier's merged statement. */
import { useState } from "react";
import { api } from "../lib/api";
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
      </div>
    </Modal>
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
