// Owner-provided code remains intact. Only its admission is session-capped.
(() => {
  const slot = document.querySelector('[data-popunder]');
  if (!(slot instanceof HTMLElement) || document.body.dataset.pageType !== 'detail') return;
  const capped = () => {
    try { return /(?:^|;\s*)pop_shown=/.test(document.cookie); }
    catch { return true; }
  };
  if (capped()) return;
  const inject = async () => {
    const template = document.createElement('template');
    template.innerHTML = slot.dataset.code || '';
    // Dynamically inserted HTML scripts are inert; recreate their original
    // attributes and text without rewriting the supplied script body.
    const append = async (source, target) => {
      if (source instanceof HTMLScriptElement) {
        const script = document.createElement('script');
        for (const attribute of source.attributes) script.setAttribute(attribute.name, attribute.value);
        script.textContent = source.textContent;
        const blocking = !!script.src && !source.hasAttribute('async');
        if (blocking) script.async = false;
        const loaded = blocking ? new Promise(resolve => { script.onload = resolve; script.onerror = resolve; }) : undefined;
        target.appendChild(script);
        if (loaded) await loaded;
      } else {
        const copy = source.cloneNode(false);
        target.appendChild(copy);
        for (const child of source.childNodes) await append(child, copy);
      }
    };
    for (const child of template.content.childNodes) await append(child, document.body);
    delete slot.dataset.code;
  };
  const onClick = event => {
    if (!event.isTrusted || event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.target.closest('[data-no-popunder], [data-interstitial], a[href^="/watch/"], a[href^="/go/"], a[target="_blank"]')) return;
    if (!event.target.closest('a,button,summary')) return;
    const claim = () => {
      if (capped()) return;
      const hours = Number(slot.dataset.capHours) || 24;
      try { document.cookie = `pop_shown=1; Path=/; Max-Age=${Math.round(hours * 3600)}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`; }
      catch { return; }
      if (!capped()) return; // Cookies blocked: do not load an uncapped code.
      document.removeEventListener('click', onClick, true);
      void inject().catch(() => {});
    };
    // Serialize claims across same-origin tabs where Web Locks is available.
    if (navigator.locks) void navigator.locks.request('screenpeek-popunder', claim);
    else claim();
  };
  document.addEventListener('click', onClick, true);
})();
