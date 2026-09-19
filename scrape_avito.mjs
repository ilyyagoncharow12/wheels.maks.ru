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
    const batchIdx = args.indexOf('--batch');
    return {
        url: args.find(a => a.startsWith('http')) || null,
        deep: args.includes('--deep'),
        apply: args.includes('--apply'),
        verify: args.includes('--verify'),
        headless: args.includes('--headless'),
        batch: (() => {
            if (batchIdx === -1) return 12;
            const v = args[batchIdx + 1];
            if (v === 'all' || v === '0') return Infinity;
            const n = parseInt(v, 10);
            return Number.isFinite(n) && n > 0 ? n : 12;
        })(),
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
        help: args.includes('--help') || args.includes('-h'),
        force: args.includes('--force')
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
  --batch N     Сколько НОВЫХ карточек добавлять за один раз (по умолчанию 12).
                Остальные новые подождут следующего запуска.
                'all' или 0 — добавить всё сразу.
  --verify      Дописать год/протектор в уже добавленные карточки по их объявлениям,
                проверить «снятые с продажи» и убрать их из каталога
  --force       Вместе с --verify: обойти ВСЕ объявления (не только с пустыми полями),
                например чтобы обновить состояние «Новые»/«Б/у»
  --watch [мин] Режим наблюдателя: повторять каждые N минут (по умолчанию 60)
  --headless    Не показывать окно браузера
  --help        Эта справка

Примеры:
  node scrape_avito.mjs "https://www.avito.ru/brands/i22897394/all?sellerId=..." --apply
  node scrape_avito.mjs "https://www.avito.ru/brands/i22897394/all?sellerId=..." --deep --apply
  node scrape_avito.mjs "https://www.avito.ru/brands/i22897394/all?sellerId=..." --batch 12 --apply
  node scrape_avito.mjs "https://www.avito.ru/brands/i22897394/all?sellerId=..." --batch all --deep --apply
  node scrape_avito.mjs "https://www.avito.ru/brands/i22897394/all?sellerId=..." --verify
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

function parsePrice(text = '') {
    const m = String(text).match(/([\d\s\u00A0,.\s]+)\s*₽/);
    if (!m) return 0;
    return parseInt(m[1].replace(/\D/g, ''), 10) || 0;
}

function parseQuantity(text = '') {
    const m = String(text).match(/за\s*(\d+)\s*шт/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
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
    const price = parsePrice(card.price);
    const count = parseQuantity(card.price);
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
        count,
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
    const seenLinks = new Set();
    const MAX_PAGES = 30;

    for (let p = 1; p <= MAX_PAGES; p++) {
        const url = page.url();
        const pageUrl = url.includes('p=')
            ? url.replace(/p=\d+/, `p=${p}`)
            : url + (url.includes('?') ? '&' : '?') + `p=${p}`;
        if (p > 1) await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        const found = await waitForCards(page);
        if (!found) {
            console.log(`[!] Страница ${p}: не найдены карточки — возможно капча или всё собрано`);
            break;
        }

        // Долистываем, чтобы подгрузились все ленивые карточки
        for (let s = 0; s < 6; s++) {
            await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
            await page.waitForTimeout(800);
        }
        await page.evaluate(() => window.scrollTo(0, 0));

        const countOnPage = await page.locator(found).count();
        console.log(`[•] Страница ${p}: найдено карточек: ${countOnPage} (собрано всего: ${items.length})`);

        let addedOnPage = 0;
        for (let i = 0; i < countOnPage; i++) {
            const card = page.locator(found).nth(i);
            let link = '';
            const linkEl = card.locator(TITLE_SELECTOR).first();
            const href = await linkEl.getAttribute('href').catch(() => null);
            if (href) {
                link = normalizeLink(href);
            }

            const title = await card.locator(TITLE_SELECTOR).first().innerText().catch(() => '');
            const price = await card.locator(PRICE_SELECTOR).first().innerText().catch(() => '');
            const imgEl = card.locator(IMG_SELECTOR).first();
            const image = await imgEl.getAttribute('src').catch(() => null)
                || await imgEl.getAttribute('data-url').catch(() => null)
                || '';

            const key = link || title;
            if (key && !seenLinks.has(key)) {
                seenLinks.add(key);
                items.push({ title, price, link, image });
                addedOnPage++;
            }
        }
        console.log(`[•] Страница ${p}: новых уникальных: ${addedOnPage}`);

        if (addedOnPage === 0) break; // страница без новых карточек — конец списка
        if (items.length >= args.limit) break;
    }

    return items;
}

// ---------- Глубокий сбор параметров с отдельного объявления ----------

function parseYearFromText(text) {
    if (!text) return null;
    const pats = [
        /((?:19|20)\d{2})\s*(?:год(?:а|у|ом|е)?|г\.в\.?|г\.)/i,
        /год\s+выпуска[:\s]*((?:19|20)\d{2})/i,
        /((?:19|20)\d{2})\s*г/i
    ];
    for (const pat of pats) {
        const m = text.match(pat);
        if (m) {
            const y = parseInt(m[1], 10);
            if (y >= 1970 && y <= 2030) return y;
        }
    }
    return null;
}

function parseTreadFromText(text) {
    if (!text) return null;
    if (/протектор[^0-9]{0,40}нов|нов[а-я]*\s*протектор|резин[а-я]*\s+нов/i.test(text)) {
        return { tread: 'новая', condition: 'new' };
    }
    const m = text.match(/(?:остаток\s+протектора|протектор[а-я]*|износ[а-я]*)[^0-9а-я]{0,60}?(\d+(?:[.,]\d+)?)\s*(?:мм|mm|миллиметр(?:а|ов)?)/i);
    if (m) return { tread: m[1].replace('.', ',') + ' мм', condition: 'used' };
    return null;
}

function parseDetail(params, descText) {
    const p = params || {};
    const get = (...names) => {
        for (const n of names) {
            const v = p[n];
            if (v && String(v).trim()) return String(v).trim();
        }
        return '';
    };

    // Год: из параметра, иначе из описания
    let year = null;
    const yearParam = get('Год выпуска', 'Год производства', 'Год');
    if (/^\d{4}$/.test(yearParam)) year = parseInt(yearParam, 10);
    if (!year) year = parseYearFromText(descText);

    // Протектор + состояние. Состояние из параметра — приоритет.
    let tread = '';
    let condition = null;
    const condParam = get('Состояние');
    if (condParam) {
        condition = /нов/i.test(condParam) ? 'new' : 'used';
    }
    const treadParam = get('Остаток протектора', 'Протектор');
    if (treadParam && /нов/i.test(treadParam)) {
        tread = 'новая';
        if (condition === null) condition = 'new';
    } else if (treadParam) {
        const tm = treadParam.match(/(\d+(?:[.,]\d+)?)/);
        tread = tm ? tm[1].replace('.', ',') + ' мм' : treadParam;
        if (condition === null) condition = 'used';
    }
    if (!tread) {
        const t = parseTreadFromText(descText);
        if (t) {
            tread = t.tread;
            if (condition === null) condition = t.condition;
        }
    }
    // Новые шины без указанного протектора — протектор «новая»
    if (condition === 'new' && !tread) tread = 'новая';
    if (condition === null) condition = 'used';

    // Сезон: явный параметр или явное упоминание в описании
    let season = null;
    const sezParam = get('Сезонность', 'Сезон', 'Шипованные');
    if (sezParam) {
        const sv = sezParam.toLowerCase();
        if (/зим|шип/.test(sv)) season = 'winter';
        else if (/лет|всесезон/.test(sv)) season = 'summer';
    } else if (descText) {
        if (/зимн|шипов/.test(descText.toLowerCase())) season = 'winter';
        else if (/летн|всесезон|шос/.test(descText.toLowerCase())) season = 'summer';
    }

    return { year, tread, condition, season };
}

function isBlockedPage(page) {
    return page.locator('body').innerText()
        .catch(() => '')
        .then(t => /доступ ограничен|проблема с IP|капч|не робот|recaptcha|captcha|verify/i.test(t));
}

async function solveAvitoCaptcha(page) {
    const btn = page.getByRole('button', { name: /Продолжить/ }).first();
    if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
    }
    await page.waitForTimeout(2500);
    for (let i = 0; i < 80; i++) {
        if (!(await isBlockedPage(page))) return true;
        await page.waitForTimeout(3000);
    }
    return !(await isBlockedPage(page));
}

async function gotoDetail(page, link) {
    const target = link.startsWith('http') ? link : 'https://www.avito.ru' + link;
    for (let attempt = 1; attempt <= 2; attempt++) {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2200);
        if (!(await isBlockedPage(page))) return true;
        console.log('[!] Авито: «Доступ ограничен» на странице объявления. Жму «Продолжить» и жду ручного решения капчи...');
        await solveAvitoCaptcha(page);
        if (!(await isBlockedPage(page))) return true;
    }
    return false;
}

