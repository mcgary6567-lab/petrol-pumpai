/** Expense management: categories with monthly budgets, approval flow, monthly summary vs revenue. */
import { Router, type Request } from "express";
import { z } from "zod";
import { all, get, run, tx, now, pkDate, getSetting, setSetting } from "../db.js";
import { h, parse, tid, requirePerm, requireAny, can } from "../auth.js";
import { bankAccountFor, accountIdField } from "./banks.js";
import { AppError, createAlert, pkr, round2 } from "../services.js";
import { linkPhotos } from "./capture.js";
import { sendToPhone } from "../whatsapp/cloud.js";
import { guardClosedDay, assertCashInHand } from "./backoffice.js";
import { registerDecider, requestApproval, closeApproval } from "./approvals.js";

export const expenses = Router();

export const DEFAULT_CATEGORIES: [string, number | null][] = [
  ["Salaries & wages", null], ["Electricity (bijli)", null], ["Generator fuel", null], ["Maintenance & repairs", null],
  ["Rent", null], ["Taxes & fees", null], ["Bank charges", null], ["Tanker freight & transport", null],
  ["Office & stationery", null], ["Tea & food", null], ["Security", null], ["Other", null],
];

/** A category typed by the user (POS / expense form): created once (case-insensitive), re-activated if it was switched off. */
/** The category an expense is booked under: an active one by name; a switched-off one is refused (the admin turned it off);
 *  an unknown name is created only when the form said so (allowNew — "apni likhein" or a quick button the list lacks). */
export function resolveCategory(tenantId: number, name: string, allowNew: boolean) {
  const n = name.trim().replace(/\s+/g, " ");
  const hit = get("SELECT id, name, active FROM expense_categories WHERE tenant_id=? AND lower(name)=lower(?)", tenantId, n);
  if (hit && hit.active) return hit.name as string;
  if (hit && !hit.active) throw new AppError(400, `"${hit.name}" category band hai — Settings → Expense categories me on karein ya doosri chunein`);
  if (!allowNew) throw new AppError(400, "Unknown category");
  return ensureCategory(tenantId, n);
}
export function ensureCategory(tenantId: number, name: string) {
  const n = name.trim().replace(/\s+/g, " ");
  const hit = get("SELECT id, name, active FROM expense_categories WHERE tenant_id=? AND lower(name)=lower(?)", tenantId, n);
  if (hit) { if (!hit.active) run("UPDATE expense_categories SET active=1 WHERE id=?", hit.id); return hit.name as string; }
  run("INSERT INTO expense_categories (tenant_id,name,monthly_budget) VALUES (?,?,NULL)", tenantId, n);
  return n;
}
export function ensureCategories(tenantId: number) {
  if (get("SELECT id FROM expense_categories WHERE tenant_id=? LIMIT 1", tenantId)) return;
  for (const [name, budget] of DEFAULT_CATEGORIES) run("INSERT INTO expense_categories (tenant_id,name,monthly_budget) VALUES (?,?,?)", tenantId, name, budget);
}

