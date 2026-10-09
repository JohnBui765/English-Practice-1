// Today tab: what to practise now — due words, a paused session, streak,
// recent lists — and first-run onboarding.
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { screen, section, row, button, card, toast } from '../ui/components.js';
import { push, resetTo } from '../ui/router.js';
import * as store from '../data/store.js';
import { startOfDay, DAY, debounce, plural } from '../core/util.js';
import { MODES, countDue, getSnapshot, clearSnapshot, liveCards, recoverSnapshot } from './practice/session.js';

const INSTALL_DISMISSED = 'vs.installHintDismissed';

// Safari with "Block All Cookies" throws on any localStorage access.
function installDismissed() {
  try {
    return !!localStorage.getItem(INSTALL_DISMISSED);
  } catch {
    return false;
  }
}

function todayLabel() {
  return new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return navigator.standalone === true || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
}

function streakDays(history, now = Date.now()) {
  const days = new Set(history.map((e) => startOfDay(e.at)));
  let day = startOfDay(now);
  if (!days.has(day)) day = startOfDay(day - DAY / 2); // yesterday still counts
  let n = 0;
  while (days.has(day)) {
    n++;
    day = startOfDay(day - DAY / 2);
  }
  return n;
}

function relativeDay(ms, now = Date.now()) {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  if (days <= 0) return 'later today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

const KIND_ICON = {
  vocab: { icon: 'books', bg: 'var(--accent)' },
  family: { icon: 'family', bg: 'var(--teal)' },
  passage: { icon: 'headphones', bg: 'var(--pink)' },
};

function listSubtitle(list, dueCount) {
  const n = list.items.length;
  const what = list.kind === 'family' ? plural(n, 'family', 'families') : list.kind === 'passage' ? plural(n, 'passage') : plural(n, 'word');
  return dueCount ? `${what} · ${dueCount} to review` : what;
}

/* ---------- blocks ---------- */

function onboarding() {
  const step = (n, iconName, color, title, text) =>
    h(
      'div',
      { class: 'onb-step' },
      h('span', { class: 'onb-step-icon', style: { background: color } }, icon(iconName, { size: 20 })),
      h('div', { class: 'onb-step-text' }, h('div', { class: 'onb-step-title' }, `${n}. ${title}`), h('div', { class: 'onb-step-sub' }, text)),
    );
  const trySample = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const { createSampleVocabList } = await import('../data/sample.js');
      const list = await createSampleVocabList();
      toast('Sample list added');
      push('list', { listId: list.id });
    } finally {
      btn.disabled = false;
    }
  };
  return h(
    'div',
    { class: 'onboarding' },
    h('img', { class: 'onb-logo', src: 'icons/icon.svg', width: 60, height: 60, alt: '' }),
    h('h2', { class: 'onb-title' }, 'Learn words in context'),
    h('p', { class: 'onb-text' }, 'Paste the word lists you collect from books, news and podcasts, then practise them in real sentences.'),
    h(
      'div',
      { class: 'onb-steps card' },
      step(1, 'clipboard', 'var(--blue)', 'Paste your list', 'Straight from your notes — your usual format works.'),
      step(2, 'sparkles', 'var(--orange)', 'Make sentences with Claude', 'Copy a prompt, paste the reply. About a minute.'),
      step(3, 'flame', 'var(--pink)', 'Practise a little every day', 'Words you miss come back sooner.'),
    ),
    button({ label: 'Paste your first list', icon: 'clipboard', size: 'large', block: true, onTap: () => push('import', {}, { modal: true }) }),
    button({ label: 'Try a sample list', variant: 'plain', block: true, onTap: trySample }),
  );
}

