// ============================================================================
//  Шины Макс — локальная админ-панель
//  Запуск:  node admin-server.mjs   (или start-admin.bat)
//  Адрес:   http://localhost:8787/admin/
// ============================================================================
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(ROOT, 'admin.config.json');
const PRODUCTS_FILE = path.join(ROOT, 'products.js');
const CONTENT_FILE = path.join(ROOT, 'content.json');
const UPLOAD_DIR = path.join(ROOT, 'images', 'uploads');
const BACKUP_DIR = path.join(ROOT, '.admin-backups');
const EDITS_FILE = path.join(ROOT, 'site-edits.json');
const WORK_FILE = path.join(ROOT, 'work-log.json');
const WORK_PHOTO_DIR = path.join(ROOT, 'images', 'work');
const SESSION_COOKIE = 'maks_admin';
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

// Две учётные записи: владелец и мастер. Пароли можно сменить в «Настройках».
const DEFAULT_USERS = [
    { username: '+79067867046', password: 'Shina-Maks_110034', role: 'owner' },
    { username: 'work', password: '203225_shina_w', role: 'worker' },
];

// ---------------------------------------------------------------- конфиг ---
function hashPassword(password, salt) {
    return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function saveConfig(data) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function makeUser(password, role) {
    const salt = crypto.randomBytes(16).toString('hex');
    return {
        salt,
        hash: hashPassword(password, salt),
        role,
        mustChangePassword: false,
    };
}

function loadConfig() {
    let config = null;
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        } catch (e) {
            console.error('[!] admin.config.json повреждён:', e.message);
            process.exit(1);
        }
    }

    // Переход на мультипользовательскую схему (владелец + мастер).
    if (!config || !config.users || typeof config.users !== 'object') {
        const base = config || {};
        const users = {};
        for (const u of DEFAULT_USERS) users[u.username] = makeUser(u.password, u.role);
        config = {
            users,
            secret: base.secret || crypto.randomBytes(32).toString('hex'),
            port: base.port || 8787,
            createdAt: base.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        saveConfig(config);
        console.log('');
        console.log('  Доступ к панели:');
        console.log('  - владелец: логин +79067867046');
        console.log('  - мастер:   логин work');
        console.log('  Пароли можно сменить в «Настройках» после входа.');
        console.log('');
    }
    return config;
}

const config = loadConfig();
const PORT = Number(process.env.PORT || config.port || 8787);

// --------------------------------------------------------------- сессии ---
const sessions = new Map();
const loginAttempts = new Map();

function signToken(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', config.secret).update(body).digest('base64url');
    return `${body}.${sig}`;
}

function readToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', config.secret).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!data || data.exp < Date.now()) return null;
        return data;
    } catch { return null; }
}

function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function currentUser(req) {
    const data = readToken(cookies(req)[SESSION_COOKIE]);
    if (!data) return null;
    const live = sessions.get(data.sid);
    if (!live || live.exp < Date.now()) return null;
    return data;
}

function isAuthed(req) {
    return Boolean(currentUser(req));
}

function requireAuth(req, res) {
    if (isAuthed(req)) return true;
    json(res, 401, { ok: false, error: 'Требуется вход' });
    return false;
}

function requireOwner(req, res) {
    const user = currentUser(req);
    if (!user) {
        json(res, 401, { ok: false, error: 'Требуется вход' });
        return false;
    }
    if (user.role !== 'owner') {
        json(res, 403, { ok: false, error: 'Доступно только владельцу' });
        return false;
    }
    return true;
}

function userConfig(username) {
    return username && config.users ? config.users[username] || null : null;
}

// ------------------------------------------------------------- утилиты ---
function json(res, code, data) {
    const body = JSON.stringify(data);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function readBody(req, limit = 25 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', c => {
            size += c.length;
            if (size > limit) { reject(new Error('Слишком большой запрос')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(new Error('Некорректный JSON')); }
        });
        req.on('error', reject);
    });
}

