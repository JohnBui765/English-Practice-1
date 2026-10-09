# Vocab Studio — architecture

Vocab Studio is an iPhone-first Progressive Web App for learning English
vocabulary in context. It is plain HTML/CSS/JavaScript (ES modules) with **no
build step and no runtime dependencies**, so the repository root can be served
as-is by GitHub Pages.

```
index.html               app shell (links every css file, loads js/app.js)
manifest.webmanifest     install metadata
sw.js                    offline cache (precache list + versioned cache)
css/app.css              design tokens + shared components
css/screens/*.css        one stylesheet per screen (owned by that screen)
js/app.js                bootstrap: settings, theme, router, tabs, SW
js/core/*.js             PURE logic, no DOM — importable from Node tests
js/data/*.js             IndexedDB storage
js/ui/*.js               DOM helpers, components, router, viewport, speech
js/screens/*.js          screens; js/screens/practice/*.js practice modes
icons/                   app icons (png + svg)
tests/unit/*.test.js     node:test unit tests  (npm test)
tests/e2e/*.mjs          Playwright scripts run against a local server
```

## Hard rules

1. `js/core/*` must not touch `window`, `document`, `localStorage`,
   `indexedDB`, `Date.now()` without an injectable `now`, or `Math.random()`
   without an injectable `rng`. They are unit-tested in Node 22.
2. **Never put user text into `innerHTML`.** Build DOM with `h()` from
   `js/ui/dom.js` (children strings become text nodes). If HTML is unavoidable,
   escape with `escapeHtml()` from `js/core/text.js`.
3. Every module is an ES module with named exports. Relative imports with
   explicit `.js` extensions (`import { h } from '../ui/dom.js'`).
4. Touch first: every tappable thing ≥ 44×44 CSS px; primary actions sit in
   the footer (thumb zone); hover styles only inside `@media (hover: hover)`.
5. Inputs: font-size ≥ 16px (prevents iOS zoom), and for answer fields
   `autocomplete="off" autocorrect="off" autocapitalize="off"
   spellcheck="false"` plus a fitting `enterkeyhint`.
6. Animate only `transform` and `opacity`. Respect
   `prefers-reduced-motion`.
7. No `alert()` / `confirm()` / `prompt()` — use `ui/components.js`.
8. A screen only writes its own files (`js/screens/<name>.js`,
   `css/screens/<name>.css`). Shared components go in `ui/components.js` /
   `css/app.css`.

Colour tokens (css/app.css): plain `--accent` / `--green` / `--orange` /
`--red` are for icons, borders, bars and tints. Text uses `--green-text`,
`--orange-text`, `--red-text` (and `--accent-on-tint` on an `--accent-tint`
background); fills behind white (`--on-fill`) text use `--accent-fill`,
`--green-fill`, `--red-fill`. These pass WCAG AA in both themes; the plain
colours do not.

## Data model

All ids are strings from `uid()` (`js/core/util.js`). Timestamps are ms epoch.

```js
// List — one pasted list (stored in IndexedDB store "lists")
{
  id, kind: 'vocab' | 'family' | 'passage',
  title: string,              // "378" — from a title line, else "List · 8 Oct"
  source: string,             // optional "where these words came from"
  rawText: string,            // the original paste
  items: VocabItem[] | FamilyItem[] | PassageItem[],
  sentences: ClozeSentence[], // vocab lists only; [] otherwise
  createdAt, updatedAt, lastPracticedAt: number | null,
}

// VocabItem
{
  id, n: number,              // 1-based position in the list
  word: string,               // "acquit", "level-headed", "come up with"
  ipa: string,                // without slashes, "" if none
  pos: string,                // normalised abbreviation: n v adj adv prep conj
                              // pron det phr idiom ... or "" (see posLabel)
  senses: string[],           // meanings, markers like "i)" removed, >= 1
  synonyms: string[],         // from "[=plain]" or "Synonyms:" lines
  examples: string[],         // from "Example:" lines
  family: string,             // from "Word family:" line, raw
  context: string,            // optional sentence where the learner met the word
}

// FamilyItem — one derivative family (first member is the model word)
{ id, members: [{ word, pos, ipa, definition, example }] }

// PassageItem — a sentence/paragraph to memorise
{ id, text: string }

// ClozeSentence — a fill-in-the-blank sentence for one sense of one item
{
  id, itemId, sense: number,  // 0-based index into item.senses
  text: string,               // target wrapped in [[ ]]: "The jury [[acquitted]] him."
  answer: string,             // "acquitted" (the bracket content)
  vi: string,                 // Vietnamese translation, may be ""
  origin: 'ai' | 'user',      // 'user' = built from item.context
  createdAt: number,
}

// Progress — spaced repetition state per VocabItem (store "progress", key itemId)
{ itemId, listId, box: 0..5, due: number, seen, right, wrong, last: number | null }

// History entry (store "history", autoIncrement key)
{ at, listId: string | null, mode, total, correct }
```