const approvalLimit = (t: number) => Number(getSetting(t, "expense_approval_limit", "10000"));
const monthOf = (d: string) => d.slice(0, 7);
const nextMonth = (m: string) => { const [y, mo] = m.split("-").map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; };
const prevMonth = (m: string) => { const [y, mo] = m.split("-").map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`; };

function checkBudget(t: number, category: string, month: string) {
  const cat = get("SELECT monthly_budget FROM expense_categories WHERE tenant_id=? AND name=?", t, category);
  if (!cat?.monthly_budget) return;
  const spent = get("SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE tenant_id=? AND category=? AND status='approved' AND expense_date >= ? AND expense_date < ?",
    t, category, month + "-01", nextMonth(month) + "-01")!.s;
  if (spent > cat.monthly_budget)
    createAlert(t, { type: "expense_budget", severity: "warning", title: `${category} over budget for ${month}`,
      body: `Spent ${pkr(spent)} of ${pkr(cat.monthly_budget)} budget.`, dedupe_key: `budget-${category}-${month}` });
}

/* ---------------- Categories & settings ---------------- */
/** Categories to pick from (switched-off ones are left out unless ?all=1 — the admin's category screen). */
expenses.get("/expense-categories", requireAny("expenses.view", "cash.pay"), h((req) => {
  ensureCategories(tid(req));
  return { categories: all(`SELECT * FROM expense_categories WHERE tenant_id=? ${req.query.all === "1" ? "" : "AND active=1"} ORDER BY name`, tid(req)), approval_limit: approvalLimit(tid(req)) };
}));
expenses.post("/expense-categories", requirePerm("expenses.approve"), h((req) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(60), monthly_budget: z.number().min(0).nullable().optional() }), req.body);
  const dup = get("SELECT id, active FROM expense_categories WHERE tenant_id=? AND name=?", tid(req), b.name);
  if (dup?.active) throw new AppError(400, "Category already exists");
  if (dup) { run("UPDATE expense_categories SET active=1 WHERE id=?", dup.id); return get("SELECT * FROM expense_categories WHERE id=?", dup.id); } // switched off earlier — bring it back
  return get("SELECT * FROM expense_categories WHERE id=?", run("INSERT INTO expense_categories (tenant_id,name,monthly_budget) VALUES (?,?,?)", tid(req), b.name, b.monthly_budget ?? null).id);
}));
/** Rename a category (its past expenses follow the new name), set its budget, or switch it off / on. */
expenses.patch("/expense-categories/:id", requirePerm("expenses.approve"), h((req) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(60).optional(), monthly_budget: z.number().min(0).nullable().optional(), active: z.boolean().optional() }), req.body);
  const t = tid(req);
  const c = get("SELECT * FROM expense_categories WHERE id=? AND tenant_id=?", Number(req.params.id), t);
  if (!c) throw new AppError(404, "Category not found");
  tx(() => {
    if (b.name && b.name !== c.name) {
      if (get("SELECT id FROM expense_categories WHERE tenant_id=? AND name=? AND id<>?", t, b.name, c.id)) throw new AppError(400, "Another category already has this name");
      run("UPDATE expense_categories SET name=? WHERE id=?", b.name, c.id);
      run("UPDATE expenses SET category=? WHERE tenant_id=? AND category=?", b.name, t, c.name);
      run("UPDATE recurring_expenses SET category=? WHERE tenant_id=? AND category=?", b.name, t, c.name);
    }
    if (b.monthly_budget !== undefined) run("UPDATE expense_categories SET monthly_budget=? WHERE id=?", b.monthly_budget, c.id);
    if (b.active !== undefined) run("UPDATE expense_categories SET active=? WHERE id=?", b.active ? 1 : 0, c.id);
  });
  return get("SELECT * FROM expense_categories WHERE id=?", c.id);
}));
/** Delete a category nothing uses; one with expenses is switched off instead. */
expenses.delete("/expense-categories/:id", requirePerm("expenses.approve"), h((req) => {
  const t = tid(req);
  const c = get("SELECT * FROM expense_categories WHERE id=? AND tenant_id=?", Number(req.params.id), t);
  if (!c) throw new AppError(404, "Category not found");
  if (get("SELECT id FROM expenses WHERE tenant_id=? AND category=? LIMIT 1", t, c.name) || get("SELECT id FROM recurring_expenses WHERE tenant_id=? AND category=? LIMIT 1", t, c.name))
    throw new AppError(400, "This category has expenses — switch it off instead");
  run("DELETE FROM expense_categories WHERE id=?", c.id);
  return { ok: true };
}));
expenses.put("/expenses/settings", requirePerm("expenses.approve"), h((req) => {
  const b = parse(z.object({ approval_limit: z.number().min(0) }), req.body);
  setSetting(tid(req), "expense_approval_limit", String(b.approval_limit));
  return { approval_limit: b.approval_limit };
}));

/* ---------------- List & summary ---------------- */
function filters(req: Request) {
  const q = parse(z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/).optional(), category: z.string().optional(),
    station_id: z.preprocess((v) => (v === "" || v == null ? undefined : v), z.coerce.number().int().positive().optional()),
    status: z.enum(["pending", "approved", "rejected"]).or(z.literal("")).optional(),
    method: z.enum(["cash", "bank", "jazzcash", "easypaisa", "raast", "cheque", "card"]).or(z.literal("")).optional(),
    q: z.string().trim().max(80).optional(), // paid to / note / receipt no / category
  }), req.query);
  const month = q.month ?? new Date().toISOString().slice(0, 7);
  return { ...q, month };
}

function listExpenses(t: number, f: ReturnType<typeof filters>) {
  const where = ["e.tenant_id=?", "e.expense_date >= ?", "e.expense_date < ?"];
  const args: (string | number)[] = [t, f.month + "-01", nextMonth(f.month) + "-01"];
  if (f.category) { where.push("e.category=?"); args.push(f.category); }
  if (f.station_id) { where.push("e.station_id=?"); args.push(f.station_id); }
  if (f.status) { where.push("e.status=?"); args.push(f.status); }
  if (f.method) { where.push("e.method=?"); args.push(f.method); }
  if (f.q) { const like = `%${f.q}%`; where.push("(e.paid_to LIKE ? OR e.note LIKE ? OR e.receipt_ref LIKE ? OR e.category LIKE ?)"); args.push(like, like, like, like); }
  return all(`SELECT e.*, s.name station_name FROM expenses e LEFT JOIN stations s ON s.id=e.station_id WHERE ${where.join(" AND ")} ORDER BY e.expense_date DESC, e.id DESC`, ...args);
}

expenses.get("/expenses", requirePerm("expenses.view"), h((req) => {
  const t = tid(req);
  ensureCategories(t);
  const f = filters(req);
  const start = f.month + "-01", end = nextMonth(f.month) + "-01";
  const pm = prevMonth(f.month);
  const total = (from: string, to: string) => get("SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE tenant_id=? AND status='approved' AND expense_date >= ? AND expense_date < ?", t, from, to)!.s;
  const byCategory = all(
    `SELECT c.name category, c.monthly_budget budget,
       COALESCE((SELECT SUM(amount) FROM expenses e WHERE e.tenant_id=c.tenant_id AND e.category=c.name AND e.status='approved' AND e.expense_date >= ? AND e.expense_date < ?),0) spent,
       COALESCE((SELECT SUM(amount) FROM expenses e WHERE e.tenant_id=c.tenant_id AND e.category=c.name AND e.status='approved' AND e.expense_date >= ? AND e.expense_date < ?),0) / 3.0 avg_3m
     FROM expense_categories c WHERE c.tenant_id=? ORDER BY spent DESC`,
    start, end, prevMonth(prevMonth(pm)) + "-01", start, t);
  const retail = get(`SELECT COALESCE(SUM(s.amount),0) a FROM sales s JOIN stations st ON st.id=s.station_id WHERE st.tenant_id=? AND s.created_at >= ? AND s.created_at < ?`, t, start, end)!.a;
  const wholesaleBilled = get(`SELECT COALESCE(SUM(CASE WHEN type='supply' THEN amount WHEN type='return' THEN -amount END),0) a FROM wholesale_txns WHERE tenant_id=? AND voided=0 AND txn_date >= ? AND txn_date < ?`, t, start, end)!.a;
  const monthTotal = total(start, end);
  return {
    month: f.month,
    expenses: listExpenses(t, f),
    summary: {
      total: round2(monthTotal), previous_month: round2(total(pm + "-01", f.month + "-01")),
      pending: get("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM expenses WHERE tenant_id=? AND status='pending'", t),
      by_category: byCategory.map((c) => ({ ...c, avg_3m: round2(c.avg_3m), over_budget: c.budget ? c.spent > c.budget : false })),
      by_method: all("SELECT method, ROUND(SUM(amount)) total FROM expenses WHERE tenant_id=? AND status='approved' AND expense_date >= ? AND expense_date < ? GROUP BY method", t, start, end),
      revenue: { retail: round2(retail), wholesale: round2(wholesaleBilled), total: round2(retail + wholesaleBilled) },
      revenue_minus_expenses: round2(retail + wholesaleBilled - monthTotal),
    },
    approval_limit: approvalLimit(t),
  };
}));

expenses.get("/expenses.csv", requirePerm("expenses.view"), (req, res, next) => {
  try {
    const f = filters(req);
    const rows = listExpenses(tid(req), f);
    const esc = (v: unknown) => `"${typeof v === "string" && /^[=+@-]/.test(v) ? "'" : ""}${String(v ?? "").replaceAll('"', '""')}"`; // ' stops Excel running a text cell as a formula
    const out = [["Date", "Category", "Amount", "Paid to", "Method", "Station", "Status", "Note", "Receipt", "Entered by", "Approved by"].map(esc).join(","),
      ...rows.map((e) => [e.expense_date.slice(0, 10), e.category, e.amount, e.paid_to, e.method, e.station_name ?? "All", e.status, e.note, e.receipt_ref, e.created_by, e.approved_by].map(esc).join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="expenses-${f.month}.csv"`);
    res.send("﻿" + out);
  } catch (e) { next(e); }
});

