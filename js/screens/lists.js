// Lists tab: every saved list (most recently updated first) with an iOS
// search field that matches titles, sources and the words inside each list.
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { screen, section, row, badge, emptyState } from '../ui/components.js';
import { push } from '../ui/router.js';
import * as store from '../data/store.js';
import { isDue } from '../core/srs.js';
import { debounce, plural } from '../core/util.js';
import { stripAccents } from '../core/text.js';

export const KIND_STYLE = {
  vocab: { icon: 'books', bg: 'var(--accent)' },
  family: { icon: 'family', bg: 'var(--teal)' },
  passage: { icon: 'headphones', bg: 'var(--pink)' },
};

const SEARCH_DELAY = 200;
const HINT_MAX = 28;

// Lowercase, accent-free, single-spaced: "Nơi  Lưu" → "noi luu".
const fold = (s) => stripAccents(String(s ?? '').toLowerCase()).replace(/\s+/g, ' ').trim();

const openImport = () => push('import', {}, { modal: true });

export function countLabel(list) {
  const items = list.items || [];
  if (list.kind === 'family') return plural(items.length, 'family', 'families');
  if (list.kind === 'passage') return plural(items.length, 'passage');
  const s = (list.sentences || []).length;
  return s ? `${plural(items.length, 'word')} · ${plural(s, 'sentence')}` : plural(items.length, 'word');
}

function itemWords(list) {
  const items = list.items || [];
  // The pasted root too: a family still waiting for Claude has no members yet.
  if (list.kind === 'family') return items.flatMap((f) => [f.root || '', ...(f.members || []).map((m) => m.word || '')].filter(Boolean));
  if (list.kind === 'passage') return items.map((p) => p.text || '');
  return items.map((i) => i.word || '');
}

// Orange "4 due" when practised words are due, "New" when never practised.
function statusOf(list, progress, now) {
  let due = 0;
  let seen = 0;
  if (list.kind === 'vocab') {
    for (const item of list.items || []) {
      const p = progress.get(item.id);
      if (!p) continue;
      seen++;
      if (isDue(p, now)) due++;
    }
  }
  if (due) return { text: `${due} due`, tone: 'orange' };
  if (!list.lastPracticedAt && !seen) return { text: 'New', tone: 'accent' };
  return null;
}

function makeEntry(list, progress, now) {
  const words = itemWords(list);
  return {
    list,
    head: fold(`${list.title || ''}\n${list.source || ''}`),
    words,
    folded: words.map(fold),
    status: statusOf(list, progress, now),
  };
}

// Returns null when the entry does not match, else { hint } — the word that
// matched when the title/source did not.
function match(entry, tokens) {
  if (!tokens.length) return { hint: null };
  if (tokens.every((t) => entry.head.includes(t))) return { hint: null };
  const all = `${entry.head}\n${entry.folded.join('\n')}`;
  if (!tokens.every((t) => all.includes(t))) return null;
  if (entry.list.kind === 'passage') return { hint: null };
  const i = entry.folded.findIndex((w) => tokens.every((t) => w.includes(t)));
  const word = i >= 0 ? entry.words[i] : null;
  return { hint: word && word.length > HINT_MAX ? `${word.slice(0, HINT_MAX - 1)}…` : word };
}

