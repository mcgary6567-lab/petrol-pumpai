/**
 * Menu search that finds a page by what is INSIDE it, not only by its menu name: "stations", "meter reset", "pin",
 * "logo", "udhaar", "gari number"… Each query word must match the page's name, its Urdu name or one of its keywords —
 * by word start, inside a word, or with one or two typos ("setings", "supplir") — and the best matches come first.
 */

/** What each page holds, in the words people actually type (English + Roman Urdu). */
export const PAGE_WORDS: Record<string, string> = {
  "/": "home dashboard khulasa summary today aaj owed lena dena net position profit money in out",
  "/reports": "report daily monthly sale summary print pdf rozana",
  "/sales-history": "sale history purani sales receipt bill invoice litre",
  "/insights": "owner insights analysis trend graph chart",
  "/owner-report": "monthly report pdf mahana",
  "/discounts-report": "discount riayat override rate kam",
  "/other-entries": "other income expense mutafarriq aamdan kharcha",
  "/margins": "margin target hadaf profit per litre",
  "/profit": "profit munafa explainer nafa nuqsan loss",
  "/suggestions": "suggestion tajaweez idea advice",
  "/inbox": "whatsapp message chat inbox sms",
  "/pos": "pos sale sell bechna fuel petrol diesel hsd pmg nozzle receipt bill undo walk-in cash card",
  "/shifts": "shift open close band kholna meter reading nozzle salesman handover cash short excess dip meter reset repair kharab",
  "/customers": "customer gahak khata vehicle gari gaari number plate phone statement ledger",
  "/khata": "khata credit udhaar udhar baqi balance recovery wasooli statement ledger",
  "/prepaid": "coupon wallet prepaid advance voucher card",
  "/card-pending": "card pending khata bank card",
  "/wholesale": "wholesale bulk client supply tanker trip order recovery wasooli rate udhaar maal bypass officer",
  "/carriage": "carriage kiraya freight thekedar transport bilty",
  "/cashier": "cashier receive pay wasooli adaigi cheque day book roznamcha voucher rv pv bank handover",
  "/expenses": "expense kharcha bill bijli utility salary approval",
  "/cash": "cash bank book balance account transfer deposit jama nikal",
  "/accounts": "accounts tax ledger balance sheet trial journal p&l profit loss fbr gst withholding",
  "/suppliers": "supplier depot company pso shell total attock go maal purchase bill payment statement invoice gari",
  "/investors": "investor investment sarmaya sarmayakar capital partner deal munafa profit share 60 40 hissa payout ledger",
  "/property": "property rent kiraya dukan shop rent",
  "/orders": "order booking delivery customer order",
  "/bookings": "booking appointment service car wash oil change",
  "/complaints": "complaint shikayat issue",
  "/campaigns": "campaign sms whatsapp offer promotion mahim",
  "/stock": "tank stock dip level litre fuel reorder decant leakage gain loss",
  "/dip-charts": "dip chart calibration tank table mm cm",
  "/register": "stock register record purchase sale balance",
  "/shop": "shop lubricant mobil oil item product saman store inventory",
  "/prices": "price rate change petrol diesel ogra new rate",
  "/alerts": "alert notification warning ittila",
  "/automations": "automation ai auto schedule bot",
  "/staff": "staff salary tankhwa advance loan employee mulazim",
  "/kiosk": "attendance hazri kiosk check in out face",
  "/roster": "roster duty schedule time",
  "/team": "rating commission incentive performance",
  "/checklist": "daily check checklist",
  "/compliance": "licence license checklist explosive ogra safety expiry",
  "/machines": "machine dispenser generator compressor service repair warranty fault",
  "/my-account": "my account profile password pin apna hisaab salary",
  "/help": "help guide rehnumai how to tutorial",
  "/users": "user role login access permission password pin staff login manager salesman cashier",
  "/audit": "audit log history changes kis ne kya",
  "/security": "security score password 2fa",
  "/corrections": "correction void cancel mansookh delete undo galti",
  "/go-live": "go live checklist setup start",
  "/opening-balances": "opening balance purana hisaab go live",
  "/lists": "list category type dropdown lookups",
  "/settings": "settings setup business profile logo brand colour name address phone ntn strn social",
};

