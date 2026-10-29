import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { num } from "../lib/format";

/** Shared pieces of the wholesale ERP pages, so every page has the same bar, search box and section style. */
export const Ur = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => <span lang="ur" dir="rtl" className={`font-urdu ${className}`}>{children}</span>;

/** The page bar: breadcrumb, title (with Urdu), then the filters and actions on the right. Sticks to the top while scrolling. */
export function ErpBar({ crumb, title, ur, children }: { crumb: string; title: string; ur: string; children?: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white/95 px-4 py-2.5 shadow-sm backdrop-blur print:hidden sm:gap-3">
      <div className="mr-auto min-w-0">
        <div className="text-[11px] text-slate-500"><Link to="/wholesale" className="hover:underline">Wholesale</Link> › {crumb}</div>
        <h1 className="truncate text-lg font-bold leading-tight sm:text-xl">{title} · <Ur className="text-base font-normal">{ur}</Ur></h1>
      </div>
      {children}
    </div>
  );
}

/** Search box with the magnifier, same size everywhere. */
export function ErpSearch({ value, onChange, placeholder = "Dhoondein… · تلاش", className = "" }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <label className={`relative block ${className}`}>
      <Search size={15} className="absolute left-2.5 top-2.5 text-slate-400" />
      <input className="input pl-8" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Search" />
      {value && <button type="button" aria-label="Clear" className="absolute right-2 top-1.5 px-1 text-slate-400 hover:text-slate-700" onClick={() => onChange("")}>×</button>}
    </label>
  );
}

/** Balance with its side in plain words: a positive balance is money the client owes us, a negative one is their advance with us. */
export const bal = (n: number) => (Math.abs(n) < 0.5 ? "0" : n > 0 ? num(Math.round(n)) : `Adv ${num(Math.round(-n))}`);