function sameOrigin(req) {
    const origin = req.headers.origin || req.headers.referer;
    if (!origin) return true; // curl / локальные инструменты
    try {
        const u = new URL(origin);
        return u.host === req.headers.host;
    } catch { return false; }
}

function serverError(res, e) {
    console.error('[!]', e);
    json(res, 500, { ok: false, error: e.message || 'Внутренняя ошибка' });
}

// ------------------------------------------------------------- товары ---
function loadProducts() {
    const code = fs.readFileSync(PRODUCTS_FILE, 'utf8');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(code + '\n;__products = PRODUCTS;', sandbox, { timeout: 8000, filename: 'products.js' });
    if (!Array.isArray(sandbox.__products)) throw new Error('В products.js не найден массив PRODUCTS');
    return sandbox.__products;
}

function serializeProducts(products) {
    const items = products.map(p => {
        const inner = Object.entries(p)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `            ${k}: ${JSON.stringify(v)}`)
            .join(',\n');
        return `        {\n${inner}\n        }`;
    }).join(',\n\n');
    return `// Файл каталога шин. Редактируется через админ-панель (admin-server.mjs).\nconst PRODUCTS = [\n${items}\n\n];\n`;
}

async function backupProducts() {
    try {
        await fsp.mkdir(BACKUP_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fsp.writeFile(path.join(BACKUP_DIR, `products-${stamp}.js`), await fsp.readFile(PRODUCTS_FILE), 'utf8');
        const files = (await fsp.readdir(BACKUP_DIR)).filter(f => f.startsWith('products-')).sort();
        for (const old of files.slice(0, Math.max(0, files.length - 20))) {
            await fsp.unlink(path.join(BACKUP_DIR, old)).catch(() => {});
        }
    } catch (e) {
        console.warn('[!] Не удалось создать бэкап:', e.message);
    }
}

function num(v, { min = -Infinity, max = Infinity, integer = true } = {}) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n)) return null;
    const clamped = Math.min(max, Math.max(min, n));
    return integer ? Math.round(clamped) : clamped;
}

function sanitizeProduct(p, index) {
    const str = v => (v === null || v === undefined ? '' : String(v)).trim();
    const season = str(p.season) === 'winter' ? 'winter' : 'summer';
    const condition = str(p.condition) === 'new' ? 'new' : 'used';
    const brand = str(p.brand);
    const title = str(p.title);
    const size = str(p.size);
    const tread = str(p.tread) || '—';
    const year = num(p.year, { min: 1950, max: 2100 });
    const price = num(p.price, { min: 0, max: 100000000 });
    const count = num(p.count, { min: 0, max: 9999 });
    const specsIn = Array.isArray(p.specs) ? p.specs.map(str).filter(Boolean) : null;

    const out = {
        id: num(p.id, { min: 1, max: 1e9 }) || 0,
        brand,
        title,
        image: str(p.image),
        size,
        season,
        condition,
        tread,
        year,
        price,
        fullTitle: str(p.fullTitle) || [brand, title, size].filter(Boolean).join(' '),
        specs: specsIn !== null ? specsIn : [size, tread, year ? String(year) : ''].filter(Boolean),
        link: str(p.link),
    };
    if (count !== null) out.count = count;

    const description = str(p.description);
    if (description) out.description = description;

    for (const [k, v] of Object.entries(p)) {
        if (k in out || k === 'count' || k === 'description') continue;
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
    }
    if (!out.id) out.__new = true;
    return out;
}

// ------------------------------------------------------------- контент ---
function stripTags(s) {
    return String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function extractFields() {
    const files = ['index.html', 'wheels_catalog.html'];
    const fields = [];
    const seen = new Set();
    for (const file of files) {
        let html;
        try { html = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { continue; }
        const re = /<([a-zA-Z0-9]+)\b([^>]*?)data-edit="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g;
        let m;
        while ((m = re.exec(html))) {
            const key = m[3];
            if (seen.has(key)) continue;
            seen.add(key);
            const attrs = `${m[2]} ${m[4]}`;
            const group = (/data-group="([^"]*)"/.exec(attrs) || [])[1] || 'Сайт';
            const label = (/data-label="([^"]*)"/.exec(attrs) || [])[1] || stripTags(m[5]) || key;
            fields.push({ key, group, label, page: file, tag: m[1], default: m[5].trim() });
        }
    }
    return fields;
}

