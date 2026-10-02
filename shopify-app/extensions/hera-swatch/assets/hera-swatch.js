/* Hera Swatch — storefront colour picker (Phase 3 + 4, 2026-10-01).
   Spec: claude/SWATCH_FEATURE_SPEC.md §6. Data: #hera-swatch-data (blocks/swatch-embed.liquid).
   - Only the colour option is ours; other options stay with the theme / Swatch King.
   - Selecting = check the theme's own radio + bubbling "change" (theme updates
     price, images, URL, cart; Swatch King follows the theme's radios).
   - Hierarchical availability; hidden variants (sold out + discontinued) are
     left out; sold-out colours go last (not re-sorted when a colour is clicked).
   - Click a colour: selected + dark overlay with the magnifier; click it again:
     large image window (browse only, does not change the selection). */
(function () {
  var dataEl = document.getElementById('hera-swatch-data');
  if (!dataEl) return;
  var D;
  try { D = JSON.parse(dataEl.textContent); } catch (e) { console.warn('[Hera Swatch] bad data', e); return; }
  if (D.debug) console.log('[Hera Swatch] data', D);
  var N = D.optionIndex;
  var VALUES = D.values;
  var wrap, list, label, modal, order = null, orderCtx = null, armed = null, modalIdx = 0, modalList = [];

  function scope() { return document.querySelector(D.scope) || document; }
  function nativePicker() { return scope().querySelector(D.selector) || document.querySelector(D.selector); }
  function skEl() { var s = scope(); for (var i = 0; i < (D.skSelectors || []).length; i++) { var e = s.querySelector(D.skSelectors[i]); if (e) return e; } return null; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sized(url, w) { return url ? url + (url.indexOf('?') >= 0 ? '&' : '?') + 'width=' + w : ''; }

  // Current value of every option, read from the theme's radios (or selects).
  function selected() {
    var out = [], vs = nativePicker();
    if (vs) {
      var fs = vs.querySelectorAll('fieldset');
      for (var i = 0; i < fs.length; i++) { var r = fs[i].querySelector('input[type=radio]:checked'); out[i] = r ? r.value : null; }
      var sl = vs.querySelectorAll('select');
      for (var j = 0; j < sl.length; j++) if (out[j] == null) out[j] = sl[j].value;
    }
    var id = new URLSearchParams(location.search).get('variant');
    var cur = null;
    for (var k = 0; k < D.variants.length; k++) if (String(D.variants[k].id) === id) cur = D.variants[k];
    if (!cur) for (var m = 0; m < D.variants.length; m++) if (D.variants[m].id === D.current) cur = D.variants[m];
    if (cur) for (var n = 0; n < cur.o.length; n++) if (out[n] == null) out[n] = cur.o[n];
    return out;
  }

  // For each colour under the options chosen before it: visible? available?
  function stateOf(sel) {
    var st = {};
    VALUES.forEach(function (x) { st[x.v] = { vis: false, av: false }; });
    D.variants.forEach(function (vr) {
      if (vr.h) return;
      for (var j = 0; j < N; j++) if (vr.o[j] !== sel[j]) return;
      var s = st[vr.o[N]];
      if (!s) return;
      s.vis = true;
      if (vr.a) s.av = true;
    });
    return st;
  }

  function choose(value) {
    var vs = nativePicker();
    if (!vs) return;
    var fs = vs.querySelectorAll('fieldset')[N];
    var radios = fs ? fs.querySelectorAll('input[type=radio]') : [];
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].value === value) {
        radios[i].checked = true;
        radios[i].dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }
    var s = vs.querySelectorAll('select')[N];
    if (s) { s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })); }
  }

  function magnifier() {
    if (D.magnifierUrl) return '<img src="' + esc(D.magnifierUrl) + '" alt="">';
    if (D.magnifierSvg && /^\s*<svg[\s>]/i.test(D.magnifierSvg)) return D.magnifierSvg;
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6.5" fill="none" stroke="#fff" stroke-width="2"/><path d="M15 15l5.5 5.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>';
  }

  function render() {
    var sel = selected();
    var st = stateOf(sel);
    var ctx = JSON.stringify(sel.slice(0, N));
    // Re-sort only when an earlier option changed (not when a colour is clicked).
    if (order === null || ctx !== orderCtx) {
      var vis = VALUES.filter(function (x) { return st[x.v].vis; });
      order = vis.filter(function (x) { return st[x.v].av; }).concat(vis.filter(function (x) { return !st[x.v].av; }));
      orderCtx = ctx;
    }
    var shown = order.filter(function (x) { return st[x.v].vis; });
    var cur = sel[N];
    // Current colour hidden under this choice -> first visible, in stock first.
    if (shown.length && !(st[cur] && st[cur].vis)) {
      var pick = shown.filter(function (x) { return st[x.v].av; })[0] || shown[0];
      choose(pick.v);
      return;
    }
    // Swatch King style: "Color : #2", normal weight.
    label.textContent = D.optionName + ' : ' + (cur || '');
    list.innerHTML = shown.map(function (x) {
      var cls = 'hs-card' + (x.v === cur ? ' is-sel' : '') + (st[x.v].av ? '' : ' is-so') + (x.v === cur && armed === cur ? ' is-armed' : '');
      var bg = x.img ? 'background-image:url(&quot;' + esc(sized(x.img, 200)) + '&quot;);' + (x.pos ? 'background-position:' + esc(x.pos) + ';' : '') : '';
      // A div (not <button>) so the theme's button styles don't apply; keyboard via onKey.
      return '<div role="button" tabindex="0" class="' + cls + '" data-v="' + esc(x.v) + '" aria-pressed="' + (x.v === cur) + '" aria-label="' + esc(x.v) + '">' +
        '<span class="hs-img" style="' + bg + '"><span class="hs-so">' + esc(D.soldOut) + '</span><span class="hs-zoom">' + magnifier() + '</span></span>' +
        '<span class="hs-name">' + esc(x.v) + '</span></div>';
    }).join('');
    modalList = shown;
  }

  function onClick(e) {
    var b = e.target.closest('.hs-card');
    if (!b) return;
    var v = b.getAttribute('data-v');
    var cur = selected()[N];
    if (v === cur && armed === v) { openModal(v); return; }
    armed = v;
    if (v === cur) render(); else choose(v);
  }

  function onKey(e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.hs-card')) { e.preventDefault(); onClick(e); }
  }

  // ── Large image window ────────────────────────────────────────────────────
  function buildModal() {
    modal = document.createElement('div');
    modal.className = 'hs-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    var arrow = function (d) { return '<svg viewBox="0 0 22 44" aria-hidden="true"><path d="' + (d < 0 ? 'M18 3L4 22l14 19' : 'M4 3l14 19L4 41') + '" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; };
    modal.innerHTML = '<div class="hs-box"><p class="hs-title"></p><div class="hs-big"></div>' +
      '<button type="button" class="hs-arrow hs-prev" aria-label="Previous">' + arrow(-1) + '</button>' +
      '<button type="button" class="hs-arrow hs-next" aria-label="Next">' + arrow(1) + '</button>' +
      '<p class="hs-note"></p></div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function (e) {
      if (e.target === modal) return closeModal();
      if (e.target.closest('.hs-prev')) step(-1);
      if (e.target.closest('.hs-next')) step(1);
    });
    var big = modal.querySelector('.hs-big'), x0 = null;
    big.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    big.addEventListener('touchend', function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
    });
    window.addEventListener('resize', function () { if (modal.classList.contains('is-open')) fitBig(); });
    document.addEventListener('keydown', function (e) {
      if (!modal.classList.contains('is-open')) return;
      if (e.key === 'Escape') closeModal();
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    });
  }
  // Size the picture area to the image's own proportions so the window hugs it
  // (Hera 2026-10-02): as tall as fits (max 625px), narrower when the image is narrow.
  var ratio = 536 / 625, sizeToken = 0;
  function fitBig() {
    if (!modal) return;
    var small = window.innerWidth <= 600;
    var padX = small ? 80 : 128;                    // left + right padding (room for the arrows)
    var maxW = Math.min(window.innerWidth - 32 - padX, 1000);
    var maxH = Math.min(625, window.innerHeight - 32 - (small ? 150 : 190)); // title + disclaimer + padding
    var h = Math.max(maxH, 120), w = h * ratio;
    if (w > maxW) { w = maxW; h = w / ratio; }
    var big = modal.querySelector('.hs-big');
    big.style.setProperty('--hs-bw', Math.round(w) + 'px');
    big.style.setProperty('--hs-bh', Math.round(h) + 'px');
  }
  function showModalItem() {
    var x = modalList[modalIdx];
    if (!x) return;
    modal.querySelector('.hs-title').textContent = x.v;
    var url = x.img ? sized(x.img, 1200) : '';
    modal.querySelector('.hs-big').style.backgroundImage = url ? 'url("' + url + '")' : 'none';
    var token = ++sizeToken;
    if (url) {
      var im = new Image();
      im.onload = function () {
        if (token !== sizeToken || !im.naturalWidth || !im.naturalHeight) return;
        ratio = im.naturalWidth / im.naturalHeight;
        fitBig();
      };
      im.src = url;
    } else {
      ratio = 536 / 625;
    }
    fitBig();
    var note = modal.querySelector('.hs-note');
    note.textContent = D.note || '';
    note.style.display = D.note ? '' : 'none';
    var many = modalList.length > 1;
    modal.querySelector('.hs-prev').style.visibility = many ? '' : 'hidden';
    modal.querySelector('.hs-next').style.visibility = many ? '' : 'hidden';
  }
  function step(d) { modalIdx = (modalIdx + d + modalList.length) % modalList.length; showModalItem(); }
  var prevOverflow = '';
  function openModal(v) {
    if (!modal) buildModal();
    modalIdx = Math.max(0, modalList.map(function (x) { return x.v; }).indexOf(v));
    showModalItem();
    prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    modal.classList.add('is-open');
  }
  function closeModal() {
    modal.classList.remove('is-open');
    document.documentElement.style.overflow = prevOverflow;
  }

  // ── Placement: where the hidden colour group was ─────────────────────────
  // Next to Swatch King's picker when it is there and shown, else next to the
  // theme picker. Outside both, because both re-render their own contents.
  function place() {
    var sk = skEl(), vs = nativePicker();
    var anchor = sk && sk.offsetParent !== null ? sk : (vs && vs.offsetParent !== null ? vs : (sk || vs));
    if (!anchor) return;
    if (N === 0) { if (wrap.nextElementSibling !== anchor) anchor.parentNode.insertBefore(wrap, anchor); }
    else if (anchor.nextElementSibling !== wrap) anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
  }

  var queued = false;
  function refresh() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; place(); render(); });
  }

  function init() {
    wrap = document.createElement('div');
    wrap.className = 'hs-wrap';
    wrap.innerHTML = '<div class="hs-label"></div><div class="hs-list" role="group"></div>';
    label = wrap.querySelector('.hs-label');
    list = wrap.querySelector('.hs-list');
    list.addEventListener('click', onClick);
    list.addEventListener('keydown', onKey);
    place();
    render();
    // The theme / Swatch King change the radios: follow them.
    document.addEventListener('change', function () { refresh(); setTimeout(refresh, 300); }, true);
    window.addEventListener('popstate', refresh);
    var target = scope();
    if (window.MutationObserver && target) {
      // Ignore our own re-renders; react to the theme / Swatch King re-rendering.
      new MutationObserver(function (ms) {
        for (var i = 0; i < ms.length; i++) if (!wrap.contains(ms[i].target) && ms[i].target !== wrap) { refresh(); return; }
      }).observe(target, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
