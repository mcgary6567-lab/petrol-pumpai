const { chromium } = require(process.env.PW_PATH || 'playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.AUDIT_BASE || 'http://localhost:4343';
const OUT = process.env.AUDIT_OUT || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const ROUTES = require('./routes.json');
const ONLY = process.argv[2] ? process.argv[2].split(',') : null;
const SKIP_RE = /delete|mansookh|void|cancel|remove|hataein|close shift|band|pay|save|submit|send|bhej|sign out|logout/i;
const MAX_CLICKS = 25;
const slug = (r) => r.replace(/^\//, '').replace(/[\/?=&:]+/g, '_') || 'root';

async function login(page) {
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.click('text=Email sign-in');
  await page.fill('input[autocomplete=username]', 'admin@pumpai.pk');
  await page.fill('input[type=password]', 'demo1234');
  await page.click('button:has-text("Sign in")');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  await page.waitForTimeout(800);
}

const overflowJs = () => {
  const de = document.documentElement;
  const over = de.scrollWidth > de.clientWidth + 2;
  const iw = window.innerWidth;
  let worst = null, worstR = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('aside, nav')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > iw + 2 && r.right > worstR) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' && (el.classList.contains('hidden') )) continue;
      worstR = r.right;
      worst = { tag: el.tagName.toLowerCase(), cls: (el.className && el.className.baseVal === undefined ? el.className : '').toString().slice(0, 120), text: (el.textContent || '').trim().slice(0, 60), right: Math.round(r.right), left: Math.round(r.left), w: Math.round(r.width) };
    }
  }
  return { over, scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, worst };
};

const labelsJs = () => {
  const out = [];
  for (const el of document.querySelectorAll('main input, main select, main textarea, [role=dialog] input, [role=dialog] select, [role=dialog] textarea')) {
    if (el.type === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const ok = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label') || el.placeholder || el.title || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
    if (!ok) out.push(`${el.tagName.toLowerCase()}[type=${el.type || ''}]` + (el.name ? `[name=${el.name}]` : '') + (el.className ? '.' + String(el.className).split(' ').slice(0, 2).join('.') : ''));
  }
  return out;
};

const buttonsJs = () => {
  const btns = [];
  const main = document.querySelector('main') || document.body;
  const els = main.querySelectorAll('button, [role=tab], a[role=button]');
  els.forEach((el, i) => {
    if (el.closest('[role=dialog], aside, nav, form')) return;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > window.innerHeight * 3) return;
    const text = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50);
    el.setAttribute('data-crawl', String(i));
    btns.push({ idx: i, text, disabled: el.disabled });
  });
  return btns;
};

