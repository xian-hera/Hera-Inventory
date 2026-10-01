/* Hera Swatch — Phase 0 test script (2026-10-01).
   Prints the probe written by blocks/swatch-embed.liquid to the console.
   Changes nothing on the page. Replaced by the real picker in Phase 3. */
(function () {
  var el = document.getElementById('hera-swatch-probe');
  if (!el) return;
  var data;
  try {
    data = JSON.parse(el.textContent);
  } catch (e) {
    console.warn('[Hera Swatch] probe JSON could not be read', e);
    return;
  }
  function run() {
    var all = document.querySelectorAll('variant-selects');
    data.variantSelectsOnPage = all.length;
    data.radiosInFirstPicker = all.length ? all[0].querySelectorAll('input[type=radio]').length : 0;
    console.log('[Hera Swatch] phase 0 probe', data);
    if (data.testFileUrl) {
      fetch(data.testFileUrl, { method: 'HEAD' })
        .then(function (r) { console.log('[Hera Swatch] file_url test', data.testFileUrl, 'HTTP ' + r.status); })
        .catch(function (e) { console.warn('[Hera Swatch] file_url test failed', e); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
