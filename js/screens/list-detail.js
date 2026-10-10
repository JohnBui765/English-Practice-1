// One list: sentences status, practice modes, progress and every item.
// params: { listId }
import { h, reducedMotion } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { screen, section, row, button, iconButton, card, badge, posBadge, emptyState, actionSheet, confirm, sheet, textArea, toast, hasOpenOverlay } from '../ui/components.js';
import { push, pop, resetTo } from '../ui/router.js';
import { speak } from '../ui/speech.js';
import { keepVisible } from '../ui/viewport.js';
import * as store from '../data/store.js';
import { isDue, boxLabel, summary, newProgress } from '../core/srs.js';
import { coverage, clozeParts, sentenceFromContext } from '../core/cloze.js';
import { familyStatus, isFamilyReady, memberBlank, memberForms, modelIndex, rootsText } from '../core/families.js';
import { plural, formatDate, startOfDay, uid, DAY } from '../core/util.js';
import { MODES, buildCards, getSnapshot, liveCards } from './practice/session.js';

const ITEM_NOUN = {
  vocab: ['word', 'words'],
  family: ['family', 'families'],
  passage: ['passage', 'passages'],
};

const STAGES = [
  { key: 'new', label: 'New', color: 'var(--label-3)' },
  { key: 'learning', label: 'Learning', color: 'var(--orange)' },
  { key: 'review', label: 'Reviewing', color: 'var(--blue)' },
  { key: 'mastered', label: 'Mastered', color: 'var(--green)' },
];

const nounFor = (kind) => ITEM_NOUN[kind] || ITEM_NOUN.vocab;
const countOf = (kind, n) => plural(n, ...nounFor(kind));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

function say(text) {
  const s = store.settings();
  speak(text, { rate: s.speechRate, voiceURI: s.voiceURI });
}