function loadContent() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8'));
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch { return {}; }
}

// ------------------------------------------------- визуальный редактор ---
function emptyPageEdits() {
    return { texts: {}, styles: {}, attrs: {}, hidden: [], inserted: [] };
}

function loadEdits() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(EDITS_FILE, 'utf8')); } catch { raw = {}; }
    const pages = raw && typeof raw.pages === 'object' && raw.pages ? raw.pages : {};
    const out = {};
    for (const [file, data] of Object.entries(pages)) {
        out[file] = sanitizePageEdits(data);
    }
    return { pages: out };
}

const EDIT_LIMITS = { pages: 4, fields: 800, html: 60000, inserted: 200, selector: 600 };

function cleanString(v, max) {
    return String(v == null ? '' : v).slice(0, max);
}

function sanitizePageEdits(data) {
    const out = emptyPageEdits();
    if (!data || typeof data !== 'object') return out;

    if (data.texts && typeof data.texts === 'object') {
        for (const [sel, html] of Object.entries(data.texts).slice(0, EDIT_LIMITS.fields)) {
            if (!sel || typeof html !== 'string') continue;
            out.texts[cleanString(sel, EDIT_LIMITS.selector)] = cleanString(html, EDIT_LIMITS.html);
        }
    }
    if (data.styles && typeof data.styles === 'object') {
        for (const [sel, styles] of Object.entries(data.styles).slice(0, EDIT_LIMITS.fields)) {
            if (!sel || !styles || typeof styles !== 'object') continue;
            const clean = {};
            for (const [prop, value] of Object.entries(styles).slice(0, 24)) {
                if (!/^[a-z-]{2,40}$/i.test(prop)) continue;
                clean[prop] = cleanString(value, 200);
            }
            if (Object.keys(clean).length) out.styles[cleanString(sel, EDIT_LIMITS.selector)] = clean;
        }
    }
    if (data.attrs && typeof data.attrs === 'object') {
        for (const [sel, attrs] of Object.entries(data.attrs).slice(0, EDIT_LIMITS.fields)) {
            if (!sel || !attrs || typeof attrs !== 'object') continue;
            const clean = {};
            for (const [name, value] of Object.entries(attrs).slice(0, 12)) {
                if (!/^[a-z-]{2,40}$/i.test(name)) continue;
                clean[name.toLowerCase()] = cleanString(value, 4000);
            }
            if (Object.keys(clean).length) out.attrs[cleanString(sel, EDIT_LIMITS.selector)] = clean;
        }
    }
    if (Array.isArray(data.hidden)) {
        out.hidden = data.hidden
            .filter(x => typeof x === 'string' && x)
            .slice(0, EDIT_LIMITS.fields)
            .map(x => cleanString(x, EDIT_LIMITS.selector));
    }
    if (Array.isArray(data.inserted)) {
        out.inserted = data.inserted
            .filter(x => x && typeof x === 'object' && typeof x.html === 'string')
            .slice(0, EDIT_LIMITS.inserted)
            .map(x => ({
                id: cleanString(x.id || '', 80).replace(/[^\w-]/g, '') || crypto.randomBytes(4).toString('hex'),
                anchor: cleanString(x.anchor || 'body', EDIT_LIMITS.selector),
                where: ['after', 'before', 'append'].includes(x.where) ? x.where : 'after',
                html: cleanString(x.html, EDIT_LIMITS.html),
            }));
    }
    return out;
}

