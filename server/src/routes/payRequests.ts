/**
 * Big payments need the owner: when staff (anyone without expenses.approve) pays out more than the pump's limit
 * (setting pay_approval_limit, 0 = off), the payment is NOT booked — it is held as a request. The owner approves in
 * the app or by replying "1" on WhatsApp (same approvals flow as expenses / price changes), and only then is it booked,
 * exactly as entered, in the requester's name. Rejected requests move nothing.
 *
 * Each money route registers how to execute its held body; the request stores the route + body as JSON.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { all, get, run, now, getSetting, setSetting } from "../db.js";
import { h, parse, tid, can, requirePerm, type AuthUser } from "../auth.js";
import { AppError, audit, createAlert, pkr } from "../services.js";
import { registerDecider, requestApproval, closeApproval } from "./approvals.js";

export const payRequests = Router();

type Executor = (req: Request, body: any) => Promise<unknown> | unknown;
const executors: Record<string, Executor> = {};
export const registerPayExecutor = (route: string, fn: Executor) => { executors[route] = fn; };

export const payLimit = (t: number) => Number(getSetting(t, "pay_approval_limit", "0")) || 0;

/**
 * Null when the payment may go through now; otherwise the request is created and the response to send back.
 * `amount` is the money leaving; `summary` is what the owner reads on WhatsApp.
 */
export async function gateBigPayment(req: Request, route: string, body: unknown, amount: number, summary: string) {
  const t = tid(req);
  const limit = payLimit(t);
  if (limit <= 0 || amount <= limit || can(req.user, "expenses.approve")) return null;
  const id = run("INSERT INTO payment_requests (tenant_id,route,body,amount,summary,requested_by,requested_name,created_at) VALUES (?,?,?,?,?,?,?,?)",
    t, route, JSON.stringify(body), amount, summary, req.user!.id, req.user!.name, now()).id;
  createAlert(t, { type: "payment_approval", severity: "warning", title: `Payment needs approval: ${pkr(amount)}`, body: `${summary} — by ${req.user!.name}`, dedupe_key: `payreq-${id}` });
  await requestApproval(t, "payment", id, `💵 Payment ${pkr(amount)} (limit ${pkr(limit)})\n${summary}\nBy ${req.user!.name}`);
  audit(t, req.user!, "payment_request", `payreq:${id}`, { route, amount, summary });
  return { pending: true, request_id: id, amount, limit, message: `${pkr(amount)} limit (${pkr(limit)}) se zyada hai — CEO ki approval ke liye bhej diya. Approve hote hi entry ban jayegi.` };
}

/** Approve (book it now, as the requester) or reject a held payment. */
export async function decidePayment(t: number, id: number, approve: boolean, by: string) {
  const r = get("SELECT * FROM payment_requests WHERE id=? AND tenant_id=?", id, t);
  if (!r) throw new AppError(404, "Payment request not found");
  if (r.status !== "pending") throw new AppError(400, `Already ${r.status}`);
  if (!approve) {
    run("UPDATE payment_requests SET status='rejected', decided_by=?, decided_at=? WHERE id=?", by, now(), r.id);
    closeApproval("payment", r.id, false, by);
    return r;
  }
  const fn = executors[r.route];
  if (!fn) throw new AppError(500, `No executor for ${r.route}`);
  const u = get("SELECT id, tenant_id, name, email, role, station_id, active FROM users WHERE id=?", r.requested_by);
  if (!u || !u.active) throw new AppError(400, `${r.requested_name} ka account ab active nahi — request reject karein`);
  delete u.active;
  // the booking runs as the person who entered it, so vouchers, cash checks and audit carry their name
  const fake = { user: u as AuthUser, headers: {}, ip: null, body: {}, params: {}, query: {} } as unknown as Request;
  try {
    const result = await fn(fake, JSON.parse(r.body));
    run("UPDATE payment_requests SET status='approved', result=?, decided_by=?, decided_at=? WHERE id=?", JSON.stringify(result ?? null), by, now(), r.id);
  } catch (e) {
    const msg = (e as Error).message;
    run("UPDATE payment_requests SET status='failed', error=?, decided_by=?, decided_at=? WHERE id=?", msg, by, now(), r.id);
    closeApproval("payment", r.id, false, by);
    throw new AppError(400, `Approve to hua, lekin entry nahi ban saki: ${msg}`);
  }
  closeApproval("payment", r.id, true, by);
  return get("SELECT * FROM payment_requests WHERE id=?", r.id);
}
registerDecider("payment", async (t, id, approve, by) => { const r = await decidePayment(t, id, approve, by); return approve ? `${pkr(r.amount)} book ho gaya (${r.requested_name}).` : `${pkr(r.amount)} reject — kuch nahi badla.`; });

payRequests.get("/payment-requests", requirePerm("cash.pay"), h((req) => {
  const t = tid(req);
  const mine = can(req.user, "expenses.approve") ? "" : `AND requested_by=${req.user!.id}`;
  return {
    limit: payLimit(t), can_decide: can(req.user, "expenses.approve"),
    pending: all(`SELECT * FROM payment_requests WHERE tenant_id=? AND status='pending' ${mine} ORDER BY id DESC`, t),
    recent: all(`SELECT * FROM payment_requests WHERE tenant_id=? AND status<>'pending' ${mine} ORDER BY decided_at DESC LIMIT 20`, t),
  };
}));
payRequests.post("/payment-requests/:id/decide", requirePerm("expenses.approve"), h(async (req) => {
  const b = parse(z.object({ approve: z.boolean() }), req.body);
  const r = await decidePayment(tid(req), Number(req.params.id), b.approve, req.user!.name);
  audit(tid(req), req.user!, b.approve ? "payment_request_approve" : "payment_request_reject", `payreq:${r.id}`, { amount: r.amount, summary: r.summary });
  return r;
}));
payRequests.put("/payment-requests/limit", requirePerm("expenses.approve"), h((req) => {
  const b = parse(z.object({ limit: z.number().min(0).max(1_000_000_000) }), req.body);
  setSetting(tid(req), "pay_approval_limit", String(Math.round(b.limit)));
  audit(tid(req), req.user!, "pay_approval_limit", "settings", { limit: b.limit });
  return { limit: Math.round(b.limit) };
}));