/* ---------------- Create / edit / approve ---------------- */
export const expenseBody = z.object({
  category: z.string().trim().min(2).max(60), new_category: z.boolean().optional(), amount: z.number().positive(), paid_to: z.string().optional().nullable(),
  method: z.enum(["cash", "bank", "jazzcash", "easypaisa", "raast", "cheque", "card"]).default("cash"),
  note: z.string().optional().nullable(), receipt_ref: z.string().optional().nullable(),
  station_id: z.number().nullable().optional(), expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  photo_id: z.number().optional().nullable(), account_id: accountIdField,
});

expenses.post("/expenses", requireAny("expenses.create", "cash.pay"), h((req) => createExpense(req, parse(expenseBody, req.body))));

/** Book an expense (approved at once up to the approval limit, else sent to the owner). Also used by the cashier desk. */
export async function createExpense(req: Request, b: z.infer<typeof expenseBody>) {
  const t = tid(req);
  b.category = resolveCategory(t, b.category, Boolean(b.new_category));
  if (b.station_id && !get("SELECT id FROM stations WHERE id=? AND tenant_id=?", b.station_id, t)) throw new AppError(400, "Station not found");
  const autoApprove = can(req.user, "expenses.approve") || b.amount <= approvalLimit(t);
  const date = b.expense_date ?? pkDate();
  guardClosedDay(req, t, date);
  if (autoApprove && b.method === "cash") assertCashInHand(t, b.amount, `${b.category} kharcha`);
  const { id } = run(
    `INSERT INTO expenses (tenant_id,station_id,category,amount,paid_to,method,note,receipt_ref,status,created_by,approved_by,expense_date,created_at,account_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    t, b.station_id ?? null, b.category, b.amount, b.paid_to ?? null, b.method, b.note ?? null, b.receipt_ref ?? null,
    autoApprove ? "approved" : "pending", req.user!.name, autoApprove ? req.user!.name : null, date, now(), bankAccountFor(t, b.account_id, b.method),
  );
  if (b.photo_id && linkPhotos(t, [b.photo_id], `expense:${id}`)) { run("UPDATE expenses SET photo_id=? WHERE id=?", b.photo_id, id); }
  if (autoApprove) checkBudget(t, b.category, monthOf(date));
  else {
    createAlert(t, { type: "expense_approval", severity: "warning", title: `Expense needs approval: ${pkr(b.amount)} ${b.category}`,
      body: `Entered by ${req.user!.name}${b.paid_to ? ` · paid to ${b.paid_to}` : ""}${b.note ? ` · ${b.note}` : ""}` });
    await requestApproval(t, "expense", id, `💸 Expense ${pkr(b.amount)} — ${b.category}\nBy ${req.user!.name}${b.paid_to ? ` · paid to ${b.paid_to}` : ""}${b.note ? ` · ${b.note}` : ""}`);
  }
  return get("SELECT * FROM expenses WHERE id=?", id)!;
}

function ownExpense(req: Request) {
  const e = get("SELECT * FROM expenses WHERE id=? AND tenant_id=?", Number(req.params.id), tid(req));
  if (!e) throw new AppError(404, "Expense not found");
  // paid out at the cash counter: the voucher is the money — change/void it from the Cashier desk so both stay in step
  if (get("SELECT id FROM cashier_vouchers WHERE tenant_id=? AND src=? AND voided=0", tid(req), `expense:${e.id}`)) throw new AppError(400, "Ye kharcha cashier voucher se hua hai — Cashier desk se edit/void karein");
  // booked on a shift that has already closed: the shift's cash figures were settled with it, so it cannot change now
  if (e.shift_id && get("SELECT id FROM shifts WHERE id=? AND status='closed'", e.shift_id)) throw new AppError(400, "Ye kharcha band shift ka hai — shift close ho chuki, ab nahi badal sakta");
  if (!can(req.user, "expenses.approve") && (e.created_by !== req.user!.name || e.status !== "pending"))
    throw new AppError(403, "You can only change your own pending expenses");
  return e;
}

expenses.patch("/expenses/:id", requirePerm("expenses.create"), h((req) => {
  const e = ownExpense(req);
  const b = parse(expenseBody.partial(), req.body);
  const m = { ...e, ...b };
  guardClosedDay(req, tid(req), e.expense_date);
  guardClosedDay(req, tid(req), m.expense_date);
  run("UPDATE expenses SET category=?, amount=?, paid_to=?, method=?, note=?, receipt_ref=?, station_id=?, expense_date=?, account_id=? WHERE id=?",
    m.category, m.amount, m.paid_to ?? null, m.method, m.note ?? null, m.receipt_ref ?? null, m.station_id ?? null, m.expense_date, bankAccountFor(tid(req), m.account_id, m.method), e.id);
  return get("SELECT * FROM expenses WHERE id=?", e.id);
}));

expenses.delete("/expenses/:id", requirePerm("expenses.create"), h((req) => {
  const e = ownExpense(req);
  guardClosedDay(req, tid(req), e.expense_date);
  run("DELETE FROM expenses WHERE id=?", e.id);
  closeApproval("expense", e.id, false, `${req.user!.name} (deleted)`);
  return { ok: true };
}));

/** Approve or reject a pending expense (from the app, or the owner's "1" on WhatsApp). */
export function decideExpense(t: number, id: number, approve: boolean, by: string) {
  const e = get("SELECT * FROM expenses WHERE id=? AND tenant_id=?", id, t);
  if (!e) throw new AppError(404, "Expense not found");
  if (e.status !== "pending") throw new AppError(400, `Expense is already ${e.status}`);
  const status = approve ? "approved" : "rejected";
  run("UPDATE expenses SET status=?, approved_by=? WHERE id=?", status, by, e.id);
  if (!approve && e.shift_id) {
    // the shift's expected cash was lowered by this expense at close; rejected = that cash should have been in the bag
    const sh = get("SELECT * FROM shifts WHERE id=?", e.shift_id);
    if (sh && sh.status === "closed") {
      const expected = round2((sh.cash_expected ?? 0) + e.amount);
      run("UPDATE shifts SET cash_expected=?, variance=? WHERE id=?", expected, round2((sh.cash_actual ?? 0) - expected), sh.id);
    }
  }
  // paid at the cash counter before approval: a rejected expense means that payout is void too (the money comes back)
  if (!approve) run("UPDATE cashier_vouchers SET voided=1, void_reason=?, voided_by=?, voided_at=? WHERE tenant_id=? AND src=? AND voided=0", "Expense rejected", by, now(), t, `expense:${e.id}`);
  closeApproval("expense", e.id, approve, by);
  if (approve) checkBudget(t, e.category, monthOf(e.expense_date));
  return get("SELECT * FROM expenses WHERE id=?", e.id);
}
registerDecider("expense", async (t, id, approve, by) => { const e = decideExpense(t, id, approve, by); return `${pkr(e.amount)} ${e.category} is now ${e.status}.`; });

expenses.post("/expenses/:id/:decision(approve|reject)", requirePerm("expenses.approve"), h((req) =>
  decideExpense(tid(req), Number(req.params.id), req.params.decision === "approve", req.user!.name)));

/** Spend per category for any range (today / 7 days / month / custom) — the owner's "kis cheez par kitna" card. */
expenses.get("/expenses/breakdown", requirePerm("expenses.view"), h((req) => {
  const t = tid(req);
  const f = parse(z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
  const to = f.to ?? pkDate(), from = f.from ?? to;
  const rows = all(`SELECT category, ROUND(SUM(amount),2) total, COUNT(*) n, MAX(expense_date) last FROM expenses WHERE tenant_id=? AND status='approved' AND expense_date >= ? AND expense_date <= ? GROUP BY category ORDER BY total DESC`, t, from, to);
  const total = round2(rows.reduce((a, r) => a + (r.total as number), 0));
  const pending = get("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM expenses WHERE tenant_id=? AND status='pending' AND expense_date >= ? AND expense_date <= ?", t, from, to)!;
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1);
  return { from, to, days, total, per_day: round2(total / days), pending: { n: pending.n, amount: round2(pending.s as number) },
    by_category: rows.map((r) => ({ ...r, pct: total ? Math.round(((r.total as number) / total) * 100) : 0 })) };
}));

/* ---------------- Statement (ERP / bank style) ----------------
 * Every approved expense in a date range, grouped by category: each line with its voucher no, payee, method and a running
 * total inside the category, the category's subtotal, and the grand total at the bottom. Filters: from / to (any range —
 * today, 7 / 15 / 30 days, a month, custom), categories (comma list), station, cash / bank. Pending ones are counted aside. */
const statementQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  categories: z.string().max(2000).optional(),
  station_id: z.preprocess((v) => (v === "" || v == null ? undefined : v), z.coerce.number().int().positive().optional()),
  pay: z.enum(["cash", "bank", "all"]).or(z.literal("")).optional(),
});
const isCashSql = "LOWER(COALESCE(e.method,'cash')) IN ('cash','')";
const addDays = (day: string, n: number) => new Date(Date.parse(day + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

/** The CEO's "Other entries" expenses (not the ones posted onto a party's khata) sit in the statement as their own group. */
export const OTHER_GROUP = "__other__";
const OTHER_LABEL = "Other kharche (CEO)";

export function expenseStatement(t: number, raw: unknown, seeOther = true) {
  const f = parse(statementQuery, raw);
  const to = f.to ?? pkDate(), from = f.from ?? to;
  if (from > to) throw new AppError(400, "'Se' ki tareekh 'tak' se pehle honi chahiye");
  const picked = (f.categories ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const cats = picked.filter((c) => c !== OTHER_GROUP);
  // no category picked = everything; otherwise the CEO's other expenses only when their chip is picked. They belong to
  // no station, so a station filter leaves them out.
  const wantExpenses = !picked.length || cats.length > 0;
  const wantOther = seeOther && (!picked.length || picked.includes(OTHER_GROUP)) && !f.station_id;
  const where = (a: string, b: string, status = "approved") => {
    const w = ["e.tenant_id=?", "e.status=?", "substr(e.expense_date,1,10) >= ?", "substr(e.expense_date,1,10) <= ?"];
    const args: (string | number)[] = [t, status, a, b];
    if (cats.length) { w.push(`e.category IN (${cats.map(() => "?").join(",")})`); args.push(...cats); }
    if (f.station_id) { w.push("e.station_id=?"); args.push(f.station_id); }
    if (f.pay === "cash") w.push(isCashSql); else if (f.pay === "bank") w.push(`NOT ${isCashSql}`);
    return { sql: w.join(" AND "), args };
  };
  const OE_DAY = "substr(datetime(o.created_at,'+5 hours'),1,10)";
  const whereOther = (a: string, b: string) => {
    const w = ["o.tenant_id=?", "o.kind='expense'", "o.voided=0", "COALESCE(o.to_party,0)=0", `${OE_DAY} >= ?`, `${OE_DAY} <= ?`];
    const args: (string | number)[] = [t, a, b];
    // an on-account entry (the party's khata bore it) moved neither cash nor bank — it shows only under "Sab"
    if (f.pay === "cash") w.push("LOWER(COALESCE(o.method,'cash')) IN ('cash','')"); else if (f.pay === "bank") w.push("LOWER(COALESCE(o.method,'cash')) NOT IN ('cash','', 'party khata')");
    return { sql: w.join(" AND "), args };
  };
  const W = where(from, to);
  const rows = wantExpenses ? all(`SELECT e.id, substr(e.expense_date,1,10) day, e.category, e.amount, e.paid_to, e.method, e.note, e.receipt_ref, e.photo_id, e.shift_id,
      e.created_by, e.approved_by, s.name station_name
    FROM expenses e LEFT JOIN stations s ON s.id=e.station_id WHERE ${W.sql} ORDER BY e.category, day, e.id`, ...W.args) : [];
  const O = whereOther(from, to);
  const others = wantOther ? all(`SELECT o.id, ${OE_DAY} day, o.reason, o.amount, o.party_name paid_to, COALESCE(o.method,'cash') method, o.note, o.created_by
    FROM other_entries o WHERE ${O.sql} ORDER BY day, o.id`, ...O.args) : [];
  const sum = (xs: any[]) => round2(xs.reduce((a, r) => a + Number(r.amount), 0));
  const isCashM = (m: unknown) => /^(cash)?$/i.test(String(m ?? "cash"));
  const expenseTotal = sum(rows), otherTotal = sum(others), total = round2(expenseTotal + otherTotal);
  const groups = new Map<string, { category: string; source: "expense" | "other"; n: number; total: number; lines: any[] }>();
  for (const r of rows) {
    const g = groups.get(r.category as string) ?? { category: r.category as string, source: "expense" as const, n: 0, total: 0, lines: [] };
    g.n++; g.total = round2(g.total + Number(r.amount));
    g.lines.push({ ...r, source: "expense", voucher: `EX-${String(r.id).padStart(5, "0")}`, cash: isCashM(r.method), running: g.total, from_shift: r.shift_id != null });
    groups.set(r.category as string, g);
  }
  const expenseGroups = [...groups.values()].sort((a, b) => b.total - a.total);
  const otherGroup = others.length ? (() => {
    let run = 0;
    return { category: OTHER_LABEL, source: "other" as const, n: others.length, total: otherTotal,
      lines: others.map((r) => { run = round2(run + Number(r.amount)); return { ...r, category: OTHER_LABEL, source: "other", note: [r.reason, r.note].filter(Boolean).join(" · "),
        voucher: `OE-${String(r.id).padStart(5, "0")}`, cash: isCashM(r.method), running: run, from_shift: false }; }) };
  })() : null;
  const categories = [...expenseGroups, ...(otherGroup ? [otherGroup] : [])].map((g) => ({ ...g, pct: total ? Math.round((g.total / total) * 1000) / 10 : 0 }));
  const cash = round2(rows.filter((r) => isCashM(r.method)).reduce((a, r) => a + Number(r.amount), 0) + others.filter((r) => isCashM(r.method)).reduce((a, r) => a + Number(r.amount), 0));
  const onAccount = round2(others.filter((r) => String(r.method).toLowerCase() === "party khata").reduce((a, r) => a + Number(r.amount), 0));
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  // the same length of time just before, for "pichle itne din se zyada / kam"
  const pTo = addDays(from, -1), pFrom = addDays(from, -days);
  const P = where(pFrom, pTo), PO = whereOther(pFrom, pTo);
  const prevTotal = round2((wantExpenses ? Number(get(`SELECT COALESCE(SUM(e.amount),0) v FROM expenses e WHERE ${P.sql}`, ...P.args)!.v) : 0)
    + (wantOther ? Number(get(`SELECT COALESCE(SUM(o.amount),0) v FROM other_entries o WHERE ${PO.sql}`, ...PO.args)!.v) : 0));
  const PD = where(from, to, "pending");
  const pending = wantExpenses ? get(`SELECT COUNT(*) n, COALESCE(SUM(e.amount),0) v FROM expenses e WHERE ${PD.sql}`, ...PD.args)! : { n: 0, v: 0 };
  return {
    from, to, days, filters: { categories: picked, station_id: f.station_id ?? null, pay: f.pay || "all" },
    total, n: rows.length + others.length, per_day: round2(total / days), cash, bank: round2(total - cash - onAccount), on_account: onAccount,
    // the two books side by side: the normal expenses and the CEO's other expenses
    parts: { expenses: { total: expenseTotal, n: rows.length }, other: { total: otherTotal, n: others.length, included: wantOther } },
    previous: { from: pFrom, to: pTo, total: prevTotal, change_pct: prevTotal ? Math.round(((total - prevTotal) / prevTotal) * 100) : null },
    pending: { n: Number(pending.n), amount: round2(Number(pending.v)) },
    categories,
  };
}

// the CEO's other expenses are CEO-only (like the Other entries page): a manager's statement shows the normal ones
const seesOther = (req: Request) => can(req.user, "other_entries.manage");
expenses.get("/expenses/statement", requirePerm("expenses.view"), h((req) => ({ ...expenseStatement(tid(req), req.query, seesOther(req)), can_see_other: seesOther(req) })));

expenses.get("/expenses/statement.csv", requirePerm("expenses.view"), (req, res, next) => {
  try {
    const s = expenseStatement(tid(req), req.query, seesOther(req));
    const esc = (v: unknown) => `"${typeof v === "string" && /^[=+@-]/.test(v) ? "'" : ""}${String(v ?? "").replaceAll('"', '""')}"`;
    const out: string[] = [[`Kharchon ki statement ${s.from} se ${s.to}`].map(esc).join(","), ""];
    out.push(["Category", "Date", "Voucher", "Paid to", "Method", "Station", "Note", "Receipt", "Amount", "Running"].map(esc).join(","));
    for (const g of s.categories) {
      for (const l of g.lines) out.push([g.category, l.day, l.voucher, l.paid_to, l.method, l.station_name ?? "", l.note, l.receipt_ref, l.amount, l.running].map(esc).join(","));
      out.push([`${g.category} — total`, "", "", "", "", "", "", `${g.n} entries`, g.total, ""].map(esc).join(","), "");
    }
    out.push(["Kharche (expenses)", "", "", "", "", "", "", `${s.parts.expenses.n} entries`, s.parts.expenses.total, ""].map(esc).join(","));
    out.push(["Other kharche (CEO)", "", "", "", "", "", "", `${s.parts.other.n} entries`, s.parts.other.total, ""].map(esc).join(","));
    out.push(["KUL KHARCHA", "", "", "", "", "", "", `${s.n} entries`, s.total, ""].map(esc).join(","));
    out.push(["Cash", "", "", "", "", "", "", "", s.cash, ""].map(esc).join(","), ["Bank / online", "", "", "", "", "", "", "", s.bank, ""].map(esc).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="kharche-${s.from}-to-${s.to}.csv"`);
    res.send("﻿" + out.join("\n"));
  } catch (e) { next(e); }
});

