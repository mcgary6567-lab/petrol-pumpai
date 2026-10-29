/**
 * Page objects for the Wholesale ERP pages (dashboard, supply voucher, party ledger, supply invoices, order-to-cash board).
 * Every locator here is role/label based so the tests survive styling changes; no CSS classes.
 */
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

export const BASE = process.env.E2E_BASE_URL ?? "http://localhost:4242";
export const USERS = { admin: "admin@pumpai.pk", officer: "wholesale@pumpai.pk", salesman: "salesman@pumpai.pk" } as const;
export const PASSWORD = "demo1234";
/** Rupees the way the app prints them: lakh grouping (1,36,000), rounded. */
export const rs = (n: number) => `Rs ${Math.round(n).toLocaleString("en-IN")}`;

/** Log in through the API and plant the token the SPA reads — faster and steadier than driving the login form every test. */
export async function login(page: Page, request: APIRequestContext, who: keyof typeof USERS) {
  const r = await request.post(`${BASE}/api/auth/login`, { data: { email: USERS[who], password: PASSWORD } });
  expect(r.ok(), `login ${who}`).toBeTruthy();
  const { token } = await r.json();
  await page.goto(`${BASE}/`);
  await page.evaluate((t) => localStorage.setItem("pumpai_token", t), token);
  return token as string;
}
export const api = (request: APIRequestContext, token: string) => ({
  get: async (path: string) => { const r = await request.get(`${BASE}/api${path}`, { headers: { authorization: `Bearer ${token}` } }); return { status: r.status(), body: await r.json().catch(() => null) }; },
  post: async (path: string, data: unknown = {}) => { const r = await request.post(`${BASE}/api${path}`, { headers: { authorization: `Bearer ${token}` }, data }); return { status: r.status(), body: await r.json().catch(() => null) }; },
});

class ErpPage {
  constructor(readonly page: Page) {}
  /** The sticky page bar every ERP page carries. */
  get bar() { return this.page.getByRole("heading", { level: 1 }); }
  get search() { return this.page.getByRole("textbox", { name: "Search", exact: true }); } // not the sidebar's "Search menu"
  pager() { return this.page.getByText(/Safha \d+ \/ \d+/); }
  next() { return this.page.getByRole("button", { name: "Agla ›" }); }
  prev() { return this.page.getByRole("button", { name: "‹ Pichla" }); }
  async expectNoHorizontalScroll() {
    const wide = await this.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    expect(wide, "page must not scroll sideways").toBeFalsy();
  }
}

export class DashboardPage extends ErpPage {
  async goto() { await this.page.goto(`${BASE}/wholesale`); await expect(this.bar).toContainText("Wholesale dashboard"); }
  kpi(label: string) { return this.page.getByText(label, { exact: true }).locator("xpath=.."); }
  get newVoucher() { return this.page.getByRole("button", { name: "New supply voucher" }); }
  get topClients() { return this.page.getByRole("table").filter({ hasText: "Outstanding" }); }
}