async function scrapeDetail(page, link) {
    const ok = await gotoDetail(page, link);
    if (!ok) {
        console.log(`[!] Капча не решена для ${link}. Пропускаю.`);
        return null;
    }

    const d = await page.evaluate(() => {
        const out = { params: {}, desc: '', body: '', removed: false };
        const list = document.querySelector('[data-marker="item-view/item-params"]');
        if (list) {
            list.querySelectorAll('li').forEach(li => {
                const text = (li.innerText || '').trim();
                const idx = text.indexOf(':');
                if (idx > 0) out.params[text.slice(0, idx).trim()] = text.slice(idx + 1).trim();
            });
        }
        const descEl = document.querySelector('[data-marker="item-view/item-description"], [itemprop="description"]');
        if (descEl) out.desc = (descEl.innerText || '').trim().slice(0, 2500);
        const h1 = (document.querySelector('h1, [data-marker="item-view/title-info-title"]') || {}).innerText || '';
        out.body = (document.body ? document.body.innerText : '').slice(0, 1500);
        out.removed = /снят(?:о|ы)? с (продажи|публикации)|товар снят с продажи|больше не(доступно| существует)|объявление (удалено|не найдено)|ошибочный адрес|не найдено/i.test(h1 + ' ' + out.body + ' ' + location.pathname);
        const priceEl = document.querySelector('[data-marker="item-view/item-price"], [itemprop="price"], [data-marker*="item-price"]');
        if (priceEl) out.priceText = (priceEl.innerText || '').trim();
        const qm = /₽\s*за\s*(\d+)\s*шт/i.exec(out.body);
        if (qm) out.count = parseInt(qm[1], 10);
        return out;
    }).catch(() => null);

    if (!d) return null;
    if (d.removed) return { removed: true };
    const parsed = parseDetail(d.params, d.desc);
    parsed.price = parsePrice(d.priceText);
    parsed.detailCount = d.count || null;
    return { removed: false, ...parsed };
}

