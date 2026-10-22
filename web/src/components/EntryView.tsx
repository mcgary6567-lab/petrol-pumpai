/**
 * "View" panel for one khata ledger entry: shows every input of the entry (and, when it came from a POS sale, the whole
 * sale — litres, rate, discount, baqi cash / shop saman, Khareed, who entered it). From here the entry can be printed,
 * sent to the customer on WhatsApp, or — if a mistake slipped in — edited and saved (the correction re-posts it and keeps
 * every book tallied).
 */
import { useState } from "react";
import { Printer, Send, Pencil } from "lucide-react";
import { api, linkToken, useApi } from "../lib/api";
import { ProofThumbs } from "./Capture";
import { Loading, Modal, useAction } from "./ui";
import { FullEditEntry } from "./FullEdit";
import { EditSale } from "../pages/Corrections";
import { PRODUCTS, num, pkr } from "../lib/format";

const dt = (s: string) => new Date(s).toLocaleString("en-PK", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  if (v == null || v === "" || v === false) return null;
  return <div className="flex justify-between gap-3 py-1 text-sm"><span className="text-slate-500">{k}</span><span className="text-right font-medium tabular-nums">{v}</span></div>;
}

/** The same "View" panel for one wholesale client entry (supply / payment / return). Editing a wholesale entry stays on
 *  the client page's own pencil (FullEditEntry), so this panel is view + print + WhatsApp. */
export function WholesaleEntryView({ clientId, txnId, onClose }: { clientId: number; txnId: number; onClose: () => void }) {
  const { data, error } = useApi<any>(`/wholesale/clients/${clientId}/txn/${txnId}/detail`);
  const { busy, run } = useAction();
  const e = data?.entry;
  const whatsapp = () => run(() => api(`/wholesale/clients/${clientId}/txn/${txnId}/whatsapp`, { body: {} }), "Client ko WhatsApp par bhej diya");
  const TY: Record<string, string> = { supply: "Supply (fuel diya)", payment: "Payment (jama)", return: "Return (wapas)", adjustment: "Adjustment", carriage: "Kiraya" };
  return (
    <Modal open onClose={onClose} title="Entry details · تفصیل">
      {error && <div className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{String(error)}</div>}
      {!data ? <Loading /> : (
        <div className="space-y-3">
          <div className="rounded-xl border border-slate-200 p-3">
            <Row k="Kism" v={TY[e.type] ?? e.type} />
            <Row k="Tareekh / waqt" v={dt(e.txn_date ?? e.created_at)} />
            <Row k="Amount" v={<span className={e.type === "payment" || e.type === "return" ? "text-emerald-700" : ""}>{pkr(e.amount)}</span>} />
            <Row k="Fuel" v={e.product ? (PRODUCTS[e.product] ?? e.product) : null} />
            <Row k="Litres" v={e.litres != null ? `${num(e.litres, 2)} L` : null} />
            <Row k="Rate" v={e.rate != null ? `Rs ${Number(e.rate).toFixed(2)}/L` : null} />
            <Row k="Gaari" v={e.vehicle_no} />
            <Row k="Driver" v={e.driver_name} />
            <Row k="Location" v={e.location} />
            <Row k="Method" v={e.method} />
            <Row k="Station" v={e.station_name} />
            <Row k="Reference" v={e.ref} />
            <Row k="Note" v={e.note} />
            <Row k="Entry ki" v={e.created_by} />
            {e.voided ? <Row k="VOID" v={e.void_reason ?? "voided"} /> : null}
            {e.proof_ids?.length ? <div className="pt-1"><ProofThumbs ids={e.proof_ids} /></div> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data.print_url && <a className="btn-secondary" href={`${data.print_url}?print=1`} target="_blank" rel="noreferrer"><Printer size={15} /> Print / PDF</a>}
            {data.can_whatsapp && <button className="btn-secondary" disabled={busy} onClick={whatsapp}><Send size={15} /> WhatsApp</button>}
          </div>
          {!data.can_whatsapp && <p className="text-xs text-slate-500">WhatsApp ke liye client ka number add karein.</p>}
          {!data.print_url && <p className="text-xs text-slate-500">Is kism ki entry ka print slip nahi (sirf nozzle supply ka hota hai).</p>}
        </div>
      )}
    </Modal>
  );
}

