import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('.avito-state', { headless: true });
const page = ctx.pages()[0] || await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push('JS: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('CON: ' + m.text()); });

await page.setViewportSize({ width: 1280, height: 900 });
await page.goto('file:///C:/Users/5/PycharmProjects/wheels.maks.ru/wheels_catalog.html', { waitUntil: 'load' });
await page.waitForTimeout(1500);
const r = await page.evaluate(() => ({
  count: document.querySelectorAll('.product-card').length,
  resultsCount: document.getElementById('resultsCount').textContent,
  resultsTotal: document.getElementById('resultsTotal').textContent,
  gridInner: document.getElementById('productsGrid').innerHTML.length,
  emptyNotice: document.querySelector('.no-tires') ? 'есть' : 'нет',
  productsVar: typeof products !== 'undefined' ? products.length : 'нет переменной',
  gridHtml: document.getElementById('productsGrid').textContent.slice(0, 120)
}));
console.log('DESKTOP:', JSON.stringify(r, null, 1));

await page.setViewportSize({ width: 390, height: 844 });
await page.goto('file:///C:/Users/5/PycharmProjects/wheels.maks.ru/wheels_catalog.html', { waitUntil: 'load' });
await page.waitForTimeout(1200);
const m = await page.evaluate(() => ({
  count: document.querySelectorAll('.product-card').length,
  resultsCount: document.getElementById('resultsCount').textContent,
  overflow: document.documentElement.scrollWidth > window.innerWidth
}));
console.log('MOBILE:', JSON.stringify(m));
console.log('errors:', errs.length ? errs.join(' | ') : 'нет');
await ctx.close();