// ---------- Сборка финального массива ----------

async function collectProducts(page, cards) {
    const products = [];
    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        if (products.length >= args.limit) break;

        const prod = buildProduct(card, i + 1);

        // Глубокая проверка — только если карточки ещё нет на сайте или не хватает год/протектор
        const known = existingCatalog.get(prod.link);
        const needsRefill = known
            && (!known.year || !known.tread || known.tread === '—' || !known.season);
        if (args.deep && card.link && (!existingLinksSet.has(card.link) || needsRefill)) {
            const detail = await scrapeDetail(page, card.link);
            if (detail) {
                if (detail.removed) {
                    console.log(`[✕] Снято с продажи: ${prod.fullTitle} — пропускаю`);
                    continue;
                }
                if (detail.season) prod.season = detail.season;
                prod.condition = detail.condition;
                prod.tread = detail.tread || (detail.condition === 'new' ? 'новая' : '—');
                prod.year = detail.year;
            }
            // Пауза между запросами, чтобы не словить ограничение
            await page.waitForTimeout(1800 + Math.random() * 2200);
        }

        prod.specs = [prod.size, prod.tread !== '—' ? prod.tread : null, prod.year ? String(prod.year) : null].filter(Boolean);
        products.push(prod);

        console.log(`[✓] ${prod.fullTitle} | ${prod.price} ₽ | ${prod.condition}${prod.year ? ' ' + prod.year : ''}${prod.tread && prod.tread !== '—' ? ' | ' + prod.tread : ''}`);
    }
    return products;
}

function loadCatalogArray() {
    const map = new Map();
    const set = new Set();
    const list = [];
    try {
        const html = readFileSync(CATALOG_HTML, 'utf8');
        const start = html.indexOf('const products = [');
        const end = html.indexOf('];', start);
        if (start !== -1 && end !== -1) {
            const oldBlock = html.slice(start, end + 2);
            const m = oldBlock.match(/const products = \[([\s\S]*)\];/);
            if (m) {
                const current = eval('[' + m[1] + ']');
                current.forEach(p => {
                    list.push(p);
                    if (p.link) {
                        map.set(p.link, p);
                        set.add(p.link);
                    }
                });
            }
        }
    } catch { /* каталога нет — считаем что всё новое */ }
    return { map, set, list };
}

const { map: existingCatalog, set: existingLinksSet } = loadCatalogArray();

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

