export {};
const input = document.querySelector<HTMLInputElement>('#search');
const form = input?.form;
const panel = form?.querySelector<HTMLElement>('[data-search-panel]');
const list = form?.querySelector<HTMLUListElement>('#search-suggestions');
const status = form?.querySelector<HTMLElement>('[data-search-status]');
const all = form?.querySelector<HTMLAnchorElement>('[data-search-all]');

if (input && form && panel && list && status && all) {
  let timer: number | undefined, controller: AbortController | undefined;
  let generation = 0, active = -1;
  let rows: HTMLLIElement[] = [];
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, name: string, text?: string) => {
    const element = document.createElement(tag);
    element.className = name;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const hide = () => {
    panel.hidden = true; active = -1;
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
    rows.forEach(row => row.setAttribute('aria-selected', 'false'));
  };
  const close = () => { clearTimeout(timer); controller?.abort(); generation++; hide(); };
  const show = () => { panel.hidden = false; input.setAttribute('aria-expanded', 'true'); };

  input.addEventListener('input', () => {
    clearTimeout(timer); controller?.abort();
    const run = ++generation, query = input.value.trim();
    hide(); rows = []; list.replaceChildren();
    if (query.length < 2 || query.length > 100) return;
    timer = window.setTimeout(async () => {
      const request = new AbortController(); controller = request;
      try {
        const response = await fetch(`/api/search/?q=${encodeURIComponent(query)}`, { signal: request.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Suggestions unavailable');
        const body = await response.json() as { results?: unknown };
        if (run !== generation || document.activeElement !== input) return;
        const results = Array.isArray(body.results) ? body.results.slice(0, 8) : [];
        for (const item of results) {
          if (!item || typeof item !== 'object') continue;
          const value = item as Record<string, unknown>;
          if ((value.type !== 'movie' && value.type !== 'tv') || typeof value.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug) || typeof value.title !== 'string') continue;
          const row = node('li', ''); row.id = `search-option-${rows.length}`;
          row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false');
          const link = node('a', 'search-suggestion'); link.href = `/${value.type === 'movie' ? 'movie' : 'tv'}/${encodeURIComponent(value.slug)}/`; link.tabIndex = -1;
          let poster: URL | undefined;
          try { if (typeof value.poster === 'string') { const url = new URL(value.poster); if (url.protocol === 'https:' && !url.username && !url.password) poster = url; } } catch { /* Use the empty thumbnail. */ }
          const thumbnail = poster ? node('img', 'search-thumb') : node('span', 'search-thumb');
          if (thumbnail instanceof HTMLImageElement && poster) {
            thumbnail.src = poster.href; thumbnail.width = 32; thumbnail.height = 48; thumbnail.alt = ''; thumbnail.loading = 'lazy'; thumbnail.decoding = 'async';
            thumbnail.addEventListener('error', () => thumbnail.replaceWith(node('span', 'search-thumb')), { once: true });
          }
          const copy = node('span', 'suggestion-copy');
          copy.appendChild(node('strong', '', value.title));
          copy.appendChild(node('small', '', `${typeof value.year === 'number' && Number.isInteger(value.year) ? value.year : 'Year TBA'} · ${value.type === 'movie' ? 'Movie' : 'TV'}`));
          link.appendChild(thumbnail); link.appendChild(copy); row.appendChild(link); rows.push(row);
        }
        list.replaceChildren(...rows);
        status.textContent = rows.length ? `${rows.length} suggestions` : 'No suggestions. See all results below.';
      } catch {
        if (run !== generation || request.signal.aborted) return;
        status.textContent = 'Suggestions are unavailable. Press Enter to search.';
      }
      all.href = `/search/?q=${encodeURIComponent(query)}`;
      show();
    }, 200);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && rows.length) {
      event.preventDefault(); show();
      active = (active + (event.key === 'ArrowDown' ? 1 : active < 0 ? 0 : -1) + rows.length) % rows.length;
      rows.forEach((row, index) => row.setAttribute('aria-selected', String(index === active)));
      input.setAttribute('aria-activedescendant', rows[active].id); rows[active].scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && !panel.hidden && active >= 0) {
      event.preventDefault(); const link = rows[active].querySelector('a'); if (link) window.location.assign(link.href);
    }
  });
  form.addEventListener('focusout', event => { if (!form.contains(event.relatedTarget as Node | null)) close(); });
  document.addEventListener('pointerdown', event => { if (!form.contains(event.target as Node)) close(); });
}