// "today" | "tomorrow" | "in 3 days"
function whenText(due, now) {
  if (due <= now) return 'today';
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function statusText(p, now) {
  if (!p || !p.seen) return 'New · not practised yet';
  if (isDue(p, now)) return `${boxLabel(p.box)} · due for review`;
  return `${boxLabel(p.box)} · next review ${whenText(p.due, now)}`;
}

// Sentence with its [[answer]] in bold and the brackets removed.
function sentenceText(text) {
  const parts = clozeParts(text);
  const unwrap = (s) => s.replace(/\[\[|\]\]/g, '');
  if (!parts) return [unwrap(text)];
  return [unwrap(parts.before), h('strong', { class: 'ld-answer' }, parts.answer), unwrap(parts.after)];
}

// The word a family is known by: the pasted root, or its model member.
function familyName(item) {
  const root = String(item?.root ?? '').trim();
  if (root) return root;
  const members = item?.members || [];
  const model = members[modelIndex(item)];
  return model ? memberForms(model)[0] || model.word : '';
}

const familyPos = (item) => String(item?.rootPos || '').trim() || (item?.members?.[modelIndex(item)]?.pos ?? '');
const formTotal = (items) => items.reduce((n, item) => n + (isFamilyReady(item) ? (item.members || []).length : 0), 0);

// A pending family list built from a vocabulary list's words ("Make word
// families from these words"). rawText is the one-line format, so Edit list
// reads the same roots back.
function familyListFrom(vocab, now = Date.now()) {
  const seen = new Set();
  const items = [];
  for (const it of vocab.items || []) {
    const word = String(it.word || '').replace(/\s+/g, ' ').trim();
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    const meaning = (it.senses || []).map((x) => String(x).trim()).filter(Boolean).join('; ');
    items.push({ id: uid(), root: word, rootPos: it.pos || '', rootMeaning: meaning, note: '', members: [] });
  }
  const rawText = rootsText(items);
  return {
    id: uid(),
    kind: 'family',
    title: `${vocab.title || 'List'} · families`,
    source: vocab.source || '',
    rawText,
    items,
    sentences: [],
    sourceListId: vocab.id,
    createdAt: now,
    updatedAt: now,
    lastPracticedAt: null,
  };
}

async function findLinked(listId) {
  try {
    return (await store.getLists()).find((l) => l.kind === 'family' && l.sourceListId === listId) || null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

function subtitleOf(list) {
  if (list.source) return list.source;
  return `${countOf(list.kind, (list.items || []).length)} · added ${formatDate(list.createdAt || Date.now())}`;
}

// Pop once the router is free (onShow runs while it is still busy).
async function leave(tries = 8) {
  if (await pop()) return;
  if (tries > 0) setTimeout(() => leave(tries - 1), 120);
  else resetTo('lists');
}

function missingScreen(ctx) {
  const s = screen({
    title: 'List',
    largeTitle: false,
    back: { label: ctx.backLabel },
    body: [emptyState({ icon: 'books', title: 'List not found', message: 'It may have been deleted.', action: { label: 'Go back', onTap: () => leave() } })],
  });
  // missing: the router skips this screen when it restores a saved stack.
  return { el: s.el, title: 'List', missing: true };
}

async function loadProgress(list) {
  if (list.kind !== 'vocab') return new Map();
  try {
    // One index query instead of a transaction per word (big lists).
    return await store.getProgressForList(list.id);
  } catch (err) {
    console.error(err);
    return new Map();
  }
}

export default async function create(params, ctx) {
  let list = null;
  try {
    list = params.listId ? await store.getList(params.listId) : null;
  } catch (err) {
    console.error(err);
  }
  if (!list) return missingScreen(ctx);
  list = { ...list, items: list.items || [], sentences: list.sentences || [] };
  let progress = await loadProgress(list);
  // Vocabulary lists: the family list made from their words, if any.
  let linked = list.kind === 'vocab' ? await findLinked(list.id) : null;

  const body = h('div', { class: 'ld-body' });
  const s = screen({
    title: list.title || 'Untitled list',
    subtitle: subtitleOf(list),
    back: { label: ctx.backLabel },
    className: 'list-detail-screen',
    actions: [{ icon: 'ellipsis', ariaLabel: 'More', onTap: () => more() }],
    body: [body],
  });

  const inst = { el: s.el, title: list.title || 'List' };
  let destroyed = false;
  let openSheet = null;

  const goSentences = () => push('sentences', { listId: list.id });
  const goFamilies = () => push('families', { listId: list.id });
  const practise = (mode) => push('practice', { listId: list.id, mode }, { modal: true });

  /* ---------- sentences ---------- */

  function sentencesBlock() {
    const n = (list.sentences || []).length;
    if (!n) {
      return h(
        'div',
        { class: 'section' },
        card({
          className: 'ld-hero',
          children: [
            h('div', { class: 'ld-hero-top' }, h('span', { class: 'ld-hero-icon' }, icon('sparkles')), h('div', { class: 'ld-hero-title' }, 'Make context sentences')),
            h('p', { class: 'ld-hero-text' }, 'Copy a prompt to the Claude app and paste the reply back. About a minute — then practise every word in real sentences.'),
            button({ label: 'Make sentences', block: true, onTap: goSentences }),
          ],
        }),
      );
    }
    const missing = coverage(list).missing.length;
    return section({
      className: 'ld-sentences',
      children: [
        row({
          icon: 'sparkles',
          iconBg: 'var(--accent)',
          title: plural(n, 'sentence'),
          subtitle: missing ? h('span', { class: 'ld-missing' }, `${plural(missing, 'meaning')} missing`) : 'Every meaning covered',
          onTap: goSentences,
        }),
      ],
    });
  }

  /* ---------- word families (family lists) ---------- */

  function familiesBlock() {
    const stat = familyStatus(list);
    if (!stat.total) return null;
    if (stat.pending.length) {
      return h(
        'div',
        { class: 'section' },
        card({
          className: 'ld-hero',
          children: [
            h('div', { class: 'ld-hero-top' }, h('span', { class: 'ld-hero-icon' }, icon('sparkles')), h('div', { class: 'ld-hero-title' }, 'Make word families')),
            h('p', { class: 'ld-hero-text' }, "Claude finds each word's family with natural examples — copy a prompt, paste the reply."),
            stat.ready ? h('p', { class: 'ld-hero-status tabular' }, `${stat.ready} of ${countOf('family', stat.total)} ready`) : null,
            button({ label: stat.ready ? 'Finish the families' : 'Make families', block: true, onTap: goFamilies }),
          ],
        }),
      );
    }
    return section({
      className: 'ld-families',
      children: [
        row({
          icon: 'sparkles',
          iconBg: 'var(--accent)',
          title: `${countOf('family', stat.total)} · ${plural(formTotal(list.items), 'form')}`,
          subtitle: 'Every word has its family',
          onTap: goFamilies,
        }),
      ],
    });
  }

  /* ---------- word families made from a vocabulary list ---------- */

  let creating = false;
  async function makeFamilies() {
    if (creating) return;
    creating = true;
    try {
      const existing = await findLinked(list.id);
      if (existing) {
        linked = existing;
        render();
        push('families', { listId: existing.id });
        return;
      }
      if (!list.items.length) {
        toast('Add some words to this list first', { icon: 'info', tone: 'accent' });
        return;
      }
      linked = await store.saveList(familyListFrom(list));
      render();
      push('families', { listId: linked.id });
    } catch (err) {
      console.error(err);
      toast('Could not make the family list. Please try again.', { icon: 'xCircle', tone: 'red' });
    } finally {
      creating = false;
    }
  }

  function familiesLinkBlock() {
    if (!list.items.length) return null;
    if (!linked) {
      return section({
        className: 'ld-fam-link',
        children: [
          row({
            icon: 'family',
            iconBg: 'var(--teal)',
            title: 'Make word families',
            subtitle: `From these ${plural(list.items.length, 'word')}`,
            ariaLabel: 'Make word families from these words',
            onTap: makeFamilies,
          }),
        ],
      });
    }
    const stat = familyStatus(linked);
    let subtitle;
    if (!stat.total) subtitle = 'No words yet';
    else if (!stat.ready) subtitle = `${countOf('family', stat.total)} · waiting for Claude`;
    else if (stat.pending.length) subtitle = `${stat.ready} of ${countOf('family', stat.total)} ready`;
    else subtitle = `${countOf('family', stat.total)} · ${plural(formTotal(linked.items || []), 'form')}`;
    const target = linked.id;
    return section({
      className: 'ld-fam-link linked',
      children: [row({ icon: 'family', iconBg: 'var(--teal)', title: 'Word families', subtitle, onTap: () => push('list', { listId: target }) })],
    });
  }

  /* ---------- paused session ---------- */

  // iOS may close the app mid-practice; the router then brings back this
  // screen (practice itself is not restored), so offer the saved session here.
  function resumeBlock() {
    const snap = getSnapshot();
    if (!snap || snap.listId !== list.id) return null;
    // Its words may have been deleted (or its sentences replaced) since.
    if (!liveCards(snap, new Map([[list.id, list]])).length) return null;
    const mode = MODES[snap.mode];
    if (!mode) return null;
    const done = Math.min(snap.done, snap.originalCount);
    return section({
      className: 'ld-resume',
      children: [
        row({
          icon: mode.icon,
          iconBg: mode.color,
          title: 'Continue practising',
          subtitle: `${mode.label} · ${done}\u00a0of\u00a0${snap.originalCount}`,
          accessory: h('span', { class: 'ld-resume-go' }, 'Resume', icon('chevronRight', { size: 18 })),
          onTap: () => push('practice', { resume: true }, { modal: true }),
        }),
      ],
    });
  }

  /* ---------- practice modes ---------- */

  function modeCount(key) {
    const items = list.items || [];
    if (key === 'cloze') {
      const ids = new Set(items.map((i) => i.id));
      const pairs = new Set((list.sentences || []).filter((x) => ids.has(x.itemId)).map((x) => `${x.itemId}:${x.sense}`));
      return pairs.size;
    }
    if (key === 'family') return items.filter((f) => (f.members || []).length > 1).length;
    if (key === 'formation') {
      // One card per member with a blank; the session builds them the same way.
      try {
        return buildCards(list, 'formation').length;
      } catch (err) {
        console.error(err);
        return 0;
      }
    }
    return items.length;
  }

  // What an empty mode is waiting for, and where to get it.
  function modeNeeds(key, n) {
    if (n > 0) return null;
    if (key === 'cloze') return { text: 'Needs sentences', go: goSentences };
    if (list.kind === 'family' && (key === 'family' || key === 'formation')) {
      const ready = familyStatus(list).ready > 0;
      return { text: key === 'formation' && ready ? 'Needs examples' : 'Needs families', go: goFamilies };
    }
    return null;
  }

  function modeCard(mode, wide) {
    const n = modeCount(mode.key);
    const needs = modeNeeds(mode.key, n);
    const countText = needs ? needs.text : mode.key === 'cloze' || mode.key === 'formation' ? plural(n, 'card') : countOf(list.kind, n);
    return card({
      className: ['ld-mode', wide ? 'wide' : '', needs ? 'needs' : ''].filter(Boolean).join(' '),
      ariaLabel: `${mode.label}, ${countText}`,
      onTap: () => (needs ? needs.go() : practise(mode.key)),
      children: h(
        'span',
        { class: 'ld-mode-inner' },
        h('span', { class: 'ld-mode-icon', style: { background: mode.color } }, icon(mode.icon)),
        h('span', { class: 'ld-mode-count tabular' }, countText),
        // If the label wraps on a narrow phone, it breaks after the arrow.
        h('span', { class: 'ld-mode-label' }, mode.label.replace(/ → /g, '\u00a0→ ')),
        h('span', { class: 'ld-mode-text' }, mode.short),
      ),
    });
  }

  function practiseBlock() {
    const modes = Object.values(MODES).filter((m) => m.key !== 'review' && m.kinds.includes(list.kind));
    const cards = modes.map((m, i) => modeCard(m, modes.length % 2 === 1 && i === 0));
    return section({ header: 'Practise', plain: true, className: 'ld-practise', children: h('div', { class: 'ld-modes' }, cards) });
  }

  /* ---------- progress ---------- */

  function progressBlock() {
    const now = Date.now();
    const items = list.items || [];
    if (!items.length) return null;
    const records = items.map((i) => progress.get(i.id) || newProgress(i.id, list.id));
    const sum = summary(records, now);
    const practised = items.map((i) => progress.get(i.id)).filter(Boolean);
    const due = practised.filter((p) => isDue(p, now)).length;

    const bar = h(
      'div',
      { class: 'ld-stack', role: 'img', 'aria-label': STAGES.map((st) => `${sum[st.key]} ${st.label.toLowerCase()}`).join(', ') },
      STAGES.filter((st) => sum[st.key] > 0).map((st) => h('span', { class: 'ld-stack-seg', style: { flexGrow: String(sum[st.key]), background: st.color } })),
    );
    const legend = h(
      'div',
      { class: 'ld-legend' },
      STAGES.map((st) =>
        h(
          'span',
          { class: ['ld-legend-item', sum[st.key] === 0 && 'zero'] },
          h('span', { class: 'ld-legend-dot', style: { background: st.color } }),
          h('span', { class: 'ld-legend-label' }, st.label),
          h('span', { class: 'ld-legend-n tabular' }, String(sum[st.key])),
        ),
      ),
    );
    let next;
    if (!practised.length) next = 'Not practised yet';
    else if (due) next = `Next review: today · ${due} due`;
    else next = `Next review: ${whenText(Math.min(...practised.map((p) => Number(p.due) || 0)), now)}`;
    return section({
      header: 'Progress',
      plain: true,
      className: 'ld-progress',
      children: h(
        'div',
        { class: 'card ld-progress-card' },
        bar,
        legend,
        h('div', { class: ['ld-next', due && 'due'] }, icon(due ? 'flame' : 'calendar', { size: 18 }), h('span', null, next)),
      ),
    });
  }

  /* ---------- items ---------- */

  // A tappable row that can hold its own speaker button (no nested buttons).
  function tappableRow(opts, onOpen) {
    const el = row(opts);
    el.classList.add('tappable');
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.addEventListener('click', onOpen);
    el.addEventListener('keydown', (e) => {
      if (e.target === el && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        onOpen();
      }
    });
    return el;
  }

  function speakerButton(text, label) {
    return h(
      'button',
      {
        type: 'button',
        class: 'icon-btn ld-speak',
        'aria-label': label,
        onClick: (e) => {
          e.stopPropagation();
          say(text);
        },
      },
      icon('speaker'),
    );
  }

  function vocabRow(item) {
    return tappableRow(
      {
        className: 'ld-item',
        title: h(
          'span',
          { class: 'ld-item-head' },
          h('span', { class: 'ld-item-word' }, item.word),
          posBadge(item.pos),
          item.ipa ? h('span', { class: 'ipa' }, `/${item.ipa}/`) : null,
        ),
        subtitle: (item.senses || []).join(' · '),
        accessory: speakerButton(item.word, `Say ${item.word}`),
        ariaLabel: item.word,
      },
      () => openWord(item.id),
    );
  }

  // waitingBadge: some families are ready, so the waiting ones are marked
  // (when none is, the hero card already says so).
  function familyRow(item, waitingBadge) {
    const members = item.members || [];
    const ready = isFamilyReady(item);
    const name = familyName(item);
    const model = modelIndex(item);
    let subtitle = null;
    if (!ready) {
      subtitle = item.rootMeaning ? h('span', { lang: 'vi' }, item.rootMeaning) : null;
    } else if (members.length === 1) {
      subtitle = item.note || null;
    } else {
      subtitle = members
        .filter((_, i) => i !== model)
        .map((m) => memberForms(m)[0] || m.word)
        .join(' · ');
    }
    return row({
      className: ready ? 'ld-item ld-fam-row' : 'ld-item ld-fam-row pending',
      title: h('span', { class: 'ld-item-head' }, h('span', { class: 'ld-item-word' }, name), posBadge(familyPos(item)), !ready && waitingBadge ? badge('Waiting', 'accent') : null),
      subtitle,
      onTap: () => openFamily(item.id),
    });
  }

  function passageRow(item) {
    return row({
      className: 'ld-item ld-passage-row',
      title: clip((item.text || '').replace(/\s+/g, ' '), 120),
      onTap: () => openPassage(item.id),
    });
  }

  function itemsBlock() {
    const items = list.items || [];
    const someReady = list.kind === 'family' && familyStatus(list).ready > 0;
    const make = list.kind === 'family' ? (item) => familyRow(item, someReady) : list.kind === 'passage' ? passageRow : vocabRow;
    if (!items.length) {
      return section({ header: nounFor(list.kind)[1], children: [row({ title: h('span', { class: 'muted' }, 'This list is empty. Tap More › Edit list to add some.') })] });
    }
    return section({ header: countOf(list.kind, items.length), className: 'ld-items', children: items.map(make) });
  }

  /* ---------- sheets ---------- */

  function sentencesFor(itemId) {
    return (list.sentences || []).filter((x) => x.itemId === itemId).sort((a, b) => a.sense - b.sense || (a.origin === 'user') - (b.origin === 'user'));
  }

  function renderSentenceCards(item) {
    const list_ = sentencesFor(item.id);
    if (!list_.length) {
      return section({
        header: 'Sentences',
        children: [row({ title: h('span', { class: 'muted' }, 'No sentences yet'), accent: false })],
        footer: list.kind === 'vocab' ? 'Make sentences for the list, or paste where you met this word below.' : null,
      });
    }
    const multi = (item.senses || []).length > 1;
    return section({
      header: plural(list_.length, 'sentence'),
      children: list_.map((x) =>
        h(
          'div',
          { class: 'row ld-sentence' },
          h(
            'span',
            { class: 'row-main' },
            // Caption → sentence → translation, as on the Sentences screen.
            multi || x.origin === 'user'
              ? h('span', { class: 'ld-sentence-meta' }, [multi ? `Meaning ${x.sense + 1}` : null, x.origin === 'user' ? 'From you' : null].filter(Boolean).join(' · '))
              : null,
            h('span', { class: 'ld-sentence-text' }, sentenceText(x.text)),
            x.vi ? h('span', { class: 'ld-sentence-vi' }, x.vi) : null,
          ),
        ),
      ),
    });
  }

  function openWord(itemId) {
    const item = list.items.find((i) => i.id === itemId);
    if (!item) return;
    const now = Date.now();
    const p = progress.get(item.id);
    const sentenceHost = h('div', null, renderSentenceCards(item));

    let savedContext = item.context || '';
    const saveBtn = button({ label: 'Save', variant: 'tinted', block: true, disabled: true, onTap: () => saveContext() });
    const ta = textArea({
      value: savedContext,
      placeholder: 'Paste the sentence here',
      rows: 3,
      className: 'ld-context',
      ariaLabel: 'Seen in',
      onInput: (v) => {
        saveBtn.disabled = v.trim() === savedContext.trim();
      },
    });
    ta.setAttribute('enterkeyhint', 'done');
    ta.addEventListener('focus', () => keepVisible(ta));
    // The keyboard's "done" key: save (or just close the keyboard), not a new line.
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      if (!saveBtn.disabled) saveContext();
      else ta.blur();
    });

    async function saveContext() {
      const context = ta.value.replace(/\s+/g, ' ').trim();
      saveBtn.disabled = true;
      try {
        const latest = (await store.getList(list.id)) || list;
        const items = latest.items.map((i) => (i.id === item.id ? { ...i, context } : i));
        const updated = items.find((i) => i.id === item.id);
        const sentences = (latest.sentences || []).filter((x) => !(x.itemId === item.id && x.origin === 'user'));
        const made = context && updated ? sentenceFromContext(updated) : null;
        if (made) sentences.push(made);
        list = await store.saveList({ ...latest, items, sentences });
        savedContext = context;
        ta.value = context;
        ta.blur();
        sentenceHost.replaceChildren(renderSentenceCards(updated || item));
        render();
        if (made) toast('Saved as a practice sentence');
        else if (context) toast(`Saved — “${item.word}” isn't in it, so it can't be practised`, { icon: 'info', tone: 'accent', duration: 3500 });
        else toast('Removed');
      } catch (err) {
        console.error(err);
        saveBtn.disabled = false;
        toast('Could not save. Please try again.', { icon: 'xCircle', tone: 'red' });
      }
    }

    const senses = item.senses || [];
    const content = h(
      'div',
      { class: 'ld-ws' },
      h(
        'div',
        { class: 'ld-ws-hero' },
        h(
          'div',
          { class: 'ld-ws-main' },
          h('div', { class: 'ld-ws-word' }, item.word),
          h('div', { class: 'ld-ws-meta' }, item.ipa ? h('span', { class: 'ipa' }, `/${item.ipa}/`) : null, posBadge(item.pos)),
        ),
        iconButtonFilled('speaker', `Say ${item.word}`, () => say(item.word)),
      ),
      section({
        header: senses.length > 1 ? plural(senses.length, 'meaning') : 'Meaning',
        children: senses.map((m, i) =>
          h('div', { class: 'row ld-sense' }, senses.length > 1 ? h('span', { class: 'ld-sense-n tabular' }, String(i + 1)) : null, h('span', { class: 'row-main' }, m)),
        ),
      }),
      item.synonyms?.length ? section({ header: 'Similar', children: [h('div', { class: 'row' }, h('span', { class: 'row-main' }, `≈ ${item.synonyms.join(', ')}`))] }) : null,
      item.examples?.length
        ? section({ header: item.examples.length > 1 ? 'Examples' : 'Example', children: item.examples.map((ex) => h('div', { class: 'row ld-example' }, h('span', { class: 'row-main' }, ex))) })
        : null,
      item.family ? section({ header: 'Word family', children: [h('div', { class: 'row' }, h('span', { class: 'row-main' }, item.family))] }) : null,
      section({
        header: 'Progress',
        children: [
          h(
            'div',
            { class: 'row ld-ws-status' },
            h('span', { class: 'ld-ws-dot', style: { background: stageColor(p) } }),
            h('span', { class: 'row-main' }, statusText(p, now)),
            p && p.seen ? h('span', { class: 'row-detail tabular' }, `${p.right || 0}/${p.seen} right`) : null,
          ),
        ],
      }),
      sentenceHost,
      section({
        header: 'Seen in',
        footer: 'Paste the sentence where you met this word — it becomes a practice sentence.',
        children: [ta],
      }),
      saveBtn,
    );
    const wordSheet = sheet({
      title: item.word,
      content,
      className: 'ld-sheet ld-word-sheet',
      onClose: () => {
        openSheet = null;
      },
    });
    openSheet = wordSheet;
    // The big word heads the sheet; the bar shows it only once that scrolls away.
    wordSheet.body.addEventListener('scroll', () => wordSheet.el.classList.toggle('scrolled', wordSheet.body.scrollTop > 44), { passive: true });
  }

  function stageColor(p) {
    if (!p || !p.seen) return 'var(--label-3)';
    const b = Number(p.box) || 0;
    if (b >= 5) return 'var(--green)';
    if (b >= 3) return 'var(--blue)';
    return 'var(--orange)';
  }

  function iconButtonFilled(name, label, onTap) {
    return h('button', { type: 'button', class: 'icon-btn filled ld-ws-speak', 'aria-label': label, onClick: onTap }, icon(name));
  }

  // Example with the member's [[form]] in bold and the brackets removed.
  function memberExample(m) {
    const blank = memberBlank(m);
    if (blank) return [blank.before, h('strong', { class: 'ld-answer' }, blank.answer), blank.after];
    const text = String(m.example || '').replace(/\[\[|\]\]/g, '');
    return text ? [text] : null;
  }

  function memberRow(item, m, index) {
    const word = memberForms(m)[0] || m.word;
    const example = memberExample(m);
    const rowEl = h(
      'div',
      { class: 'row ld-member' },
      h(
        'span',
        { class: 'row-main' },
        h('span', { class: 'ld-item-head' }, h('span', { class: 'ld-item-word' }, m.word), posBadge(m.pos), m.ipa ? h('span', { class: 'ipa' }, `/${m.ipa}/`) : null),
        m.vi || m.hint
          ? h('span', { class: 'ld-member-mean' }, m.vi ? h('span', { lang: 'vi' }, m.vi) : null, m.vi && m.hint ? ' · ' : null, m.hint ? h('span', { class: 'ld-member-hint' }, m.hint) : null)
          : null,
        m.definition ? h('span', { class: 'ld-member-def' }, m.definition) : null,
        example || m.exampleVi
          ? h(
              'span',
              { class: 'ld-member-quote' },
              example ? h('span', { class: 'ld-member-ex' }, example) : null,
              m.exampleVi ? h('span', { class: 'ld-member-exvi', lang: 'vi' }, m.exampleVi) : null,
            )
          : null,
      ),
      h(
        'span',
        { class: 'ld-member-actions' },
        speakerButton(word, `Say ${word}`),
        iconButton({ icon: 'trash', label: `Remove ${word}`, className: 'ld-member-trash', onTap: () => removeMember(item.id, index, m, rowEl) }),
      ),
    );
    return rowEl;
  }

  function familyContent(item) {
    const members = item.members || [];
    const ready = isFamilyReady(item);
    const name = familyName(item);
    const model = members[modelIndex(item)];
    const meaning = String(item.rootMeaning || '').trim() || model?.vi || '';
    return h(
      'div',
      { class: 'ld-ws ld-fs' },
      h(
        'div',
        { class: 'ld-ws-hero' },
        h(
          'div',
          { class: 'ld-ws-main' },
          h('div', { class: 'ld-ws-word' }, name),
          h('div', { class: 'ld-ws-meta' }, model?.ipa ? h('span', { class: 'ipa' }, `/${model.ipa}/`) : null, posBadge(familyPos(item))),
          meaning ? h('div', { class: 'ld-fs-meaning', lang: 'vi' }, meaning) : null,
        ),
        iconButtonFilled('speaker', `Say ${name}`, () => say(name)),
      ),
      item.note ? h('div', { class: 'card ld-fs-note' }, icon('info', { size: 20 }), h('span', null, item.note)) : null,
      ready
        ? null
        : h(
            'div',
            { class: 'card ld-fs-wait' },
            h('div', { class: 'ld-fs-wait-title' }, 'Waiting for Claude'),
            h('p', { class: 'ld-fs-wait-text' }, members.length ? 'Only one form came back. Ask Claude again for the rest of the family.' : "Copy the prompt to Claude and paste the reply — this word's family will appear here."),
            button({
              label: 'Make word families',
              icon: 'sparkles',
              variant: 'tinted',
              block: true,
              onTap: async () => {
                if (openSheet) await openSheet.close();
                goFamilies();
              },
            }),
          ),
      members.length ? section({ header: plural(members.length, 'form'), className: 'ld-fs-forms', children: members.map((m, i) => memberRow(item, m, i)) }) : null,
    );
  }

  function openFamily(itemId) {
    const item = list.items.find((i) => i.id === itemId);
    if (!item) return;
    const famSheet = sheet({
      title: familyName(item) || 'Word family',
      content: familyContent(item),
      className: 'ld-sheet ld-word-sheet ld-family-sheet',
      onClose: () => {
        openSheet = null;
      },
    });
    famSheet.itemId = itemId;
    openSheet = famSheet;
    // The big word heads the sheet; the bar shows it only once that scrolls away.
    famSheet.body.addEventListener('scroll', () => famSheet.el.classList.toggle('scrolled', famSheet.body.scrollTop > 44), { passive: true });
  }

  async function removeMember(itemId, index, member, rowEl) {
    const item = list.items.find((i) => i.id === itemId);
    if (!item) return;
    const left = (item.members || []).length - 1;
    const shown = memberForms(member)[0] || member.word;
    let message = 'It will not be practised in this family any more.';
    if (left === 0) message = 'The family will be empty until Claude builds it again.';
    else if (left < 2 && !item.note) message = 'Only one form will be left, so this family will need Claude again.';
    const ok = await confirm({ title: `Remove “${shown}”?`, message, confirmLabel: 'Remove', destructive: true });
    if (!ok) return;
    let updated = null;
    try {
      const latest = (await store.getList(list.id)) || list;
      const items = (latest.items || []).map((i) => {
        if (i.id !== itemId) return i;
        const members = i.members || [];
        // The member at `index` if it is still the same word, else the first with that word.
        const at = members[index]?.word === member.word ? index : members.findIndex((m) => m.word === member.word);
        // A family pasted written out is known by its first form: keep that
        // name when it goes, so the family can still be asked for (and Edit
        // list still finds it).
        const keepName = at === 0 && !String(i.root || '').trim() ? { root: familyName(i), rootPos: familyPos(i) } : null;
        updated = { ...i, ...keepName, members: at < 0 ? members : members.filter((_, k) => k !== at) };
        return updated;
      });
      list = await store.saveList({ ...latest, items });
      list = { ...list, items: list.items || [], sentences: list.sentences || [] };
    } catch (err) {
      console.error(err);
      toast('Could not remove it. Please try again.', { icon: 'xCircle', tone: 'red' });
      return;
    }
    const sheetNow = openSheet && openSheet.itemId === itemId ? openSheet : null;
    const redraw = () => {
      if (sheetNow && openSheet === sheetNow && updated) sheetNow.body.replaceChildren(familyContent(updated));
    };
    if (reducedMotion() || !rowEl.isConnected) redraw();
    else {
      rowEl.style.pointerEvents = 'none';
      rowEl
        .animate([{ opacity: 1, transform: 'translate3d(0,0,0)' }, { opacity: 0, transform: 'translate3d(-24px,0,0)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' })
        .finished.then(redraw, redraw);
    }
    render();
    toast(`Removed “${shown}”`, { icon: 'trash', tone: 'accent' });
  }

  function openPassage(itemId) {
    const item = list.items.find((i) => i.id === itemId);
    if (!item) return;
    openSheet = sheet({
      title: 'Passage',
      className: 'ld-sheet',
      onClose: () => (openSheet = null),
      content: [
        h('div', { class: 'card ld-passage' }, item.text),
        button({ label: 'Listen', icon: 'speaker', variant: 'tinted', block: true, onTap: () => say(item.text) }),
      ],
    });
  }

  /* ---------- more menu ---------- */

  async function more() {
    const actions = [{ label: 'Edit list', value: 'edit' }];
    if (list.kind === 'vocab') {
      actions.push({ label: (list.sentences || []).length ? 'Make new sentences' : 'Make sentences', value: 'sentences' });
      actions.push({ label: 'Make word families', value: 'families' });
    }
    if (list.kind === 'family' && list.items.length) actions.push({ label: 'Make word families', value: 'families' });
    actions.push({ label: 'Delete list', value: 'delete', style: 'destructive' });
    const choice = await actionSheet({ title: list.title, actions });
    if (choice === 'edit') push('import', { listId: list.id }, { modal: true });
    else if (choice === 'sentences') goSentences();
    else if (choice === 'families') {
      if (list.kind === 'family') goFamilies();
      else if (linked) push('families', { listId: linked.id });
      else makeFamilies();
    }
    else if (choice === 'delete') {
      const ok = await confirm({
        title: `Delete “${list.title}”?`,
        message: 'Its words, sentences and progress will be removed from this phone.',
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
      await store.deleteList(list.id);
      toast('List deleted', { icon: 'trash', tone: 'accent' });
      leave();
    }
  }

  /* ---------- render / refresh ---------- */

  function render() {
    const parts = [resumeBlock()];
    if (list.kind === 'vocab') parts.push(sentencesBlock());
    if (list.kind === 'family') parts.push(familiesBlock());
    parts.push(practiseBlock());
    if (list.kind === 'vocab') parts.push(familiesLinkBlock(), progressBlock());
    parts.push(cachedItemsBlock());
    body.replaceChildren(...parts.filter(Boolean));
  }

  // The rows only depend on the list's words, so returning from practice
  // (new progress, same words) reuses them instead of rebuilding every row.
  let itemsCache = null;
  function cachedItemsBlock() {
    const key = `${list.updatedAt}|${list.kind}|${list.items.length}`;
    if (!itemsCache || itemsCache.key !== key) itemsCache = { key, el: itemsBlock() };
    return itemsCache.el;
  }

  async function refresh() {
    let fresh;
    try {
      fresh = await store.getList(params.listId);
    } catch (err) {
      console.error(err);
      return; // keep showing what we have
    }
    if (destroyed) return;
    if (!fresh) {
      if (openSheet) {
        const open = openSheet;
        openSheet = null; // so leave() is not held back by the closing sheet
        open.close();
      }
      leave();
      return;
    }
    list = { ...fresh, items: fresh.items || [], sentences: fresh.sentences || [] };
    progress = await loadProgress(list);
    if (list.kind === 'vocab') linked = await findLinked(list.id);
    if (destroyed) return;
    const title = list.title || 'Untitled list';
    s.setTitle(title);
    s.setSubtitle(subtitleOf(list));
    inst.title = title;
    render();
  }

  render();

  inst.onShow = (opts = {}) => {
    if (opts.returning) refresh();
  };
  // Escape (iPad / desktop keyboards) should close a sheet or menu, not also
  // leave this screen. The overlay closes itself before the router's Escape
  // handler runs, so remember that this Escape belonged to an overlay.
  let overlayEscape = false;
  const onEscape = (e) => {
    if (e.key !== 'Escape' || !hasOpenOverlay()) return;
    overlayEscape = true;
    setTimeout(() => (overlayEscape = false), 0);
  };
  document.addEventListener('keydown', onEscape, true);
  // hasOpenOverlay() turns false as soon as a sheet starts closing, so Back
  // works straight away (openSheet is only cleared after the fade-out).
  inst.beforeLeave = () => !overlayEscape && !hasOpenOverlay();

  inst.onDestroy = () => {
    destroyed = true;
    document.removeEventListener('keydown', onEscape, true);
    if (openSheet) openSheet.close();
  };
  return inst;
}
