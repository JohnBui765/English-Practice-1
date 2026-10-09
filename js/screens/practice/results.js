// Results after a practice session: accuracy ring, stats, missed words, and
// a one-tap "Practise mistakes" round.
import { h } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, ring, section, row, posBadge } from '../../ui/components.js';
import { pop, replace } from '../../ui/router.js';
import { speak } from '../../ui/speech.js';
import * as store from '../../data/store.js';
import { MODES } from './session.js';

function formatDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
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
  const head = headline(summary.accuracy);
  const isScored = summary.mode === 'family' || summary.mode === 'dictation';
  const pct = isScored ? summary.score ?? summary.accuracy : summary.accuracy;

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
          accessory: h(
            'button',
            { type: 'button', class: 'icon-btn', 'aria-label': `Say ${item.word}`, onClick: (e) => { e.stopPropagation(); const s = store.settings(); speak(item.word, { rate: s.speechRate, voiceURI: s.voiceURI }); } },
            icon('speaker'),
          ),
        }),
      );
    } else if (list.kind === 'family') {
      missedRows.push(row({ title: item.members.map((x) => x.word).join(' · '), subtitle: item.members[0]?.definition }));
    } else {
      missedRows.push(row({ title: item.text.length > 90 ? item.text.slice(0, 90) + '…' : item.text }));
    }
  }

  const practiseMistakes = () => {
    if (summary.mode === 'review') replace('practice', { mode: 'review', missed: summary.missed });
    else replace('practice', { listId: summary.listId, mode: summary.mode, itemIds: summary.missed.map((m) => m.itemId) });
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
    summary.hinted ? h('p', { class: 'res-note' }, `${summary.hinted} answered with a hint — they'll come back a little sooner.`) : null,
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