Settings (store "settings", one record per key; defaults in
`js/data/store.js` → `DEFAULT_SETTINGS`):

```js
{
  theme: 'system',            // 'system' | 'light' | 'dark'
  voiceURI: '',               // '' = best English voice
  speechRate: 0.9,            // 0.5 .. 1.2
  autoSpeak: true,            // speak after an answer is checked
  clozeAnswer: 'bank',        // 'bank' (tap words) | 'type'
  autoAdvance: 0,             // 0 = off, else seconds (1..10) after a correct answer
  dictationHideAfter: 0,      // 0 = keep result visible, else seconds (5..180)
  dictationStart: 'read',     // 'read' (see text first) | 'listen' (audio only)
  familyDifficulty: 'intermediate', // 'beginner' | 'intermediate' | 'advanced'
  familyDuplicates: 'contextual',   // 'contextual' | 'numbered'
  ignoreAccents: false,
  sentencesPerSense: 1,       // 1 | 2
  level: 'B2',                // 'B1' | 'B2' | 'C1'
  reviewLimit: 20,            // max words per Today review
}
```

## Module contracts

### js/core/util.js
`uid()`, `shuffle(array, rng = Math.random)` (Fisher–Yates, returns a new
array), `pick(array, rng)`, `clamp(n, lo, hi)`, `startOfDay(ms)`,
`addDays(ms, days)`, `debounce(fn, ms)`, `plural(n, one, many?)`,
`formatDate(ms, locale?)`.