/** The owner gets the range's totals per category on WhatsApp. */
expenses.post("/expenses/statement/whatsapp", requirePerm("expenses.view"), h(async (req) => {
  const t = tid(req);
  const s = expenseStatement(t, req.body ?? {}, seesOther(req));
  const owner = (getSetting(t, "owner_phone", "") || (get("SELECT owner_phone FROM tenants WHERE id=?", t)?.owner_phone as string | undefined)) as string | undefined;
  if (!owner) throw new AppError(400, "Owner ka WhatsApp number set nahi (Settings → Owner phone)");
  const lines = s.categories.map((g) => `• ${g.category}: ${pkr(g.total)} (${g.n})`);
  const text = `🧾 Kharche ${s.from}${s.from !== s.to ? ` se ${s.to}` : ""}\n${lines.join("\n") || "Koi kharcha nahi"}\n────────\nKharche: ${pkr(s.parts.expenses.total)}${s.parts.other.n ? ` · Other (CEO): ${pkr(s.parts.other.total)}` : ""}\nKul: ${pkr(s.total)} · ${s.n} entries\nCash ${pkr(s.cash)} · Bank ${pkr(s.bank)}${s.previous.change_pct != null ? `\nPichle ${s.days} din se ${s.previous.change_pct >= 0 ? "+" : ""}${s.previous.change_pct}%` : ""}${s.pending.n ? `\nManzoori baqi: ${s.pending.n} (${pkr(s.pending.amount)})` : ""}`;
  await sendToPhone(owner, text);
  return { ok: true, sent_to: owner };
}));
