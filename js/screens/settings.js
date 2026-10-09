// Settings tab: practice options, pronunciation, appearance, backup, help.
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { screen, section, row, segmented, toggle, slider, sheet, actionSheet, confirm, toast, button } from '../ui/components.js';
import { englishVoices, speak, supported as speechSupported } from '../ui/speech.js';
import { resetTo } from '../ui/router.js';
import * as store from '../data/store.js';

const VERSION = '1.0';

const AUTO_ADVANCE = [
  { value: 0, label: 'Off' },
  { value: 1, label: '1 second' },
  { value: 2, label: '2 seconds' },
  { value: 3, label: '3 seconds' },
  { value: 5, label: '5 seconds' },
  { value: 8, label: '8 seconds' },
];
const HIDE_AFTER = [
  { value: 0, label: 'Never' },
  { value: 10, label: '10 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
];
const REVIEW_LIMIT = [10, 20, 30, 50].map((n) => ({ value: n, label: `${n} words` }));

const labelOf = (options, value) => options.find((o) => o.value === value)?.label ?? String(value);

function controlRow(title, control, subtitle) {
  return h(
    'div',
    { class: 'row settings-control' },
    h('span', { class: 'row-main' }, h('span', { class: 'row-title', style: { display: 'block' } }, title), subtitle ? h('span', { class: 'row-subtitle', style: { display: 'block' } }, subtitle) : null),
    control,
  );
}

function stackedRow(title, control) {
  return h('div', { class: 'row settings-stacked' }, h('div', { class: 'row-title' }, title), control);
}

function formatBytes(n) {
  if (!n) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function exportBackup() {
  const data = await store.exportAll();
  const json = JSON.stringify(data, null, 1);
  // Local date (toISOString is UTC: early morning in Vietnam gives yesterday).
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const name = `vocab-studio-backup-${date}.json`;
  const file = new File([json], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Vocab Studio backup' });
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
  toast('Backup saved', { icon: 'download' });
}

function importBackup() {
  const input = h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
      store.validateBackup(data);
    } catch (err) {
      toast(err.message && !/JSON/.test(err.message) ? err.message : 'That file is not a valid backup.', { icon: 'xCircle', tone: 'red', duration: 3500 });
      return;
    }
    // Count only the lists that will actually be restored.
    const count = data.lists.filter((l) => l && typeof l.id === 'string' && Array.isArray(l.items)).length;
    const mode = await actionSheet({
      title: `Restore ${count} ${count === 1 ? 'list' : 'lists'}?`,
      message: 'Merge keeps your current lists and adds anything newer from the backup. Replace deletes what is on this phone first.',
      actions: [
        { label: 'Merge with my lists', value: 'merge' },
        { label: 'Replace everything', value: 'replace', style: 'destructive' },
      ],
    });
    if (!mode) return;
    if (mode === 'replace' && !(await confirm({ title: 'Replace all data?', message: 'Lists and progress on this phone will be deleted.', confirmLabel: 'Replace', destructive: true }))) return;
    try {
      const res = await store.importAll(data, { mode });
      // Rebuild this screen so its controls show the restored settings.
      await resetTo('settings');
      toast(`Restored ${res.lists} ${res.lists === 1 ? 'list' : 'lists'}`);
    } catch (err) {
      toast(err.message || 'Could not restore the backup.', { icon: 'xCircle', tone: 'red', duration: 3500 });
    }
  });
  document.body.appendChild(input);
  input.click();
}

function infoSheet(title, paragraphs) {
  sheet({
    title,
    content: h(
      'div',
      { class: 'settings-help' },
      paragraphs.map((p) =>
        Array.isArray(p)
          ? h('ol', null, p.map((li) => h('li', null, li)))
          : typeof p === 'string'
            ? h('p', null, p)
            : p,
      ),
    ),
  });
}

function installHelp() {
  infoSheet('Install on iPhone', [
    'Vocab Studio works like a normal app once it is on your Home Screen — full screen, offline, and it keeps your lists.',
    [
      h('span', null, 'Open this page in ', h('strong', null, 'Safari'), '.'),
      h('span', null, 'Tap the ', h('strong', null, 'Share'), ' button ', icon('share', { size: 16, className: 'inline-icon' }), ' in the toolbar.'),
      h('span', null, 'Scroll down and tap ', h('strong', null, 'Add to Home Screen'), '.'),
      h('span', null, 'Tap ', h('strong', null, 'Add'), '. Open it from the new icon.'),
    ],
    'Your words are stored only on this phone. Use Export backup now and then to keep a copy in Files or iCloud Drive.',
  ]);
}