async function auditRoute(browser, state, vp, route, tag, results) {
  const ctx = await browser.newContext({ viewport: vp, storageState: state, deviceScaleFactor: 1, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const rec = { route, vp: tag, console: [], pageerrors: [], api: [], clicks: [], overflow: null, unlabeled: [], finalUrl: '', shot: '' };
  page.on('console', (m) => { if (m.type() === 'error') rec.console.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => rec.pageerrors.push(String(e.message || e).slice(0, 300)));
  rec.failedReq = [];
  page.on('requestfailed', (q) => { const u = q.url(); if (!/fonts\.(googleapis|gstatic)/.test(u)) rec.failedReq.push(u.slice(0, 160) + ' ' + (q.failure() && q.failure().errorText)); });
  page.on('response', async (r) => {
    try {
      const u = r.url();
      if (r.status() >= 400 && (u.includes('/api/') || u.includes('/bill/'))) {
        let body = '';
        try { body = (await r.text()).slice(0, 160); } catch { }
        rec.api.push({ url: u.replace(BASE, ''), status: r.status(), body, phase: rec._phase || 'load' });
      }
    } catch { }
  });
  try {
    await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => { });
    await page.waitForTimeout(1200);
    rec.finalUrl = page.url().replace(BASE, '');
    rec.overflow = await page.evaluate(overflowJs);
    rec.unlabeled = await page.evaluate(labelsJs);
    rec.shot = path.join(OUT, `${slug(route)}-${tag}.png`);
    await page.screenshot({ path: rec.shot, fullPage: false });
    // clicks
    if (!['/login', '/setup', '/signup', '/platform'].includes(route)) {
      const btns = (await page.evaluate(buttonsJs)).filter((b) => !b.disabled && b.text && !SKIP_RE.test(b.text)).slice(0, MAX_CLICKS);
      rec.buttonsSeen = btns.length;
      for (const b of btns) {
        const before = { c: rec.console.length, p: rec.pageerrors.length, a: rec.api.length };
        rec._phase = 'click:' + b.text;
        const r = { text: b.text, ok: true };
        try {
          await page.evaluate(buttonsJs);
          let el = page.locator(`[data-crawl="${b.idx}"]`).first();
          if (!(await el.count())) {
            const fresh = await page.evaluate(buttonsJs);
            const m = fresh.find((f) => f.text === b.text);
            if (!m) { r.ok = 'gone'; rec.clicks.push(r); continue; }
            el = page.locator(`[data-crawl="${m.idx}"]`).first();
          }
          await el.click({ timeout: 2500, force: false }).catch(async () => { r.clickErr = true; });
          await page.waitForTimeout(450);
          const url = page.url().replace(BASE, '');
          if (url.split('?')[0] !== route.split('?')[0] && url !== route) { r.navigatedTo = url; }
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
          const dialog = await page.locator('[role=dialog]').count();
          if (dialog) {
            // try close button
            const closeBtn = page.locator('[role=dialog] button[aria-label*="close" i], [role=dialog] button:has-text("×"), [role=dialog] button:has-text("Band"), [role=dialog] button:has-text("Close"), [role=dialog] button:has-text("Cancel")').first();
            if (await closeBtn.count()) await closeBtn.click({ timeout: 1500 }).catch(() => { });
            await page.waitForTimeout(300);
            if (await page.locator('[role=dialog]').count()) { r.stuckModal = true; await page.goto(BASE + route, { waitUntil: 'load', timeout: 20000 }).catch(() => { }); await page.waitForTimeout(900); await page.evaluate(buttonsJs); }
          }
          if (r.navigatedTo) { await page.goto(BASE + route, { waitUntil: 'load', timeout: 20000 }).catch(() => { }); await page.waitForTimeout(900); await page.evaluate(buttonsJs); }
        } catch (e) { r.err = String(e.message).slice(0, 120); }
        r.newConsole = rec.console.slice(before.c);
        r.newPageErr = rec.pageerrors.slice(before.p);
        r.newApi = rec.api.slice(before.a);
        if (r.newConsole.length || r.newPageErr.length || r.newApi.length || r.stuckModal || r.err) rec.clicks.push(r);
      }
      rec._phase = 'post';
    }
  } catch (e) { rec.fatal = String(e.message).slice(0, 200); }
  delete rec._phase;
  await ctx.close();
  results.push(rec);
  const o = rec.overflow;
  console.log(`${tag} ${route} -> ${rec.finalUrl} | con:${rec.console.length} pe:${rec.pageerrors.length} api:${rec.api.length} over:${o && o.over ? 'Y ' + o.scrollWidth + '>' + o.clientWidth + ' ' + (o.worst && o.worst.tag + '.' + o.worst.cls.slice(0, 40)) : 'n'} unl:${rec.unlabeled.length} clicks:${rec.clicks.length}`);
}

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctx0 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx0.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const p0 = await ctx0.newPage();
  await login(p0);
  const state = await ctx0.storageState();
  fs.writeFileSync(path.join(OUT, 'state.json'), JSON.stringify(state));
  await ctx0.close();
  const results = [];
  const outFile = path.join(OUT, ONLY ? 'results-partial.json' : 'results.json');
  const jobs = [];
  for (const route of ROUTES) {
    if (ONLY && !ONLY.includes(route)) continue;
    for (const [tag, vp] of [['d', { width: 1366, height: 900 }], ['m', { width: 390, height: 844 }]]) jobs.push([route, tag, vp]);
  }
  const N = 6;
  await Promise.all(Array.from({ length: N }, async () => {
    while (jobs.length) { const [route, tag, vp] = jobs.shift(); try { await auditRoute(browser, state, vp, route, tag, results); } catch (e) { console.log('FATAL', route, tag, e.message); } fs.writeFileSync(outFile, JSON.stringify(results, null, 1)); }
  }));
  await browser.close();
})();
