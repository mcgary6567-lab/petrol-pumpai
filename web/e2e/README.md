# Wholesale ERP — end-to-end tests

Playwright specs for the wholesale pages (dashboard, supply voucher, party ledger, supply invoices, order-to-cash board),
written against roles and labels (Page Object Model in `pages/`).

They post real vouchers, so run them only against a **demo-data** server — never a live pump.

```sh
# once
npm i -D @playwright/test        # in web/ — brings its own browser
# server with demo data on :4242 (any empty DB_PATH seeds the demo)
PORT=4242 DB_PATH=/tmp/e2e.db npm run dev -w server
# run
cd web && E2E_BASE_URL=http://localhost:4242 npx playwright test -c e2e/playwright.config.ts
```

`@playwright/test` is deliberately not in `package.json` so the production image (`npm ci && npm run build`) stays small;
add it locally or in the CI job that runs these.
