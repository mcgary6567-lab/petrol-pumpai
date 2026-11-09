/**
 * "Asaan mode" — the simple, big-button face of the app for salesmen, cashiers and anyone who finds the full screens
 * too busy. One job per tile, the number biggest, every label in Roman Urdu + Urdu, one meaning per colour
 * (green = money in / OK, red = money out / danger, amber = attention). Text is never light grey, touch targets ≥ 64 px.
 *
 * Building blocks: BigAction (home tile), MoneyCard (ledger card), NumPad (calculator keypad), TankGauge.
 * The mode is a per-device choice (localStorage), ON by default for salesman and cashier; everyone can switch it.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowDownCircle, ArrowUpCircle, Delete, Fuel, HandCoins, LogIn, LogOut, Receipt, RefreshCw, ShoppingCart } from "lucide-react";
import { useApi } from "../lib/api";
import { useAuth } from "../App";
import { num, pkr, PRODUCTS, PRODUCT_UR } from "../lib/format";
import { toWords } from "../lib/words";

/* ------------------------------------------------------------------ the mode switch ------------------------------------------------------------------ */
const KEY = "pumpai_asaan";
const subs = new Set<() => void>();
const read = (): "1" | "0" | null => { try { const v = localStorage.getItem(KEY); return v === "1" || v === "0" ? v : null; } catch { return null; } };
/** Roles that start in Asaan mode until they switch it off. */
export const ASAAN_DEFAULT_ROLES = ["salesman", "cashier"];
export function useAsaan(): [boolean, (on: boolean) => void] {
  const { user } = useAuth();
  const v = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, read, () => null);
  const on = v === null ? ASAAN_DEFAULT_ROLES.includes(user?.role ?? "") : v === "1";
  const set = (x: boolean) => { try { localStorage.setItem(KEY, x ? "1" : "0"); } catch { /* private window: this visit only */ } subs.forEach((f) => f()); };
  return [on, set];
}