function installHint(onDismiss) {
  return h(
    'div',
    { class: 'install-hint card' },
    h('span', { class: 'install-icon' }, icon('phone', { size: 22 })),
    h(
      'div',
      { class: 'install-text' },
      h('div', { class: 'install-title' }, 'Install on your iPhone'),
      h('div', { class: 'install-sub' }, 'Tap ', icon('share', { size: 15, className: 'inline-icon' }), ' Share, then Add to Home Screen. It opens full screen and works offline.'),
    ),
    h('button', { type: 'button', class: 'icon-btn install-close', 'aria-label': 'Dismiss', onClick: onDismiss }, icon('close', { size: 18 })),
  );
}

// IndexedDB could not be opened (e.g. storage full): nothing survives a relaunch.
function storageWarning() {
  return h(
    'div',
    { class: 'storage-warning card', role: 'alert' },
    h('span', { class: 'storage-warning-icon' }, icon('info', { size: 22 })),
    h(
      'div',
      { class: 'storage-warning-text' },
      h('div', { class: 'storage-warning-title' }, 'Storage is unavailable'),
      h('div', { class: 'storage-warning-sub' }, 'Lists you add will be lost when the app closes. Export a backup in Settings before closing.'),
    ),
  );
}

function resumeCard(snap) {
  const mode = MODES[snap.mode] || MODES.review;
  const done = Math.min(snap.done, snap.originalCount);
  return h(
    'div',
    { class: 'resume card' },
    h('div', { class: 'resume-head' }, h('span', { class: 'resume-icon', style: { background: mode.color } }, icon(mode.icon, { size: 20 })), h('div', { class: 'grow' }, h('div', { class: 'resume-title' }, 'Continue where you left off'), h('div', { class: 'resume-sub' }, `${snap.title ? snap.title + ' · ' : ''}${mode.label}\u00a0· ${done}\u00a0of\u00a0${snap.originalCount}`))),
    h(
      'div',
      { class: 'resume-actions' },
      button({ label: 'Discard', variant: 'secondary', onTap: () => { clearSnapshot(); refresh(); } }),
      button({ label: 'Resume', icon: 'play', onTap: () => push('practice', { resume: true }, { modal: true }) }),
    ),
  );
}

// `secondary`: a paused session's Resume is the main action, so this one is tinted.
function reviewCard({ total, due, fresh, nextDue, limit, secondary = false }) {
  if (total === 0) {
    return h(
      'div',
      { class: 'review card done' },
      h('div', { class: 'review-top' }, h('span', { class: 'review-badge green' }, icon('checkCircle', { size: 28 })), h('div', null, h('div', { class: 'review-title' }, 'All caught up'), h('div', { class: 'review-sub' }, nextDue ? `Next review ${relativeDay(nextDue)}.` : 'Add a list to start learning.'))),
      button({ label: 'Practise a list', variant: 'tinted', size: 'large', block: true, onTap: () => resetTo('lists') }),
    );
  }
  const parts = [];
  if (due) parts.push(`${due} due`);
  if (fresh) parts.push(`${fresh} new`);
  const session = Math.min(total, limit);
  return h(
    'div',
    { class: 'review card' },
    h(
      'div',
      { class: 'review-top' },
      h('span', { class: 'review-badge' }, icon('flame', { size: 28 })),
      h('div', null, h('div', { class: 'review-count tabular' }, String(total)), h('div', { class: 'review-sub' }, `${total === 1 ? 'word' : 'words'} to review · ${parts.join(' · ')}`)),
    ),
    button({ label: session < total ? `Start review · ${session} words` : 'Start review', icon: 'play', variant: secondary ? 'tinted' : 'primary', size: 'large', block: true, onTap: () => push('practice', { mode: 'review' }, { modal: true }) }),
  );
}

function statTile(iconName, color, value, label) {
  return h('div', { class: 'stat-tile' }, h('span', { class: 'stat-icon', style: { color } }, icon(iconName, { size: 20 })), h('div', { class: 'stat-value tabular' }, String(value)), h('div', { class: 'stat-label' }, label));
}

/* ---------- screen ---------- */

let refresh = () => {};

