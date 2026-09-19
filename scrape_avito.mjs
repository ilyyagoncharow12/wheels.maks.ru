import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '.avito-state');
const OUT_JSON = path.join(__dirname, 'avito_products.json');
const CATALOG_HTML = path.join(__dirname, 'wheels_catalog.html');

function parseArgs() {
    const args = process.argv.slice(2);
    const watchIdx = args.indexOf('--watch');
    return {
        url: args.find(a => a.startsWith('http')) || null,
        deep: args.includes('--deep'),
        apply: args.includes('--apply'),
        headless: args.includes('--headless'),
        watch: watchIdx !== -1,
        intervalMin: (() => {
            if (watchIdx === -1) return 0;
            const v = parseInt(args[watchIdx + 1], 10);
            return Number.isFinite(v) && v > 0 ? v : 60;
        })(),
        limit: (() => {
            const i = args.indexOf('--limit');
            return i !== -1 && args[i + 1] ? parseInt(args[i + 1], 10) : Infinity;
        })(),
        help: args.includes('--help') || args.includes('-h')
    };
}

const HELP = `
Скрапер каталога шин с профиля Авито + автоперенос на сайт.

Использование:
  node scrape_avito.mjs <URL_профиля> [опции]

Опции:
  --deep        Открывать каждое объявление и вытаскивать год/протектор/состояние
  --limit N     Обрабатывать не больше N объявлений (по умолчанию все)
  --apply       Сразу вставить собранные товары в wheels_catalog.html
  --watch [мин] Режим наблюдателя: повторять каждые N минут (по умолчанию 60)
  --headless    Не показывать окно браузера
  --help        Эта справка

Примеры:
  node scrape_avito.mjs "https://www.avito.ru/brands/i22897394/all?sellerId=..." --apply
  node scrape_avito.mjs "https://www.avito.ru/brands/i22897394/all?sellerId=..." --deep --apply
  node scrape_avito.mjs "https://www.avito.ru/brands/i22897394/all?sellerId=..." --watch 60 --apply
`;

// ---------- Парсинг из карточки ----------

const WINTER_HINTS = /(hakka|hakkapeliitta|contiwinter|ice|arctic|wmos|snow|winter|gislaved|nordman|iceguard|icezero|studless|шип|зима|зимн)/i;
const SIZE_RE = /(\d{3})\s*\/\s*(\d{2})\s*R\s*(\d{2})/i;
const YEAR_RE = /(19|20)\d{2}/;

function cleanText(s = '') {
    return s.replace(/\s+/g, ' ').trim();
}

function parseSize(text) {
    const m = text.toUpperCase().match(SIZE_RE);
    if (!m) return null;
    return `${m[1]}/${m[2]} R${m[3]}`;
}

function normalizeImage(src = '') {
    if (!src) return '';
    let url = src.trim();
    if (url.startsWith('//')) url = 'https:' + url;
    return url;
}

function normalizeLink(link = '') {
    if (!link) return '';
    let url = link.startsWith('http') ? link : 'https://www.avito.ru' + link;
    try {
        const u = new URL(url);
        u.searchParams.delete('slocation');
        u.searchParams.delete('context');
        return u.toString();
    } catch {
        return url;
    }
}

function buildProduct(card, idx) {
    const title = cleanText(card.title);
    const cleanedTitle = title.replace(/^(шина|шины|колесо|колёса|покрышка|покрышки)\s*/i, '').replace(/^в сборе\s*/i, '');

    const size = parseSize(cleanedTitle) || card.size || '';
    const sizePos = size ? cleanedTitle.toUpperCase().indexOf(size) : -1;
    const brandPart = (sizePos > 0 ? cleanedTitle.slice(0, sizePos) : cleanedTitle).trim();
    const brandWords = brandPart.split(/\s+/);
    const brand = brandWords[0] ? brandWords[0].toUpperCase() : '';
    const rest = brandWords.slice(1).join(' ');

    const season = WINTER_HINTS.test(cleanedTitle) ? 'winter' : 'summer';
    const price = parseInt(String(card.price).replace(/\D/g, ''), 10) || 0;
    const fullTitle = size ? `${capitalize(brand)} ${rest} ${size}`.replace(/\s+/g, ' ').trim() : cleanedTitle;

    return {
        id: idx,
        brand,
        title: rest || cleanedTitle,
        image: normalizeImage(card.image),
        size,
        season,
        condition: 'used',
        tread: '—',
        year: null,
        price,
        fullTitle,
        specs: size ? [size] : [],
        link: normalizeLink(card.link)
    };
}

