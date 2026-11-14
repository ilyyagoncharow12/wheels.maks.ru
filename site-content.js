// Подстановка текстов сайта, отредактированных в админ-панели.
// Данные хранятся в content.json рядом с этим файлом.
(function () {
  var PHONE_KEY = 'common.phone';

  function normalizePhone(text) {
    var digits = String(text || '').replace(/[^\d+]/g, '');
    if (digits.indexOf('+') > 0) digits = digits.replace(/\+/g, '');
    return digits;
  }

  function apply(data) {
    if (!data || typeof data !== 'object') return;

    document.querySelectorAll('[data-edit]').forEach(function (el) {
      var key = el.getAttribute('data-edit');
      var value = data[key];
      if (typeof value === 'string' && value.trim() !== '') {
        if (el.innerHTML !== value) el.innerHTML = value;
      }
    });

    var phone = data[PHONE_KEY];
    if (typeof phone === 'string' && phone.trim()) {
      var tel = normalizePhone(phone);
      window.SITE_PHONE = tel;
      document.querySelectorAll('a[href^="tel:"]').forEach(function (a) {
        a.setAttribute('href', 'tel:' + tel);
      });
    }
  }

  function load() {
    return new Promise(function (resolve) {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', 'content.json?_=' + Date.now(), true);
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { apply(JSON.parse(xhr.responseText)); } catch (e) { /* ignore */ }
          }
          resolve();
        };
        xhr.onerror = function () { resolve(); };
        xhr.send();
      } catch (e) { resolve(); }
    });
  }

  function start() {
    window.SITE_CONTENT_READY = load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
