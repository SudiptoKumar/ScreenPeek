export {};
interface Entry { id: number; type: 'movie' | 'tv'; slug: string; title: string; year: string; poster: string; }
const savedKey = 'screenpeek:mylist';
const historyKey = 'screenpeek:history';
const valid = (value: unknown): value is Entry => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Entry;
  return Number.isSafeInteger(item.id) && item.id !== 0 && ['movie', 'tv'].includes(item.type) &&
    typeof item.slug === 'string' && /^[a-z0-9][a-z0-9-]{0,199}$/.test(item.slug) &&
    typeof item.title === 'string' && item.title.length > 0 && item.title.length <= 250 &&
    typeof item.year === 'string' && /^(?:\d{4})?$/.test(item.year) && typeof item.poster === 'string';
};
const keyFor = (item: Entry) => `${item.type}:${item.id}`;
const read = (key: string): Entry[] => {
  const value: unknown = JSON.parse(localStorage.getItem(key) || '[]');
  return Array.isArray(value) ? [...new Map(value.filter(valid).map(item => [keyFor(item), item])).values()].slice(0, 200) : [];
};
const fromElement = (element: HTMLElement): Entry | null => {
  const data = element.dataset;
  const item = { id: Number(data.titleId), type: data.titleType, slug: data.slug, title: data.title, year: data.year || '', poster: data.poster || '' };
  return valid(item) ? item : null;
};
const buttons = () => document.querySelectorAll<HTMLButtonElement>('[data-mylist-toggle]');
const status = document.querySelector<HTMLElement>('[data-library-status]');
const message = (text: string) => { if (status) status.textContent = text; };
let saved: Entry[] = [], history: Entry[] = [];
const update = () => buttons().forEach(button => {
  const item = fromElement(button);
  if (!item) return;
  const active = saved.some(value => keyFor(value) === keyFor(item));
  button.disabled = false;
  button.setAttribute('aria-pressed', String(active));
  button.textContent = active ? '✓ My List' : '+ My List';
});
function render() {
  const root = document.querySelector<HTMLElement>('[data-library-page]');
  if (!root) return;
  const url = new URL(location.href);
  const make = (tag: string, text = '', className = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  for (const [name, items] of [['saved', saved], ['history', history]] as const) {
    const target = root.querySelector<HTMLElement>(`[data-library-${name}]`)!;
    target.replaceChildren();
    if (!items.length) { target.appendChild(make('p', name === 'saved' ? 'Your list is empty. Save a title while browsing.' : 'Titles you open will appear here.', 'quiet-empty')); continue; }
    const pages = Math.ceil(items.length / 24);
    const page = Math.min(pages, Math.max(1, Number.parseInt(url.searchParams.get(name) || '1') || 1));
    const grid = make('div', '', name === 'saved' ? 'poster-grid' : 'history-list');
    for (const item of items.slice((page - 1) * 24, page * 24)) {
      const wrapper = make('div', '', 'poster-item');
      const link = document.createElement('a');
      link.href = `/${item.type === 'movie' ? 'movie' : 'tv'}/${encodeURIComponent(item.slug)}/`;
      link.className = name === 'saved' ? 'poster-card' : 'history-title';
      if (name === 'saved') link.dataset.posterCard = '';
      if (name === 'saved') {
        const frame = make('div', '', 'poster-frame');
        let poster: URL | undefined;
        try {
          const base = new URL(root.dataset.mediaBase || '');
          const candidate = new URL(item.poster);
          if (candidate.protocol === 'https:' && !candidate.username && !candidate.password && candidate.origin === base.origin && candidate.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/')) poster = candidate;
        } catch { /* Missing or edited local image data uses a placeholder. */ }
        if (poster) {
          const image = document.createElement('img'); image.src = poster.href; image.width = 185; image.height = 278; image.loading = 'lazy'; image.alt = `${item.title} poster`; frame.appendChild(image);
        } else frame.appendChild(make('div', 'Poster unavailable', 'poster-placeholder'));
        link.appendChild(frame);
      }
      link.appendChild(make('h3', item.title, 'poster-title')); link.appendChild(make('p', `${item.year || 'Year TBA'} · ${item.type === 'movie' ? 'Movie' : 'TV'}`, 'poster-meta'));
      wrapper.appendChild(link);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'library-remove'; remove.textContent = name === 'saved' ? 'Remove' : 'Remove from history';
      remove.addEventListener('click', () => {
        try {
          const next = (name === 'saved' ? read(savedKey) : read(historyKey)).filter(value => keyFor(value) !== keyFor(item));
          localStorage.setItem(name === 'saved' ? savedKey : historyKey, JSON.stringify(next));
          if (name === 'saved') saved = next; else history = next;
          render(); update();
        } catch { message('Browser storage is unavailable. Your changes could not be saved.'); }
      });
      wrapper.appendChild(remove); grid.appendChild(wrapper);
    }
    target.appendChild(grid);
    if (pages > 1) {
      const nav = make('nav', '', 'pagination'); nav.setAttribute('aria-label', `${name} pages`);
      for (let number = 1; number <= pages; number++) {
        const next = new URL(location.href); next.searchParams.set(name, String(number));
        const link = document.createElement('a'); link.href = next.pathname + next.search; link.textContent = String(number);
        if (number === page) link.setAttribute('aria-current', 'page'); nav.appendChild(link);
      }
      target.appendChild(nav);
    }
  }
}
try {
  // Parse each key separately so corrupted data doesn't erase another list.
  try { saved = read(savedKey); } catch { message('Saved-list data could not be read. Clear this site’s saved data in your browser to reset it.'); }
  try { history = read(historyKey); } catch { message('Viewing history could not be read.'); }
  localStorage.setItem('screenpeek:storage-check', '1'); localStorage.removeItem('screenpeek:storage-check');
  const current = document.querySelector<HTMLElement>('[data-title-record]');
  const entry = current && fromElement(current);
  if (entry) { history = [entry, ...history.filter(item => keyFor(item) !== keyFor(entry))].slice(0, 50); localStorage.setItem(historyKey, JSON.stringify(history)); }
  update(); render();
  buttons().forEach(button => button.addEventListener('click', () => {
    const item = fromElement(button); if (!item) return;
    try {
      // Re-read to retain changes made in another tab.
      saved = read(savedKey);
      const found = saved.some(value => keyFor(value) === keyFor(item));
      if (!found && saved.length >= 200) { message('Your list holds up to 200 titles. Remove one to make space.'); return; }
      saved = found ? saved.filter(value => keyFor(value) !== keyFor(item)) : [item, ...saved];
      localStorage.setItem(savedKey, JSON.stringify(saved)); update(); message(found ? 'Removed from My List.' : 'Saved to My List on this browser.');
    } catch { message('Browser storage is unavailable. Your changes could not be saved.'); }
  }));
  window.addEventListener('storage', event => {
    if (event.key !== savedKey && event.key !== historyKey && event.key !== null) return;
    try { saved = read(savedKey); history = read(historyKey); update(); render(); } catch { message('Browser storage could not be read.'); }
  });
} catch { message('Enable browser storage to use My List and viewing history.'); }