function sentencesHelp() {
  infoSheet('How sentences work', [
    'Your lists contain meanings but no English sentences, so the app asks Claude to write them — once per list.',
    [
      'Open a list and tap Make sentences.',
      'Tap Copy prompt, then open the Claude app and paste it into a new chat.',
      "When Claude answers, copy its whole reply (or tap the copy button on the code block).",
      'Come back here and tap Paste reply, then Save.',
    ],
    'The sentences are saved with the list, so practice works offline afterwards. Tap New set any time for fresh sentences — so you learn the words, not the sentences.',
  ]);
}

// Voices can take up to 1.5 s to load on a cold start: ignore taps meanwhile.
let voiceSheetOpening = false;
async function voiceSheet(onPicked) {
  if (voiceSheetOpening) return;
  voiceSheetOpening = true;
  let voices;
  try {
    voices = await englishVoices();
  } finally {
    voiceSheetOpening = false;
  }
  const current = store.settings().voiceURI;
  let s;
  const pick = async (uri) => {
    await store.setSetting('voiceURI', uri);
    onPicked();
    s.close();
  };
  const preview = (v) => speak('This is how your words will sound.', { voiceURI: v ? v.voiceURI : '', rate: store.settings().speechRate });
  const voiceRow = (v) =>
    row({
      title: v ? v.name.replace(/\s*\(.*?\)\s*/g, ' ').trim() : 'Automatic (best available)',
      subtitle: v ? `${v.lang.replace('_', '-')}${/enhanced|premium/i.test(v.name) ? ' · Enhanced' : ''}` : 'Picks the clearest English voice on this phone',
      accessory: (v ? v.voiceURI : '') === current ? h('span', { class: 'check-mark' }, icon('check')) : h('span', { class: 'check-mark' }),
      onTap: () => {
        preview(v);
        pick(v ? v.voiceURI : '');
      },
    });
  s = sheet({
    title: 'Voice',
    content: [
      section({ children: [voiceRow(null)] }),
      voices.length
        ? section({ header: 'English voices', footer: 'Tip: download “Enhanced” voices in iPhone Settings › Accessibility › Spoken Content › Voices › English.', children: voices.map(voiceRow) })
        : h('p', { class: 'muted small', style: { padding: '0 16px' } }, 'No English voices were found on this device.'),
    ],
  });
}

