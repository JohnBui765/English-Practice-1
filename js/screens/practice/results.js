// Results after a practice session: accuracy ring, stats, missed words, and
// a one-tap "Practise mistakes" round.
import { h } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, ring, section, row, posBadge } from '../../ui/components.js';
import { pop, replace } from '../../ui/router.js';
import { speak } from '../../ui/speech.js';
import * as store from '../../data/store.js';
import { memberForms, modelIndex } from '../../core/families.js';
import { MODES, familyRoot } from './session.js';

function formatDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

// A speaker button for a results row.
function sayButton(word) {
  return h(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': `Say ${word}`,
      onClick: (e) => {
        e.stopPropagation();
        const s = store.settings();
        speak(word, { rate: s.speechRate, voiceURI: s.voiceURI });
      },
    },
    icon('speaker'),
  );
}

// A missed family: its root (or model word) and the other members' words.
// Word formation marks the members that were missed.
function familyRow(item, missed) {
  const members = item.members || [];
  const mi = modelIndex(item);
  const root = familyRoot(item);
  const pos = item.rootPos || members[mi]?.pos || '';
  const missedAt = new Set();
  for (const x of missed.members || []) {
    // By word: deleting a member since shifts the indices.
    const at = x.word != null ? members.findIndex((m) => m.word === x.word) : x.member;
    if (at >= 0) missedAt.add(at);
  }
  const words = [];
  members.forEach((m, i) => {
    const form = memberForms(m)[0];
    if (!form || (i === mi && !missedAt.has(i))) return;
    if (words.length) words.push(' · ');
    words.push(missedAt.has(i) ? h('strong', { class: 'res-missed-form' }, form) : form);
  });
  return row({
    title: h('span', { class: 'stack-h wrap' }, h('strong', { lang: 'en' }, root), posBadge(pos)),
    subtitle: words.length ? h('span', { lang: 'en' }, words) : null,
    accessory: root ? sayButton(root) : 'none',
  });
}

function headline(acc) {
  if (acc === 100) return { title: 'Perfect!', tone: 'var(--green)' };
  if (acc >= 80) return { title: 'Great work!', tone: 'var(--green)' };
  if (acc >= 50) return { title: 'Good effort', tone: 'var(--orange)' };
  return { title: 'Keep going', tone: 'var(--red)' };
}

export default async function create(params) {
  const summary = params.summary || { total: 0, right: 0, hinted: 0, wrong: 0, accuracy: 0, missed: [], mode: 'review', durationMs: 0 };
  const mode = MODES[summary.mode] || MODES.review;
  const isScored = summary.mode === 'family' || summary.mode === 'dictation';
  // Word families, Word formation and Dictation do not schedule reviews.
  const usesReview = !['family', 'formation', 'dictation'].includes(summary.mode);
  const pct = isScored ? summary.score ?? summary.accuracy : summary.accuracy;
  // The ring's colour and the headline follow the number it shows.
  const head = headline(pct);

  const r = ring({ fraction: 0, size: 148, stroke: 12, label: `${pct}%`, color: head.tone, labelSize: 36 });
  requestAnimationFrame(() => r.set(pct / 100));

  const stat = (value, label, color) =>
    h('div', { class: 'res-stat' }, h('div', { class: 'res-stat-value tabular', style: { color } }, String(value)), h('div', { class: 'res-stat-label' }, label));

  // Missed words with their meanings.
  const missedRows = [];
  const listCache = new Map();
  for (const m of summary.missed || []) {
    if (!listCache.has(m.listId)) listCache.set(m.listId, await store.getList(m.listId));
    const list = listCache.get(m.listId);
    const item = list?.items.find((i) => i.id === m.itemId);
    if (!item) continue;
    if (list.kind === 'vocab') {
      missedRows.push(
        row({
          title: h('span', { class: 'stack-h wrap' }, h('strong', null, item.word), item.ipa ? h('span', { class: 'ipa' }, `/${item.ipa}/`) : null, posBadge(item.pos)),
          subtitle: item.senses.join(' · '),
          accessory: sayButton(item.word),
        }),
      );
    } else if (list.kind === 'family') {
      missedRows.push(familyRow(item, m));
    } else {
      missedRows.push(row({ title: item.text.length > 90 ? item.text.slice(0, 90) + '…' : item.text }));
    }
  }

  const practiseMistakes = () => {
    if (summary.mode === 'review') return replace('practice', { mode: 'review', missed: summary.missed });
    const params = { listId: summary.listId, mode: summary.mode, itemIds: summary.missed.map((m) => m.itemId) };
    // Word formation: only the members that were missed, not whole families.
    const members = summary.missed.flatMap((m) => (m.members || []).filter((x) => x.word != null).map((x) => ({ itemId: m.itemId, word: x.word })));
    if (summary.mode === 'formation' && members.length) params.members = members;
    return replace('practice', params);
  };

  const body = h(
    'div',
    { class: 'results' },
    h('div', { class: 'res-hero' }, r.el, h('h1', { class: 'res-title' }, head.title), h('p', { class: 'res-sub' }, [...new Set([summary.title, mode.label].filter(Boolean))].join(' · '))),
    h(
      'div',
      { class: 'res-stats' },
      stat(summary.right + summary.hinted, 'Correct', 'var(--green-text)'),
      stat(summary.wrong, summary.wrong === 1 ? 'Mistake' : 'Mistakes', summary.wrong ? 'var(--red-text)' : 'var(--label-2)'),
      stat(formatDuration(summary.durationMs), 'Time', 'var(--label)'),
    ),
    summary.hinted ? h('p', { class: 'res-note' }, usesReview ? `${summary.hinted} answered with a hint — they'll come back a little sooner.` : `${summary.hinted} answered with a hint.`) : null,
    missedRows.length ? section({ header: 'To review', children: missedRows }) : null,
  );

  const done = button({ label: 'Done', variant: missedRows.length ? 'secondary' : 'primary', size: 'large', block: true, onTap: () => pop() });
  const again = missedRows.length ? button({ label: 'Practise mistakes', icon: 'refresh', size: 'large', block: true, onTap: practiseMistakes }) : null;

  const el = h(
    'section',
    { class: 'screen results-screen' },
    h('div', { class: 'scroll' }, h('div', { class: 'scroll-inner' }, body)),
    h('div', { class: 'footer' }, h('div', { class: 'footer-row stacked' }, again, done)),
  );

  return { el, title: 'Results', swipeBack: false };
}
