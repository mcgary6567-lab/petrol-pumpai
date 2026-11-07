# A–Z system audit — run this before saying "sab theek hai"

Last full run: **2026-11-04** (incremental, from the 2026-11-02 baseline: commits 42a0738…db03f09 + review fixes).
Baseline after that run: 750/756 server tests, e2e 9/9, `/books/check` 0 farq after every flow, crawl of the 16 routes
touched (30 route×viewport) with **0 JS errors, 0 overflow, 0 failed API**, print audit clean. The full crawl of all
106 routes last ran 2026-11-02 (0 errors).
Next time start from here — re-run the four legs, compare with this baseline, fix only what regressed or is new.

## 0. Baseline (5 min)
```bash
cd server && npx tsc --noEmit -p . && cd ../web && npx tsc --noEmit -p . && npm run build
cd server && rm -rf /tmp/pumpai-* && npx tsx --test test/*.test.ts | grep -E "^# (tests|pass|fail)|^not ok"
```
Expected: all pass. `test/books_audit.test.ts` (in the suite) is the hisaab driver: it boots the seeded demo pump, runs every
money flow (cashier receive/pay, shift open/close/handover, khata cash-back, shop parchi cash in-shift and at the counter,
investor transfers with/without cash + voids, bypass delivery + whole-voucher void + to-client shift + recost, pump & depot
trips + voids, backdated expense, shop stock-in/sale, cash count, every cash-in-hand guard) and calls `GET /api/books/check`
after each. Any `!!` line or farq > 0 in its output is a bug.

## 1. UI crawl — every route, desktop + mobile, every button (≈45 min)
```bash
cp <demo db> /tmp/pumpai-crawl.db          # never crawl the live DB; the click pass mutates data
cd server && SAAS_MODE=1 PORT=4343 DB_PATH=/tmp/pumpai-crawl.db ANTHROPIC_API_KEY= WA_TOKEN= npx tsx src/index.ts &
# in the cloud sandbox: PW_PATH=/opt/node22/lib/node_modules/playwright/index.js PW_CHROMIUM=/opt/pw-browsers/chromium
AUDIT_BASE=http://localhost:4343 node tools/audit/crawl.cjs            # all routes; or crawl.cjs /khata,/pos for a few
AUDIT_BASE=http://localhost:4343 node tools/audit/print.cjs            # A4 PDFs + print-media overflow of the report pages
```
- Login: admin@pumpai.pk / demo1234 via "Email sign-in". `routes.json` = every `path="…"` in `web/src/App.tsx` plus the
  `?tab=` variants; **add new routes/tabs there when you add pages.**
- Output in `tools/audit/out/` (git-ignored): `results.json`, `report.md`, `<route>-d.png` / `-m.png`, `print/*.pdf`.
- Per route it records: console + page errors, every `/api` response ≥ 400, horizontal overflow (and the widest element),
  up to 25 safe button/tab clicks (skips delete/void/save/send/pay… by text) with any error they trigger, unlabeled inputs.
- Read `report.md`: anything other than Google-Fonts / `google.com/s2/favicons` resource failures is a finding.

## 2. Hisaab (accounting) review — static
Every table that moves money or stock must (a) post in `routes/ledger.ts`, (b) reverse everywhere on void/undo
(ledger, `shifts.ts` summary, `backoffice.ts cashFlows`/`cashPosition`, stock), (c) agree with the day book
(`cashier.ts dayBook`). Known-correct rules to keep: shift cash corrections go through `services.adjustClosedShiftCash`;
every cash-out door calls `backoffice.assertCashInHand`; shop parchi cash ≤ salesman bag (`shiftSummary.cash_expected`);
expenses book on `expense_date`; bill mode uses `crm.isBilledDebit` (no refund:/xfer:/open: lines).
Review of 2026-11-04 (new code: to-client shift, POS edit, date-time back-dating) fixed: back-dated POS→wholesale fill on
a closed shift is refused (409); a shifted purchase and its client payment reverse each other (`routes/clientFuel.ts`);
pos-edit rate needs `wholesale.rates` + closed-day guard; paid-now leg dated with the fill; strict date-time validation
(no 500s); ratesAt uses history for every rate mode.
Still open (judged low / by design, re-check if touched): investors void hard-DELETEs cashier_vouchers/bank_txns;
bypass reversal does not flag supplier payments already made against the voided bill; `/books/check` has no tie for
unbilled card-pending fuel or depot money held; `splitTax` rounding could drift with GST on.

## 3. Security review — static
Check list (all verified clean on 2026-11-02 unless noted): every router mounted after `requireAuth`; every mutating
route has `requirePerm`/`requireRole`; every caller-supplied id scoped by `tenant_id`; no `${}` user input inside SQL;
`esc()` on every server-rendered page (billing, backoffice, customerCare, pinPortal, board, legal, system OAuth page);
rate limits on auth/setup/signup/platform/portal/attend; `requirePlatform` takes `?token=` only on `/backups/:name`;
`/integrations` is platform-owner-only in SaaS; `/signup` ignores `modules`. Known leftovers: CSP has `script-src
'unsafe-inline'`; bill/receipt/slip tokens live 400–730 days with no revocation claim; WhatsApp inbound routes to
`WA_TENANT_ID` (one tenant) — fine for a single live pump, wrong for true multi-tenant WhatsApp.

## 4. Finish
`e2e`: `cd web && E2E_BASE_URL=http://localhost:4242 npx playwright test -c e2e/playwright.config.ts` (9 specs).
Commit per leg (security / hisaab / UI), push `main` (auto-deploys to Fly), then update the "Last full run" line above.
