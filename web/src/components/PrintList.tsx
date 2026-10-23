/**
 * "Print" for a master list (khata customers, wholesale clients, suppliers, shop items, thekedars): the rows currently on
 * screen (after search / chips) go on A4 with the pump's letterhead, a totals line and the print time. Uses the same hidden
 * frame as the trip papers, so the app around the list is never printed; on a phone it opens a tab with a Print / PDF button.
 */
import { Printer } from "lucide-react";
import { useBusiness } from "./Letterhead";
import { printPages } from "./TripPrint";
import { SOCIALS, handle } from "../lib/social";
import { phone as fmtPhone } from "../lib/format";
import { useAuth } from "../App";

export type PrintCol<T> = {
  label: string;
  /** right-align (numbers) */
  r?: boolean;
  /** main cell text */
  v: (row: T) => string | number | null | undefined;
  /** small grey second line */
  sub?: (row: T) => string | null | undefined;
  /** totals row text for this column */
  total?: (rows: T[]) => string | number | null | undefined;
  /** cell colour: "pos" = green (credit / money in), "neg" = red (debit / money out) */
  tone?: (row: T) => "pos" | "neg" | "" | undefined;
  /** colour for this column's totals cell */
  totalTone?: "pos" | "neg" | "";
};
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function letterhead(b: any, title: string, sub: string, by?: string) {
  const ph = fmtPhone(b.biz_phone || b.owner_phone);
  return `<div class="head"><div>${b.logo_url ? `<img class="logo" src="${esc(b.logo_url)}">` : ""}<div class="biz">${esc(b.name)}</div>${b.omc ? `<div class="muted">${esc(b.omc)} dealer</div>` : ""}
    <div class="muted">${esc([b.place, ph ? `☎ ${ph}` : ""].filter(Boolean).join(" · "))}</div>
    ${b.ntn || b.strn ? `<div class="muted">${b.ntn ? `NTN ${esc(b.ntn)}` : ""}${b.ntn && b.strn ? " · " : ""}${b.strn ? `STRN ${esc(b.strn)}` : ""}</div>` : ""}</div>
    <div class="title"><b>${esc(title)}</b><div class="muted">${esc(sub)}</div><div class="muted">Printed ${new Date().toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" })}${by ? ` by ${esc(by)}` : ""}</div></div></div>`;
}
function footer(b: any) {
  const line = [b.place, b.biz_email, b.website].filter(Boolean).map(esc).join(" · ");
  const soc = SOCIALS.filter((s) => b[s.key]).map((s) => `<span><svg viewBox="0 0 24 24">${s.svg}</svg>${esc(handle(b[s.key]))}</span>`).join("");
  return line || soc || b.receipt_footer ? `<div class="foot">${line ? `<div>${line}</div>` : ""}${soc ? `<div class="soc">${soc}</div>` : ""}${b.receipt_footer ? `<div><b>${esc(b.receipt_footer)}</b></div>` : ""}</div>` : "";
}

/** The HTML of one list page (exported for tests / other callers). */
export function listPage<T>(b: any, title: string, sub: string, columns: PrintCol<T>[], rows: T[], by?: string, note?: string) {
  const hasTotal = columns.some((c) => c.total);
  const body = rows.map((r, i) => `<tr><td class="no">${i + 1}</td>${columns.map((c) => {
    const s = c.sub?.(r);
    const tone = c.tone?.(r);
    return `<td class="${c.r ? "r" : ""}${tone ? ` ${tone}` : ""}">${esc(c.v(r) ?? "—")}${s ? `<div class="muted">${esc(s)}</div>` : ""}</td>`;
  }).join("")}</tr>`).join("");
  const totals = hasTotal ? `<tr class="total"><td></td>${columns.map((c, i) => `<td class="${c.r ? "r" : ""}${c.totalTone ? ` ${c.totalTone}` : ""}">${i === 0 && !c.total ? `Total · کل (${rows.length})` : esc(c.total?.(rows) ?? "")}</td>`).join("")}</tr>` : "";
  return `<div class="page">${letterhead(b ?? {}, title, sub, by)}
    <table class="list"><thead><tr><th>#</th>${columns.map((c) => `<th class="${c.r ? "r" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${body}${totals}</tbody></table>
    ${note ? `<div class="note">${esc(note)}</div>` : ""}${footer(b ?? {})}</div>
    <style>table.list td.no{color:#64748b;width:2.2em}table.list td{vertical-align:top;font-size:12px}table.list th{font-size:10.5px}table.list td .muted{font-size:10px}table.list tr{page-break-inside:avoid}table.list td.r{white-space:normal}@media screen{.page{overflow-x:auto}}</style>`;
}

export function PrintListButton<T>({ title, subtitle, columns, rows, note, className = "", label = "Print" }: { title: string; subtitle?: string; columns: PrintCol<T>[]; rows: T[]; note?: string; className?: string; label?: string }) {
  const b = useBusiness();
  const { user, tenant } = useAuth() as any;
  const go = () => printPages(title, listPage(b, title, `${subtitle ? `${subtitle} · ` : ""}${rows.length} rows`, columns, rows, user?.name, note), tenant?.color ?? b?.color);
  return (
    <button type="button" className={`btn-secondary ${className}`} onClick={go} disabled={!rows.length} title="Jo list screen par hai wahi letterhead ke saath print / PDF">
      <Printer size={15} /> {label}
    </button>
  );
}