export default async function create() {
  let entries = [];
  let query = '';
  let visible = true;
  let dirty = false;
  let destroyed = false;
  const rowCache = new Map(); // list id -> { sig, el }

  /* ---------- search field ---------- */

  const input = h('input', {
    type: 'search',
    class: 'lists-search-input',
    placeholder: 'Search',
    'aria-label': 'Search lists and words',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    onInput: () => {
      searchEl.classList.toggle('has-text', input.value !== '');
      runSearch();
    },
    onKeydown: (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape' && input.value) {
        e.stopPropagation();
        clearSearch();
      }
    },
  });
  const clearBtn = h(
    'button',
    {
      type: 'button',
      class: 'lists-clear',
      'aria-label': 'Clear search',
      tabindex: '-1',
      // Keep the keyboard up, like iOS.
      onPointerdown: (e) => e.preventDefault(),
      onMousedown: (e) => e.preventDefault(),
      onClick: () => {
        clearSearch();
        input.focus();
      },
    },
    h('span', { class: 'lists-clear-dot' }, icon('close')),
  );
  const searchEl = h(
    'div',
    { class: 'lists-search', role: 'search' },
    h('label', { class: 'lists-search-field' }, icon('search'), input),
    clearBtn,
  );

  /* ---------- list ---------- */

  const listSection = section({ className: 'lists-section', children: [] });
  const group = listSection.querySelector('.group');
  const countEl = h('div', { class: 'section-footer lists-count' });
  listSection.appendChild(countEl);
  const noResultsText = h('div', { class: 'lists-noresults-text' });
  const noResults = h('div', { class: 'lists-noresults', hidden: true }, h('div', { class: 'lists-noresults-title' }, 'No Results'), noResultsText);
  const empty = emptyState({
    icon: 'books',
    title: 'No lists yet',
    message: 'Paste a vocabulary list from your notes to get started.',
    action: { label: 'Paste a list', icon: 'clipboard', onTap: openImport },
  });
  empty.classList.add('lists-empty');

  const s = screen({
    title: 'Lists',
    tab: 'lists',
    className: 'lists-screen',
    actions: [{ icon: 'plus', ariaLabel: 'New list', onTap: openImport }],
    body: [searchEl, listSection, noResults, empty],
  });

  function rowFor(entry, hint) {
    const { list, status } = entry;
    const style = KIND_STYLE[list.kind] || KIND_STYLE.vocab;
    const title = list.title || 'Untitled list';
    const subtitle = countLabel(list);
    // The source gets its own line so it is never cut down to "f…".
    const source = !hint && list.source ? list.source : '';
    const sig = `${list.kind}|${title}|${subtitle}|${source}|${hint || ''}|${status ? status.text : ''}`;
    const cached = rowCache.get(list.id);
    if (cached && cached.sig === sig) return cached.el;
    const trail = h(
      'span',
      { class: 'lists-trail' },
      status ? badge(status.text, status.tone) : null,
      h('span', { class: 'row-chevron' }, icon('chevronRight')),
    );
    const el = row({
      icon: style.icon,
      iconBg: style.bg,
      title,
      // The matching word comes first so it is never cut off.
      subtitle: hint
        ? h('span', null, h('span', { class: 'lists-hit' }, `“${hint}”`), ` · ${subtitle}`)
        : source
          ? h('span', null, subtitle, h('span', { class: 'lists-source' }, `from ${source}`))
          : subtitle,
      accessory: trail,
      className: 'lists-row',
      onTap: () => push('list', { listId: list.id }),
    });
    rowCache.set(list.id, { sig, el });
    return el;
  }

  function render() {
    const hasLists = entries.length > 0;
    empty.hidden = hasLists;
    searchEl.hidden = !hasLists;
    if (!hasLists) {
      listSection.hidden = true;
      noResults.hidden = true;
      group.replaceChildren();
      return;
    }
    const tokens = fold(query).split(' ').filter(Boolean);
    const rows = [];
    for (const entry of entries) {
      const m = match(entry, tokens);
      if (m) rows.push(rowFor(entry, m.hint));
    }
    // Re-attaching cached nodes is cheap and keeps the separators right.
    group.replaceChildren(...rows);
    listSection.hidden = rows.length === 0;
    noResults.hidden = rows.length > 0;
    if (!rows.length) noResultsText.textContent = `Nothing matches “${query.trim()}”. Check the spelling or try another word.`;
    countEl.textContent = tokens.length ? `${rows.length} of ${plural(entries.length, 'list')}` : plural(entries.length, 'list');
  }

  async function load() {
    const [lists, progress] = await Promise.all([store.getLists(), store.getProgress()]);
    if (destroyed) return;
    const now = Date.now();
    entries = lists.map((l) => makeEntry(l, progress, now));
    const ids = new Set(lists.map((l) => l.id));
    for (const id of rowCache.keys()) if (!ids.has(id)) rowCache.delete(id);
    dirty = false;
    render();
  }

  const runSearch = debounce(() => {
    query = input.value;
    render();
  }, SEARCH_DELAY);

  function clearSearch() {
    input.value = '';
    query = '';
    searchEl.classList.remove('has-text');
    render();
  }

  // Dismiss the keyboard when the user starts scrolling the results (iOS).
  let touchY = null;
  s.scroll.addEventListener('touchstart', (e) => (touchY = e.touches[0].clientY), { passive: true });
  s.scroll.addEventListener(
    'touchmove',
    (e) => {
      if (touchY !== null && document.activeElement === input && Math.abs(e.touches[0].clientY - touchY) > 12) input.blur();
    },
    { passive: true },
  );

  const scheduleLoad = debounce(() => {
    if (destroyed) return;
    if (visible) load();
    else dirty = true;
  }, 120);
  const unsubscribe = store.onChange(({ store: name }) => {
    if (name === 'lists' || name === 'progress' || name === 'all') scheduleLoad();
  });
  const onVisibility = () => {
    if (document.visibilityState === 'visible' && visible) load();
  };
  document.addEventListener('visibilitychange', onVisibility);

  try {
    await load();
  } catch (err) {
    console.error(err);
    render();
  }

  return {
    el: s.el,
    title: 'Lists',
    onShow(opts = {}) {
      visible = true;
      if (!opts.first || dirty) load();
    },
    onHide() {
      visible = false;
    },
    onDestroy() {
      destroyed = true;
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