export default async function create() {
  const st = store.settings();
  let voiceName = 'Automatic';

  const voiceDetail = h('span', null, voiceName);
  const refreshVoiceName = async () => {
    const uri = store.settings().voiceURI;
    if (!uri) {
      voiceDetail.textContent = 'Automatic';
      return;
    }
    const v = (await englishVoices()).find((x) => x.voiceURI === uri);
    voiceDetail.textContent = v ? v.name.replace(/\s*\(.*?\)\s*/g, ' ').trim() : 'Automatic';
  };
  refreshVoiceName();

  // A choice opens a sheet of options with a checkmark on the current one
  // (like the Voice row): action sheets are for actions, not settings.
  const choiceRow = (title, key, options, { subtitle, sheetTitle = title, sheetFooter } = {}) => {
    const detail = h('span', null, labelOf(options, store.settings()[key]));
    let open = null;
    return row({
      title,
      subtitle,
      detail,
      onTap: () => {
        if (open) return; // a double tap opens one sheet
        const current = store.settings()[key];
        const optionRow = (o) =>
          row({
            title: o.label,
            accessory: h('span', { class: 'check-mark' }, o.value === current ? icon('check') : null),
            onTap: async () => {
              if (!open) return;
              const s = open;
              open = null;
              await store.setSetting(key, o.value);
              detail.textContent = labelOf(options, o.value);
              s.close();
            },
          });
        open = sheet({
          title: sheetTitle,
          content: section({ footer: sheetFooter, children: options.map(optionRow) }),
          onClose: () => {
            open = null;
          },
        });
      },
    });
  };

  const set = (key) => (value) => store.setSetting(key, value);

  const storageRowDetail = h('span', null, '…');
  store.storageStatus().then((s) => {
    storageRowDetail.textContent = s.durable ? `${formatBytes(s.usage)}${s.persistent ? ' · protected' : ''}` : 'Temporary';
    if (!s.durable) storageRowDetail.classList.add('settings-warn');
  });

  const body = [
    section({
      header: 'In context',
      footer: 'Tap words is fastest on a phone. Typing makes you spell the exact form the sentence needs.',
      children: [
        stackedRow('Answer by', segmented({ options: [{ value: 'bank', label: 'Tapping words' }, { value: 'type', label: 'Typing' }], value: st.clozeAnswer, onChange: set('clozeAnswer') })),
        stackedRow('Sentences per meaning', segmented({ options: [{ value: 1, label: '1' }, { value: 2, label: '2' }], value: st.sentencesPerSense, onChange: set('sentencesPerSense') })),
        stackedRow('Sentence level', segmented({ options: [{ value: 'B1', label: 'B1' }, { value: 'B2', label: 'B2' }, { value: 'C1', label: 'C1' }], value: st.level, onChange: set('level') })),
      ],
    }),
    section({
      header: 'Practice',
      children: [
        choiceRow('Continue after a correct answer', 'autoAdvance', AUTO_ADVANCE, { sheetTitle: 'Auto-continue', sheetFooter: 'After a correct answer, go to the next card on its own after this long.' }),
        choiceRow('Words per review', 'reviewLimit', REVIEW_LIMIT),
        controlRow('Ignore Vietnamese accents', toggle({ checked: st.ignoreAccents, onChange: set('ignoreAccents'), label: 'Ignore accents' }), 'When checking typed answers'),
      ],
    }),
    section({
      header: 'Word families',
      footer: 'Beginner shows the first letter. Advanced shuffles the forms.',
      children: [
        stackedRow('Difficulty', segmented({ options: [{ value: 'beginner', label: 'Beginner' }, { value: 'intermediate', label: 'Medium' }, { value: 'advanced', label: 'Advanced' }], value: st.familyDifficulty, onChange: set('familyDifficulty') })),
        stackedRow('Same part of speech', segmented({ options: [{ value: 'contextual', label: 'Hints' }, { value: 'numbered', label: 'Numbers' }], value: st.familyDuplicates, onChange: set('familyDuplicates') })),
      ],
    }),
    section({
      header: 'Dictation',
      children: [
        stackedRow('Start by', segmented({ options: [{ value: 'read', label: 'Reading' }, { value: 'listen', label: 'Listening' }], value: st.dictationStart, onChange: set('dictationStart') })),
        choiceRow('Hide result after', 'dictationHideAfter', HIDE_AFTER),
      ],
    }),
    section({
      header: 'Pronunciation',
      footer: speechSupported ? null : 'Speech is not available in this browser.',
      children: [
        row({ title: 'Voice', detail: voiceDetail, onTap: () => voiceSheet(refreshVoiceName) }),
        stackedRow(
          'Speed',
          slider({
            min: 0.5,
            max: 1.2,
            step: 0.05,
            value: st.speechRate,
            format: (v) => `${Math.round(v * 100)}%`,
            onChange: (v) => {
              store.setSetting('speechRate', v);
              speak('Repository', { rate: v, voiceURI: store.settings().voiceURI });
            },
            ariaLabel: 'Speech speed',
          }),
        ),
        controlRow('Speak after answering', toggle({ checked: st.autoSpeak, onChange: set('autoSpeak'), label: 'Speak after answering' })),
        row({
          title: 'Test voice',
          accent: true,
          accessory: h('span', { class: 'row-chevron' }, icon('speaker')),
          onTap: () => speak('After a two-week trial, the jury acquitted him of all charges.', { rate: store.settings().speechRate, voiceURI: store.settings().voiceURI }),
        }),
      ],
    }),
    section({
      header: 'Appearance',
      children: [stackedRow('Theme', segmented({ options: [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], value: st.theme, onChange: set('theme') }))],
    }),
    section({
      header: 'Backup',
      footer: 'Your lists live only on this phone. Export a backup to Files or iCloud Drive now and then.',
      children: [
        row({ icon: 'upload', iconBg: 'var(--blue)', title: 'Export backup', onTap: () => exportBackup() }),
        row({ icon: 'download', iconBg: 'var(--green)', title: 'Restore from backup', onTap: () => importBackup() }),
        row({
          icon: 'info',
          iconBg: store.isPersistentStorage() ? 'var(--gray)' : 'var(--red)',
          title: 'Storage',
          subtitle: store.isPersistentStorage() ? null : 'Unavailable: lists are lost when the app closes',
          detail: storageRowDetail,
        }),
      ],
    }),
    section({
      header: 'Help',
      children: [
        row({ icon: 'phone', iconBg: 'var(--accent)', title: 'Install on iPhone', onTap: installHelp }),
        row({ icon: 'sparkles', iconBg: 'var(--orange)', title: 'How sentences work', onTap: sentencesHelp }),
      ],
    }),
    h('p', { class: 'settings-version' }, `Vocab Studio ${VERSION}`),
  ];

  const s = screen({ title: 'Settings', tab: 'settings', body });
  return { el: s.el, title: 'Settings' };
}
