// Применение правок визуального редактора (site-edits.json) на страницах сайта.
// Правки хранятся отдельно от HTML: текст, стили, атрибуты, скрытые блоки и
// добавленные элементы. Так обновления каталога и данные товаров не ломаются.
(function () {
  'use strict';

  var EDIT_MODE = /[?&]edit=1\b/.test(location.search);
  var STYLE_ID = 've-applied-style';

  function injectBaseStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.ve-is-hidden{display:none!important}' +
      '.ve-block{box-sizing:border-box}' +
      '.ve-inserted{scroll-margin:80px}';
    (doc.head || doc.documentElement).appendChild(style);
  }

  function pageKey() {
    var name = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    if (name === '' || name === '/') return 'index.html';
    return name;
  }

  function safeQuery(doc, selector) {
    if (!selector) return null;
    try { return doc.querySelector(selector); } catch (e) { return null; }
  }

  function applyPageEdits(doc, data) {
    if (!doc || !data) return;
    injectBaseStyle(doc);

    // Сначала находим все элементы на «чистой» странице, потом меняем DOM.
    var texts = Object.keys(data.texts || {}).map(function (sel) {
      return { el: safeQuery(doc, sel), value: data.texts[sel] };
    }).filter(function (x) { return x.el; });

    var styles = Object.keys(data.styles || {}).map(function (sel) {
      return { el: safeQuery(doc, sel), value: data.styles[sel] };
    }).filter(function (x) { return x.el; });

    var attrs = Object.keys(data.attrs || {}).map(function (sel) {
      return { el: safeQuery(doc, sel), value: data.attrs[sel] };
    }).filter(function (x) { return x.el; });

    var hidden = (data.hidden || []).map(function (sel) {
      return safeQuery(doc, sel);
    }).filter(Boolean);

    var inserted = (data.inserted || []).map(function (item) {
      return { item: item, anchor: safeQuery(doc, item.anchor) };
    }).filter(function (x) { return x.anchor; });

    texts.forEach(function (x) {
      if (x.el.innerHTML !== x.value) x.el.innerHTML = x.value;
    });

    styles.forEach(function (x) {
      Object.keys(x.value).forEach(function (prop) {
        x.el.style.setProperty(prop, x.value[prop]);
      });
    });

    attrs.forEach(function (x) {
      Object.keys(x.value).forEach(function (name) {
        x.el.setAttribute(name, x.value[name]);
      });
    });

    inserted.forEach(function (x) {
      var id = x.item.id;
      if (safeQuery(doc, '[data-ve="' + id + '"]')) return;
      var tpl = doc.createElement('template');
      tpl.innerHTML = x.item.html;
      var nodes = Array.prototype.slice.call(tpl.content.children);
      if (!nodes.length) return;
      nodes.forEach(function (node) {
        node.classList.add('ve-inserted');
        if (x.item.where === 'append') {
          x.anchor.appendChild(node);
        } else if (x.item.where === 'before') {
          x.anchor.parentNode.insertBefore(node, x.anchor);
        } else {
          x.anchor.parentNode.insertBefore(node, x.anchor.nextSibling);
        }
      });
    });

    hidden.forEach(function (el) { el.classList.add('ve-is-hidden'); });

    doc.dispatchEvent(new CustomEvent('ve:applied', { detail: data }));
  }

  window.VEApplyPageEdits = applyPageEdits;

  function load() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'site-edits.json?_=' + Date.now(), true);
    xhr.onload = function () {
      if (xhr.status < 200 || xhr.status >= 300) return;
      var parsed;
      try { parsed = JSON.parse(xhr.responseText); } catch (e) { return; }
      var pages = (parsed && parsed.pages) || {};
      var data = pages[pageKey()] || null;
      window.SITE_EDITS = pages;
      if (!EDIT_MODE && data) applyPageEdits(document, data);
    };
    xhr.send();
  }

  function start() {
    injectBaseStyle(document);
    var ready = window.SITE_CONTENT_READY;
    if (ready && typeof ready.then === 'function') ready.then(load, load);
    else load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