async function backupFile(file, prefix) {
    try {
        if (!fs.existsSync(file)) return;
        await fsp.mkdir(BACKUP_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fsp.writeFile(path.join(BACKUP_DIR, `${prefix}-${stamp}.json`), await fsp.readFile(file), 'utf8');
        const files = (await fsp.readdir(BACKUP_DIR)).filter(f => f.startsWith(prefix + '-')).sort();
        for (const old of files.slice(0, Math.max(0, files.length - 20))) {
            await fsp.unlink(path.join(BACKUP_DIR, old)).catch(() => {});
        }
    } catch (e) {
        console.warn('[!] Не удалось создать бэкап:', e.message);
    }
}

// ---------------------------------------------------------- журнал работ ---
const WORK_LIMITS = { entries: 5000, photos: 12 };
const WORK_PHOTO_RE = /^[a-z0-9][a-z0-9._-]{0,120}\.(jpe?g|png|webp|avif|gif)$/i;

function workId() {
    return crypto.randomBytes(6).toString('hex');
}

function sanitizeWorkEntry(e) {
    if (!e || typeof e !== 'object') return null;
    const str = v => (v === null || v === undefined ? '' : String(v)).trim();
    let date = str(e.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = '';
    const photos = Array.isArray(e.photos)
        ? e.photos.map(x => str(x)).filter(x => WORK_PHOTO_RE.test(x)).slice(0, WORK_LIMITS.photos)
        : [];
    const amountRaw = num(e.amount, { min: 0, max: 1_000_000_000 });
    const out = {
        id: str(e.id).replace(/[^\w-]/g, '').slice(0, 40) || workId(),
        date,
        plate: str(e.plate).slice(0, 30),
        brand: str(e.brand).slice(0, 120),
        work: str(e.work).slice(0, 8000),
        sold: str(e.sold).slice(0, 8000),
        amount: amountRaw === null ? null : amountRaw,
        photos,
        createdAt: str(e.createdAt).slice(0, 40) || new Date().toISOString(),
        updatedAt: str(e.updatedAt).slice(0, 40) || new Date().toISOString(),
    };
    return out;
}

function loadWork() {
    try {
        const raw = JSON.parse(fs.readFileSync(WORK_FILE, 'utf8'));
        const entries = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : []);
        return entries.map(sanitizeWorkEntry).filter(Boolean);
    } catch { return []; }
}

async function saveWork(entries) {
    await backupFile(WORK_FILE, 'work-log');
    const tmp = WORK_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ entries }, null, 2) + '\n', 'utf8');
    await fsp.rename(tmp, WORK_FILE);
}

function workPhotoPath(name) {
    if (!WORK_PHOTO_RE.test(name)) return null;
    const abs = path.join(WORK_PHOTO_DIR, name);
    if (!abs.startsWith(WORK_PHOTO_DIR + path.sep)) return null;
    return abs;
}

// ------------------------------------------------------------- статика ---
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
};

const BLOCKED = new Set(['admin.config.json', 'admin-server.mjs', 'package.json', 'package-lock.json', 'sync.bat', 'start-admin.bat', 'work-log.json']);

async function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel === '/admin' || rel === '/admin/') rel = '/admin/index.html';
    if (rel.endsWith('/')) rel += 'index.html';

    const abs = path.resolve(ROOT, '.' + rel);
    if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) {
        return json(res, 403, { ok: false, error: 'Forbidden' });
    }
    const name = path.basename(abs);
    const relPath = path.relative(ROOT, abs);
    const parts = relPath.split(path.sep);
    const first = parts[0];
    const second = parts[1];
    if (BLOCKED.has(name) || first === '.git' || first === 'node_modules' || first === '.admin-backups' || first === '.avito-state'
        || (first === 'images' && second === 'work')) {
        res.writeHead(404).end('Not found');
        return;
    }

    try {
        const stat = await fsp.stat(abs);
        if (stat.isDirectory()) return serveStatic(req, res, rel.replace(/\/?$/, '/'));
        const data = await fsp.readFile(abs);
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
            'Content-Length': data.length,
            'Cache-Control': 'no-store',
        });
        res.end(data);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 — файл не найден');
    }
}

