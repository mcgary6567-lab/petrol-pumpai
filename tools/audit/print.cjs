const { chromium } = require(process.env.PW_PATH || 'playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.AUDIT_BASE || 'http://localhost:4343';
const ROOT = process.env.AUDIT_OUT || path.join(__dirname, 'out');
const OUT = path.join(ROOT, 'print');
fs.mkdirSync(OUT, { recursive: true });
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8')); // written by crawl.cjs after login
// the app token sits in localStorage (pumpai_token) inside the saved browser state
const TOK = (state.origins ?? []).flatMap((o) => o.localStorage ?? []).find((kv) => kv.name === 'pumpai_token')?.value ?? '';
const slug = (r) => r.replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '').replace(/[\/?=&:.]+/g, '_').slice(0, 60) || 'root';

const PAGES = ['/customers/23', '/wholesale', '/wholesale?tab=trips', '/wholesale?tab=clients', '/wholesale/1', '/suppliers', '/cashier?tab=daybook', '/investors', '/reports', '/owner-report', '/owner-report?tab=bs', '/owner-report?tab=tb', '/owner-report?tab=journal', '/shifts', '/accounts#ledger', '/wholesale/ledger', '/wholesale/invoices', '/khata'];

const overflowJs = () => {
  const de = document.documentElement;
  const iw = de.clientWidth;
  let worst = null, worstR = 0;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > iw + 2 && r.right > worstR) {
      worstR = r.right;
      worst = { tag: el.tagName.toLowerCase(), cls: (typeof el.className === 'string' ? el.className : '').slice(0, 120), text: (el.textContent || '').trim().slice(0, 60), right: Math.round(r.right), w: Math.round(r.width) };
    }
  }
  return { over: de.scrollWidth > iw + 2, scrollWidth: de.scrollWidth, clientWidth: iw, worst, hiddenMain: !document.querySelector('main') || getComputedStyle(document.querySelector('main')).display === 'none' };
};

async function fetchJson(ctx, p) {
  const r = await ctx.request.get(BASE + p, { headers: { authorization: 'Bearer ' + TOK } });
  return r.json();
}

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const results = [];
  const ctx = await browser.newContext({ viewport: { width: 794, height: 1123 }, storageState: state });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  // public pages
  const bill = await fetchJson(ctx, '/api/customers/23/bill-link?mode=bill');
  const stmt = await fetchJson(ctx, '/api/wholesale/clients/1/statement-link');
  const pubs = [bill.url, stmt.url].map((u) => u.replace(/^https?:\/\/[^/]+/, BASE));
  const all = PAGES.map((p) => ({ url: BASE + p, kind: 'app' })).concat(pubs.map((u) => ({ url: u, kind: 'public' })));
  for (const { url, kind } of all) {
    const page = await ctx.newPage();
    const rec = { url: url.replace(BASE, ''), kind, console: [], api: [] };
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) rec.console.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => rec.console.push('PAGEERROR ' + String(e.message).slice(0, 200)));
    page.on('response', (r) => { if (r.status() >= 400 && /\/api\/|\/bill\//.test(r.url())) rec.api.push(r.url().replace(BASE, '') + ' ' + r.status()); });
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => { });
      await page.waitForTimeout(1200);
      rec.status = page.url().replace(BASE, '');
      // screen overflow at 794 and (public) 390
      rec.screen794 = await page.evaluate(overflowJs);
      if (kind === 'public') {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(400);
        rec.screen390 = await page.evaluate(overflowJs);
        await page.screenshot({ path: path.join(OUT, slug(rec.url) + '-390.png'), fullPage: true });
        await page.setViewportSize({ width: 794, height: 1123 });
      }
      await page.emulateMedia({ media: 'print' });
      await page.waitForTimeout(400);
      rec.print794 = await page.evaluate(overflowJs);
      await page.screenshot({ path: path.join(OUT, slug(rec.url) + '-printmedia.png'), fullPage: true });
      const pdf = path.join(OUT, slug(rec.url) + '.pdf');
      await page.pdf({ format: 'A4', printBackground: true, path: pdf });
      rec.pdf = pdf;
    } catch (e) { rec.err = String(e.message).slice(0, 200); }
    await page.close();
    results.push(rec);
    console.log(rec.url, 'screen:', rec.screen794 && rec.screen794.over, 'print:', rec.print794 && rec.print794.over, rec.print794 && rec.print794.worst && (rec.print794.worst.tag + '.' + rec.print794.worst.cls.slice(0, 50) + ' right=' + rec.print794.worst.right), rec.screen390 ? '390:' + rec.screen390.over : '', rec.err || '');
  }
  fs.writeFileSync(path.join(OUT, 'print-results.json'), JSON.stringify(results, null, 1));
  await browser.close();
})();