function applyToCatalog(products, batch = 12) {
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
        // Обновляем существующие позиции по ссылке, новые добавляем
        try {
            const oldBlock = html.slice(start, end + 2);
            const arrMatch = oldBlock.match(/const products = \[([\s\S]*)\];/);
            if (arrMatch) {
                const current = eval('[' + arrMatch[1] + ']');
                const byLink = new Map();
                current.forEach(p => { if (p.link) byLink.set(p.link, p); });

                let updatedCount = 0;
                let maxId = current.reduce((m, p) => Math.max(m, p.id || 0), 0);
                const allFresh = products.filter(p => !byLink.has(p.link));
                const fresh = allFresh.slice(0, batch);
                const pending = allFresh.length - fresh.length;
                products.forEach(p => {
                    const ex = byLink.get(p.link);
                    if (ex) {
                        const keptId = ex.id;
                        // Не затираем заполненные поля пустыми значениями из карточки
                        const keep = {};
                        const protect = ['year', 'tread', 'season', 'specs', 'title', 'brand', 'fullTitle', 'size'];
                        for (const k of protect) {
                            const fv = p[k];
                            const empty = fv === null || fv === undefined || fv === '' || fv === '—'
                                || (Array.isArray(fv) && fv.length === 0);
                            if (empty) keep[k] = ex[k];
                        }
                        Object.assign(ex, p, keep, { id: keptId });
                        updatedCount++;
                    }
                });
                fresh.forEach(p => { maxId += 1; p.id = maxId; });

                next = [...current];
                next.push(...fresh);
                console.log(`[•] Обновлено существующих: ${updatedCount}, новых добавлено: ${fresh.length}${pending > 0 ? ` (ещё ${pending} ждут следующего запуска)` : ''}`);
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

function writeCatalog(products) {
    const html = readFileSync(CATALOG_HTML, 'utf8');
    const start = html.indexOf('const products = [');
    const end = html.indexOf('];', start);
    if (start === -1 || end === -1) {
        console.error('[!] Блок "const products = [...]" не найден в wheels_catalog.html');
        return false;
    }
    const body = `const products = [\n${serializeProducts(products)}\n\n        ];`;
    writeFileSync(CATALOG_HTML, html.slice(0, start) + body + html.slice(end + 2), 'utf8');
    return true;
}

async function runVerify() {
    console.log('\n[•] Проверка каталога по объявлениям Авито...');
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

        if (await isBlockedPage(page)) {
            console.log('[!] Авито: проверка «не робот». Жму «Продолжить» и жду ручного решения...');
            if (!(await solveAvitoCaptcha(page))) {
                console.log('[!] Капчу не решили — прерываю.');
                return;
            }
            await page.waitForTimeout(1500);
        }

        const cards = await scrapeCards(page);
        console.log(`[•] Живых объявлений на Авито: ${cards.length}`);

        const liveByLink = new Map();
        cards.forEach((c, i) => liveByLink.set(normalizeLink(c.link), buildProduct(c, i + 1)));

        const { list } = loadCatalogArray();
        // Нормализуем ссылки, чтобы совпадали со свежими карточками
        list.forEach(p => { p.link = normalizeLink(p.link); });
        const next = [];
        let visited = 0;
        let filled = 0;
        let pricesUpdated = 0;
        const removedList = [];

        for (const p of list) {
            const live = liveByLink.get(p.link);
            const needVisit = args.force || !live || !p.year || !p.tread || p.tread === '—';

            let detail = null;
            if (needVisit) {
                detail = await scrapeDetail(page, p.link);
                visited++;
                if (detail && detail.removed) {
                    removedList.push(`${p.brand} ${p.title}`);
                    console.log(`[✕] Снято с продажи: ${p.brand} ${p.title} — удаляю`);
                    continue;
                }
                await page.waitForTimeout(1500 + Math.random() * 2000);
            }

            if (detail && !detail.removed) {
                if (detail.year) p.year = detail.year;
                if (detail.tread) p.tread = detail.tread;
                if (detail.condition) p.condition = detail.condition;
                if (detail.season) p.season = detail.season;
                if (!p.count && detail.detailCount) p.count = detail.detailCount;
                if (!live && detail.price) p.price = detail.price;
                p.specs = [p.size, p.tread !== '—' ? p.tread : null, p.year ? String(p.year) : null].filter(Boolean);
                filled++;
                console.log(`[✓] ${p.fullTitle || p.brand + ' ' + p.title} | ${p.year ? p.year + ' | ' : ''}${p.tread !== '—' ? p.tread : ''}`);
            }

            if (live) {
                if (live.price) p.price = live.price;
                if (live.count) p.count = live.count;
                pricesUpdated++;
            }

            next.push(p);

            if (visited > 0 && visited % 15 === 0) {
                writeCatalog(next);
                console.log(`[•] Промежуточное сохранение: ${next.length} карточек (проверено объявлений: ${visited})`);
            }
        }

        writeCatalog(next);
        writeFileSync(OUT_JSON, JSON.stringify(next, null, 4), 'utf8');
        console.log(`\n[✓] Готово: в каталоге ${next.length} карточек.`);
        console.log(`    дополнено год/протектор: ${filled}, цены обновлены: ${pricesUpdated}, удалено снятых: ${removedList.length}`);
        if (removedList.length) {
            console.log('    Удалённые объявления:\n     - ' + removedList.join('\n     - '));
        }
    } finally {
        await context.close();
    }
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
        if (await isBlockedPage(page)) {
            console.log('[!] Авито показал проверку «не робот». Жму «Продолжить» и жду ручного решения капчи...');
            const solved = await solveAvitoCaptcha(page);
            if (!solved) {
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
            applyToCatalog(products, args.batch);
        }
        return products.length;
    } finally {
        await context.close();
    }
}

const count = await (args.verify ? runVerify() : runOnce());

if (args.verify) {
    process.exit(0);
}

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