// --------------------------------------------------------------- роутер ---
function setSession(res, req, username, role) {
    const sid = crypto.randomBytes(18).toString('hex');
    const exp = Date.now() + SESSION_TTL;
    sessions.set(sid, { exp, username });
    const token = signToken({ sid, u: username, role, exp });
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
}

async function api(req, res, url) {
    const p = url.pathname;
    const method = req.method || 'GET';

    // ---------- публичное ----------
    if (p === '/api/session' && method === 'GET') {
        const user = currentUser(req);
        const profile = user ? userConfig(user.u) : null;
        return json(res, 200, {
            authenticated: Boolean(user && profile),
            username: user && profile ? user.u : null,
            role: user && profile ? (profile.role || user.role || 'owner') : null,
            mustChangePassword: profile ? Boolean(profile.mustChangePassword) : false,
            siteTitle: 'Шины Макс',
        });
    }

    if (p === '/api/showcase' && method === 'GET') {
        try {
            const products = loadProducts().filter(x => x && x.image);
            const pick = products[Math.floor(Math.random() * products.length)] || {};
            return json(res, 200, {
                ok: true,
                product: {
                    brand: pick.brand || 'MICHELIN', title: pick.title || 'Pilot Sport 4',
                    image: pick.image || '', size: pick.size || '225/45 R18',
                    condition: pick.condition || 'used', season: pick.season || 'summer',
                    tread: pick.tread || '6 мм', year: pick.year || 2022,
                    price: pick.price || 18500, count: pick.count || 4,
                    description: pick.description || '',
                },
                total: loadProducts().length,
            });
        } catch (e) {
            return json(res, 200, { ok: false, product: null });
        }
    }

    if (p === '/api/login' && method === 'POST') {
        const ip = req.socket.remoteAddress || 'local';
        const attempt = loginAttempts.get(ip);
        if (attempt && attempt.until > Date.now()) {
            return json(res, 429, { ok: false, error: 'Слишком много попыток. Подождите минуту.' });
        }
        if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'Запрос с чужого сайта' });

        const body = await readBody(req, 64 * 1024);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const profile = userConfig(username);
        let okPass = false;
        if (profile) {
            const actual = Buffer.from(hashPassword(password, profile.salt), 'hex');
            const expected = Buffer.from(profile.hash, 'hex');
            okPass = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
        }
        if (!profile || !okPass) {
            const prev = loginAttempts.get(ip) || { count: 0 };
            prev.count++;
            prev.until = prev.count >= 5 ? Date.now() + 60_000 : 0;
            if (prev.count >= 5) prev.count = 0;
            loginAttempts.set(ip, prev);
            return json(res, 401, { ok: false, error: 'Неверный логин или пароль' });
        }
        loginAttempts.delete(ip);
        // Только один активный пользователь: новый вход завершает прежние сессии
        sessions.clear();
        setSession(res, req, username, profile.role || 'owner');
        return json(res, 200, {
            ok: true,
            role: profile.role || 'owner',
            mustChangePassword: Boolean(profile.mustChangePassword),
            singleUser: true,
        });
    }

    if (p === '/api/logout' && method === 'POST') {
        const data = readToken(cookies(req)[SESSION_COOKIE]);
        if (data) sessions.delete(data.sid);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        return json(res, 200, { ok: true });
    }

    // ---------- дальше только с авторизацией ----------
    if (!p.startsWith('/api/')) return false;
    const actor = currentUser(req);
    if (!actor) return json(res, 401, { ok: false, error: 'Требуется вход' });

    // Мастер видит только журнал работ и смену пароля.
    if ((actor.role || 'owner') !== 'owner') {
        const allowed = p === '/api/work'
            || p.startsWith('/api/work/')
            || p === '/api/password'
            || p === '/api/logout'
            || p === '/api/session';
        if (!allowed) return json(res, 403, { ok: false, error: 'Доступно только владельцу' });
    }

    if (p === '/api/work' && method === 'GET') {
        try {
            return json(res, 200, { ok: true, entries: loadWork() });
        } catch (e) { return serverError(res, e); }
    }

    if (p === '/api/work' && (method === 'PUT' || method === 'POST')) {
        if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'Запрос с чужого сайта' });
        try {
            const body = await readBody(req);
            if (!Array.isArray(body.entries)) return json(res, 400, { ok: false, error: 'Ожидается массив entries' });
            if (body.entries.length > WORK_LIMITS.entries) return json(res, 400, { ok: false, error: 'Слишком много записей' });
            const entries = body.entries.map(sanitizeWorkEntry).filter(Boolean);
            await saveWork(entries);
            return json(res, 200, { ok: true, count: entries.length, entries });
        } catch (e) { return serverError(res, e); }
    }

    if (p === '/api/work/upload' && method === 'POST') {
        if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'Запрос с чужого сайта' });
        try {
            const body = await readBody(req, 20 * 1024 * 1024);
            const m = /^data:(image\/(png|jpe?g|webp|avif|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(body.dataUrl || ''));
            if (!m) return json(res, 400, { ok: false, error: 'Поддерживаются PNG, JPG, WEBP, AVIF и GIF' });
            const buf = Buffer.from(m[3].replace(/\s/g, ''), 'base64');
            if (buf.length > 12 * 1024 * 1024) return json(res, 413, { ok: false, error: 'Файл больше 12 МБ' });
            const ext = m[2].toLowerCase().replace('jpeg', 'jpg');
            const file = `w-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
            await fsp.mkdir(WORK_PHOTO_DIR, { recursive: true });
            await fsp.writeFile(path.join(WORK_PHOTO_DIR, file), buf);
            return json(res, 200, { ok: true, file, size: buf.length });
        } catch (e) { return serverError(res, e); }
    }

    if (p.startsWith('/api/work/photo/') && method === 'GET') {
        const file = decodeURIComponent(p.slice('/api/work/photo/'.length));
        const abs = workPhotoPath(file);
        if (!abs) return json(res, 404, { ok: false, error: 'Не найдено' });
        try {
            const data = await fsp.readFile(abs);
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
                'Content-Length': data.length,
                'Cache-Control': 'private, max-age=3600',
            });
            res.end(data);
            return;
        } catch { return json(res, 404, { ok: false, error: 'Не найдено' }); }
    }

    if (p === '/api/products' && method === 'GET') {
        try {
            const products = loadProducts();
            return json(res, 200, { ok: true, products, updatedAt: fs.statSync(PRODUCTS_FILE).mtime.toISOString() });
        } catch (e) { return serverError(res, e); }
    }

    if (p === '/api/products' && (method === 'PUT' || method === 'POST')) {
        if (!requireOwner(req, res)) return;
        if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'Запрос с чужого сайта' });
        try {
            const body = await readBody(req);
            if (!Array.isArray(body.products)) return json(res, 400, { ok: false, error: 'Ожидается массив products' });
            if (body.products.length > 5000) return json(res, 400, { ok: false, error: 'Слишком много товаров' });

            const usedIds = new Set();
            let maxId = 0;
            for (const p of body.products) {
                const id = num(p.id, { min: 1, max: 1e9 });
                if (id && id > maxId) maxId = id;
            }

            const clean = body.products.map(p => sanitizeProduct(p, 0));
            for (const p of clean) {
                if (!p.id || usedIds.has(p.id)) p.id = ++maxId;
                usedIds.add(p.id);
                delete p.__new;
            }

            await backupProducts();
            const tmp = PRODUCTS_FILE + '.tmp';
            await fsp.writeFile(tmp, serializeProducts(clean), 'utf8');
            await fsp.rename(tmp, PRODUCTS_FILE);
            return json(res, 200, { ok: true, count: clean.length, products: clean });
        } catch (e) { return serverError(res, e); }
    }

    if (p === '/api/content' && method === 'GET') {
        const values = loadContent();
        return json(res, 200, { ok: true, values, fields: extractFields() });
    }

    if (p === '/api/content' && (method === 'PUT' || method === 'POST')) {
        if (!requireOwner(req, res)) return;
        if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'Запрос с чужого сайта' });
        try {
            const body = await readBody(req);
            const values = body.values;
            if (!values || typeof values !== 'object' || Array.isArray(values)) {
                return json(res, 400, { ok: false, error: 'Ожидается объект values' });
            }
            const known = new Set(extractFields().map(f => f.key));
            const clean = {};
            for (const [k, v] of Object.entries(values)) {
                if (!known.has(k) || typeof v !== 'string') continue;
                clean[k] = v.slice(0, 20000);
            }
            const tmp = CONTENT_FILE + '.tmp';
            await fsp.writeFile(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
            await fsp.rename(tmp, CONTENT_FILE);
            return json(res, 200, { ok: true, count: Object.keys(clean).length });
        } catch (e) { return serverError(res, e); }
    }

    if (p === '/api/upload' && method === 'POST') {
        if (!requireOwner(req, res)) return;
        if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'Запрос с чужого сайта' });
        try {
            const body = await readBody(req, 20 * 1024 * 1024);
            const m = /^data:(image\/(png|jpe?g|webp|avif|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(body.dataUrl || ''));
            if (!m) return json(res, 400, { ok: false, error: 'Поддерживаются PNG, JPG, WEBP, AVIF и GIF' });
            const buf = Buffer.from(m[3].replace(/\s/g, ''), 'base64');
            if (buf.length > 12 * 1024 * 1024) return json(res, 413, { ok: false, error: 'Файл больше 12 МБ' });

            const ext = m[2].toLowerCase().replace('jpeg', 'jpg');
            const base = String(body.name || 'foto')
                .replace(/\.[a-z0-9]+$/i, '')
                .toLowerCase()
                .replace(/[^a-z0-9а-яё-]+/gi, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 48) || 'foto';
            const file = `${base}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
            await fsp.mkdir(UPLOAD_DIR, { recursive: true });
            await fsp.writeFile(path.join(UPLOAD_DIR, file), buf);
            const rel = `images/uploads/${file}`;
            return json(res, 200, { ok: true, path: rel, url: '/' + rel, size: buf.length });
        } catch (e) { return serverError(res, e); }
    }

    if (p === '/api/editor' && method === 'GET') {
        return json(res, 200, {
            ok: true,
            pages: ['index.html', 'wheels_catalog.html'],
            edits: loadEdits(),
        });
    }

    if (p === '/api/editor' && (method === 'PUT' || method === 'POST')) {
        if (!requireOwner(req, res)) return;
        if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'Запрос с чужого сайта' });
        try {
            const body = await readBody(req, 2 * 1024 * 1024);
            const pagesIn = body && body.pages;
            if (!pagesIn || typeof pagesIn !== 'object' || Array.isArray(pagesIn)) {
                return json(res, 400, { ok: false, error: 'Ожидается объект pages' });
            }
            const pages = {};
            for (const [file, data] of Object.entries(pagesIn).slice(0, EDIT_LIMITS.pages)) {
                if (!['index.html', 'wheels_catalog.html'].includes(file)) continue;
                pages[file] = sanitizePageEdits(data);
            }
            await backupFile(EDITS_FILE, 'site-edits');
            const tmp = EDITS_FILE + '.tmp';
            await fsp.writeFile(tmp, JSON.stringify({ pages }, null, 2) + '\n', 'utf8');
            await fsp.rename(tmp, EDITS_FILE);
            return json(res, 200, { ok: true, pages: Object.keys(pages) });
        } catch (e) { return serverError(res, e); }
    }

    if (p === '/api/password' && method === 'POST') {
        if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'Запрос с чужого сайта' });
        try {
            const body = await readBody(req, 64 * 1024);
            const current = String(body.current || '');
            const next = String(body.next || '');
            const profile = userConfig(actor.u);
            if (!profile) return json(res, 401, { ok: false, error: 'Требуется вход' });
            const actual = Buffer.from(hashPassword(current, profile.salt), 'hex');
            const expected = Buffer.from(profile.hash, 'hex');
            const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
            if (!ok) return json(res, 400, { ok: false, error: 'Текущий пароль неверен' });
            if (next.length < 6) return json(res, 400, { ok: false, error: 'Новый пароль — минимум 6 символов' });
            profile.salt = crypto.randomBytes(16).toString('hex');
            profile.hash = hashPassword(next, profile.salt);
            profile.mustChangePassword = false;
            profile.updatedAt = new Date().toISOString();
            config.updatedAt = new Date().toISOString();
            await fsp.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
            sessions.clear();
            setSession(res, req, actor.u, profile.role || 'owner');
            return json(res, 200, { ok: true });
        } catch (e) { return serverError(res, e); }
    }

    if (p === '/api/open-folder' && method === 'POST') {
        if (!requireOwner(req, res)) return;
        if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'Запрос с чужого сайта' });
        if (process.platform === 'win32') {
            execFile('explorer.exe', [ROOT], () => {});
        } else if (process.platform === 'darwin') {
            execFile('open', [ROOT], () => {});
        } else {
            execFile('xdg-open', [ROOT], () => {});
        }
        return json(res, 200, { ok: true, path: ROOT });
    }

    if (p === '/api/publish' && method === 'POST') {
        if (!requireOwner(req, res)) return;
        if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'Запрос с чужого сайта' });
        const run = (args) => new Promise(resolve => {
            execFile('git', args, { cwd: ROOT, windowsHide: true }, (err, stdout, stderr) => {
                resolve({ code: err ? (err.code || 1) : 0, out: `${stdout || ''}${stderr || ''}`.trim() });
            });
        });
        try {
            const body = await readBody(req, 64 * 1024);
            const message = String(body.message || '').trim() || `Обновление сайта из админ-панели ${new Date().toLocaleString('ru-RU')}`;
            const steps = [];
            steps.push({ cmd: 'git add -A', ...(await run(['add', '-A'])) });
            const commit = await run(['commit', '-m', message]);
            steps.push({ cmd: `git commit -m "${message}"`, ...commit });
            const nothing = /nothing to commit|нечего коммитить|no changes added/i.test(commit.out);
            if (commit.code !== 0 && !nothing) {
                return json(res, 500, { ok: false, steps, error: 'Коммит не удался' });
            }
            if (!nothing) {
                const push = await run(['push']);
                steps.push({ cmd: 'git push', ...push });
                if (push.code !== 0) return json(res, 500, { ok: false, steps, error: 'Push не удался' });
            }
            return json(res, 200, { ok: true, steps, message });
        } catch (e) { return serverError(res, e); }
    }

    return json(res, 404, { ok: false, error: 'Неизвестный метод API' });
}

// ---------------------------------------------------------------- сервер ---
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
        if (url.pathname.startsWith('/api/')) {
            const handled = await api(req, res, url);
            if (handled === false) json(res, 404, { ok: false, error: 'Неизвестный метод API' });
            return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { Allow: 'GET, HEAD' }).end();
            return;
        }
        await serveStatic(req, res, url.pathname);
    } catch (e) {
        if (!res.headersSent) serverError(res, e);
        else res.end();
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('  ┌─────────────────────────────────────────────────┐');
    console.log('  │  Шины Макс · админ-панель                       │');
    console.log(`  │  http://localhost:${String(PORT).padEnd(5)}/admin/                  │`);
    console.log('  │  Остановить: Ctrl+C                             │');
    console.log('  └─────────────────────────────────────────────────┘');
    console.log('');
});

server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
        console.error(`[!] Порт ${PORT} уже занят. Запустите с другим портом:  set PORT=8788 && node admin-server.mjs`);
        process.exit(1);
    }
    console.error('[!]', e);
});