function capitalize(s) {
    return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

// ---------- Ожидание карточек (устойчиво к капче) ----------

const CARD_SELECTORS = [
    '[data-marker="item"]',
    '[data-marker-item="item"]',
    '[class*="iva-item-root"]',
    'div[itemtype*="Product"]',
    '[data-marker="catalog-serp"] [data-marker="item"]'
];

const TITLE_SELECTOR = 'a[data-marker="item-title"], [data-marker="item-title"] a, a[data-marker*="item-title"]';
const PRICE_SELECTOR = '[data-marker="item-price"], [data-marker*="price"], [class*="price"]';
const IMG_SELECTOR = 'img[data-marker="image"], img[src*="img.avito.st"], img[data-url*="img.avito.st"]';

async function waitForCards(page) {
    for (const sel of CARD_SELECTORS) {
        const cards = page.locator(sel).first();
        try {
            await cards.waitFor({ state: 'attached', timeout: 15000 });
            return sel;
        } catch { /* пробуем следующий */ }
    }
    return null;
}

async function scrapeCards(page) {
    const items = [];
    const urls = new Set();

    const numPages = await readTotalPages(page).catch(() => 1);

    for (let p = 1; p <= Math.max(1, numPages); p++) {
        const url = page.url();
        const pageUrl = url.includes('p=')
            ? url.replace(/p=\d+/, `p=${p}`)
            : url + (url.includes('?') ? '&' : '?') + `p=${p}`;

        if (p > 1) await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);

        const found = await waitForCards(page);
        if (!found) {
            console.log(`[!] Страница ${p}: не найдены карточки — возможно капча или нет объявлений`);
            break;
        }

        const countOnPage = await page.locator(found).count();
        console.log(`[•] Страница ${p}: найдено карточек: ${countOnPage}`);

        for (let i = 0; i < countOnPage; i++) {
            const card = page.locator(found).nth(i);
            let link = '';
            const linkEl = card.locator(TITLE_SELECTOR).first();
            const href = await linkEl.getAttribute('href').catch(() => null);
            if (href) {
                link = href.startsWith('http') ? href : 'https://www.avito.ru' + href;
            }

            const title = await card.locator(TITLE_SELECTOR).first().innerText().catch(() => '');
            const price = await card.locator(PRICE_SELECTOR).first().innerText().catch(() => '');
            const imgEl = card.locator(IMG_SELECTOR).first();
            const image = await imgEl.getAttribute('src').catch(() => null)
                || await imgEl.getAttribute('data-url').catch(() => null)
                || '';

            items.push({ title, price, link, image });
        }

        if (p >= numPages || items.length >= args.limit) break;
    }

    const seen = new Set();
    const unique = items.filter(it => {
        const key = it.link || it.title;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return unique;
}

async function readTotalPages(page) {
    const paginator = page.locator('[data-marker="pagination-button/nextPage"]').first();
    if (await paginator.isVisible().catch(() => false)) {
        return 5; // есть пагинация, но точное число неизвестно — смотрим до 5 страниц
    }
    return 1;
}

// ---------- Глубокий сбор параметров с отдельного объявления ----------

async function scrapeDetail(page, link) {
    try {
        const target = link.startsWith('http') ? link : 'https://www.avito.ru' + link;
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1800);

        const text = await page.locator('body').innerText().catch(() => '');

        const yearMatch = text.match(YEAR_RE);
        const season = WINTER_HINTS.test(text) ? 'winter' : 'summer';
        const condition = /новое|новая/i.test(text) && !/б\/у|б\.у|бывш/i.test(text) ? 'new' : 'used';
        const treadMatch = text.match(/(?:протектор|остаток)[^\n]{0,40}?(\d+(?:[.,]\d+)?)\s*мм/);

        return {
            year: yearMatch ? parseInt(yearMatch[0], 10) : null,
            season,
            condition,
            tread: treadMatch ? treadMatch[1].replace('.', ',') + ' мм' : '—'
        };
    } catch {
        return null;
    }
}

// ---------- Сборка финального массива ----------

async function collectProducts(page, cards) {
    const products = [];
    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        if (products.length >= args.limit) break;

        const prod = buildProduct(card, i + 1);

        if (args.deep && card.link) {
            const detail = await scrapeDetail(page, card.link);
            if (detail) {
                prod.season = detail.season;
                prod.condition = detail.condition;
                prod.tread = detail.tread;
                prod.year = detail.year;
            }
        }

        prod.specs = [prod.size, prod.tread !== '—' ? prod.tread : null, prod.year ? String(prod.year) : null].filter(Boolean);
        products.push(prod);

        console.log(`[✓] ${prod.fullTitle} | ${prod.price} ₽ | ${prod.condition}${prod.year ? ' ' + prod.year : ''}${prod.tread && prod.tread !== '—' ? ' | ' + prod.tread : ''}`);
    }
    return products;
}

// ---------- Вставка в каталог ----------