export class VoucherPage extends ErpPage {
  async goto(clientId?: number, orderId?: number) {
    const q = new URLSearchParams({ ...(clientId ? { client: String(clientId) } : {}), ...(orderId ? { order: String(orderId) } : {}) }).toString();
    await this.page.goto(`${BASE}/wholesale/voucher${q ? `?${q}` : ""}`);
    await expect(this.bar).toContainText("New supply voucher");
  }
  get client() { return this.page.getByLabel("Client *"); }
  get station() { return this.page.getByLabel("From station *"); }
  get bilty() { return this.page.getByLabel("Bilty / ref no."); }
  get narration() { return this.page.getByLabel("Narration"); }
  get kiraya() { return this.page.getByRole("spinbutton", { name: "Kiraya" }); }
  fuel(n: number) { return this.page.getByRole("combobox", { name: `Fuel ${n}` }); }
  litres(n: number) { return this.page.getByRole("spinbutton", { name: `Litres ${n}` }); }
  rate(n: number) { return this.page.getByRole("spinbutton", { name: `Rate ${n}` }); }
  get addLine() { return this.page.getByRole("button", { name: /Add line/ }); }
  get post() { return this.page.getByRole("button", { name: /Post voucher/ }); }
  get issues() { return this.page.getByText("Post se pehle theek karein:"); }
  get creditCheck() { return this.page.getByText("Credit check").locator("xpath=.."); }
  get posting() { return this.page.getByText("Posting preview").locator("xpath=.."); }
  get total() { return this.page.locator("text=Total").locator("xpath=..").getByText(/Rs/); }
  get postedDialog() { return this.page.getByRole("dialog", { name: /Voucher WS-\d+ posted/ }); }
  async fill(lines: { product: string; litres: number }[], opts: { kiraya?: number; bilty?: string; note?: string } = {}) {
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await this.addLine.click();
      await this.fuel(i + 1).selectOption(lines[i].product);
      await this.litres(i + 1).fill(String(lines[i].litres));
    }
    if (opts.kiraya != null) await this.kiraya.fill(String(opts.kiraya));
    if (opts.bilty) await this.bilty.fill(opts.bilty);
    if (opts.note) await this.narration.fill(opts.note);
    await expect(this.posting).toContainText("Balanced ✓"); // the server preview has answered
  }
  async submit(): Promise<string> {
    await this.post.click();
    await expect(this.postedDialog).toBeVisible();
    const no = (await this.postedDialog.textContent())?.match(/WS-\d+/)?.[0];
    expect(no, "voucher number in the dialog").toBeTruthy();
    return no!;
  }
}

export class LedgerPage extends ErpPage {
  async goto(clientId: number, range: { from?: string; to?: string } = {}) {
    const q = new URLSearchParams({ client: String(clientId), from: range.from ?? "", to: range.to ?? "" }).toString();
    await this.page.goto(`${BASE}/wholesale/ledger?${q}`);
    await expect(this.bar).toContainText("Party account");
  }
  get clientSelect() { return this.page.getByRole("combobox", { name: "Client" }); }
  view(name: "Detailed" | "Monthly" | RegExp) { return this.page.getByRole("button", { name }); }
  cell(label: RegExp | string) { return this.page.getByText(label).locator("xpath=.."); }
  get table() { return this.page.getByRole("table"); }
  row(voucherNo: string) { return this.page.getByRole("row").filter({ has: this.page.getByRole("button", { name: voucherNo, exact: true }) }); }
  get totalsRow() { return this.page.getByRole("row").filter({ hasText: "Totals for the period" }); }
  get entryDialog() { return this.page.getByRole("dialog"); }
}

export class InvoicesPage extends ErpPage {
  async goto(q: Record<string, string> = {}) {
    const qs = new URLSearchParams(q).toString();
    await this.page.goto(`${BASE}/wholesale/invoices${qs ? `?${qs}` : ""}`);
    await expect(this.bar).toContainText("Supply invoices");
  }
  tab(name: string) { return this.page.getByRole("button", { name: new RegExp(`^${name}\\s`) }); }
  get list() { return this.page.getByRole("region", { name: "Invoices" }); } // the bill list only — the sidebar has list items too
  listItem(no: string) { return this.list.getByRole("listitem").filter({ hasText: no }).getByRole("button"); }
  get bill() { return this.page.getByRole("article"); }
  get balanceDue() { return this.bill.getByText("Balance due").locator("xpath=.."); }
  get whatsapp() { return this.page.getByRole("button", { name: "WhatsApp" }); }
  get voidBtn() { return this.page.getByRole("button", { name: "Void" }); }
  get print() { return this.page.getByRole("button", { name: "Print / PDF" }); }
}

export class BoardPage extends ErpPage {
  async goto() { await this.page.goto(`${BASE}/wholesale/board`); await expect(this.bar).toContainText("Order to cash"); }
  column(name: "Client requests" | "Order book" | "Supplied — unpaid" | "Overdue" | "Paid"): Locator { return this.page.getByRole("region", { name }); }
  get fuelFilter() { return this.page.getByRole("combobox", { name: "Fuel" }); }
  showMore(col: Locator) { return col.getByRole("button", { name: /Show 10 more/ }); }
}