/** Sections inside the Settings page — a hit opens Settings and scrolls straight to that box. */
export const SETTINGS_SECTIONS: { id: string; label: string; words: string }[] = [
  { id: "set-profile", label: "Business profile & branding", words: "business profile branding logo colour color name owner phone email address city ntn strn website social facebook instagram receipt sign-in link" },
  { id: "set-team", label: "Team & access", words: "team access users roles login" },
  { id: "set-stations", label: "Stations, tanks & meters", words: "station stations tank tanks meter meters nozzle nozzles dispenser meter reset repair kharab reading capacity add tank add meter retire" },
  { id: "set-limits", label: "Limits & tolerances", words: "limit limits tolerance shortage excess cash short variance" },
  { id: "set-messages", label: "Automatic messages & bookkeeping", words: "automatic messages whatsapp sms bookkeeping daily brief" },
  { id: "set-khata", label: "Khata rules", words: "khata rules credit limit udhaar discount" },
  { id: "set-safety", label: "Safety rules", words: "safety rules cancel pin void pin mansookh pin approval" },
  { id: "set-hardware", label: "Hardware connections", words: "hardware printer scanner atg probe connection" },
  { id: "set-alerts", label: "Alert sensitivity", words: "alert sensitivity threshold" },
  { id: "set-backups", label: "Backups", words: "backup restore google drive dropbox download" },
];

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** edit distance, or Infinity once it is over the limit (stops early) */
function dist(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return Infinity;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return Infinity;
    prev = cur;
  }
  return prev[b.length] <= max ? prev[b.length] : Infinity;
}
const within = (a: string, b: string, max: number) => dist(a, b, max) <= max;

/** how well one typed word fits a field's words: 3 = word starts with it, 2 = inside a word, 1.5 / 0.75 = one / two typos away, 0 = no */
function fit(token: string, words: string[]) {
  let s = 0;
  const max = token.length >= 7 ? 2 : 1;
  for (const w of words) {
    if (w.startsWith(token)) return 3;
    if (token.length >= 4 && w.includes(token)) { s = Math.max(s, 2); continue; }
    if (token.length < 4) continue;
    const d = Math.min(dist(token, w, max), dist(token, w.slice(0, token.length + 1), max), dist(token, w.slice(0, token.length), max));
    if (d <= max) s = Math.max(s, d <= 1 ? 1.5 : 0.75);
  }
  return s;
}

export type Searchable = { label: string; ur?: string; words?: string };

/** score of an item for the query (0 = not a match). Name matches outweigh keyword matches. */
export function scoreItem(query: string, it: Searchable): number {
  const raw = query.trim();
  if (!raw) return 0;
  const q = norm(raw);
  const label = norm(it.label), lw = label.split(" "), kw = norm(it.words ?? "").split(" ").filter(Boolean);
  // Urdu typed: plain contains on the Urdu name
  if (/[؀-ۿ]/.test(raw)) return (it.ur ?? "").includes(raw) ? 50 : 0;
  const tokens = q.split(" ").filter(Boolean);
  if (!tokens.length) return 0;
  let total = 0;
  for (const tk of tokens) {
    const inName = fit(tk, lw), inWords = fit(tk, kw);
    if (!inName && !inWords) return 0;
    total += Math.max(inName * 4, inWords * 2);
  }
  if (label.startsWith(q)) total += 20;
  else if (label.includes(` ${q}`)) total += 10;
  return total;
}

/** the keywords that explain why a page matched (shown under the hit, e.g. "stations · meter reset") */
export function whyMatched(query: string, it: Searchable): string {
  const tokens = norm(query).split(" ").filter(Boolean);
  const label = norm(it.label).split(" ");
  if (tokens.every((t) => fit(t, label) > 0)) return "";
  const kw = norm(it.words ?? "").split(" ").filter(Boolean);
  const shown = new Set<string>();
  for (const t of tokens) {
    const w = kw.find((x) => x.startsWith(t)) ?? kw.find((x) => t.length >= 4 && x.includes(t)) ?? kw.find((x) => t.length >= 4 && within(t, x, t.length >= 7 ? 2 : 1));
    if (w) shown.add(w);
  }
  return [...shown].join(" · ");
}