/** The switch shown in the menu: big, both languages, says what it does. */
export function AsaanToggle({ dark = true }: { dark?: boolean }) {
  const [on, set] = useAsaan();
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => set(!on)}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold ${dark ? "bg-white/10 text-white hover:bg-white/15" : "bg-slate-100 text-ink"}`}>
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-emerald-400" : "bg-white/30"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
      </span>
      <span className="min-w-0 flex-1 leading-tight">Asaan mode<span lang="ur" dir="rtl" className="font-urdu block text-xs font-normal opacity-80">آسان موڈ — بڑے بٹن</span></span>
    </button>
  );
}

/* ------------------------------------------------------------------ building blocks ------------------------------------------------------------------ */
const Urdu = ({ children, className = "" }: { children: ReactNode; className?: string }) => <span lang="ur" dir="rtl" className={`font-urdu ${className}`}>{children}</span>;

type Tone = "in" | "out" | "warn" | "ink" | "brand";
const TILE: Record<Tone, string> = {
  in: "bg-in text-white ring-in-ring", out: "bg-out text-white ring-out-ring", warn: "bg-warn text-white ring-warn-ring",
  ink: "bg-ink text-white ring-slate-400", brand: "bg-brand-700 text-white ring-brand-500",
};

/** A home-screen tile: full width, ≥ 104 px, a big icon, the action in Roman Urdu and Urdu, an optional line under it. */
export function BigAction({ to, onClick, icon: Icon, en, ur, sub, tone = "brand" }: { to?: string; onClick?: () => void; icon: any; en: string; ur: string; sub?: ReactNode; tone?: Tone }) {
  const body = (
    <>
      <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-white/15"><Icon size={40} strokeWidth={2.25} aria-hidden /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-act uppercase tracking-wide">{en}</span>
        <Urdu className="block text-ur-act">{ur}</Urdu>
        {sub && <span className="mt-0.5 block text-base font-semibold opacity-95">{sub}</span>}
      </span>
      <span className="text-3xl font-black opacity-80" aria-hidden>›</span>
    </>
  );
  const cls = `flex min-h-tap-xl w-full items-center gap-4 rounded-3xl px-5 py-4 text-left shadow-lg ring-4 ring-transparent transition active:scale-[.98] focus-visible:outline-none focus-visible:ring-offset-2 focus-visible:ring-ink ${TILE[tone]}`;
  return to ? <Link to={to} className={cls}>{body}</Link> : <button type="button" onClick={onClick} className={cls}>{body}</button>;
}

/** A ledger card: label on top, the number biggest, a thick colour edge that says good (green) or owed (red). */
export function MoneyCard({ en, ur, value, tone = "ink", sub }: { en: string; ur: string; value: number | null | undefined; tone?: "in" | "out" | "ink"; sub?: ReactNode }) {
  const edge = tone === "in" ? "border-in bg-in-bg" : tone === "out" ? "border-out bg-out-bg" : "border-slate-300 bg-white";
  const text = tone === "in" ? "text-in" : tone === "out" ? "text-out" : "text-ink";
  return (
    <div className={`rounded-2xl border-2 border-l-8 p-4 ${edge}`}>
      <div className="flex items-baseline justify-between gap-2"><span className="text-base font-bold text-ink">{en}</span><Urdu className="text-lg text-ink">{ur}</Urdu></div>
      <div className={`mt-1 text-num-lg tabular-nums sm:text-num-xl ${text}`}>{value == null ? "—" : pkr(value)}</div>
      {sub && <div className="mt-1 text-sm font-semibold text-slate-700">{sub}</div>}
    </div>
  );
}

/** Calculator keypad for amounts: 72 px keys, a 000 key, the amount big on top and in words under it. */
export function NumPad({ value, onChange, max = 1_000_000_000, label = "Raqam", ur = "رقم" }: { value: string; onChange: (v: string) => void; max?: number; label?: string; ur?: string }) {
  const n = Number(value) || 0;
  const press = (k: string) => {
    if (k === "back") return onChange(value.slice(0, -1));
    if (k === "clear") return onChange("");
    const next = (value === "0" ? "" : value) + k;
    if (Number(next) > max || next.length > 12) return;
    onChange(next.replace(/^0+(?=\d)/, ""));
  };
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "000", "0", "back"];
  return (
    <div className="rounded-3xl border-2 border-slate-300 bg-white p-3">
      <div className="flex items-baseline justify-between px-1"><span className="text-base font-bold text-ink">{label}</span><Urdu className="text-lg text-ink">{ur}</Urdu></div>
      <output aria-live="polite" className="block px-1 text-right text-num-xl tabular-nums text-ink">{n ? `Rs ${num(n)}` : "Rs 0"}</output>
      <p className="min-h-5 px-1 text-right text-sm font-semibold text-slate-700">{n > 0 ? toWords(n) : " "}</p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {keys.map((k) => (
          <button key={k} type="button" onClick={() => press(k)} aria-label={k === "back" ? "Mitao" : k}
            className={`flex h-[72px] items-center justify-center rounded-2xl text-3xl font-extrabold active:scale-95 ${k === "back" ? "bg-out-bg text-out" : "bg-slate-100 text-ink hover:bg-slate-200"}`}>
            {k === "back" ? <Delete size={30} /> : k}
          </button>
        ))}
      </div>
      {n > 0 && <button type="button" onClick={() => press("clear")} className="mt-2 w-full rounded-xl py-2 text-base font-bold text-slate-700 underline">Saaf karein · <Urdu>صاف کریں</Urdu></button>}
    </div>
  );
}

const LIGHT = {
  green: { bar: "bg-in", text: "text-in", bg: "bg-in-bg border-in-ring", en: "Theek hai", ur: "ٹھیک ہے" },
  amber: { bar: "bg-warn", text: "text-warn", bg: "bg-warn-bg border-warn-ring", en: "Order kar dein", ur: "آرڈر کر دیں" },
  red: { bar: "bg-out", text: "text-out", bg: "bg-out-bg border-out-ring", en: "Fauran order karein!", ur: "فوراً آرڈر کریں!" },
} as const;
const daysText = (d: number | null) => (d == null ? null : d < 1 ? "1 din se kam" : `${d % 1 ? d.toFixed(1) : d} din`);

/** One tank as a big upright gauge: fill level, litres, days of fuel left, traffic-light colour. */
export function TankGauge({ t }: { t: any }) {
  const L = LIGHT[t.light as keyof typeof LIGHT] ?? LIGHT.green;
  return (
    <div className={`flex items-center gap-4 rounded-3xl border-2 p-4 ${L.bg}`}>
      <div className="relative h-32 w-16 shrink-0 overflow-hidden rounded-2xl border-4 border-ink bg-white" role="img" aria-label={`${t.pct}% bhara`}>
        <div className={`absolute inset-x-0 bottom-0 ${L.bar}`} style={{ height: `${Math.max(3, t.pct)}%` }} />
        <span className="absolute inset-x-1 top-1 rounded-md bg-white/95 text-center text-sm font-black text-ink shadow-sm">{t.pct}%</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2"><span className="text-act text-ink">{PRODUCTS[t.product] ?? t.product}</span><Urdu className="text-ur-act text-ink">{PRODUCT_UR[t.product] ?? ""}</Urdu><span className="text-sm font-semibold text-slate-700">{t.name}</span></div>
        <div className="text-num-lg tabular-nums text-ink">{num(t.current_l)} L</div>
        <div className={`text-lg font-extrabold leading-snug ${L.text}`}>{daysText(t.days_left) ? <>{daysText(t.days_left)} ka tail · </> : null}{L.en}<Urdu className="block text-lg font-normal">{L.ur}</Urdu></div>
        {t.per_day_l > 0 && <div className="text-sm font-semibold text-slate-700">Roz ki sale ~{num(t.per_day_l)} L · {num(t.capacity_l)} L ka tank</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ screens ------------------------------------------------------------------ */
function useHome() { return useApi<any>("/asaan/home", 60_000); }

/** The worst tank, as a banner on top of the home screen (only when one needs fuel). */
function TankBanner({ tanks }: { tanks: any[] }) {
  const bad = [...tanks].filter((t) => t.light !== "green").sort((a, b) => (a.light === "red" ? -1 : 1) - (b.light === "red" ? -1 : 1))[0];
  if (!bad) return null;
  const red = bad.light === "red";
  return (
    <Link to="/tanks-level" className={`flex items-center gap-3 rounded-2xl border-2 px-4 py-3 ${red ? "border-out bg-out text-white" : "border-warn-ring bg-warn-bg text-warn"}`}>
      {/* only the icon blinks — the text keeps full contrast for sunlight */}
      <span className="relative flex shrink-0"><Fuel size={32} aria-hidden />{red && <span className="absolute -right-1 -top-1 h-3.5 w-3.5 rounded-full bg-white motion-safe:animate-ping" aria-hidden />}</span>
      <span className="min-w-0 flex-1 text-lg font-extrabold leading-tight">{PRODUCTS[bad.product] ?? bad.product}: {daysText(bad.days_left) ?? `${bad.pct}%`} ka tail baqi!<Urdu className="block text-base font-normal">{PRODUCT_UR[bad.product] ?? ""} کم ہے — {red ? "فوراً آرڈر کریں" : "آرڈر کر دیں"}</Urdu></span>
    </Link>
  );
}

/** Salesman / cashier home: three or four big tiles and the one number that matters. */
export function AsaanHome() {
  const { user, can, modules } = useAuth();
  const { data, reload } = useHome();
  const cashier = can("cashier.desk");
  const shift = data?.shift;
  return (
    <div className="mx-auto max-w-xl space-y-4 pb-28">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0"><h1 className="truncate text-2xl font-extrabold text-ink">Salam, {user?.name?.split(" ")[0]}</h1><Urdu className="text-lg text-ink">آج کیا کرنا ہے؟</Urdu></div>
        <button type="button" onClick={() => reload()} className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-ink" aria-label="Taaza karein"><RefreshCw size={26} /></button>
      </div>

      {data?.tanks && <TankBanner tanks={data.tanks} />}

      {cashier ? <>
        <BigAction to="/cashier?tab=receive" icon={ArrowDownCircle} tone="in" en="Paisa aaya" ur="رقم آئی — وصولی" sub="Khata, client, supplier se" />
        <BigAction to="/cashier?tab=pay" icon={ArrowUpCircle} tone="out" en="Paisa gaya" ur="رقم گئی — ادائیگی" sub="Kharcha, supplier, advance" />
        {can("shifts.handover") && <BigAction to="/cashier?tab=handover" icon={HandCoins} tone="ink" en="Salesman se cash" ur="سیلزمین سے کیش لیں" />}
      </> : <>
        <BigAction to="/shifts" icon={shift ? LogOut : LogIn} tone={shift ? "out" : "in"}
          en={shift ? "Shift band karein" : "Shift shuru karein"} ur={shift ? "شفٹ ختم کریں" : "شفٹ شروع کریں"}
          sub={shift ? `Chal rahi hai · ${shift.station_name}` : "Abhi koi shift nahi"} />
        {modules.pos
          ? <BigAction to="/pos" icon={ShoppingCart} tone="brand" en="Sale darj karein" ur="روزانہ کیش انٹری — فروخت" sub={shift ? `Is shift mein ${pkr(shift.sale_amount)} · ${num(shift.sale_litres)} L` : undefined} />
          : <BigAction to="/shifts" icon={Receipt} tone="brand" en="Aaj ka cash" ur="روزانہ کیش انٹری" />}
      </>}
      <BigAction to="/tanks-level" icon={Fuel} tone="warn" en="Tank mein tail kitna hai" ur="ٹینک میں تیل کتنا ہے" />

      {data?.cash_in_hand != null && <MoneyCard en="Galla abhi" ur="گلہ — ہاتھ میں کیش" value={data.cash_in_hand} tone="in" />}
      {shift && !cashier && <MoneyCard en="Is shift ki sale" ur="اس شفٹ کی فروخت" value={shift.sale_amount} tone="ink" sub={`${shift.sale_n} entries · ${num(shift.sale_litres)} L`} />}

      <p className="text-center text-sm font-semibold text-slate-700">Poora menu ☰ upar hai · <Urdu>باقی سب کچھ مینو میں</Urdu></p>
    </div>
  );
}

/** Tank levels for everyone (salesman included): one big gauge per tank, worst first. */
export function TanksLevel() {
  const { data, reload } = useHome();
  const tanks = [...(data?.tanks ?? [])].sort((a, b) => ["red", "amber", "green"].indexOf(a.light) - ["red", "amber", "green"].indexOf(b.light));
  useEffect(() => { const id = setInterval(() => reload(), 120_000); return () => clearInterval(id); }, [reload]);
  return (
    <div className="mx-auto max-w-xl space-y-3 pb-28">
      <div><h1 className="text-2xl font-extrabold text-ink">Tank mein tail kitna hai</h1><Urdu className="text-xl text-ink">ٹینک میں تیل کتنا ہے</Urdu></div>
      {!data ? <p className="text-lg font-semibold text-slate-700">Load ho raha hai…</p>
        : !tanks.length ? <p className="text-lg font-semibold text-slate-700">Koi tank nahi mila</p>
        : tanks.map((t) => <TankGauge key={t.id} t={t} />)}
      <p className="text-sm font-semibold text-slate-700">Din = pichle 7 din ki roz ki sale ke hisaab se. 🟢 3 din se zyada · 🟡 1½–3 din · 🔴 1½ din se kam.</p>
    </div>
  );
}

/** Tiny hook for pages that want a NumPad instead of the phone keyboard in Asaan mode. */
export function useNumPadOn() { const [on] = useAsaan(); const [touch] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches); return on && touch; }