### js/core/text.js
- `normalizeAnswer(s, { ignoreAccents = false } = {})` → lowercase, NFC,
  unify quotes/apostrophes (’ ‘ ` → '), dashes (– — → -), collapse
  whitespace, trim, strip leading/trailing punctuation.
- `stripAccents(s)` (keeps đ/Đ → d/D when stripping).
- `escapeHtml(s)`.
- `tokenizeWords(s)` → `[{ word, start, end }]` using Unicode letters/digits
  plus inner `'` `’` `-`.
- `posLabel(pos)` → 'noun' | 'verb' | 'adjective' | ... | pos (unknown) | ''.
- `normalizePos(raw)` → abbreviation used in `VocabItem.pos`.

### js/core/parse.js
- `detectFormat(text)` → `'oneline' | 'block' | 'family' | 'passage'`.
- `parseList(text, { kind } = {})` →
  `{ kind, format, title, items, warnings: [{ line, text, reason }] }`.
  `kind` forces 'vocab' | 'family' | 'passage'; otherwise auto.
  See the "Input formats" section.

### js/core/grade.js
- `levenshtein(a, b)`.
- `checkWord(input, answer, { ignoreAccents, pos } = {})` →
  `{ correct, close, expected }`. Accepts answer alternatives written
  `a / b`, `a, b`, `a (b)` forms; accepts a leading "to " for verbs; `close`
  = wrong but within 1 edit (≤ 4 letters) or 2 edits (longer).
- `checkForm(input, answer, lemma, opts)` → `{ correct, rightWordWrongForm }`
  for typed cloze answers (lemma accepted as right word, wrong form).
- `diffWords(expected, actual, { ignoreCase = true, ignorePunctuation = true,
  ignoreAccents = false })` →
  `{ ops: [{ type: 'equal'|'wrong'|'missing'|'extra'|'break', expected?, actual? }],
     score: 0..1, correct: boolean }` — LCS alignment on words, line
  breaks in `expected` preserved as `break` ops, an adjacent missing+extra
  pair becomes `wrong`.
- `similarity(a, b)` → 0..1 (token based).

### js/core/cloze.js  (sentences come from the Claude app — "route B")
- `buildPrompt(list, { sentencesPerSense = 1, level = 'B2', fresh = false,
  only = null }) → string` — the text the user pastes into Claude.
  `fresh` lists the existing sentences to avoid; `only` is
  `[{ itemId, sense }]` to request just those.
- `parseReply(text, list) → { sentences: ClozeSentence[], problems:
  [{ ref, reason, text? }], missing: [{ itemId, sense }] }` — tolerant: code
  fences, prose around JSON, smart quotes, trailing commas, JSON Lines.
- `clozeParts(text) → { before, answer, after } | null`.
- `formMatchesWord(form, word) → boolean` (inflection-aware).
- `sentenceFromContext(item, now) → ClozeSentence | null` (finds the word
  form in `item.context` and brackets it).
- `coverage(list) → { total, covered, missing: [{ itemId, sense }] }`.

Reply format requested from Claude (one JSON code block):

```json
{"sentences":[{"w":4,"s":2,"text":"She [[acquitted]] herself well in her debut.","vi":"Cô ấy đã thể hiện tốt trong trận ra mắt."}]}
```

`w` = 1-based word number **as numbered in the prompt** (index + 1),
`s` = 1-based sense number.

### js/core/srs.js  (Leitner boxes)
`INTERVAL_DAYS = [0, 1, 3, 7, 14, 30]` indexed by box.
- `newProgress(itemId, listId)` → box 0, due 0.
- `review(progress, outcome, now)` → new object. `outcome`:
  `'right'` → box+1 (max 5), due = local midnight INTERVAL_DAYS[box] calendar
  days after today (DST-safe: `startOfDay(addDays(startOfDay(now), n))`);
  `'hinted'` → box unchanged (min 1), due = next local midnight;
  `'wrong'` → box 1, due = now. Updates seen/right/wrong/last.
- `practise(progress, outcome, now)` → what a practice session saves: like
  `review()`, except that `'right'` on a word that is not due yet (box ≥ 1,
  due > now) keeps its box and due date and only counts the answer — so
  practising a new list in every mode on day one does not make it "Mastered".
- `isDue(progress, now)`; `dueItems(progressList, now)` (sorted, most
  overdue/lowest box first); `boxLabel(box)`; `summary(progressList, now)` →
  `{ new, learning, review, mastered, due }`.

### js/data/store.js
```js
DEFAULT_SETTINGS
getLists(), getList(id), saveList(list), deleteList(id)
getProgress(itemIds?) -> Map<itemId, Progress>, getProgressForList(listId), saveProgress(progressArray)
getSettings(), setSetting(key, value)
addHistory(entry), getHistory({ listId, limit })
exportAll() -> object, importAll(object, { mode: 'merge' | 'replace' })  // replace = one transaction
onChange(fn) -> unsubscribe   // fired after any write: { store, id? }
isPersistentStorage() -> false when IndexedDB failed and data lives in memory only
```

### js/ui/dom.js
`h(tag, props?, ...children)` — `props`: `class`, `style` (object),
`dataset`, `on<Event>` handlers (`onClick`, `onInput`...), `ref` (callback),
any other key → attribute (boolean true → empty attribute, false/null →
omitted). Children: strings/numbers (→ text nodes), nodes, arrays, null.
Also `$(sel, root)`, `$$(sel, root)`, `clear(el)`, `onTap(el, fn)`
(click with pointer handling).

### js/ui/icons.js
`icon(name, { size = 22, class }) → SVGElement` — SF-Symbols-like line icons:
`plus chevronLeft chevronRight close check xmark speaker speakerSlash
lightbulb clipboard copy sparkles refresh trash share gear book books
calendar flame textCursor rectangleStack arrowRight arrowUturnLeft
pencil info listBullet circle checkCircle xCircle eye eyeSlash
square.and.arrow.down headphones quote shuffle play`.

### js/ui/components.js
```js
button({ label, icon, variant = 'primary' | 'secondary' | 'tinted' | 'plain' | 'destructive',
         size = 'large' | 'regular' | 'small', onTap, disabled, block })
iconButton({ icon, label, onTap })            // 44×44 round, aria-label
navBar({ title, back, actions })              // used by screen(); a back label over 12 chars shows as "Back"
screen({ title, largeTitle = true, back, actions, body, footer, className })
  -> { el, content, footer, setTitle(t) }    // large title collapses on scroll
section({ header, footer, children, inset = true })
row({ icon, iconBg, title, subtitle, detail, accessory = 'chevron'|'none'|Node, onTap, destructive })
segmented({ options: [{ value, label }], value, onChange })
toggle({ checked, onChange, label })
slider({ min, max, step, value, format, onChange })
textField({ value, placeholder, onInput, answer = false, enterkeyhint, ... })
textArea({ value, placeholder, rows, onInput, answer = false })
chip({ label, tone, onTap, selected, disabled })
badge(text, tone)
progressBar(fraction) -> { el, set(fraction) }
ring({ fraction, size, label })               // circular progress
emptyState({ icon, title, message, action })
card({ children, onTap, className })
alert({ title, message, actions: [{ label, style: 'default'|'cancel'|'destructive', value }] }) -> Promise<value>
confirm({ title, message, confirmLabel, destructive }) -> Promise<boolean>
actionSheet({ title, message, actions }) -> Promise<value | null>
sheet({ title, content, onClose, actions }) -> { el, close() }  // swipe down to dismiss
toast(message, { icon, tone, duration = 2200, action, className })
                                              // below the nav bar (or an open sheet's header); taps pass
                                              // through it except on the action button
```

### js/ui/router.js
Single navigation stack with iOS transitions.
```js
register(name, factory)    // factory(params, ctx) -> { el, onShow?, onHide?, onDestroy?, beforeLeave?, swipeBack?, missing? }
push(name, params, { modal = false })   // modal = full-screen cover from bottom, hides tab bar
pop()                                   // or closes the top modal
replace(name, params, opts)
resetTo(tabName)                        // switch tab root (today | lists | settings)
current() -> { name, params }
```
Pushed screens support an interactive left-edge swipe-back. The router
persists the serialisable stack (`name` + `params`) so the app comes back to
the same screen after iOS evicts it (e.g. while the user is in the Claude app).
A screen that returns `missing: true` (its list was deleted) ends the restore:
the app lands on the deepest screen that still exists.

### js/ui/viewport.js
Keeps `--app-h` / `--app-top` CSS vars in sync with `visualViewport` so the
whole app sits above the iOS keyboard; toggles `html.kb-open`; when the frame
shrinks, keeps the focused field in view. `keepVisible(el)` centres a field
once the keyboard is up; `revealField(el)` scrolls the nearest `.scroll` just
enough to clear `el` (uses layout offsets, so a running FLIP is no problem).

### js/ui/speech.js
`speak(text, { rate, voiceURI, lang = 'en-US' })`, `stop()`,
`englishVoices() -> Promise<SpeechSynthesisVoice[]>`, `supported`.

### js/ui/clipboard.js
`copyText(text) -> Promise<boolean>`, `readText() -> Promise<string | null>`.

### Practice engine (js/screens/practice/)
`session.js` owns the queue (wrong cards are re-queued at the end, max 2
extra tries; spaced repetition uses each item's **first-try** outcome).
`practice.js` owns the header (close, progress, counter) and the footer
(primary button → feedback banner → Continue). A **mode module** renders the
body of one card:

```js
// js/screens/practice/<mode>.js   (cloze | meaning | flashcard | family | dictation)
export function render(card, ctx) -> {
  el,                    // card body element (practice.js adds .practice-card)
  focus?(),              // called SYNCHRONOUSLY right after el is inserted —
                         // focus the answer field here so the iOS keyboard stays up
  check() -> Result|null,// primary button tapped while idle. Return a Result to
                         // finish the card, or null if the mode handled it
                         // (moved to another phase, or self-graded reveal)
  primaryLabel?: string, // initial footer label (default 'Check')
  readyInitially?: bool, // primary enabled from the start (default false)
  grade?(correct) -> Result, // self-graded modes: called by Knew it / Didn't know
  destroy?(),            // timers, listeners
}

ctx = {
  card, list, item, sentence /* cloze only */, items /* list.items */,
  settings,              // snapshot of store.settings()
  retry,                 // 0 first time, 1..2 when re-asked
  rng,
  speak(text),           // TTS with the user's voice/rate; call inside tap handlers
  setReady(bool),        // enable/disable the primary button
  setPrimaryLabel(text),
  submit(),              // same as tapping the primary button (Enter in a field)
  showGradeButtons(),    // self-graded: footer shows "Didn't know" / "Knew it"
}

Result = {
  correct: boolean,
  hinted?: boolean,      // correct but a hint was used → SRS keeps the box
  score?: number,        // 0..1 partial credit (family, dictation)
  close?: boolean,       // wrong but nearly right (a one-letter slip, half the family
                         // forms, ≥ 70% of a passage): the footer shows it in orange
  feedback?: { title?, detail? },  // footer banner; detail is clamped to 2 lines, so
                         // anything longer belongs in the card's reveal
  noAutoAdvance?: boolean,
}
```

After a Result the footer shows the banner (`data-state` right | close | wrong)
and Continue, which stays the accent button in every state. The card gets the
class `.checked`; the mode must already have
marked its own UI (green/red, revealed answer) and made inputs read-only
(keep focus in a typed field so Enter → Continue and the keyboard stays up).
When `settings.autoSpeak` is on, the mode speaks inside `check()` (it runs in
the tap handler, which iOS requires for speech).

Session params (router `push('practice', params, { modal: true })`):
`{ listId, mode }`, `{ listId, mode, itemIds }`, `{ mode: 'review' }`,
`{ mode: 'review', missed }`, `{ resume: true }` (see `getSnapshot()`).

Footer timing: after every footer change (Check → Continue, Show answer →
grade buttons, a new card) taps and Enter are ignored for 350 ms
(`.practice-footer.settling`), so the second tap of a double tap never acts
on the button that replaced the first. The session is saved (`commit()`) as
soon as the last card is answered, not when Continue is tapped.

Snapshot (`session.js`, one localStorage slot, 24 h): `answer()` saves it;
`getSnapshot()` returns an unfinished one; `liveCards(session, listsById)`
lists the remaining cards whose list/item/sentence still exist (Today, the
list page and resume hide or skip a session with none); `clearSnapshot(id?)`
clears it (with an id: only if it is that session); `recoverSnapshot()`
(launch, Today) saves and clears a snapshot that cannot continue — finished,
or every remaining card deleted; `commitPausedSession(id)` saves a different
paused session before a new session's first answer overwrites the slot.

## Input formats (parse.js)

1. **One-line** (main format, e.g. a Google Keep note):
   ```
   378.
   1. repository (n) /rɪˈpɑːzətɔːri/ : i) nơi lưu trữ ... ii) người nắm ...
   4. acquit (v): i) tuyên chính thức vô tội tại tòa. ii) tự mình thể hiện ...
   6. jolt (v): làm chuyển động mạnh bạo và bất ngờ. ii) khiến ai sốc ...
   9. unadorned (adj): tính không hoa lá màu mè - chỉ giản đơn mộc mạc [=plain]
   ```
   Number + `.`, `)` or `/`; optional `(pos)` (the last parenthesised group that is
   a part of speech); optional `/ipa/` before or after the pos (may contain
   `:`); separator `:` outside slashes/parentheses (spaces around it
   allowed); senses split on `i) ii) iii) iv) v) vi)` / `1) 2)` markers — the
   first sense may have no marker; ` - ` stays inside a sense; `[=x, y]` →
   synonyms. A bare number line (`378.`) or a non-entry first line is the
   title. Lines that do not start a new entry continue the previous entry.
2. **Block**: `1. word /ipa/` then `Definition:`, `Example:`,
   `Word family:`, `Synonyms:` lines.
3. **Family**: blank-line separated blocks, each numbered from 1:
   `1. strength (noun) /streŋkθ/: the quality of being strong` +
   `Example:` lines. IPA optional.
4. **Passage**: anything without numbered entries; blank-line separated
   paragraphs → one PassageItem each.