export default async function create() {
  const s = screen({ title: 'Today', subtitle: todayLabel(), tab: 'today', body: [] });
  const body = h('div', { class: 'today' });
  s.content.appendChild(body);

  let alive = true;
  let rendering = null;

  async function render() {
    const now = Date.now();
    const [lists, progress, history] = await Promise.all([store.getLists(), store.getProgress(), store.getHistory({ limit: 400 })]);
    if (!alive) return;
    s.setSubtitle(todayLabel());
    const blocks = [];

    if (!store.isPersistentStorage()) blocks.push(storageWarning());

    if (isIOS() && !isStandalone() && !installDismissed()) {
      blocks.push(
        installHint(() => {
          try {
            localStorage.setItem(INSTALL_DISMISSED, '1');
          } catch {
            /* ignore */
          }
          refresh();
        }),
      );
    }

    if (!lists.length) {
      blocks.push(onboarding());
      body.replaceChildren(...blocks);
      return;
    }

    const snap = getSnapshot();
    let resuming = false;
    if (snap) {
      // Its words may have been deleted (or its sentences replaced) since.
      resuming = liveCards(snap, new Map(lists.map((l) => [l.id, l]))).length > 0;
      if (resuming) blocks.push(resumeCard(snap));
      else recoverSnapshot().catch((err) => console.error(err));
    }

    const counts = await countDue(now, { lists, progress });
    if (!alive) return;
    // Only words still in a list count (Edit list can remove words that
    // keep their progress record).
    let nextDue = null;
    let mastered = 0;
    for (const list of lists) {
      if (list.kind !== 'vocab') continue;
      for (const item of list.items) {
        const p = progress.get(item.id);
        if (!p) continue;
        if (p.box >= 5) mastered++;
        if (p.due > now && (nextDue === null || p.due < nextDue)) nextDue = p.due;
      }
    }
    blocks.push(reviewCard({ ...counts, nextDue, limit: store.settings().reviewLimit || 20, secondary: resuming }));

    const words = lists.filter((l) => l.kind === 'vocab').reduce((n, l) => n + l.items.length, 0);
    const streak = streakDays(history, now);
    blocks.push(
      h(
        'div',
        { class: 'stat-strip' },
        statTile('flame', 'var(--orange)', streak, streak === 1 ? 'day streak' : 'day streak'),
        statTile('star', 'var(--yellow)', mastered, 'mastered'),
        statTile('books', 'var(--accent)', words, words === 1 ? 'word' : 'words'),
      ),
    );

    const recent = lists
      .slice()
      .sort((a, b) => (b.lastPracticedAt || b.updatedAt || 0) - (a.lastPracticedAt || a.updatedAt || 0))
      .slice(0, 4);
    blocks.push(
      section({
        header: 'Recent lists',
        children: [
          ...recent.map((list) => {
            const k = KIND_ICON[list.kind] || KIND_ICON.vocab;
            const due = list.kind === 'vocab' ? list.items.filter((i) => progress.get(i.id)?.due <= now).length : 0;
            return row({ icon: k.icon, iconBg: k.bg, title: list.title, subtitle: listSubtitle(list, due), onTap: () => push('list', { listId: list.id }) });
          }),
          row({ title: 'All lists', accent: true, onTap: () => resetTo('lists') }),
        ],
      }),
    );

    blocks.push(button({ label: 'Paste a new list', icon: 'plus', variant: 'tinted', size: 'large', block: true, className: 'today-add', onTap: () => push('import', {}, { modal: true }) }));
    body.replaceChildren(...blocks);
  }

  refresh = () => {
    if (!rendering) {
      rendering = render().finally(() => {
        rendering = null;
      });
    }
    return rendering;
  };
  const refreshSoon = debounce(refresh, 150);
  const unsubscribe = store.onChange(refreshSoon);
  await refresh();

  return {
    el: s.el,
    title: 'Today',
    onShow: ({ returning } = {}) => {
      if (returning) refresh();
    },
    onDestroy: () => {
      alive = false;
      unsubscribe();
    },
  };
}
