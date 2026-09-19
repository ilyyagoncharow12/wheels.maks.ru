import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const h = readFileSync('wheels_catalog.html', 'utf8');
const m = h.match(/const products = \[([\s\S]*?)\n\s*\];/);
const arr = eval('[' + m[1] + ']');
const ids = [5, 14, 15, 58, 65, 98];

const ctx = await chromium.launchPersistentContext('.avito-state', { headless: false });
const page = ctx.pages()[0] || await ctx.newPage();

for (const id of ids) {
    const p = arr.find(x => x.id === id);
    await page.goto(p.link, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2200);
    const info = await page.evaluate(() => {
        const h1 = (document.querySelector('h1') || {}).innerText || '';
        const params = {};
        const list = document.querySelector('[data-marker="item-view/item-params"]');
        if (list) list.querySelectorAll('li').forEach(li => {
            const t = (li.innerText || '').trim();
            const i = t.indexOf(':');
            if (i > 0) params[t.slice(0, i).trim()] = t.slice(i + 1).trim();
        });
        const dead = /снят(?:о|ы)? с (продажи|публикации)|товар снят с продажи|больше не(доступно| существует)|не найдено|ошибочный адрес/i.test(h1 + ' ' + (document.body ? document.body.innerText : '').slice(0, 900));
        return { href: location.href.slice(0, 80), h1: h1.slice(0, 60), params: { 'Состояние': params['Состояние'], 'Остаток протектора': params['Остаток протектора'], 'Год выпуска': params['Год выпуска'] }, dead };
    }).catch(e => ({ err: e.message }));
    console.log(id, JSON.stringify(info));
}

await ctx.close();