export function EntryView({ customerId, lineId, canEdit, onClose, onChanged }: { customerId: number; lineId: number; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const { data, error, reload } = useApi<any>(`/customers/${customerId}/ledger/${lineId}/detail`);
  const { busy, run } = useAction();
  const [editing, setEditing] = useState(false);

  if (editing && data?.sale && data.can_edit_sale)
    return <EditSale sale={data.sale} onClose={() => setEditing(false)} onDone={() => { setEditing(false); reload(); onChanged(); }} />;
  if (editing && data?.can_edit_entry)
    return <FullEditEntry kind="khata" id={lineId} onClose={() => setEditing(false)} onDone={() => { setEditing(false); reload(); onChanged(); }} />;

  const e = data?.entry, s = data?.sale;
  const whatsapp = () => run(() => api(`/customers/${customerId}/ledger/${lineId}/whatsapp`, { body: {} }), "Customer ko WhatsApp par bhej diya");
  return (
    <Modal open onClose={onClose} title="Entry details · تفصیل">
      {error && <div className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{String(error)}</div>}
      {!data ? <Loading /> : (
        <div className="space-y-3">
          <div className="rounded-xl border border-slate-200 p-3">
            <Row k="Kism" v={e.type === "credit" ? "Payment (jama)" : "Charge (udhaar)"} />
            <Row k="Tareekh / waqt" v={dt(e.created_at)} />
            <Row k="Amount" v={<span className={data.is_refund ? "text-rose-700" : e.type === "credit" ? "text-emerald-700" : ""}>{data.is_refund ? "− " : e.type === "credit" ? "−" : "+"}{pkr(e.amount)}{data.is_refund ? " (paisa bahar)" : ""}</span>} />
            <Row k="Payment method · طریقہ" v={data.method ? <span className="capitalize">{data.method}{data.is_refund ? " (advance wapas)" : ""}</span> : null} />
            <Row k="Bank / account" v={data.account_name} />
            <Row k="Fuel" v={e.product ? (PRODUCTS[e.product] ?? e.product) : null} />
            <Row k="Litres" v={e.litres != null ? `${num(e.litres, 2)} L` : null} />
            <Row k="Rate" v={e.rate != null ? `Rs ${Number(e.rate).toFixed(2)}/L` : null} />
            <Row k="Gaari" v={e.vehicle_no} />
            <Row k="Slip / parchi" v={e.slip_no} />
            <Row k="Station" v={e.station_name} />
            <Row k="Note" v={e.note} />
            <Row k="Reference" v={e.ref} />
            {e.proof_ids?.length ? <div className="pt-1"><ProofThumbs ids={e.proof_ids} /></div> : null}
          </div>
          {s && (s.cash_back_litres > 0 || s.khareed > 0) && (
            <div className="rounded-xl bg-amber-50/60 p-3 ring-1 ring-amber-200">
              <div className="mb-1 text-xs font-semibold text-amber-900">Parchi se kam tel · baqi cash / saman</div>
              <Row k="Nozzle se tel" v={`${num(s.litres, 2)} L`} />
              <Row k="Baqi / parchi litres" v={`${num(s.cash_back_litres, 2)} L`} />
              <Row k="Baqi value" v={pkr(Math.round(s.cash_back_litres * s.rate))} />
              <Row k="Cash di (bag se)" v={s.cash_back > 0 ? pkr(s.cash_back) : null} />
              <Row k="Shop saman (lagat)" v={s.items_cost > 0 ? pkr(s.items_cost) : null} />
              <Row k="Saman detail" v={s.items_note} />
              <Row k="Khareed (munafa)" v={<span className="text-emerald-700">{pkr(s.khareed)}</span>} />
            </div>
          )}
          {s && (
            <div className="rounded-xl border border-slate-200 p-3">
              {s.discount > 0 && <Row k="Discount" v={`− ${pkr(s.discount)}`} />}
              <Row k="Payment method" v={<span className="capitalize">{s.payment_method}</span>} />
              <Row k="Entry ki" v={s.created_by_name} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {data.print_url && <a className="btn-secondary" href={`${data.print_url}?print=1`} target="_blank" rel="noreferrer"><Printer size={15} /> Print / PDF</a>}
            {data.can_whatsapp && <button className="btn-secondary" disabled={busy} onClick={whatsapp}><Send size={15} /> WhatsApp</button>}
            {canEdit && (data.can_edit_sale || data.can_edit_entry) && <button className="btn-primary ml-auto" onClick={() => setEditing(true)}><Pencil size={15} /> Edit</button>}
          </div>
          {canEdit && !(data.can_edit_sale || data.can_edit_entry) && <p className="text-xs text-slate-500">Ye entry yahan se edit nahi hoti (meter-settlement / shop / coupon type). Zaroorat ho to Corrections se void karein.</p>}
          {!data.can_whatsapp && <p className="text-xs text-slate-500">WhatsApp ke liye customer ka number add karein.</p>}
        </div>
      )}
    </Modal>
  );
}
