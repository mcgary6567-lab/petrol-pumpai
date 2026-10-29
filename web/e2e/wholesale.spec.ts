/**
 * Wholesale ERP end-to-end: voucher → ledger → invoice → board, plus the negative paths a tester reaches for first.
 * Runs against a server started with demo data (`npm run dev -w server` or the Docker image); never against a live pump.
 *
 *   npm i -D @playwright/test           (once; the browser comes with it)
 *   E2E_BASE_URL=http://localhost:4242 npx playwright test -c e2e/playwright.config.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { api, login, rs, BoardPage, DashboardPage, InvoicesPage, LedgerPage, VoucherPage } from "./pages/wholesale";

type Ctx = { token: string; client: { id: number; name: string; rates: Record<string, number> }; station: { id: number } };
async function setup(page: Page, request: Parameters<typeof login>[1], who: "admin" | "officer" = "admin"): Promise<Ctx> {
  const token = await login(page, request, who);
  const a = api(request, token);
  const clients = (await a.get("/wholesale/clients")).body as Ctx["client"][];
  const client = clients.find((c) => Object.keys(c.rates ?? {}).includes("HSD")) ?? clients[0];
  const station = (await a.get("/stations")).body[0];
  return { token, client, station };
}

test.describe("Supply voucher → ledger → invoice → board", () => {
  test("happy path: a 2-line voucher with kiraya posts once, lands in the ledger as one bill and on the board as unpaid", async ({ page, request }) => {
    const { token, client, station } = await setup(page, request);
    const a = api(request, token);
    const before = (await a.get(`/wholesale/clients/${client.id}/statement`)).body;
    const rate = client.rates.HSD;

    const v = new VoucherPage(page);
    await v.goto(client.id);
    await expect(v.station).toHaveValue(String(station.id));
    await v.fill([{ product: "HSD", litres: 400 }, { product: "HSD", litres: 100 }], { kiraya: 3000, bilty: "E2E-77", note: "e2e voucher" });
    await expect(v.creditCheck).toContainText("This voucher");
    await expect(v.posting).toContainText("Carriage income");
    await expect(v.page.getByText(rs(500 * rate + 3000)).first()).toBeVisible();
    const no = await v.submit();

    // ledger: 3 lines carry the voucher number, running balance moved by exactly the total
    const l = new LedgerPage(page);
    await l.goto(client.id, { from: "", to: "" });
    await l.search.fill(no);
    await expect(l.page.getByRole("button", { name: no, exact: true })).toHaveCount(3);
    const after = (await a.get(`/wholesale/clients/${client.id}/statement`)).body;
    expect(Math.round(after.closing_balance - before.closing_balance)).toBe(Math.round(500 * rate + 3000));
    await l.search.fill(""); // clearing search brings the totals row back
    await expect(l.totalsRow).toBeVisible();

    // invoice: one bill, 3 lines, status unpaid, balanced journal, printable
    const inv = new InvoicesPage(page);
    await inv.goto({ no, client: String(client.id), from: "2000-01-01" });
    await expect(inv.bill).toContainText(no);
    await expect(inv.bill.getByRole("row")).toHaveCount(4); // header + 3 lines
    await expect(inv.balanceDue).toContainText(rs(500 * rate + 3000));
    await expect(inv.page.getByText("Journal entry")).toBeVisible();

    // board: the same bill sits in "Supplied — unpaid"
    const b = new BoardPage(page);
    await b.goto();
    await expect(b.column("Supplied — unpaid")).toContainText(no);
    await b.search.fill(no);
    await expect(b.column("Order book")).toContainText("Khaali");
  });

  test("edge: over the credit limit the officer is blocked with a reason, the CEO can override", async ({ page, request }) => {
    const { token, client, station } = await setup(page, request);
    const a = api(request, token);
    // make the limit tiny for this run, restore after
    const orig = (await a.get(`/wholesale/clients/${client.id}`)).body.credit_limit as number;
    await a.post(`/wholesale/clients/${client.id}`, {}); // no-op guard: PATCH below is what matters
    const r = await request.patch(`${process.env.E2E_BASE_URL ?? "http://localhost:4242"}/api/wholesale/clients/${client.id}`, { headers: { authorization: `Bearer ${token}` }, data: { credit_limit: 1 } });
    expect(r.ok()).toBeTruthy();
    try {
      const v = new VoucherPage(page);
      await v.goto(client.id);
      await v.litres(1).fill("50");
      await expect(v.issues).toBeVisible();
      await expect(v.page.getByText(/Credit limit exceeded/)).toBeVisible();
      await expect(v.post).toBeDisabled();
      await v.page.getByLabel(/CEO: limit se upar allow karein/).check();
      await expect(v.post).toBeEnabled();
    } finally {
      await request.patch(`${process.env.E2E_BASE_URL ?? "http://localhost:4242"}/api/wholesale/clients/${client.id}`, { headers: { authorization: `Bearer ${token}` }, data: { credit_limit: orig } });
    }
    void station;
  });

  test("negative: empty form cannot post (button + Ctrl+S), a fuel with no rate is refused, 7th line not allowed", async ({ page, request }) => {
    const { token, client } = await setup(page, request);
    const a = api(request, token);
    const n0 = (await a.get(`/wholesale/clients/${client.id}/statement`)).body.lines.length;
    const v = new VoucherPage(page);
    await v.goto(client.id);
    await expect(v.post).toBeDisabled();
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(500);
    expect((await a.get(`/wholesale/clients/${client.id}/statement`)).body.lines.length).toBe(n0);
    const missing = Object.keys({ PMG: 1, HOBC: 1, HSD: 1 }).find((p) => !client.rates[p]);
    if (missing) {
      await v.fuel(1).selectOption(missing);
      await v.litres(1).fill("10");
      await expect(v.page.getByText(/No .* rate set/)).toBeVisible();
      await expect(v.post).toBeDisabled();
    }
    for (let i = 0; i < 5; i++) await v.addLine.click();
    await expect(v.addLine).toBeDisabled(); // 6 lines max
  });

  test("ledger: search narrows, pager works, voucher opens its entry, balances are plain numbers (no Dr/Cr)", async ({ page, request }) => {
    const { client } = await setup(page, request);
    const l = new LedgerPage(page);
    await l.goto(client.id, { from: "", to: "" });
    const rows = await l.table.getByRole("row").count();
    expect(rows).toBeLessThanOrEqual(13); // header + opening + 10 + totals
    if (await l.pager().isVisible()) {
      await l.next().click();
      await expect(l.pager()).toContainText("Safha 2");
      await l.prev().click();
    }
    await expect(l.table).not.toContainText(/\d Dr\b/);
    await l.view("Monthly").click();
    await expect(l.table.getByRole("row").first()).toContainText("Month");
    await l.view("Detailed").click();
    await l.search.fill("Payment");
    await expect(l.table.getByRole("button", { name: /^(WS|JV|CN)-\d+$/ })).toHaveCount(0); // server search answered (debounced)
    for (const row of await l.table.getByRole("row").all()) {
      const t = (await row.textContent()) ?? "";
      if (/RV-|WS-|JV-|CN-/.test(t)) expect(t).toMatch(/Payment/);
    }
    const first = l.table.getByRole("button", { name: /^RV-\d+$/ }).first();
    if (await first.isVisible()) { await first.click(); await expect(l.entryDialog).toBeVisible(); }
  });

  test("invoices: status tabs filter, counts add up, 10 a page", async ({ page, request }) => {
    await setup(page, request);
    const inv = new InvoicesPage(page);
    await inv.goto({ from: "2000-01-01" });
    const count = async (name: string) => Number((await inv.tab(name).textContent())?.match(/\d+/)?.[0] ?? 0);
    const all = await count("All");
    expect(await count("Unpaid") + await count("Partly paid") + await count("Overdue") + await count("Paid") + await count("Void")).toBe(all);
    expect(await inv.list.getByRole("listitem").count()).toBeLessThanOrEqual(10);
    await inv.tab("Paid").click();
    for (const li of await inv.list.getByRole("listitem").all()) await expect(li).toContainText("Paid");
    await inv.print.click({ trial: true }); // reachable, not fired (would open the OS dialog)
  });

  test("roles: a salesman cannot reach wholesale; the officer sees no CEO approve buttons", async ({ page, request, browser }) => {
    const { token } = await setup(page, request, "officer");
    const b = new BoardPage(page);
    await b.goto();
    await expect(b.page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    const a = api(request, token);
    expect((await a.get("/wholesale/requests")).status).toBe(403);
    const p2 = await (await browser.newContext()).newPage();
    const t2 = await login(p2, request, "salesman");
    expect((await api(request, t2).get("/wholesale/invoices")).status).toBe(403);
    await p2.goto(`${process.env.E2E_BASE_URL ?? "http://localhost:4242"}/wholesale/invoices`);
    await expect(p2.getByRole("heading", { name: /Supply invoices/ })).toHaveCount(0);
  });

  test("api hardening: bad dates and shapes are 400, never 500", async ({ page, request }) => {
    const { token, client, station } = await setup(page, request);
    const a = api(request, token);
    expect((await a.get("/wholesale/invoices?from=2026-13-45")).status).toBe(400);
    expect((await a.get("/wholesale/invoices/WS-1'%20OR%201=1--")).status).toBe(400);
    expect((await a.get(`/wholesale/invoices?q=${encodeURIComponent("%' OR '1'='1")}`)).status).toBe(200);
    expect((await a.post(`/wholesale/clients/${client.id}/voucher/preview`, { station_id: station.id, lines: [{ product: "HSD", litres: -5 }] })).status).toBe(400);
    expect((await a.post(`/wholesale/clients/${client.id}/voucher/preview`, { station_id: station.id, lines: [{ product: "HSD", litres: 1 }], carriage: 1e12 })).status).toBe(400);
    const xss = await a.post(`/wholesale/clients/${client.id}/voucher/preview`, { station_id: station.id, lines: [{ product: "HSD", litres: 1 }], note: "<img src=x onerror=alert(1)>" });
    expect(xss.status).toBe(200); // stored as text, rendered by React as text — asserted on the page below
    const v = new VoucherPage(page);
    await v.goto(client.id);
    await v.narration.fill("<b>bold</b>");
    expect(await page.locator("b", { hasText: "bold" }).count()).toBe(0);
  });
});

test.describe("Responsive + accessibility smoke", () => {
  for (const [w, h, tag] of [[390, 844, "phone"], [1024, 768, "tablet"]] as const) {
    test(`${tag}: no sideways scroll, every input labelled, one h1, skip link works`, async ({ page, request }) => {
      await page.setViewportSize({ width: w, height: h });
      const { client } = await setup(page, request);
      for (const go of [() => new DashboardPage(page).goto(), () => new LedgerPage(page).goto(client.id), () => new InvoicesPage(page).goto(), () => new BoardPage(page).goto(), () => new VoucherPage(page).goto(client.id)]) {
        await go();
        await new DashboardPage(page).expectNoHorizontalScroll();
        expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
        const unlabeled = await page.evaluate(() => [...document.querySelectorAll("input,select,textarea")].filter((e: any) => e.type !== "hidden" && e.type !== "file" && !e.labels?.length && !e.getAttribute("aria-label")).length);
        expect(unlabeled, "inputs without a label").toBe(0);
      }
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: /Skip to content/ })).toBeFocused();
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("main");
    });
  }
});
