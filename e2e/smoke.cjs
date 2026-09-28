// Teste ponta a ponta (Playwright) contra um servidor em execução.
// Uso: BASE_URL=http://localhost:3000 node e2e/smoke.cjs   (requer `npm i -g playwright` ou playwright no NODE_PATH)
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const email = `e2e${Date.now()}@test.dev`;
  await page.goto(`${BASE}/register`);
  await page.fill('input:not([type])', 'Usuário E2E');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', 'secret123');
  await page.click('button.btn.lg');
  await page.waitForURL('**/tracker', { timeout: 15000 });
  await page.fill('input.desc', 'Registro E2E');
  await page.click('text=Iniciar');
  await page.waitForSelector('text=Parar');
  await page.click('text=Parar');
  await page.waitForSelector('text=Registro E2E');
  for (const route of ['/timesheet', '/calendar', '/dashboard', '/reports', '/projects', '/team', '/clients', '/tags', '/settings', '/profile']) {
    await page.goto(`${BASE}${route}`);
    await page.waitForTimeout(500);
  }
  await browser.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('e2e ok');
})().catch((e) => { console.error(e); process.exit(1); });
