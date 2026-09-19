import { chromium } from 'playwright';

const URL = process.argv[2] || 'https://www.avito.ru/dolgoprudnyy/zapchasti_i_aksessuary/continental_contipremiumcontact_6_24545_r19_7407237554';
const STATE_DIR = '.avito-state';

const ctx = await chromium.launchPersistentContext(STATE_DIR, { headless: false });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3500);

const info = await page.evaluate(() => {
    const out = {
        href: location.href,
        title: document.title,
        h1: (document.querySelector('h1') || {}).innerText || '',
        paramsBlock: '',
        paramsList: [],
        description: '',
        bodySnippet: (document.body ? document.body.innerText : '').slice(0, 3000),
    };
    const list = document.querySelector('[data-marker="item-view/item-params"]');
    if (list) {
        out.paramsBlock = list.innerText || '';
        out.paramsList = Array.from(list.querySelectorAll('li')).map(li => (li.innerText || '').trim());
    }
    const desc = document.querySelector('[data-marker="item-view/item-description"], [itemprop="description"], .item-description');
    if (desc) out.description = (desc.innerText || '').trim().slice(0, 1500);
    return out;
}).catch(e => ({ error: e.message }));

console.log(JSON.stringify(info, null, 2));
await ctx.close();
