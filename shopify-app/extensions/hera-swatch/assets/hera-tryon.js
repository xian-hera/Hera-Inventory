/* Hera Wig Try-on — storefront widget (2026-11-05). Spec: claude/WIG_TRYON_FEATURE_SPEC.md §13.
 *
 * Screens (Hera's mobile mock-ups):
 *   1. icon on the top-left corner of the product photo
 *   2. bottom sheet: choose colour -> accept privacy -> upload selfie (checked at once) -> "Try it out!"
 *   3. "Your photo is being loaded" while the Hub generates (polled every 3 s)
 *   4. result: Save photo / Try another (back to 2, same selfie kept)
 * Not logged in -> straight to the login page; after login the window opens by itself.
 * Every call goes through the Shopify App Proxy (data.proxyPath), which tells the Hub who
 * the customer is — the browser never sends a customer id.
 */
(function () {
  'use strict';
  var el = document.getElementById('hera-tryon-data');
  if (!el || window.__heraTryon) return;
  window.__heraTryon = true;
  var D;
  try { D = JSON.parse(el.textContent); } catch (e) { return; }
  var T = D.t || {};
  // FALLBACK: texts added after the storefront data was last saved in the Hub.
  var FALLBACK = D.lang === 'fr'
    ? { changePhoto: 'Changer de photo', removePhoto: 'Supprimer la photo', titleLabel: 'Essayage IA de perruque', leftLabel: "Essais restants aujourd'hui", btnChooseColor: 'Choisissez une couleur', btnUploadSelfie: 'Téléversez un selfie' }
    : { changePhoto: 'Change photo', removePhoto: 'Remove photo', titleLabel: 'Wig AI try on', leftLabel: 'Try-ons left today', btnChooseColor: 'Choose Color', btnUploadSelfie: 'Upload a Selfie' };
  var tx = function (k) { return T[k] || (D.tEn && D.tEn[k]) || FALLBACK[k] || ''; };
  var log = function () { if (D.debug && window.console) console.log.apply(console, ['[Hera Try-on]'].concat([].slice.call(arguments))); };
  log('data', D);

  var PENDING_KEY = 'hera_tryon_open';
  // Checked selfie kept for this visit (Hera 2026-11-05): sessionStorage = this browser
  // tab only, cleared when the tab / browser is closed. The Hub keeps its copy 30 min
  // after the last use; if that copy is gone, the kept photo is checked again silently.
  var KEPT_KEY = 'hera_tryon_selfie';
  function loadKept() { try { var k = JSON.parse(sessionStorage.getItem(KEPT_KEY) || 'null'); return k && k.id && k.data ? k : null; } catch (e) { return null; } }
  function saveKept(id, data) { try { sessionStorage.setItem(KEPT_KEY, JSON.stringify({ id: id, data: data })); } catch (e) { /* storage full / blocked: works for this page only */ } }
  function clearKept() { try { sessionStorage.removeItem(KEPT_KEY); } catch (e) { /* ignore */ } }
  var SESSION_KEY = 'hera_tryon_sid';
  var sid = (function () {
    try {
      var s = sessionStorage.getItem(SESSION_KEY);
      if (!s) { s = Date.now().toString(36) + Math.random().toString(36).slice(2, 10); sessionStorage.setItem(SESSION_KEY, s); }
      return s;
    } catch (e) { return 'x' + Math.random().toString(36).slice(2, 12); }
  })();

  var ICON_SVG = '<svg viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="18" fill="#FFBCC7"/>'
    + '<path d="M22 14l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="#1d1d1d"/>'
    + '<path d="M66 16h8a6 6 0 0 1 6 6v8M30 80h-8a6 6 0 0 1-6-6v-8" fill="none" stroke="#1d1d1d" stroke-width="4" stroke-linecap="round"/>'
    + '<path d="M47 18c-14 0-22 10-21 25 0 9-3 15-6 21 6 3 13 3 18-1-2 6-1 11 3 14 4-6 6-13 5-20" fill="#1d1d1d"/>'
    + '<path d="M47 18c13 0 20 10 19 23 0 7 2 12 5 16-4 2-9 2-12-1" fill="#1d1d1d"/>'
    + '<ellipse cx="46" cy="42" rx="11" ry="14" fill="#FFBCC7"/>'
    + '<rect x="54" y="60" width="30" height="22" rx="4" fill="#1d1d1d"/><rect x="62" y="56" width="10" height="6" rx="2" fill="#1d1d1d"/>'
    + '<circle cx="69" cy="71" r="6" fill="none" stroke="#FFBCC7" stroke-width="3"/></svg>';
  var CLOSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  var CAM_SVG = '<svg viewBox="0 0 44 36" aria-hidden="true"><path d="M14 6l3-4h10l3 4h6a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4z" fill="currentColor"/><circle cx="22" cy="18" r="7" fill="none" stroke="#fff" stroke-width="3"/><circle cx="37" cy="29" r="7" fill="currentColor" stroke="#fff" stroke-width="2"/><path d="M37 25v8M34 28l3-3 3 3" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';

  function iconHtml() { return D.iconUrl ? '<img src="' + esc(D.iconUrl) + '" alt="">' : ICON_SVG; }
  // Wig name in the window is always shown in Title Case (Hera 2026-11-05):
  // "NUTIQUE ILLUZE LACE DUO FLIP-UP ALIA" -> "Nutique Illuze Lace Duo Flip-Up Alia".
  // A letter is capitalised at the start and after a space, "-", "/" or "(";
  // not after an apostrophe ("IT'S" -> "It's").
  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/(^|[\s\-\/(])(\p{L})/gu, function (m, sep, ch) { return sep + ch.toUpperCase(); });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ─── Hub calls (App Proxy) ──────────────────────────────────────────────────
  function api(method, path, body) {
    var keep = false;
    if (body && body.__keepalive) { keep = true; delete body.__keepalive; }
    var url = D.proxyPath + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'locale=' + encodeURIComponent(D.lang);
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      keepalive: keep,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { d.__status = r.status; return d; });
    });
  }
  function track(type, extra) {
    var b = { event_type: type, session_id: sid, product_id: D.productId, __keepalive: true };
    if (extra) for (var k in extra) b[k] = extra[k];
    api('POST', '/event', b).catch(function () {});
  }

  // ─── Icon on the product photo ──────────────────────────────────────────────
  function placeIcon() {
    var host = null;
    var sels = [D.gallerySelector, 'media-gallery[id$="__main"]', '.product__media-wrapper'];
    for (var i = 0; i < sels.length && !host; i++) { try { if (sels[i]) host = document.querySelector(sels[i]); } catch (e) { /* bad selector */ } }
    if (!host) { log('no gallery found'); return false; }
    if (host.querySelector('.ht-icon')) return true;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ht-icon';
    b.setAttribute('aria-label', tx('iconLabel'));
    b.title = tx('iconLabel');
    b.style.width = b.style.height = D.iconSize + 'px';
    b.style.top = b.style.left = D.iconOffset + 'px';
    b.innerHTML = iconHtml();
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); onIconClick(); });
    host.appendChild(b);
    return true;
  }

  function onIconClick() {
    track('button_click');
    if (D.requireLogin && !D.loggedIn) {
      try { sessionStorage.setItem(PENDING_KEY, String(D.productId)); } catch (e) { /* ignore */ }
      var back = location.pathname + location.search;
      var u = D.loginUrl || '/account/login';
      location.href = u + (u.indexOf('?') >= 0 ? '&' : '?') + 'return_url=' + encodeURIComponent(back);
      return;
    }
    open();
  }

  // ─── State ──────────────────────────────────────────────────────────────────
  // colors: from the Hub (/status), English names — null until loaded.
  var S = { colors: null, name: null, color: null, consent: false, selfieId: null, thumb: null, checking: false, check: null, remaining: null, blocked: null, busy: false, image: null, pollTimer: null, step: 'form' };
  var ov, sheet, body, foot, leftEl;

  function build() {
    ov = document.createElement('div');
    ov.className = 'ht-overlay';
    ov.innerHTML = '<div class="ht-sheet" role="dialog" aria-modal="true" aria-labelledby="ht-title">'
      // Header (Hera 2026-11-05): small label + wig name on the left, small label + number on the right.
      + '<div class="ht-head"><div class="ht-head-l"><span class="ht-lbl">' + esc(tx('titleLabel')) + '</span><h2 class="ht-title" id="ht-title"></h2></div>'
      + '<div class="ht-head-r"><span class="ht-lbl">' + esc(tx('leftLabel')) + '</span><span class="ht-qty ht-left"></span></div>'
      + '<button type="button" class="ht-close" aria-label="Close">' + CLOSE_SVG + '</button></div>'
      + '<div class="ht-body"></div><div class="ht-foot"></div></div>';
    sheet = ov.querySelector('.ht-sheet');
    body = ov.querySelector('.ht-body');
    foot = ov.querySelector('.ht-foot');
    leftEl = ov.querySelector('.ht-left');
    // English wig name comes from the Hub; the page's (maybe translated) one is shown
    // only on English pages until it arrives.
    ov.querySelector('.ht-title').textContent = D.titleIsEnglish ? titleCase(D.title) : '';
    ov.querySelector('.ht-close').addEventListener('click', close);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ov.classList.contains('is-open')) close(); });
    document.body.appendChild(ov);
  }

  function open() {
    if (!ov) build();
    if (!S.selfieId) {
      var k = loadKept();
      // consent was given before that photo was uploaded in this visit
      if (k) { S.selfieId = k.id; S.thumb = k.data; S.check = 'ok'; S.consent = true; }
    }
    S.step = 'form';
    S.color = null; // never pre-selected (Hera 2026-11-05): the customer must choose
    render();
    ov.style.display = 'flex';
    document.documentElement.classList.add('ht-lock');
    // Start at the top ("Choose color"): scrollTop can only be set once the window is visible.
    body.scrollTop = 0;
    requestAnimationFrame(function () { body.scrollTop = 0; ov.classList.add('is-open'); });
    refreshStatus();
  }

  function close() {
    if (!ov) return;
    ov.classList.remove('is-open');
    document.documentElement.classList.remove('ht-lock');
    clearTimeout(S.pollTimer);
    setTimeout(function () { ov.style.display = 'none'; }, 280);
    // The selfie is kept (other wigs in this visit) — only "Remove photo" deletes it.
    S.image = null; S.busy = false; S.step = 'form';
    if (S.check === 'bad') { S.check = null; S.thumb = null; }
  }

  // No colour is pre-selected (Hera 2026-11-05, after customer tests: people pressed
  // the button straight away). Kept as a function in case a default is wanted again;
  // D.selectedIndex (colour selected on the page) is still passed by the Liquid.
  function pickDefaultColor() {
    return null;
  }

  function refreshStatus(precamera) {
    var kept = S.selfieId;
    return api('GET', '/status?product_id=' + D.productId + '&session_id=' + sid + (precamera ? '&check=precamera' : '') + (kept ? '&selfie_id=' + encodeURIComponent(kept) : ''))
      .then(function (d) {
        if (d.__status !== 200) { if (S.colors === null) { S.colors = []; if (S.step === 'form') renderForm(); } return; }
        // The Hub's copy expired (30 min / restart): check the kept photo again, silently.
        if (kept && d.selfieValid === false && S.selfieId === kept && S.thumb && !S.checking) checkData(S.thumb, true);
        S.remaining = d.remaining;
        if (d.product) {
          if (d.product.name) { S.name = d.product.name; ov.querySelector('.ht-title').textContent = titleCase(S.name); }
          var first = S.colors === null;
          S.colors = d.product.colors || [];
          if (!S.color || !S.colors.some(function (c) { return c.v === S.color; })) S.color = pickDefaultColor();
          if (first && S.step === 'form') renderForm();
        } else if (S.colors === null) {
          S.colors = [];
          if (S.step === 'form') renderForm();
        }
        S.blocked = d.quota && !d.quota.ok ? d.quota.message : null;
        if (!d.enabled) S.blocked = S.blocked || tx('busy');
        updateLeft();
        if (S.step === 'form') renderFoot();
      }).catch(function () {
        if (S.colors === null) { S.colors = []; if (S.step === 'form') renderForm(); }
      });
  }
  function updateLeft() {
    leftEl.textContent = S.remaining == null ? '' : String(S.remaining);
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────
  function render() {
    updateLeft();
    if (S.step === 'form') renderForm();
    else if (S.step === 'loading') renderLoading();
    else renderResult();
  }

  // Card size / accent from Online › Swatch › Style (same as the product page picker).
  function swatchVars() {
    var st = D.swatchStyle || {};
    var w = +st.w || 72, h = +st.h || 81;
    var acc = /^#[0-9a-f]{3,8}$|^rgba?\([\d\s.,%]+\)$/i.test(String(st.accent || '')) ? st.accent : '#E32A69';
    return '--ht-w:' + w + 'px;--ht-h:' + h + 'px;--ht-accent:' + acc;
  }

  function renderForm() {
    var h = '';
    if (S.colors === null) {
      h += '<div class="ht-sec"><div class="ht-h"><span>' + esc(tx('chooseColor')) + '</span></div><div class="ht-desc">…</div></div>';
    } else if (S.colors.length) {
      h += '<div class="ht-sec"><div class="ht-h"><span>' + esc(tx('chooseColor')) + '</span><span class="ht-sel">' + esc(S.color || '') + '</span></div><div class="ht-colors" role="radiogroup" style="' + swatchVars() + '">';
      S.colors.forEach(function (c, i) {
        var sel = c.v === S.color;
        h += '<button type="button" class="ht-color' + (sel ? ' is-sel' : '') + '" role="radio" aria-checked="' + sel + '" data-i="' + i + '">'
          + '<span class="ht-swatch"' + (c.img ? ' style="background-image:url(&quot;' + esc(c.img) + '&quot;);background-position:' + esc(c.pos || (D.swatchStyle && D.swatchStyle.pos) || 'center top') + '"' : '') + '></span>'
          + '<span class="ht-cname">' + esc(c.v) + '</span></button>';
      });
      h += '</div></div>';
    }
    var upCls = 'ht-upload' + (S.consent ? '' : ' is-disabled') + (S.checking ? ' is-checking' : '') + (S.check === 'ok' ? ' is-ok' : '') + (S.check === 'bad' ? ' is-bad' : '');
    h += '<div class="ht-sec"><div class="ht-h"><span>' + esc(tx('uploadSelfie')) + '</span></div>'
      + '<label class="ht-consent"><input type="checkbox" class="ht-consent-cb"' + (S.consent ? ' checked' : '') + '><span>'
      + esc(tx('consentBefore')) + ' <a href="' + esc(D.privacyUrl) + '" target="_blank" rel="noopener">' + esc(tx('consentLink')) + '</a> ' + esc(tx('consentAfter')) + '</span></label>'
      + '<div class="ht-upload-row"><button type="button" class="' + upCls + '" aria-label="' + esc(tx('uploadSelfie')) + '">'
      + (S.thumb ? '<img src="' + S.thumb + '" alt="">' : CAM_SVG)
      + '<span class="ht-spin"></span>' + (S.check === 'ok' ? '<span class="ht-badge">&#10003;</span>' : S.check === 'bad' ? '<span class="ht-badge">!</span>' : '') + '</button>'
      + '<div class="ht-req">' + esc(tx('requirements'))
      + (S.checking ? '<div class="ht-status">' + esc(tx('checking')) + '</div>' : S.check === 'ok' ? '<div class="ht-status is-ok">' + esc(tx('selfieOk')) + '</div>' : '')
      + (S.thumb && !S.checking ? '<div class="ht-links"><button type="button" class="ht-link ht-change">' + esc(tx('changePhoto')) + '</button>'
        + '<button type="button" class="ht-link ht-remove">' + esc(tx('removePhoto')) + '</button></div>' : '')
      + '</div></div>'
      + '<input type="file" accept="image/*" class="ht-file" hidden></div>';
    if (tx('description')) h += '<div class="ht-sec"><div class="ht-desc">' + esc(tx('description')) + '</div></div>';
    // Re-drawing keeps the scroll position (e.g. after the selfie check); only opening the
    // window and "Try another" go back to the top.
    var keepTop = body.scrollTop;
    body.innerHTML = h;
    body.scrollTop = keepTop;

    [].forEach.call(body.querySelectorAll('.ht-color'), function (b) {
      b.addEventListener('click', function () {
        var c = S.colors[+b.getAttribute('data-i')];
        if (S.color !== c.v) { S.color = c.v; track('color_selected', { color_name: c.v }); }
        setAlert('');
        var keep = body.scrollTop;
        renderForm();
        body.scrollTop = keep;
      });
    });
    var cb = body.querySelector('.ht-consent-cb');
    cb.addEventListener('change', function () {
      S.consent = cb.checked;
      if (S.consent) { track('consent_accepted'); setAlert(''); }
      body.querySelector('.ht-upload').classList.toggle('is-disabled', !S.consent);
      renderFoot();
    });
    var file = body.querySelector('.ht-file');
    body.querySelector('.ht-upload').addEventListener('click', function () {
      if (S.checking || S.busy) return;
      if (!S.consent) { setAlert(tx('consentFirst')); return; }
      if (S.blocked) { setAlert(S.blocked); return; }
      file.click();
    });
    var ch = body.querySelector('.ht-change');
    if (ch) ch.addEventListener('click', function () { if (!S.busy && !S.blocked) file.click(); else if (S.blocked) setAlert(S.blocked); });
    var rm = body.querySelector('.ht-remove');
    if (rm) rm.addEventListener('click', function () { if (!S.busy) { removeSelfie(); renderForm(); } });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      file.value = '';
      if (f) onPhoto(f);
    });
    renderFoot();
  }

  function renderFoot(alertText) {
    if (S.step !== 'form') return;
    var a = alertText != null ? alertText : (foot.querySelector('.ht-alert') ? foot.querySelector('.ht-alert').textContent : '');
    if (S.blocked) a = S.blocked;
    // Step-by-step button (Hera 2026-11-05): "Choose Color" (disabled) -> "Upload a Selfie"
    // (disabled) -> "Try it out!" once a colour is chosen AND the selfie passed the check.
    var label = tx('tryButton');
    var ready = !S.blocked && !S.busy && !S.checking;
    if (!S.blocked) {
      if (S.colors === null || (S.colors.length && !S.color)) { label = tx('btnChooseColor'); ready = false; }
      else if (!S.selfieId || S.check !== 'ok') { label = tx('btnUploadSelfie'); ready = false; }
    }
    foot.innerHTML = '<div class="ht-alert" role="alert">' + esc(a) + '</div>'
      + '<button type="button" class="ht-btn ht-go"' + (ready ? '' : ' disabled') + '>' + esc(label) + '</button>';
    foot.querySelector('.ht-go').addEventListener('click', function () { submit(false); });
  }
  function setAlert(t) {
    var a = foot.querySelector('.ht-alert');
    if (a) a.textContent = S.blocked || t || '';
  }

  function renderLoading() {
    body.innerHTML = '<div class="ht-loading"><p>' + esc(tx('loading')) + '</p><div class="ht-logo">' + iconHtml() + '</div></div>';
    foot.innerHTML = '';
  }

  function renderResult() {
    body.innerHTML = '<div class="ht-result">' + (S.color ? '<span class="ht-sel">' + esc(S.color) + '</span>' : '')
      + '<div class="ht-photo"><img alt="" src="' + S.image + '"></div></div>';
    foot.innerHTML = '<div class="ht-btns"><button type="button" class="ht-btn is-ghost ht-save">' + esc(tx('savePhoto')) + '</button>'
      + '<button type="button" class="ht-btn ht-again">' + esc(tx('tryAnother')) + '</button></div>';
    foot.querySelector('.ht-save').addEventListener('click', save);
    foot.querySelector('.ht-again').addEventListener('click', function () {
      S.step = 'form'; S.image = null;
      render();
      body.scrollTop = 0;
      refreshStatus();
    });
  }

  // ─── Selfie: resize in the browser, then the Hub checks it ─────────────────
  function toJpeg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var max = 1536;
        var sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * sc);
        c.height = Math.round(img.naturalHeight * sc);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.9));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('read')); };
      img.src = url;
    });
  }

  function removeSelfie() {
    if (S.selfieId) api('POST', '/discard-selfie', { selfie_id: S.selfieId, __keepalive: true }).catch(function () {});
    clearKept();
    S.selfieId = null; S.thumb = null; S.check = null;
  }

  function onPhoto(f) {
    if (S.selfieId) removeSelfie(); // a new photo replaces the kept one
    S.checking = true; S.check = null;
    setAlert('');
    renderForm();
    toJpeg(f).then(function (dataUrl) { return checkData(dataUrl, false); })
      .catch(function () {
        S.checking = false; S.check = 'bad';
        renderForm();
        renderFoot(D.lang === 'fr' ? 'Impossible de lire cette photo. Veuillez en choisir une autre.' : 'This photo could not be read. Please choose another one.');
      });
  }

  // Sends a photo (JPEG data URL) to the selfie check. silent = re-check of the kept
  // photo after the Hub's copy expired. Resolves true when the photo passed.
  function checkData(dataUrl, silent) {
    S.checking = true; S.thumb = dataUrl;
    if (S.step === 'form') renderForm();
    return api('POST', '/check-selfie', { selfie: dataUrl, product_id: D.productId, color_name: S.color, session_id: sid })
      .then(function (d) {
        S.checking = false;
        if (d.__status === 200 && d.ok) {
          S.check = 'ok'; S.selfieId = d.selfieId;
          saveKept(d.selfieId, dataUrl);
          if (S.step === 'form') renderForm();
          return true;
        }
        S.selfieId = null; S.check = 'bad'; clearKept();
        if (silent) S.thumb = null;
        if (d.code === 'limit' || d.code === 'busy') { S.blocked = d.message; S.remaining = d.code === 'limit' ? 0 : S.remaining; updateLeft(); }
        if (S.step === 'form') { renderForm(); renderFoot(d.message || tx('uploadFirst')); }
        return false;
      }, function () {
        S.checking = false; S.check = silent ? 'ok' : 'bad';
        if (S.step === 'form') { renderForm(); if (!silent) renderFoot(D.lang === 'fr' ? 'Erreur réseau. Veuillez réessayer.' : 'Network error. Please try again.'); }
        return false;
      });
  }

  // ─── Generate ───────────────────────────────────────────────────────────────
  function submit(retried) {
    if (S.blocked) { setAlert(S.blocked); return; }
    if (S.colors === null) return; // still loading
    if (S.colors.length && !S.color) { setAlert(tx('chooseColorFirst')); return; }
    if (!S.consent) { setAlert(tx('consentFirst')); return; }
    if (!S.selfieId) { setAlert(tx('uploadFirst')); return; }
    S.busy = true;
    renderFoot('');
    api('POST', '/generate', { product_id: D.productId, color_name: S.color, selfie_id: S.selfieId, session_id: sid })
      .then(function (d) {
        S.busy = false;
        if (d.__status === 200 && d.jobId) {
          if (d.remaining != null) { S.remaining = d.remaining; updateLeft(); }
          S.step = 'loading';
          render();
          poll(d.jobId, Date.now());
          return;
        }
        if (d.code === 'selfie_expired') {
          // Hub copy gone: check the kept photo again, then try once more.
          var data = S.thumb;
          S.selfieId = null; clearKept();
          if (data && retried !== true) {
            checkData(data, true).then(function (ok) { if (ok) submit(true); });
            return;
          }
          S.thumb = null; S.check = null; renderForm();
        }
        if (d.code === 'limit' || d.code === 'busy') { S.blocked = d.message; if (d.code === 'limit') { S.remaining = 0; updateLeft(); } }
        renderFoot(d.message || '');
      })
      .catch(function () { S.busy = false; renderFoot(D.lang === 'fr' ? 'Erreur réseau. Veuillez réessayer.' : 'Network error. Please try again.'); });
  }

  function poll(jobId, t0) {
    S.pollTimer = setTimeout(function () {
      if (S.step !== 'loading') return;
      api('GET', '/jobs/' + encodeURIComponent(jobId)).then(function (d) {
        if (S.step !== 'loading') return;
        if (d.status === 'running') {
          if (Date.now() - t0 > 6 * 60 * 1000) return fail(null);
          return poll(jobId, t0);
        }
        if (d.status === 'done' && d.image) { S.image = d.image; S.step = 'result'; render(); return; }
        fail(d.message);
      }).catch(function () {
        if (Date.now() - t0 > 6 * 60 * 1000) fail(null); else poll(jobId, t0);
      });
    }, 3000);
  }
  function fail(message) {
    S.step = 'form';
    render();
    renderFoot(message || (D.lang === 'fr' ? "Désolé, nous n'avons pas pu créer votre image. Veuillez réessayer." : 'Sorry, we could not create your try-on image. Please try again.'));
    refreshStatus();
  }

  // ─── Save ───────────────────────────────────────────────────────────────────
  function save() {
    track('image_downloaded', { color_name: S.color });
    var name = 'hera-try-on.jpg';
    try {
      var parts = S.image.split(',');
      var mime = (parts[0].match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
      var bin = atob(parts[1]);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      var blob = new Blob([arr], { type: mime });
      var file = new File([blob], name, { type: mime });
      // Phones: share sheet -> "Save Image" puts it in the photo library.
      if (navigator.canShare && navigator.canShare({ files: [file] }) && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
        navigator.share({ files: [file] }).catch(function () {});
        return;
      }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) {
      window.open(S.image, '_blank');
    }
  }

  // ─── Start ──────────────────────────────────────────────────────────────────
  function start() {
    var tries = 0;
    (function tryPlace() {
      if (placeIcon() || ++tries > 20) return;
      setTimeout(tryPlace, 300);
    })();
    // Back from the login page -> open the window by itself.
    try {
      if (D.loggedIn && sessionStorage.getItem(PENDING_KEY) === String(D.productId)) {
        sessionStorage.removeItem(PENDING_KEY);
        track('login_completed');
        open();
      }
    } catch (e) { /* ignore */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