function serializeProducts(products) {
    const lines = products.map(p => {
        const inner = Object.entries(p)
            .map(([k, v]) => {
                const val = typeof v === 'string' ? `"${v.replace(/"/g, '\\"')}"` : JSON.stringify(v);
                return `                ${k}: ${val}`;
            })
            .join(',\n');
        return `            {\n${inner}\n            }`;
    });
    return lines.join(',\n\n');
}

function applyToCatalog(products) {
    if (!products.length) {
        console.warn('[!] Нечего вставлять — собрано 0 товаров. Каталог не тронут.');
        return false;
    }
    if (!existsSync(CATALOG_HTML)) {
        console.error('[!] wheels_catalog.html не найден');
        return false;
    }
    let html = readFileSync(CATALOG_HTML, 'utf8');
    const start = html.indexOf('const products = [');
    const end = html.indexOf('];', start);
    if (start === -1 || end === -1) {
        console.error('[!] Блок "const products = [...]" не найден в wheels_catalog.html');
        return false;
    }

    let next = products;
    if (start !== -1) {
        // Влияем на каталог: обновляем существующие по ссылке, новые добавляем
        try {
            const oldBlock = html.slice(start, end + 2);
            const arrMatch = oldBlock.match(/const products = \[([\s\S]*)\];/);
            if (arrMatch) {
                const current = eval('[' + arrMatch[1] + ']');
                const seen = new Set();
                current.forEach(p => { if (p.link) seen.add(p.link); });
                let maxId = current.reduce((m, p) => Math.max(m, p.id || 0), 0);
                const fresh = products.filter(p => !seen.has(p.link));
                fresh.forEach(p => { maxId += 1; p.id = maxId; });
                next = [...current, ...fresh];
                console.log(`[•] В каталоге уже есть: ${current.length}, новых добавлено: ${fresh.length}`);
            }
        } catch (e) {
            console.warn('[!] Не смог прочитать текущий каталог, заменяю целиком:', e.message);
        }
    }

    const body = `const products = [\n${serializeProducts(next)}\n\n        ];`;
    html = html.slice(0, start) + body + html.slice(end + 2);
    writeFileSync(CATALOG_HTML, html, 'utf8');
    console.log(`[✓] Каталог обновлён: ${next.length} товаров`);
    return true;
}

// ---------- Main ----------

const args = parseArgs();
if (args.help || !args.url) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
}

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

async function runOnce() {
    console.log('\n[•] Запуск браузера...');
    const context = await chromium.launchPersistentContext(STATE_DIR, {
        headless: args.headless,
        viewport: { width: 1440, height: 900 },
        locale: 'ru-RU',
        args: ['--disable-blink-features=AutomationControlled']
    });
    try {
        const page = context.pages()[0] || await context.newPage();
        await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 90000 });

        await page.waitForTimeout(2500);

        // Авито-защита: «Доступ ограничен» / капча
        const blocked = async () => {
            const t = await page.locator('body').innerText().catch(() => '');
            return /доступ ограничен|капч|не робот|recaptcha|captcha|verify/i.test(t + ' ' + page.url());
        };

        if (await blocked()) {
            console.log('[!] Авито показал проверку «не робот». Жму «Продолжить» и жду ручного решения капчи...');
            const btn = page.getByRole('button', { name: /Продолжить/ }).first();
            if (await btn.isVisible().catch(() => false)) {
                await btn.click().catch(() => {});
            }
            try {
                await page.waitForTimeout(2500);
                for (let i = 0; i < 60; i++) {
                    if (!(await blocked())) break;
                    await page.waitForTimeout(3000);
                }
            } finally { /* ничего */ }
            if (await blocked()) {
                console.log('[!] Проверку так и не прошли.');
                return 0;
            }
            console.log('[✓] Проверка пройдена, продолжаю.');
            await page.waitForTimeout(1500);
        }

        const cards = await scrapeCards(page);
        cards.forEach(c => console.log(`[~] Найден: ${c.title} — ${c.price} ₽`));
        console.log(`[•] Уникальных объявлений: ${cards.length}`);

        const products = await collectProducts(page, cards);

        writeFileSync(OUT_JSON, JSON.stringify(products, null, 4), 'utf8');
        console.log(`[✓] avito_products.json сохранён (${products.length} товаров)`);

        if (args.apply) {
            applyToCatalog(products);
        }
        return products.length;
    } finally {
        await context.close();
    }
}

const count = await runOnce();

if (args.watch) {
    const min = args.intervalMin;
    console.log(`\n[⌛] Режим наблюдателя: повтор каждые ${min} мин. Ctrl+C для остановки.`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
        await new Promise(r => setTimeout(r, min * 60_000));
        const c = await runOnce();
        console.log(`[•] ${new Date().toLocaleString('ru-RU')} — собрано ${c} объявлений`);
    }
}

console.log('[✓] Готово.');