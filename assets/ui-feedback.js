/* Live-feel UI: every click shows instant feedback, every network call shows progress.
   - Buttons press-in on click.
   - A button that starts a network request shows a spinner until the requests finish.
   - A thin progress bar runs at the top of the page while anything is loading.
   - EMUI.busy(btn, label) / EMUI.toast(message, 'error') for explicit use.
   Load this BEFORE the Firebase scripts so their requests are tracked too. */
(function () {
  'use strict';
  if (window.EMUI) return;

  var css = [
    'button:not(:disabled):active,a.btn:active,[role=button]:active{transform:scale(.96)}',
    'button,a.btn{transition:transform .12s ease,opacity .2s ease,filter .2s ease}',
    '.em-loading{position:relative;pointer-events:none;opacity:.8;cursor:progress}',
    '.em-loading::after{content:"";position:absolute;right:12px;top:50%;width:16px;height:16px;margin-top:-8px;border-radius:9999px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;animation:em-spin .7s linear infinite}',
    '@keyframes em-spin{to{transform:rotate(360deg)}}',
    '.em-spinner{display:inline-block;width:.95em;height:.95em;vertical-align:-.15em;border-radius:9999px;border:2px solid currentColor;border-top-color:transparent;animation:em-spin .7s linear infinite}',
    '.em-link-loading{position:relative;pointer-events:none;opacity:.85;cursor:progress}',
    '.em-link-loading::after{content:"";display:inline-block;width:.9em;height:.9em;margin-left:.55em;vertical-align:-.12em;border-radius:9999px;border:2px solid currentColor;border-top-color:transparent;animation:em-spin .7s linear infinite}',
    'body.em-leaving{opacity:.55;transition:opacity .25s ease}',
    '.em-skeleton{border-radius:1rem;min-height:120px;background:linear-gradient(90deg,rgba(255,255,255,.04),rgba(255,255,255,.11),rgba(255,255,255,.04));background-size:200% 100%;animation:em-shim 1.2s linear infinite}',
    '@keyframes em-shim{to{background-position:-200% 0}}',
    '#emTopbar{position:fixed;top:0;left:0;height:3px;width:0;z-index:2147483000;background:linear-gradient(90deg,#60a5fa,#a78bfa,#fb7185);transition:width .35s ease,opacity .3s ease;opacity:0;pointer-events:none}',
    '#emToasts{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483001;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;width:min(92vw,420px)}',
    '.em-toast{pointer-events:auto;width:100%;padding:12px 16px;border-radius:14px;font:700 14px/1.4 system-ui,sans-serif;color:#fff;background:#111b30;border:1px solid rgba(255,255,255,.12);box-shadow:0 18px 40px rgba(0,0,0,.45);animation:em-pop .25s ease}',
    '.em-toast.ok{border-color:rgba(52,211,153,.55)}.em-toast.err{border-color:rgba(251,113,133,.6)}',
    '@keyframes em-pop{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}'
  ].join('\n');
  var style = document.createElement('style');
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  function ready(fn) {
    if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn);
  }

  /* ---------- toast ---------- */
  function toast(message, type) {
    ready(function () {
      var box = document.getElementById('emToasts');
      if (!box) {
        box = document.createElement('div');
        box.id = 'emToasts';
        box.setAttribute('role', 'status');
        document.body.appendChild(box);
      }
      var t = document.createElement('div');
      t.className = 'em-toast ' + (type === 'error' ? 'err' : 'ok');
      t.textContent = message;
      box.appendChild(t);
      setTimeout(function () {
        t.style.transition = 'opacity .3s';
        t.style.opacity = '0';
        setTimeout(function () { t.remove(); }, 320);
      }, 3800);
    });
  }

  /* ---------- explicit busy state ---------- */
  function busy(btn, label) {
    if (!btn) return function () {};
    var original = btn.innerHTML;
    btn.classList.add('em-loading');
    btn.setAttribute('aria-busy', 'true');
    if (label) btn.textContent = label;
    return function done() {
      btn.classList.remove('em-loading');
      btn.removeAttribute('aria-busy');
      btn.innerHTML = original;
    };
  }

  /* ---------- progress bar + click-linked spinner ---------- */
  var inflight = 0, bar = null, lastBtn = null, lastAt = 0, linked = [], idleTimer = null;
  function barEl() {
    if (!bar) { bar = document.createElement('div'); bar.id = 'emTopbar'; document.body.appendChild(bar); }
    return bar;
  }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button,[role=button],input[type=submit]') : null;
    if (b && !b.disabled) { lastBtn = b; lastAt = Date.now(); }
  }, true);

  function start() {
    inflight++;
    clearTimeout(idleTimer);
    ready(function () { var b = barEl(); b.style.opacity = '1'; b.style.width = '70%'; });
    if (lastBtn && Date.now() - lastAt < 2500 && linked.indexOf(lastBtn) === -1) {
      lastBtn.classList.add('em-loading');
      linked.push(lastBtn);
    }
  }
  function finish() {
    inflight = Math.max(0, inflight - 1);
    if (inflight) return;
    // Short grace period so multi-step actions keep the spinner running between requests.
    idleTimer = setTimeout(function () {
      if (inflight) return;
      linked.forEach(function (b) { b.classList.remove('em-loading'); });
      linked = [];
      if (bar) { bar.style.width = '100%'; setTimeout(function () { bar.style.opacity = '0'; setTimeout(function () { bar.style.width = '0'; }, 300); }, 200); }
    }, 350);
  }
  if (window.fetch) {
    var nativeFetch = window.fetch.bind(window);
    window.fetch = function () {
      start();
      var p;
      try { p = nativeFetch.apply(null, arguments); } catch (err) { finish(); throw err; }
      return p.then(function (r) { finish(); return r; }, function (err) { finish(); throw err; });
    };
  }

  /* ---------- page links: instant feedback while the next page loads ---------- */
  function resetLinks() {
    document.querySelectorAll('.em-link-loading').forEach(function (a) { a.classList.remove('em-link-loading'); });
    if (document.body) document.body.classList.remove('em-leaving');
    if (bar) { bar.style.opacity = '0'; bar.style.width = '0'; }
  }
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || /^(mailto:|tel:|javascript:|whatsapp:)/i.test(href)) return;
    var url; try { url = new URL(a.href, location.href); } catch (_) { return; }
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search) return;
    a.classList.add('em-link-loading');
    document.body.classList.add('em-leaving');
    ready(function () { var b = barEl(); b.style.opacity = '1'; b.style.width = '80%'; });
    setTimeout(resetLinks, 15000);
  }, false);
  window.addEventListener('pageshow', function (e) { if (e.persisted) resetLinks(); });

  /* ---------- placeholder cards while a list loads ---------- */
  function skeleton(el, count) {
    if (!el) return;
    var html = '';
    for (var i = 0; i < (count || 3); i++) html += '<div class="em-skeleton"></div>';
    el.innerHTML = html;
  }

  window.EMUI = Object.freeze({ busy: busy, toast: toast, skeleton: skeleton });
}());
