(function () {
    'use strict';
    const E = id => document.getElementById(id);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const money = n => (n || n === 0) ? Number(n).toLocaleString('ru-RU') + ' ₽' : 'Цена по звонку';
    const imgSrc = v => !v ? '' : (/^(https?:)?\/\//i.test(v) || v.startsWith('/') ? v : '/' + v);

    const state = {
        products: [],
        q: '', cond: '', season: '',
        draftIndex: -1,
        fields: [],
        values: {},
        textsLoaded: false,
        saving: false,
        role: 'owner',
        username: '',
    };

    const TITLES = {
        products: ['Карточки шин', 'Редактирование каталога — перетаскивайте карточки, чтобы менять порядок'],
        texts: ['Тексты сайта', 'Заголовки, описания, услуги, адреса и контакты — всё без кода'],
        work: ['Журнал работ', 'Машины, работы, фотографии, продажи и выручка — по месяцам и дням'],
        editor: ['Визуальный редактор', 'Нажмите на элемент страницы, чтобы изменить его текст и оформление'],
        settings: ['Настройки', 'Пароль, публикация и служебная информация'],
    };

    // ------------------------------------------------------------------ UI --
    function toast(message, type) {
        type = type || 'ok';
        const el = document.createElement('div');
        el.className = 'toast ' + type;
        el.textContent = message;
        E('toastWrap').appendChild(el);
        setTimeout(() => {
            el.style.transition = 'opacity .25s, transform .25s';
            el.style.opacity = '0';
            el.style.transform = 'translateY(8px)';
            setTimeout(() => el.remove(), 260);
        }, type === 'err' ? 5200 : 3000);
    }

    function setSave(mode, text) {
        const box = E('saveState');
        box.className = 'save-state' + (mode === 'busy' ? ' busy' : mode === 'err' ? ' error' : '');
        E('saveText').textContent = text;
    }

    function switchView(name) {
        document.querySelectorAll('.sb-link[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
        document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
        const t = TITLES[name] || TITLES.products;
        E('viewTitle').textContent = t[0];
        E('viewSub').textContent = t[1];
        if (name === 'texts' && !state.textsLoaded) loadTexts();
        if (name === 'texts') E('textsState').className = 'save-state';
        if (name === 'work') loadWork();
        if (name === 'editor' && state.role === 'owner') loadEditor();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ------------------------------------------------------------- сессия ---
    fetch('/api/session', { cache: 'no-store' })
        .then(r => r.json())
        .then(s => {
            if (!s || !s.authenticated) { location.replace('index.html'); return; }
            state.role = s.role === 'worker' ? 'worker' : 'owner';
            state.username = s.username || '';
            E('passWarn').hidden = !s.mustChangePassword;
            E('cfgUser').textContent = state.username || '—';
            E('cfgUrl').textContent = location.origin + '/admin/';
            document.querySelectorAll('[data-owner-only]').forEach(el => { el.hidden = state.role !== 'owner'; });
            E('cardPublish').hidden = state.role !== 'owner';
            E('cardInfo').hidden = state.role !== 'owner';
            if (state.role === 'worker') {
                E('saveState').hidden = true;
                loadWork();
                switchView('work');
            } else {
                loadProducts();
                loadWork();
            }
        })
        .catch(() => {
            document.body.innerHTML = '<div style="max-width:520px;margin:80px auto;padding:24px;font-family:Inter,sans-serif;background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.15)"><h2 style="margin-bottom:8px">Сервер недоступен</h2><p style="color:#5d6b80">Запустите <b>start-admin.bat</b> или <b>node admin-server.mjs</b> и обновите страницу.</p></div>';
        });

    // ------------------------------------------------------------- товары ---
    async function loadProducts() {
        setSave('busy', 'Загружаю каталог…');
        try {
            const r = await fetch('/api/products', { cache: 'no-store' });
            const d = await r.json();
            if (r.status === 401) { location.replace('index.html'); return; }
            if (!r.ok) throw new Error(d.error || 'Не удалось загрузить каталог');
            state.products = d.products || [];
            setSave('ok', 'Сохранено');
            renderProducts();
        } catch (e) {
            setSave('err', 'Ошибка загрузки');
            toast(e.message, 'err');
        }
    }

    function filtered() {
        const q = state.q.trim().toLowerCase();
        return state.products
            .map((p, index) => ({ p, index }))
            .filter(({ p }) => {
                if (state.cond && p.condition !== state.cond) return false;
                if (state.season && p.season !== state.season) return false;
                if (q) {
                    const hay = `${p.brand || ''} ${p.title || ''} ${p.fullTitle || ''} ${p.size || ''} ${p.description || ''}`.toLowerCase();
                    if (!q.split(/\s+/).every(t => hay.includes(t))) return false;
                }
                return true;
            });
    }

    const ICON_DRAG = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
    const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
    const ICON_DUP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const ICON_DEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>';

    function cardHtml(p, index) {
        const condTxt = p.condition === 'new' ? 'Новые' : 'Б/у';
        const seasonTxt = p.season === 'winter' ? 'Зима' : 'Лето';
        return `
        <article class="pcard" data-index="${index}" draggable="true">
            <button class="drag-handle" type="button" title="Перетащите, чтобы изменить порядок" aria-label="Перетащить">${ICON_DRAG}</button>
            <div class="a-image">
                ${p.image ? `<img src="${esc(imgSrc(p.image))}" alt="" loading="lazy" draggable="false">` : '<span class="noimg">Нет фото</span>'}
                <div class="a-badges">
                    <span class="badge ${p.condition === 'new' ? 'new' : 'used'}">${condTxt}</span>
                    <span class="badge ${p.season === 'winter' ? 'winter' : 'summer'}">${seasonTxt}</span>
                    ${p.count ? `<span class="badge count">${p.count} шт</span>` : ''}
                </div>
            </div>
            <div class="a-body">
                <div class="a-brand">${esc(p.brand || '—')}</div>
                <div class="a-title">${esc(p.title || p.fullTitle || 'Без названия')}</div>
                <div class="a-size">${p.size ? `<span class="r">${esc(p.size)}</span>` : ''}</div>
                <div class="a-meta">
                    ${p.tread && p.tread !== '—' ? `<span>протектор ${esc(p.tread)}</span>` : ''}
                    ${p.year ? `<span>${p.year}</span>` : ''}
                </div>
                ${p.description ? `<div class="a-meta" style="color:#8a97ab">${esc(String(p.description).slice(0, 80))}${String(p.description).length > 80 ? '…' : ''}</div>` : ''}
                <div class="a-price">${money(p.price)}<small>${p.count ? 'комплект ' + p.count + ' шт' : 'за всё предложение'}</small></div>
            </div>
            <div class="a-actions">
                <button class="icon-btn move" type="button" data-act="up" title="Выше">↑</button>
                <button class="icon-btn move" type="button" data-act="down" title="Ниже">↓</button>
                <button class="icon-btn" type="button" data-act="edit" title="Редактировать">${ICON_EDIT}</button>
                <button class="icon-btn" type="button" data-act="dup" title="Дублировать">${ICON_DUP}</button>
                <button class="icon-btn del" type="button" data-act="del" title="Удалить">${ICON_DEL}</button>
            </div>
        </article>`;
    }

    function renderProducts() {
        const list = filtered();
        const grid = E('pGrid');
        grid.innerHTML = list.map(({ p, index }) => cardHtml(p, index)).join('');
        E('pEmpty').hidden = list.length !== 0;
        E('pCounter').textContent = list.length === state.products.length
            ? `Всего карточек: ${state.products.length}`
            : `Показано: ${list.length} из ${state.products.length}`;
        E('navCount').textContent = state.products.length;

        const brands = [...new Set(state.products.map(p => p.brand).filter(Boolean))].sort();
        E('brandList').innerHTML = brands.map(b => `<option value="${esc(b)}"></option>`).join('');
    }

    let saveTimer = null;
    async function persist(opts) {
        opts = opts || {};
        clearTimeout(saveTimer);
        setSave('busy', 'Сохраняю…');
        try {
            const r = await fetch('/api/products', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ products: state.products }),
            });
            const d = await r.json();
            if (r.status === 401) { location.replace('index.html'); return; }
            if (!r.ok) throw new Error(d.error || 'Ошибка сохранения');
            state.products = d.products || state.products;
            setSave('ok', 'Сохранено');
            renderProducts();
            if (opts.toast) toast(opts.toast);
        } catch (e) {
            setSave('err', 'Не сохранено');
            toast(e.message, 'err');
        }
    }

    function queueSave() {
        clearTimeout(saveTimer);
        setSave('busy', 'Есть изменения…');
        saveTimer = setTimeout(() => persist(), 350);
    }

    // --------------------------------------------------- drag & drop / кнопки --
    const grid = E('pGrid');
    let dragIndex = null;

    grid.addEventListener('dragstart', e => {
        const card = e.target.closest('.pcard');
        if (!card) return;
        dragIndex = Number(card.dataset.index);
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(dragIndex)); } catch (err) {}
    });
    grid.addEventListener('dragover', e => {
        if (dragIndex === null) return;
        const card = e.target.closest('.pcard');
        if (!card) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        grid.querySelectorAll('.drop-target').forEach(c => c.classList.remove('drop-target'));
        card.classList.add('drop-target');
    });
    grid.addEventListener('dragleave', e => {
        const card = e.target.closest('.pcard');
        if (card) card.classList.remove('drop-target');
    });
    grid.addEventListener('drop', e => {
        const card = e.target.closest('.pcard');
        if (!card || dragIndex === null) return;
        e.preventDefault();
        const to = Number(card.dataset.index);
        card.classList.remove('drop-target');
        if (to !== dragIndex && Number.isFinite(to)) {
            const moved = state.products.splice(dragIndex, 1)[0];
            state.products.splice(to, 0, moved);
            renderProducts();
            persist({ toast: 'Порядок обновлён' });
        }
        dragIndex = null;
    });
    grid.addEventListener('dragend', () => {
        dragIndex = null;
        grid.querySelectorAll('.dragging,.drop-target').forEach(c => c.classList.remove('dragging', 'drop-target'));
    });

    grid.addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const card = btn.closest('.pcard');
        const index = Number(card.dataset.index);
        const act = btn.dataset.act;
        if (act === 'edit') return openEdit(index);
        if (act === 'up') return move(index, -1);
        if (act === 'down') return move(index, 1);
        if (act === 'dup') return duplicate(index);
        if (act === 'del') return remove(index);
    });

    function move(index, dir) {
        const to = index + dir;
        if (to < 0 || to >= state.products.length) return;
        const [p] = state.products.splice(index, 1);
        state.products.splice(to, 0, p);
        renderProducts();
        persist();
    }

    function duplicate(index) {
        const copy = JSON.parse(JSON.stringify(state.products[index]));
        delete copy.id;
        state.products.splice(index + 1, 0, copy);
        renderProducts();
        persist({ toast: 'Карточка скопирована' });
    }

    function remove(index) {
        const p = state.products[index];
        if (!confirm(`Удалить карточку «${p.title || p.fullTitle || 'без названия'}»?\n\nДействие можно отменить только через git/резервную копию.`)) return;
        state.products.splice(index, 1);
        renderProducts();
        persist({ toast: 'Карточка удалена' });
    }

    // -------------------------------------------------------------- модалка --
    const modal = E('editModal');
    const F = {
        title: E('fTitle'), brand: E('fBrand'), size: E('fSize'), season: E('fSeason'),
        condition: E('fCondition'), tread: E('fTread'), year: E('fYear'), price: E('fPrice'),
        count: E('fCount'), link: E('fLink'), description: E('fDescription'), image: E('fImage'),
    };

    function blankProduct() {
        return {
            brand: '', title: '', image: '', size: '', season: 'summer', condition: 'used',
            tread: '—', year: '', price: '', fullTitle: '', specs: [], link: '', count: 4, description: '',
        };
    }

    function showPreview(src) {
        const box = E('photoPreview');
        if (src) {
            box.innerHTML = `<img src="${esc(imgSrc(src))}" alt="">`;
        } else {
            box.innerHTML = '<div class="ph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:34px;height:34px;margin:0 auto 6px;color:#c2ccda"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>Нет фото</div>';
        }
    }

    function openEdit(index) {
        state.draftIndex = index;
        const p = index >= 0 ? state.products[index] : blankProduct();
        const isNew = index < 0;

        E('editTitle').textContent = isNew ? 'Новая карточка' : 'Редактирование карточки';
        E('editSub').textContent = isNew ? 'Заполните информацию о шине и сохраните' : `ID ${p.id || '—'} · изменения появятся в каталоге сразу`;
        E('btnDeleteProduct').style.display = isNew ? 'none' : '';

        F.title.value = p.title || '';
        F.brand.value = p.brand || '';
        F.size.value = p.size || '';
        F.season.value = p.season === 'winter' ? 'winter' : 'summer';
        F.condition.value = p.condition === 'new' ? 'new' : 'used';
        F.tread.value = p.tread && p.tread !== '—' ? p.tread : '';
        F.year.value = p.year || '';
        F.price.value = p.price || p.price === 0 ? p.price : '';
        F.count.value = p.count || p.count === 0 ? p.count : '';
        F.link.value = p.link || '';
        F.description.value = p.description || '';
        F.image.value = p.image || '';
        showPreview(p.image || '');
        F.title.closest('.field').classList.remove('invalid');

        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        setTimeout(() => F.title.focus(), 60);
    }

    function closeEdit() {
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        state.draftIndex = -1;
    }

    modal.querySelectorAll('[data-close-edit]').forEach(el => el.addEventListener('click', closeEdit));
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.classList.contains('open')) closeEdit();
    });

    function readForm() {
        const title = F.title.value.trim();
        if (!title) {
            F.title.closest('.field').classList.add('invalid');
            F.title.focus();
            toast('Укажите название модели', 'err');
            return null;
        }
        F.title.closest('.field').classList.remove('invalid');
        return {
            title,
            brand: F.brand.value.trim(),
            size: F.size.value.trim(),
            season: F.season.value,
            condition: F.condition.value,
            tread: F.tread.value.trim() || '—',
            year: F.year.value === '' ? null : Number(F.year.value),
            price: F.price.value === '' ? null : Number(F.price.value),
            count: F.count.value === '' ? null : Number(F.count.value),
            link: F.link.value.trim(),
            description: F.description.value.trim(),
            image: F.image.value.trim(),
        };
    }

    E('btnSaveProduct').addEventListener('click', () => {
        const data = readForm();
        if (!data) return;
        if (state.draftIndex >= 0) {
            const old = state.products[state.draftIndex];
            state.products[state.draftIndex] = Object.assign({}, old, data, { id: old.id });
        } else {
            state.products.push(Object.assign(blankProduct(), data));
        }
        closeEdit();
        persist({ toast: 'Карточка сохранена' });
    });

    E('btnDeleteProduct').addEventListener('click', () => {
        if (state.draftIndex < 0) return;
        const p = state.products[state.draftIndex];
        if (!confirm(`Удалить карточку «${p.title || 'без названия'}»?`)) return;
        state.products.splice(state.draftIndex, 1);
        closeEdit();
        persist({ toast: 'Карточка удалена' });
    });

    E('btnAdd').addEventListener('click', () => openEdit(-1));
    E('pSearch').addEventListener('input', () => { state.q = E('pSearch').value; renderProducts(); });
    E('pFilterCond').addEventListener('change', () => { state.cond = E('pFilterCond').value; renderProducts(); });
    E('pFilterSeason').addEventListener('change', () => { state.season = E('pFilterSeason').value; renderProducts(); });

    // --------------------------------------------------------- загрузка фото --
    function readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = () => reject(new Error('Не удалось прочитать файл'));
            fr.readAsDataURL(file);
        });
    }

    async function uploadFile(file) {
        if (!file) return;
        if (!/^image\//.test(file.type)) { toast('Это не изображение', 'err'); return; }
        if (file.size > 12 * 1024 * 1024) { toast('Файл больше 12 МБ', 'err'); return; }
        try {
            const dataUrl = await readFileAsDataUrl(file);
            showPreview(dataUrl);
            toast('Загружаю фото…', 'info');
            const r = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: file.name, dataUrl }),
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'Не удалось загрузить фото');
            F.image.value = d.path;
            showPreview(d.path);
            toast('Фото загружено');
        } catch (e) {
            showPreview(F.image.value);
            toast(e.message, 'err');
        }
    }

    E('btnPickImage').addEventListener('click', () => E('fileInput').click());
    E('fileInput').addEventListener('change', e => {
        uploadFile(e.target.files && e.target.files[0]);
        e.target.value = '';
    });
    E('btnRemoveImage').addEventListener('click', () => { F.image.value = ''; showPreview(''); });

    F.image.addEventListener('input', () => showPreview(F.image.value.trim()));
    F.image.addEventListener('change', () => showPreview(F.image.value.trim()));

    const dropZone = E('dropZone');
    ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, e => {
        e.preventDefault(); dropZone.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => {
        e.preventDefault(); dropZone.classList.remove('over');
    }));
    dropZone.addEventListener('drop', e => {
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        uploadFile(f);
    });
    modal.addEventListener('dragover', e => e.preventDefault());
    modal.addEventListener('drop', e => {
        if (e.target.closest('#dropZone')) return;
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) { e.preventDefault(); uploadFile(f); }
    });

    // --------------------------------------------------------------- тексты --
    async function loadTexts() {
        E('textsStateText').textContent = 'Загружаю…';
        try {
            const r = await fetch('/api/content', { cache: 'no-store' });
            const d = await r.json();
            if (r.status === 401) { location.replace('index.html'); return; }
            if (!r.ok) throw new Error(d.error || 'Не удалось загрузить тексты');
            state.fields = d.fields || [];
            state.values = d.values || {};
            state.textsLoaded = true;
            renderTexts();
            E('textsStateText').textContent = 'Загружено';
            E('textsState').className = 'save-state';
        } catch (e) {
            E('textsState').className = 'save-state error';
            E('textsStateText').textContent = 'Ошибка загрузки';
            toast(e.message, 'err');
        }
    }

    function renderTexts() {
        const groups = [];
        const byName = new Map();
        for (const f of state.fields) {
            if (!byName.has(f.group)) {
                const g = { name: f.group, fields: [] };
                byName.set(f.group, g);
                groups.push(g);
            }
            byName.get(f.group).fields.push(f);
        }

        E('tGroups').innerHTML = groups.map((g, gi) => `
            <details class="group" ${gi === 0 ? 'open' : ''} data-group="${esc(g.name)}">
                <summary>
                    <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>
                    ${esc(g.name)}
                    <span class="gcount">${g.fields.length}</span>
                </summary>
                <div class="g-body">
                    ${g.fields.map(f => {
                        const value = typeof state.values[f.key] === 'string' ? state.values[f.key] : f.default;
                        return `
                        <div class="tfield" data-key="${esc(f.key)}" data-search="${esc((f.key + ' ' + f.label + ' ' + g.name + ' ' + value).toLowerCase())}">
                            <div class="t-head">
                                <span class="t-label">${esc(f.label)}</span>
                                <span class="t-key">${esc(f.key)}</span>
                                <button class="t-reset" type="button" data-reset="${esc(f.key)}">сбросить</button>
                            </div>
                            <textarea rows="${value.length > 120 ? 4 : 2}" spellcheck="false">${esc(value)}</textarea>
                            <span class="t-default">По умолчанию: ${esc(f.default.slice(0, 140))}${f.default.length > 140 ? '…' : ''}</span>
                        </div>`;
                    }).join('')}
                </div>
            </details>`).join('');

        E('tCounter').textContent = `${state.fields.length} полей на сайте`;
        filterTexts();
    }

    function filterTexts() {
        const q = E('tSearch').value.trim().toLowerCase();
        let visible = 0;
        document.querySelectorAll('#tGroups .tfield').forEach(el => {
            const show = !q || (el.dataset.search || '').includes(q);
            el.hidden = !show;
            if (show) visible++;
        });
        document.querySelectorAll('#tGroups .group').forEach(g => {
            const any = [...g.querySelectorAll('.tfield')].some(f => !f.hidden);
            g.hidden = !any;
            if (q && any) g.open = true;
        });
        E('tCounter').textContent = q
            ? `Найдено полей: ${visible} из ${state.fields.length}`
            : `${state.fields.length} полей на сайте`;
    }
    E('tSearch').addEventListener('input', filterTexts);

    E('tGroups').addEventListener('click', e => {
        const btn = e.target.closest('[data-reset]');
        if (!btn) return;
        const field = state.fields.find(f => f.key === btn.dataset.reset);
        if (!field) return;
        const row = btn.closest('.tfield');
        row.querySelector('textarea').value = field.default;
        E('textsState').className = 'save-state busy';
        E('textsStateText').textContent = 'Есть изменения…';
    });

    E('tGroups').addEventListener('input', () => {
        E('textsState').className = 'save-state busy';
        E('textsStateText').textContent = 'Есть изменения…';
    });

    E('btnTextsSave').addEventListener('click', async () => {
        const values = {};
        document.querySelectorAll('#tGroups .tfield').forEach(row => {
            const key = row.dataset.key;
            const ta = row.querySelector('textarea');
            values[key] = ta.value;
        });
        E('btnTextsSave').disabled = true;
        E('textsState').className = 'save-state busy';
        E('textsStateText').textContent = 'Сохраняю…';
        try {
            const r = await fetch('/api/content', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ values }),
            });
            const d = await r.json();
            if (r.status === 401) { location.replace('index.html'); return; }
            if (!r.ok) throw new Error(d.error || 'Не удалось сохранить');
            state.values = values;
            E('textsState').className = 'save-state';
            E('textsStateText').textContent = 'Сохранено';
            toast('Тексты сохранены — обновите сайт, чтобы увидеть изменения');
        } catch (e) {
            E('textsState').className = 'save-state error';
            E('textsStateText').textContent = 'Не сохранено';
            toast(e.message, 'err');
        } finally {
            E('btnTextsSave').disabled = false;
        }
    });

    E('btnTextsReload').addEventListener('click', () => {
        if (!confirm('Вернуть последние сохранённые тексты? Несохранённые правки пропадут.')) return;
        loadTexts();
    });

    // ------------------------------------------------------------- настройки --
    E('passForm').addEventListener('submit', async e => {
        e.preventDefault();
        const current = E('passCurrent').value;
        const next = E('passNext').value;
        const next2 = E('passNext2').value;
        if (next !== next2) { toast('Новые пароли не совпадают', 'err'); return; }
        if (next.length < 6) { toast('Новый пароль — минимум 6 символов', 'err'); return; }
        try {
            const r = await fetch('/api/password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ current, next }),
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'Не удалось сменить пароль');
            E('passForm').reset();
            E('passWarn').hidden = true;
            toast('Пароль изменён');
        } catch (err) { toast(err.message, 'err'); }
    });

    E('btnPublish').addEventListener('click', async () => {
        if (!confirm('Сделать коммит и отправить изменения на GitHub? После этого обновится сайт.')) return;
        const btn = E('btnPublish');
        const log = E('publishLog');
        const msgBox = E('publishMsg');
        btn.disabled = true;
        msgBox.className = 'publish-msg';
        msgBox.textContent = 'Публикую…';
        log.className = 'publish-log show';
        log.textContent = '';
        try {
            const r = await fetch('/api/publish', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: E('publishMessage').value.trim() }),
            });
            const d = await r.json();
            log.innerHTML = (d.steps || []).map(s =>
                `$ ${esc(s.cmd)}\n<span class="${s.code === 0 ? 'ok' : 'err'}">${esc(s.out || (s.code === 0 ? 'OK' : 'Ошибка'))}</span>`
            ).join('\n\n');
            if (!r.ok) throw new Error(d.error || 'Не удалось опубликовать');
            msgBox.className = 'publish-msg ok';
            msgBox.textContent = 'Готово — изменения отправлены в GitHub.';
            toast('Сайт опубликован');
        } catch (e) {
            msgBox.className = 'publish-msg err';
            msgBox.textContent = e.message;
            toast(e.message, 'err');
        } finally {
            btn.disabled = false;
        }
    });

    E('btnOpenFolder').addEventListener('click', async () => {
        try {
            const r = await fetch('/api/open-folder', { method: 'POST' });
            if (!r.ok) throw new Error('Не удалось открыть папку');
            toast('Папка проекта открыта', 'info');
        } catch (e) { toast(e.message, 'err'); }
    });

    E('btnLogout').addEventListener('click', async () => {
        await fetch('/api/logout', { method: 'POST' }).catch(() => {});
        location.replace('index.html');
    });

    document.querySelectorAll('.sb-link[data-view]').forEach(btn => {
        btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // ========================================================== ЖУРНАЛ РАБОТ =
    const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

    const workState = { entries: [], loaded: false, q: '', month: '', year: '', editId: null, photos: [] };
    const workModal = E('workModal');

    function parseWorkDate(s) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
        return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
    }
    function fmtWorkDate(s) {
        const d = parseWorkDate(s);
        return d ? `${d.d} ${MONTHS_GEN[d.m - 1]} ${d.y}` : 'Без даты';
    }
    function workWeekday(s) {
        const d = parseWorkDate(s);
        if (!d) return 'дата';
        return WEEKDAYS[new Date(d.y, d.m - 1, d.d).getDay()] || 'дата';
    }
    function workAmount(n) {
        return (n || n === 0) ? Number(n).toLocaleString('ru-RU') + ' ₽' : '—';
    }
    function todayStr() {
        const d = new Date();
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    function workPhotoSrc(file) { return '/api/work/photo/' + encodeURIComponent(file); }

    function filteredWork() {
        const q = workState.q.trim().toLowerCase();
        return workState.entries
            .filter(e => {
                const d = parseWorkDate(e.date);
                if (workState.month && (!d || d.m !== Number(workState.month))) return false;
                if (workState.year && (!d || d.y !== Number(workState.year))) return false;
                if (q) {
                    const hay = `${e.plate || ''} ${e.brand || ''} ${e.work || ''} ${e.sold || ''}`.toLowerCase();
                    if (!q.split(/\s+/).every(t => hay.includes(t))) return false;
                }
                return true;
            })
            .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    }

    function workRowHtml(e) {
        const d = parseWorkDate(e.date);
        const photos = e.photos || [];
        const thumbs = photos.slice(0, 3).map(f => `<img src="${esc(workPhotoSrc(f))}" alt="" loading="lazy">`).join('');
        const more = photos.length > 3 ? `<span class="more">+${photos.length - 3}</span>` : '';
        return `
        <article class="wrow" data-id="${esc(e.id)}">
            <div class="wdate"><b>${d ? d.d : '—'}</b><span>${workWeekday(e.date)}</span></div>
            <div class="wmain">
                <div class="whead">
                    ${e.plate ? `<span class="wplate">${esc(e.plate)}</span>` : ''}
                    ${e.brand ? `<span class="wbrand">${esc(e.brand)}</span>` : '<span class="wbrand" style="color:#9aa8bc">Без марки</span>'}
                </div>
                ${e.work ? `<div class="wtext">${esc(e.work)}</div>` : ''}
                ${e.sold ? `<div class="wsold"><b>Продано:</b> ${esc(e.sold)}</div>` : ''}
            </div>
            <div class="wphotos">${thumbs}${more}</div>
            <div class="wamount">${workAmount(e.amount)}<small>получено</small></div>
            <div class="wactions">
                <button class="icon-btn" type="button" data-wact="edit" title="Редактировать">${ICON_EDIT}</button>
                <button class="icon-btn del" type="button" data-wact="del" title="Удалить">${ICON_DEL}</button>
            </div>
        </article>`;
    }

    function renderWork() {
        const list = filteredWork();
        const total = list.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
        const plates = new Set(list.map(e => (e.plate || '').trim().toLowerCase()).filter(Boolean));
        const photoCount = list.reduce((sum, e) => sum + (e.photos ? e.photos.length : 0), 0);

        E('workSummary').innerHTML = `
            <div class="wsum"><span>Записей</span><b>${list.length}</b></div>
            <div class="wsum"><span>Машин</span><b>${plates.size}</b></div>
            <div class="wsum"><span>Получено</span><b>${total ? total.toLocaleString('ru-RU') + ' ₽' : '—'}</b></div>
            <div class="wsum"><span>Фотографий</span><b>${photoCount}</b></div>`;

        E('wEmpty').hidden = list.length !== 0;
        E('wCounter').textContent = list.length === workState.entries.length
            ? `Всего записей: ${workState.entries.length}`
            : `Показано: ${list.length} из ${workState.entries.length}`;
        E('navWorkCount').textContent = workState.entries.length;

        const years = [...new Set(workState.entries.map(e => {
            const d = parseWorkDate(e.date);
            return d ? d.y : null;
        }).filter(Boolean))].sort((a, b) => b - a);
        E('wFilterYear').innerHTML = '<option value="">Все годы</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
        E('wFilterYear').value = workState.year || '';

        const months = [...new Set(workState.entries.map(e => {
            const d = parseWorkDate(e.date);
            return d ? d.m : null;
        }).filter(Boolean))].sort((a, b) => a - b);
        E('wFilterMonth').innerHTML = '<option value="">Все месяцы</option>' + months.map(m => `<option value="${m}">${MONTHS_NOM[m - 1]}</option>`).join('');
        E('wFilterMonth').value = workState.month || '';

        const groups = new Map();
        for (const e of list) {
            const d = parseWorkDate(e.date);
            const key = d ? `${d.y}-${String(d.m).padStart(2, '0')}` : 'none';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(e);
        }

        let html = '';
        for (const [key, items] of groups) {
            const label = key === 'none' ? 'Без даты' : `${MONTHS_NOM[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`;
            html += `<div class="wmonth">${esc(label)}</div>`;
            for (const e of items) html += workRowHtml(e);
        }
        E('workList').innerHTML = html;
    }

    async function loadWork(force) {
        if (workState.loaded && !force) return;
        try {
            const r = await fetch('/api/work', { cache: 'no-store' });
            const d = await r.json();
            if (r.status === 401) { location.replace('index.html'); return; }
            if (!r.ok) throw new Error(d.error || 'Не удалось загрузить журнал');
            workState.entries = d.entries || [];
            workState.loaded = true;
            renderWork();
        } catch (e) { toast(e.message, 'err'); }
    }

    async function persistWork(okText) {
        try {
            const r = await fetch('/api/work', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries: workState.entries }),
            });
            const d = await r.json();
            if (r.status === 401) { location.replace('index.html'); return false; }
            if (!r.ok) throw new Error(d.error || 'Не удалось сохранить журнал');
            workState.entries = d.entries || workState.entries;
            renderWork();
            if (okText) toast(okText);
            return true;
        } catch (e) {
            toast(e.message, 'err');
            return false;
        }
    }

    function renderWorkPhotos() {
        E('wPhotoGrid').innerHTML = workState.photos.map((f, i) => `
            <div class="wphoto">
                <img src="${esc(workPhotoSrc(f))}" alt="">
                <button type="button" data-photo-remove="${i}" title="Убрать фото">×</button>
            </div>`).join('');
    }

    function openWork(id) {
        const entry = id ? workState.entries.find(x => x.id === id) : null;
        workState.editId = entry ? entry.id : null;
        workState.photos = entry && Array.isArray(entry.photos) ? entry.photos.slice() : [];
        E('workTitle').textContent = entry ? 'Редактирование записи' : 'Новая запись';
        E('workSub').textContent = entry
            ? `${fmtWorkDate(entry.date)}${entry.plate ? ' · ' + entry.plate : ''}`
            : 'Работа по машине: номер, марка, что сделали и выручка';
        E('btnDeleteWork').style.display = entry ? '' : 'none';
        E('wDate').value = entry ? entry.date || '' : todayStr();
        E('wPlate').value = entry ? entry.plate || '' : '';
        E('wBrand').value = entry ? entry.brand || '' : '';
        E('wWork').value = entry ? entry.work || '' : '';
        E('wSold').value = entry ? entry.sold || '' : '';
        E('wAmount').value = entry && entry.amount !== null && entry.amount !== undefined ? entry.amount : '';
        renderWorkPhotos();
        workModal.classList.add('open');
        workModal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        setTimeout(() => E('wPlate').focus(), 60);
    }

    function closeWork() {
        workModal.classList.remove('open');
        workModal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        workState.editId = null;
        workState.photos = [];
    }

    async function uploadWorkPhotos(files) {
        for (const file of files) {
            if (!/^image\//.test(file.type)) { toast('Пропущен файл: это не изображение', 'err'); continue; }
            if (file.size > 12 * 1024 * 1024) { toast(`Файл «${file.name}» больше 12 МБ`, 'err'); continue; }
            try {
                const dataUrl = await readFileAsDataUrl(file);
                const r = await fetch('/api/work/upload', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ dataUrl }),
                });
                const d = await r.json();
                if (!r.ok) throw new Error(d.error || 'Не удалось загрузить фото');
                workState.photos.push(d.file);
                renderWorkPhotos();
            } catch (e) { toast(e.message, 'err'); }
        }
    }

    E('btnAddWork').addEventListener('click', () => openWork(null));
    E('wSearch').addEventListener('input', () => { workState.q = E('wSearch').value; renderWork(); });
    E('wFilterMonth').addEventListener('change', () => { workState.month = E('wFilterMonth').value; renderWork(); });
    E('wFilterYear').addEventListener('change', () => { workState.year = E('wFilterYear').value; renderWork(); });

    E('workList').addEventListener('click', e => {
        const btn = e.target.closest('[data-wact]');
        if (!btn) return;
        const row = btn.closest('.wrow');
        const id = row.dataset.id;
        if (btn.dataset.wact === 'edit') return openWork(id);
        if (btn.dataset.wact === 'del') {
            const entry = workState.entries.find(x => x.id === id);
            if (!entry) return;
            if (!confirm(`Удалить запись${entry.plate ? ' по номеру ' + entry.plate : ''}?`)) return;
            workState.entries = workState.entries.filter(x => x.id !== id);
            persistWork('Запись удалена');
        }
    });

    E('btnSaveWork').addEventListener('click', async () => {
        const date = E('wDate').value;
        if (!date) { toast('Укажите дату', 'err'); return; }
        const data = {
            date,
            plate: E('wPlate').value.trim(),
            brand: E('wBrand').value.trim(),
            work: E('wWork').value.trim(),
            sold: E('wSold').value.trim(),
            amount: E('wAmount').value === '' ? null : Number(E('wAmount').value),
            photos: workState.photos.slice(),
        };
        if (!data.plate && !data.brand && !data.work && !data.sold) {
            toast('Заполните хотя бы номер, марку или работу', 'err');
            return;
        }
        const now = new Date().toISOString();
        if (workState.editId) {
            const i = workState.entries.findIndex(x => x.id === workState.editId);
            if (i >= 0) workState.entries[i] = Object.assign({}, workState.entries[i], data, { updatedAt: now });
        } else {
            workState.entries.push(Object.assign({ createdAt: now, updatedAt: now }, data, {
                id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            }));
        }
        const ok = await persistWork('Запись сохранена');
        if (ok) closeWork();
    });

    E('btnDeleteWork').addEventListener('click', async () => {
        if (!workState.editId) return;
        if (!confirm('Удалить эту запись из журнала?')) return;
        workState.entries = workState.entries.filter(x => x.id !== workState.editId);
        const ok = await persistWork('Запись удалена');
        if (ok) closeWork();
    });

    E('btnPickWorkPhoto').addEventListener('click', () => E('wFileInput').click());
    E('wFileInput').addEventListener('change', e => {
        uploadWorkPhotos([...e.target.files]);
        e.target.value = '';
    });
    E('wPhotoGrid').addEventListener('click', e => {
        const btn = e.target.closest('[data-photo-remove]');
        if (!btn) return;
        workState.photos.splice(Number(btn.dataset.photoRemove), 1);
        renderWorkPhotos();
    });
    workModal.querySelectorAll('[data-close-work]').forEach(el => el.addEventListener('click', closeWork));
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && workModal.classList.contains('open')) closeWork();
    });

    // ==================================================== ВИЗУАЛЬНЫЙ РЕДАКТОР =
    const ed = {
        loaded: false,
        pages: {},
        page: 'index.html',
        doc: null,
        win: null,
        selected: null,
        selector: '',
        history: [],
        dirty: false,
    };
    const EDITOR_STYLE = `
        .ve-hover{outline:2px dashed rgba(31,91,255,.65)!important;outline-offset:2px!important;cursor:pointer!important}
        .ve-selected{outline:2px solid #1f5bff!important;outline-offset:2px!important}
    `;
    const blockModal = E('blockModal');

    function edPageData() {
        if (!ed.pages[ed.page] || typeof ed.pages[ed.page] !== 'object') {
            ed.pages[ed.page] = { texts: {}, styles: {}, attrs: {}, hidden: [], inserted: [] };
        }
        const p = ed.pages[ed.page];
        p.texts = p.texts || {};
        p.styles = p.styles || {};
        p.attrs = p.attrs || {};
        p.hidden = Array.isArray(p.hidden) ? p.hidden : [];
        p.inserted = Array.isArray(p.inserted) ? p.inserted : [];
        return p;
    }

    function edSetState(mode, text) {
        const box = E('edState');
        box.className = 'save-state' + (mode === 'busy' ? ' busy' : mode === 'error' ? ' error' : '');
        E('edStateText').textContent = text;
    }

    function edSnapshot() {
        ed.history.push(JSON.stringify(ed.pages));
        if (ed.history.length > 60) ed.history.shift();
    }

    function edChanged() {
        ed.dirty = true;
        edSetState('busy', 'Есть несохранённые правки');
    }

    async function loadEditor(force) {
        if (ed.loaded && !force) return;
        try {
            const r = await fetch('/api/editor', { cache: 'no-store' });
            const d = await r.json();
            if (r.status === 401) { location.replace('index.html'); return; }
            if (r.status === 403) { toast('Редактор доступен только владельцу', 'err'); return; }
            if (!r.ok) throw new Error(d.error || 'Не удалось загрузить правки');
            ed.pages = (d.edits && d.edits.pages) || {};
            ed.loaded = true;
            edSetState('ok', 'Загружено');
            edOpenPage(ed.page);
        } catch (e) {
            edSetState('error', 'Ошибка загрузки');
            toast(e.message, 'err');
        }
    }

    function edOpenPage(page) {
        ed.page = page;
        ed.selected = null;
        ed.selector = '';
        E('edPage').value = page;
        E('edInsBody').hidden = true;
        E('edInsEmpty').hidden = false;
        edSetState('ok', 'Загружаю страницу…');
        const frame = E('edFrame');
        frame.onload = edFrameReady;
        frame.src = '/' + page + '?edit=1&_=' + Date.now();
    }

    function edFrameReady() {
        const frame = E('edFrame');
        let doc;
        try { doc = frame.contentDocument; } catch (e) { toast('Не удалось открыть страницу', 'err'); return; }
        if (!doc || !doc.body) return;
        ed.doc = doc;
        ed.win = frame.contentWindow;

        let st = doc.getElementById('ve-editor-style');
        if (!st) {
            st = doc.createElement('style');
            st.id = 've-editor-style';
            (doc.head || doc.documentElement).appendChild(st);
        }
        st.textContent = EDITOR_STYLE;

        doc.addEventListener('mouseover', edHover, true);
        doc.addEventListener('mouseout', edHoverOut, true);
        doc.addEventListener('click', edClick, true);
        doc.addEventListener('submit', e => e.preventDefault(), true);

        edApplyAll();
        edSetState(ed.dirty ? 'busy' : 'ok', ed.dirty ? 'Есть несохранённые правки' : 'Загружено');
    }

    function edQuery(sel) {
        if (!sel || !ed.doc) return null;
        try { return ed.doc.querySelector(sel); } catch (e) { return null; }
    }

    function edApplyAll() {
        const doc = ed.doc;
        if (!doc) return;
        const p = edPageData();

        Object.keys(p.texts).forEach(sel => {
            const el = edQuery(sel);
            if (el && el.innerHTML !== p.texts[sel]) el.innerHTML = p.texts[sel];
        });
        Object.keys(p.styles).forEach(sel => {
            const el = edQuery(sel);
            if (!el) return;
            Object.keys(p.styles[sel]).forEach(prop => el.style.setProperty(prop, p.styles[sel][prop]));
        });
        Object.keys(p.attrs).forEach(sel => {
            const el = edQuery(sel);
            if (!el) return;
            Object.keys(p.attrs[sel]).forEach(name => el.setAttribute(name, p.attrs[sel][name]));
        });
        p.hidden.forEach(sel => {
            const el = edQuery(sel);
            if (el) el.classList.add('ve-is-hidden');
        });
        p.inserted.forEach(item => {
            if (edQuery(`[data-ve="${item.id}"]`)) return;
            const anchor = edQuery(item.anchor) || doc.body;
            if (!anchor) return;
            const tpl = doc.createElement('template');
            tpl.innerHTML = item.html;
            const nodes = Array.from(tpl.content.children);
            nodes.forEach(node => {
                node.classList.add('ve-inserted');
                if (item.where === 'append') anchor.appendChild(node);
                else if (item.where === 'before') anchor.parentNode.insertBefore(node, anchor);
                else anchor.parentNode.insertBefore(node, anchor.nextSibling);
            });
        });
    }

    function edEditable(el) {
        if (!el || el.nodeType !== 1) return null;
        const tag = el.tagName.toLowerCase();
        if (['html', 'head', 'body', 'script', 'style', 'meta', 'link', 'title'].includes(tag)) return null;
        if (el.closest('#ve-editor-style')) return null;
        return el;
    }

    function edTarget(el) {
        const editable = edEditable(el);
        if (!editable) return null;
        return editable.closest('[data-ve]') || editable;
    }

    let edHoverEl = null;
    function edHover(e) {
        const target = edTarget(e.target);
        if (!target || target === edHoverEl) return;
        if (edHoverEl) edHoverEl.classList.remove('ve-hover');
        edHoverEl = target;
        if (target !== ed.selected) target.classList.add('ve-hover');
    }
    function edHoverOut(e) {
        if (edHoverEl && !edHoverEl.contains(e.relatedTarget)) {
            edHoverEl.classList.remove('ve-hover');
            edHoverEl = null;
        }
    }
    function edClick(e) {
        const raw = e.target;
        if (!raw || raw.nodeType !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        if (raw.closest('.product-card, .products-grid, .pagination, #pModal')) {
            toast('Карточки шин меняются в разделе «Карточки шин»', 'info');
            return;
        }
        const target = edTarget(raw);
        if (!target) { edClearSelection(); return; }
        edSelect(target);
    }

    function edClearSelection() {
        if (ed.selected) ed.selected.classList.remove('ve-selected');
        ed.selected = null;
        ed.selector = '';
        E('edInsBody').hidden = true;
        E('edInsEmpty').hidden = false;
    }

    function edSelect(el) {
        if (ed.selected) ed.selected.classList.remove('ve-selected', 've-hover');
        ed.selected = el;
        ed.selector = edCssPath(el);
        el.classList.add('ve-selected');
        edRenderInspector();
    }

    function edCssPath(el) {
        const doc = ed.doc;
        if (el.hasAttribute('data-ve')) return `[data-ve="${el.getAttribute('data-ve')}"]`;
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== doc.documentElement) {
            if (node === doc.body) { parts.unshift('body'); break; }
            if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && doc.querySelectorAll('#' + node.id).length === 1) {
                parts.unshift('#' + node.id);
                break;
            }
            const parent = node.parentElement;
            if (!parent) break;
            const index = Array.prototype.indexOf.call(parent.children, node) + 1;
            parts.unshift(node.tagName.toLowerCase() + ':nth-child(' + index + ')');
            node = parent;
        }
        return parts.join(' > ');
    }

    function edCurrentText(el) {
        const stored = edPageData().texts[ed.selector];
        return typeof stored === 'string' ? stored : el.innerHTML;
    }
    function edCurrentStyle(el, prop) {
        const stored = (edPageData().styles[ed.selector] || {})[prop];
        if (stored) return stored;
        try { return ed.win.getComputedStyle(el).getPropertyValue(prop) || ''; } catch (e) { return ''; }
    }
    function edCurrentAttr(el, name) {
        const stored = (edPageData().attrs[ed.selector] || {})[name];
        return typeof stored === 'string' ? stored : (el.getAttribute(name) || '');
    }
    function toHex(color) {
        if (!color) return '#000000';
        if (/^#[0-9a-f]{6}$/i.test(color)) return color;
        if (/^#[0-9a-f]{3}$/i.test(color)) return '#' + color.slice(1).split('').map(c => c + c).join('');
        const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color);
        if (!m) return '#000000';
        return '#' + [1, 2, 3].map(i => Number(m[i]).toString(16).padStart(2, '0')).join('');
    }

    function edSetStyle(prop, value) {
        const p = edPageData();
        const styles = p.styles[ed.selector] || (p.styles[ed.selector] = {});
        if (value === '' || value == null) delete styles[prop];
        else styles[prop] = value;
        if (!Object.keys(styles).length) delete p.styles[ed.selector];
        if (ed.selected) {
            if (value === '' || value == null) ed.selected.style.removeProperty(prop);
            else ed.selected.style.setProperty(prop, value);
        }
        edChanged();
    }
    function edSetText(value) {
        const p = edPageData();
        p.texts[ed.selector] = value;
        if (ed.selected && ed.selected.innerHTML !== value) ed.selected.innerHTML = value;
        edChanged();
    }
    function edSetAttr(name, value) {
        const p = edPageData();
        const attrs = p.attrs[ed.selector] || (p.attrs[ed.selector] = {});
        if (value === '') delete attrs[name];
        else attrs[name] = value;
        if (!Object.keys(attrs).length) delete p.attrs[ed.selector];
        if (ed.selected) {
            if (value === '') ed.selected.removeAttribute(name);
            else ed.selected.setAttribute(name, value);
        }
        edChanged();
    }

    function edRenderInspector() {
        const el = ed.selected;
        if (!el) return;
        const p = edPageData();
        const tag = el.tagName.toLowerCase();
        const isLink = tag === 'a';
        const isInserted = el.hasAttribute('data-ve');
        const hasText = !['img', 'input', 'br', 'video', 'iframe', 'hr'].includes(tag);
        const curSize = String(parseFloat(edCurrentStyle(el, 'font-size')) || '');
        const sizeOptions = ['', '12', '14', '16', '18', '20', '24', '28', '32', '40', '48', '56', '64'];
        const weightOptions = ['', '400', '500', '600', '700', '800', '900'];
        const curWeight = String(edCurrentStyle(el, 'font-weight')).replace(/\s/g, '');
        const alignOptions = [['', 'как на сайте'], ['left', 'по левому краю'], ['center', 'по центру'], ['right', 'по правому краю']];

        let h = `<div class="ins-head"><b>&lt;${esc(tag)}&gt;</b><span title="${esc(ed.selector)}">${esc(ed.selector)}</span></div>`;
        h += `<div class="ins-note">${isInserted ? 'Добавленный блок: его можно редактировать, дублировать и удалять.' : 'Правки сохраняются в site-edits.json и применяются на сайте.'}</div>`;

        if (hasText) {
            h += `<label class="ins-field"><span>Текст${isLink ? ' (ссылка)' : ''}</span><textarea id="insText">${esc(edCurrentText(el))}</textarea></label>`;
        }
        if (isLink) {
            h += `<label class="ins-field"><span>Ссылка (href)</span><input type="text" id="insHref" value="${esc(edCurrentAttr(el, 'href'))}"></label>`;
            h += `<label class="ins-field"><span>Открывать</span><select id="insTarget">
                <option value="">В этом окне</option>
                <option value="_blank"${edCurrentAttr(el, 'target') === '_blank' ? ' selected' : ''}>В новой вкладке</option>
            </select></label>`;
        }

        h += `<div class="ins-row">
            <label class="ins-field"><span>Размер шрифта</span><select id="insSize">${sizeOptions.map(s => `<option value="${s}"${curSize === s ? ' selected' : ''}>${s ? s + ' px' : 'как на сайте'}</option>`).join('')}</select></label>
            <label class="ins-field"><span>Насыщенность</span><select id="insWeight">${weightOptions.map(w => `<option value="${w}"${curWeight === w ? ' selected' : ''}>${w || 'как на сайте'}</option>`).join('')}</select></label>
        </div>`;
        h += `<div class="ins-row">
            <label class="ins-field"><span>Цвет текста</span><div class="ins-color"><input type="color" id="insColor" value="${toHex(edCurrentStyle(el, 'color'))}"><input type="text" id="insColorText" value="${esc(edCurrentStyle(el, 'color'))}"></div></label>
            <label class="ins-field"><span>Фон</span><div class="ins-color"><input type="color" id="insBg" value="${toHex(edCurrentStyle(el, 'background-color'))}"><input type="text" id="insBgText" value="${esc(edCurrentStyle(el, 'background-color'))}"></div></label>
        </div>`;
        h += `<div class="ins-row">
            <label class="ins-field"><span>Выравнивание</span><select id="insAlign">${alignOptions.map(([v, l]) => `<option value="${v}"${edCurrentStyle(el, 'text-align') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
            <label class="ins-field"><span>Скругление</span><input type="text" id="insRadius" value="${esc(edCurrentStyle(el, 'border-radius'))}" placeholder="12px"></label>
        </div>`;
        h += `<label class="ins-field"><span>Отступы (padding)</span><input type="text" id="insPadding" value="${esc(edCurrentStyle(el, 'padding'))}" placeholder="12px 24px"></label>`;
        h += `<div class="ins-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-ins="hide">${p.hidden.includes(ed.selector) ? 'Показать элемент' : 'Скрыть элемент'}</button>
            <button class="btn btn-ghost btn-sm" type="button" data-ins="duplicate">Дублировать элемент</button>
            <button class="btn btn-ghost btn-sm" type="button" data-ins="reset">Сбросить правки элемента</button>
            ${isInserted ? '<button class="btn btn-danger btn-sm" type="button" data-ins="delete-block">Удалить добавленный блок</button>' : ''}
        </div>`;

        E('edInsBody').innerHTML = h;
        E('edInsEmpty').hidden = true;
        E('edInsBody').hidden = false;
        edBindInspector();
    }

    function edBindInspector() {
        const text = E('insText');
        if (text) text.addEventListener('input', () => edSetText(text.value));
        const href = E('insHref');
        if (href) href.addEventListener('change', () => edSetAttr('href', href.value.trim()));
        const target = E('insTarget');
        if (target) target.addEventListener('change', () => edSetAttr('target', target.value));
        const size = E('insSize');
        if (size) size.addEventListener('change', () => edSetStyle('font-size', size.value ? size.value + 'px' : ''));
        const weight = E('insWeight');
        if (weight) weight.addEventListener('change', () => edSetStyle('font-weight', weight.value));
        const align = E('insAlign');
        if (align) align.addEventListener('change', () => edSetStyle('text-align', align.value));
        const radius = E('insRadius');
        if (radius) radius.addEventListener('change', () => edSetStyle('border-radius', radius.value.trim()));
        const padding = E('insPadding');
        if (padding) padding.addEventListener('change', () => edSetStyle('padding', padding.value.trim()));
        const color = E('insColor');
        if (color) color.addEventListener('input', () => {
            edSetStyle('color', color.value);
            E('insColorText').value = color.value;
        });
        const colorText = E('insColorText');
        if (colorText) colorText.addEventListener('change', () => {
            const v = colorText.value.trim();
            edSetStyle('color', v);
            if (v) color.value = toHex(v);
        });
        const bg = E('insBg');
        if (bg) bg.addEventListener('input', () => {
            edSetStyle('background-color', bg.value);
            E('insBgText').value = bg.value;
        });
        const bgText = E('insBgText');
        if (bgText) bgText.addEventListener('change', () => {
            const v = bgText.value.trim();
            edSetStyle('background-color', v);
            if (v) bg.value = toHex(v);
        });
        E('edInsBody').querySelectorAll('[data-ins]').forEach(btn => {
            btn.addEventListener('click', () => edAction(btn.dataset.ins));
        });
    }

    function edAction(action) {
        const el = ed.selected;
        if (!el) return;
        const p = edPageData();

        if (action === 'hide') {
            edSnapshot();
            const hidden = new Set(p.hidden);
            if (hidden.has(ed.selector)) {
                hidden.delete(ed.selector);
                el.classList.remove('ve-is-hidden');
                toast('Элемент снова виден', 'info');
            } else {
                hidden.add(ed.selector);
                el.classList.add('ve-is-hidden');
                toast('Элемент скрыт — сохраните правки', 'info');
            }
            p.hidden = [...hidden];
            edChanged();
            edRenderInspector();
            return;
        }

        if (action === 'duplicate') {
            edSnapshot();
            const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            const clone = el.cloneNode(true);
            clone.removeAttribute('id');
            clone.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
            p.inserted.push({
                id,
                anchor: ed.selector,
                where: 'after',
                html: `<div class="ve-block" data-ve="${id}">${clone.outerHTML}</div>`,
            });
            edApplyAll();
            edChanged();
            toast('Элемент продублирован');
            return;
        }

        if (action === 'reset') {
            edSnapshot();
            delete p.texts[ed.selector];
            delete p.styles[ed.selector];
            delete p.attrs[ed.selector];
            p.hidden = p.hidden.filter(s => s !== ed.selector);
            ed.dirty = true;
            edOpenPage(ed.page);
            toast('Правки элемента сброшены');
            return;
        }

        if (action === 'delete-block') {
            if (!el.hasAttribute('data-ve')) return;
            edSnapshot();
            const id = el.getAttribute('data-ve');
            p.inserted = p.inserted.filter(x => x.id !== id);
            delete p.texts[ed.selector];
            delete p.styles[ed.selector];
            delete p.attrs[ed.selector];
            el.remove();
            edClearSelection();
            edChanged();
            toast('Блок удалён');
        }
    }

    function blockHtml(preset, text, link) {
        const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const t = esc(text || '');
        const url = esc(link || '#');
        let inner = '';
        if (preset === 'heading') {
            inner = `<h2 style="font-size:clamp(1.5rem,3vw,2.2rem);font-weight:800;margin:0 0 10px">${t}</h2>`;
        } else if (preset === 'text') {
            inner = `<p style="font-size:1rem;line-height:1.6;margin:0 0 10px">${t}</p>`;
        } else if (preset === 'button') {
            inner = `<a href="${url}" style="display:inline-flex;align-items:center;justify-content:center;padding:13px 26px;border-radius:12px;background:#1f5bff;color:#fff;font-weight:700;text-decoration:none">${t}</a>`;
        } else if (preset === 'card') {
            inner = `<div style="background:#fff;border:1px solid #e3e9f2;border-radius:16px;padding:24px;box-shadow:0 8px 28px rgba(12,30,58,.08)">
                <h3 style="font-size:1.15rem;font-weight:800;margin:0 0 8px">${t}</h3>
                <p style="font-size:.92rem;color:#5d6b80;margin:0 0 14px">Короткий текст о преимуществе или услуге.</p>
                <a href="${url}" style="display:inline-flex;padding:10px 20px;border-radius:10px;background:#1f5bff;color:#fff;font-weight:700;text-decoration:none">Подробнее</a>
            </div>`;
        } else {
            inner = `<div style="height:28px"></div><hr style="border:0;border-top:1px solid #e3e9f2;margin:0 0 28px">`;
        }
        const html = `<div class="ve-block" data-ve="${id}" style="max-width:1100px;margin:22px auto;padding:0 20px">${inner}</div>`;
        return { id, html };
    }

    function edInsertBlock() {
        const preset = E('bPreset').value;
        const text = E('bText').value.trim();
        const link = E('bLink').value.trim();
        if (preset !== 'spacer' && !text) { toast('Введите текст блока', 'err'); return; }
        if (!ed.doc) { toast('Сначала дождитесь загрузки страницы', 'err'); return; }

        edSnapshot();
        const p = edPageData();
        const built = blockHtml(preset, text, link);
        const where = E('bWhere').value;
        let anchor = 'body';
        let place = 'append';
        if (where !== 'append' && ed.selector) {
            anchor = ed.selector;
            place = where;
        }
        p.inserted.push({ id: built.id, anchor, where: place, html: built.html });
        edApplyAll();
        edChanged();
        closeBlockModal();
        toast('Блок добавлен — сохраните правки');
        const el = edQuery(`[data-ve="${built.id}"]`);
        if (el) edSelect(el);
    }

    function openBlockModal() {
        E('bText').value = '';
        E('bLink').value = '';
        E('bWhere').value = ed.selector ? 'after' : 'append';
        E('bHint').textContent = ed.selector
            ? `Блок появится относительно выбранного элемента: ${ed.selector}`
            : 'Элемент не выбран — блок добавится в конец страницы.';
        E('bPreset').dispatchEvent(new Event('change'));
        blockModal.classList.add('open');
        blockModal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        setTimeout(() => E('bText').focus(), 60);
    }
    function closeBlockModal() {
        blockModal.classList.remove('open');
        blockModal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
    }

    async function edSave() {
        edSetState('busy', 'Сохраняю…');
        try {
            const r = await fetch('/api/editor', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages: ed.pages }),
            });
            const d = await r.json();
            if (r.status === 401) { location.replace('index.html'); return; }
            if (!r.ok) throw new Error(d.error || 'Не удалось сохранить правки');
            ed.dirty = false;
            edSetState('ok', 'Сохранено');
            toast('Правки сохранены — обновите сайт, чтобы увидеть их');
        } catch (e) {
            edSetState('error', 'Не сохранено');
            toast(e.message, 'err');
        }
    }

    function edUndo() {
        if (!ed.history.length) { toast('Нечего отменять', 'info'); return; }
        try {
            ed.pages = JSON.parse(ed.history.pop());
            ed.dirty = true;
            edOpenPage(ed.page);
        } catch (e) { toast('Не удалось отменить', 'err'); }
    }

    E('edPage').addEventListener('change', () => edOpenPage(E('edPage').value));
    E('edSave').addEventListener('click', edSave);
    E('edUndo').addEventListener('click', edUndo);
    E('edReload').addEventListener('click', () => edOpenPage(ed.page));
    E('edAddBlock').addEventListener('click', openBlockModal);
    E('btnInsertBlock').addEventListener('click', edInsertBlock);
    E('bPreset').addEventListener('change', () => {
        const preset = E('bPreset').value;
        E('bLinkField').style.display = preset === 'button' || preset === 'card' ? '' : 'none';
    });
    blockModal.querySelectorAll('[data-close-block]').forEach(el => el.addEventListener('click', closeBlockModal));
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && blockModal.classList.contains('open')) closeBlockModal();
    });
})();
