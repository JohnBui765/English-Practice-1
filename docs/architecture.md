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
  sourceListId?: string,      // family lists made from a vocab list ("Make word families")
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

// FamilyItem — one word family. Old lists (pasted written out) have only
// { id, members } with members { word, pos, ipa, definition, example }; every
// other field is optional. See "Word families from Claude" below.
{
  id,
  root: string,               // the word the learner pasted ('' for families pasted written out)
  rootPos: string,            // normalised pos from the paste, may be ''
  rootMeaning: string,        // meaning from the paste (often Vietnamese), may be ''
  note: string,               // "Phrasal verb — it has no word family." ('' normally)
  members: [{                 // [] until Claude's reply is saved ("pending")
    word,                     // "authorize / authorise" — a slash lists accepted spellings
    pos, ipa,                 // ipa without slashes
    definition,               // English definition (written-out lists), may be ''
    vi,                       // short Vietnamese meaning, may be ''
    hint,                     // 1–3 word English hint for members sharing a pos, may be ''
    example,                  // Claude's contain exactly one [[form]]; written-out ones none
    exampleVi,                // translation of the example, may be ''
  }],
}

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
  familyTranslate: true,      // ask Claude for Vietnamese translations of family examples
  ignoreAccents: false,
  sentencesPerSense: 1,       // 1 | 2
  level: 'B2',                // 'B1' | 'B2' | 'C1' — for the sentence and family prompts
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
- `detectFormat(text)` → `'oneline' | 'block' | 'family' | 'passage' | 'wordlist'`.
- `KIND_BY_FORMAT` (frozen) → `{ oneline: 'vocab', block: 'vocab', family: 'family',
  passage: 'passage', wordlist: 'family' }`.
- `parseList(text, { kind, roots } = {})` →
  `{ kind, format, title, items, warnings: [{ line, text, reason }] }`.
  `kind` forces 'vocab' | 'family' | 'passage'; otherwise auto.
  `{ kind: 'family', roots: true }` and an auto-detected word list give
  `format: 'roots'` (pending FamilyItems); `{ kind: 'family' }` alone reads
  written-out families (`format: 'family'`). See the "Input formats" section.

### js/core/json.js
Tolerant JSON reading shared by cloze.js and families.js (code fences, prose
around the JSON, smart quotes, trailing commas, raw line breaks, JSON Lines,
several code blocks, replies cut off half-way): `parseLoose(s)`,
`isObject(v)`, `firstDefined(obj, keys)`, `readJsonReply(text, { extract,
salvage })`, `salvageFlatObjects(text, accept)`, `salvageNestedObjects(text,
extract)`, `toNumber(v, { roman })`.

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
- `bracketFirstForm(text, word) → { text, answer } | null` (wraps the first
  form of `word` in `[[ ]]`), `tidyText(s)` (tidies a sentence and its `[[ ]]`).

Reply format requested from Claude (one JSON code block):

```json
{"sentences":[{"w":4,"s":2,"text":"She [[acquitted]] herself well in her debut.","vi":"Cô ấy đã thể hiện tốt trong trận ra mắt."}]}
```

`w` = 1-based word number **as numbered in the prompt** (index + 1),
`s` = 1-based sense number.

### js/core/families.js  (word families come from Claude too)
- `buildFamilyPrompt(list, { level = 'B2', translate = true, only = null })
  → string` — `only`: item ids to ask for (e.g. `familyStatus(list).pending`);
  word numbers stay index + 1. `''` when nothing is asked for.
- `parseFamilyReply(text, list) → { families: [{ itemId, members, note }],
  problems: [{ ref, reason, text?, skipped }], missing: [itemId] }` — see
  "Word families from Claude" below.
- `applyFamilies(items, families) → items` (new array): members and note
  replaced, `root` / `rootPos` / `rootMeaning` filled in.
- `rootsText(items) → string`: the families as roots in the one-line format
  ("1. authority (n): quyền lực"; a family pasted written out by its model
  member), which `parseList(text, { kind: 'family', roots: true })` reads back.
- `familyStatus(list) → { total, ready, pending: [itemId] }`,
  `isFamilyReady(item)` (2+ members, or 1 member plus a note).
- `memberForms(member) → string[]` (the spellings in `word`, first = shown),
  `memberBlank(member) → { before, answer, after } | null`,
  `modelIndex(item) → number` (the member that is the root, else 0).
- `checkFormation(input, answer, member, { ignoreAccents, members })
  → { correct, close, rightWordWrongForm, otherMember? }`.

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
`icon(name, { size = 22, className, label }) → SVGElement` — SF-Symbols-like line icons:
`plus minus chevronLeft chevronRight chevronDown close xmark check speaker
speakerSlash lightbulb clipboard copy sparkles refresh trash share download
upload gear book books sun calendar flame keyboard arrowRight arrowUturnLeft
pencil info listBullet circle checkCircle xCircle eye eyeSlash headphones
quote shuffle play search ellipsis target family blank cards textInput mic
clock star trophy bolt moon link externalLink phone homeAdd` (`iconNames`).

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
posBadge(pos)                                 // "noun" badge from a pos abbreviation; null for ''
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
once the keyboard is up; `revealField(el, { above })` scrolls the nearest `.scroll` just
enough to clear `el` (uses layout offsets, so a running FLIP is no problem);
`above` (e.g. the sentence a field answers) is kept in view too when both fit.

### js/ui/speech.js
`speak(text, { rate, voiceURI, lang = 'en-US' })`, `stop()`,
`englishVoices() -> Promise<SpeechSynthesisVoice[]>`, `supported`.

### js/ui/clipboard.js
`copyText(text) -> Promise<boolean>`, `readText() -> Promise<string | null>`.

### Practice engine (js/screens/practice/)
`session.js` owns the queue (wrong cards are re-queued at the end, max 2
extra tries; spaced repetition uses each item's **first-try** outcome, and
only In context, Meaning → Word and Word → Meaning cards update it — Word
families, Word formation and Dictation practise forms or passages, not the
item's own word).
`practice.js` owns the header (close, progress, counter) and the footer
(primary button → feedback banner → Continue). A **mode module** renders the
body of one card:

```js
// js/screens/practice/<mode>.js   (cloze | meaning | flashcard | family | formation | dictation)
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
`{ listId, mode }`, `{ listId, mode, itemIds }`, `{ listId, mode: 'formation',
itemIds, members: [{ itemId, word }] }` (only those family members — "Practise
mistakes" after Word formation), `{ mode: 'review' }`, `{ mode: 'review',
missed }`, `{ resume: true }` (see `getSnapshot()`).

`MODES` (session.js) lists every mode with `{ key, label, short, icon, color,
kinds }`; the list page shows the modes whose `kinds` include the list's kind,
in that order. `buildCards(list, mode, { itemIds, members, rng })` makes the
cards; a card is `{ listId, type, itemId, sentenceId? }`, and a Word
formation card also has `member` (index) and `word` (the member's word, so
deleting another member never swaps the question). `summarize(session).missed`
is `[{ itemId, listId, members? }]` — `members: [{ member, word }]` for Word
formation.

Footer timing: after every footer change (Check → Continue, Show answer →
grade buttons, a new card) taps and Enter are ignored for 350 ms
(`.practice-footer.settling`), so the second tap of a double tap never acts
on the button that replaced the first. The session is saved (`commit()`) as
soon as the last card is answered, not when Continue is tapped.

Snapshot (`session.js`, one localStorage slot, 24 h): `answer()` saves it;
`getSnapshot()` returns an unfinished one; `liveCards(session, listsById)`
lists the remaining cards that can still be shown — `cardResolves(card,
listsById)`: the list and item exist, plus the sentence (cloze), 2+ members
(Word families) or the member with a blank (Word formation) — so Today, the
list page and resume hide or skip a session with none; `clearSnapshot(id?)`
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
4. **Word list** (`'wordlist'` → a family list of roots for Claude): every
   item is 1–4 words with no sentence punctuation and no `:` meaning — one per
   line (plain, numbered or bulleted) or separated by commas/semicolons:
   ```
   Families 12
   authority
   demonstrate
   come up with
   ```
   An optional title line: a heading (`378.`), a short line with a number
   (`Families 12`), a line ending in `:`, or a capitalised line with a blank
   line before lower-case words. Most items must be one word or start with a
   small letter, so a to-do list ("1. Wake up early") stays a passage.
   With **Families → Make with Claude** the one-line format (`root` = word,
   `rootPos`, `rootMeaning` = senses joined with "; ", synonyms left out),
   the block format (Definition), each numbered line of written-out families and
   `word: / - / = / → meaning` lines are read as roots too. Duplicates are
   dropped ignoring case (the first is kept); a mid-list `379.` heading is
   skipped; other lines give the warning "Not a word or a short phrase".
5. **Passage**: anything else without numbered entries; blank-line separated
   paragraphs → one PassageItem each.

## Word families from Claude

The learner pastes plain root words (or any of their usual list formats);
the app turns them into a **family list whose families are still empty**,
and the "Make word families" screen gets the families from the Claude app
with the same copy-prompt / paste-reply flow as sentences ("route B").
Two practice modes use them: **Word families** (type every form) and
**Word formation** (type the form a sentence needs).

### Data
`FamilyItem` gains `root`, `rootPos`, `rootMeaning` and `note`, and members
gain `vi`, `hint` and `exampleVi` (see "Data model"; all optional, so lists
pasted written out keep working). A family list made from a vocabulary list
remembers it in `sourceListId`. A family is **ready** when it has ≥ 2
members, or exactly 1 member plus a `note` (no real family); otherwise it is
**pending** (`members: []` until Claude's reply is saved).

### Parsing (js/core/parse.js)
- `detectFormat` returns `'wordlist'` for plain word lists (input format 4);
  `KIND_BY_FORMAT.wordlist = 'family'`.
- `parseList(text, { kind: 'family', roots: true })` (and auto-detected word
  lists) returns `{ kind: 'family', format: 'roots', title, items, warnings }`,
  items `{ id, root, rootPos, rootMeaning, note: '', members: [] }`.
- `parseList(text, { kind: 'family' })` without `roots` keeps the written-out
  family parsing.

### Prompt and reply (js/core/families.js)
The prompt is the one agreed with the owner (locked word for word by
`tests/unit/families.test.js`): 3–6 common members sharing the core meaning,
include the root, no rare/technical forms or look-alikes, at most one very
common negative form, American IPA, Vietnamese meaning, hints only when two
members share a pos, both spellings when US/UK differ, one natural 10–20
word example per member with typical collocations, sentences set in one
situation when natural but never forced, the member bracketed `[[form]]`, a
"note" for words with no family, Vietnamese example translations when
`translate`, reply as one JSON code block
`{"families":[{"w":1,"note":"","members":[{"word","pos","ipa","hint","vi","example","example_vi"}]}]}`
(the format line shows where "note" goes).
`w` is the word number in the prompt (index + 1, also with `only`). A family
pasted written out (root `''`) is asked for by its model member.

`parseFamilyReply` is as tolerant as `parseReply` (js/core/json.js) and
validates: word required; members deduped by normalised word; an example
must contain exactly one `[[…]]` whose content `formMatchesWord` accepts for
the member word (slash spellings allowed) — otherwise the member is
auto-bracketed in its example, else kept with an unbracketed example and a
problem. If Claude echoes the format line back it is ignored; a family
without `w` is matched by its root word (or to the only item); when the same
`w` comes twice, the later members win. A "note" may also come inside the
only member; a family with a note and no members gets the word itself as its
one member (word = root, pos = rootPos).
- Word numbers are checked against the family's forms. A family that
  contains its own word stays. One that does not (numbered 1, 2 for words 2
  and 4, counted from 0, swapped, no `w`, or a number not in the list) moves
  to the one word whose root it contains, preferring words still pending
  (problem `'Came back as word 1 — matched by its forms.'`, skipped false).
  Otherwise it is kept, flagged ("… is not in this family — is the word
  number right?", skipped false), only on a pending word that is in no other
  family; else it is skipped with that reason (or "There is no word 9 in this
  list." / "A family has no word number") — so it never replaces a saved family.
- `problems: [{ ref, reason, text?, skipped }]`, sorted by word number:
  `ref` is `null`, `'w2'`, `'w2 member 3'` or `'"root"'` (a family named by
  an unknown word); `skipped: true` = the family or member is left out,
  `false` = kept with a flaw (no example, an example without a blank, one word
  and no note, the root not in the family). An unreadable reply gives exactly
  `[{ ref: null, reason: 'Could not read the reply — copy the whole JSON block from Claude.' }]`.
- `missing`: ids of items that would still be pending after saving the reply
  (a ready family absent from the reply is not missing; a one-member family
  without a note is in `families` and in `missing`).

`checkFormation(input, answer, member, { ignoreAccents, members })`:
a leading "to " or article the answer does not start with is ignored;
`correct` = the answer or an accepted spelling (slash spellings, British
`-ise/-isation/-yse` of an American answer, the British doubled l of a family
word ending in one vowel + l: traveled → travelled); `rightWordWrongForm` = another
form of the member word ("authorize" for "authorized") — wrong, since the
form is the point; `close` = a slip of 1 letter (≤ 5 letters) or 2 (longer),
or accents only — never another form, a negative (`un/in/im/il/ir/dis/non/mis`
+ the answer) or, with `members`, another family member (`otherMember` is
then its index, else -1).

### Screens
- **Import**: with type Families (chosen, or detected under Auto) a second
  control "Make with Claude" / "Already written" appears. It follows the text
  (written-out family blocks → Already written, anything else → Make with
  Claude) until the learner taps it; the choice is kept in the draft. Roots
  preview: "5 words — Claude will build their families next", footer
  "Save 5 words". Editing a family list keeps ids, members and notes of the
  words that did not change; a new word arrives pending. Edit list opens a
  list of Claude's families on "Make with Claude" when its text reads back as
  the same roots; when it does not (families pasted written out and rebuilt
  by Claude since) the text is rebuilt with `rootsText`. Read as written-out
  families, a family whose text is unchanged since saving keeps what was
  saved for it (Claude's members, forms removed in the family sheet).
  Emptying the text (or the Paste button replacing it) lets the next text
  pick the family mode again; the title is only taken from text with items.
- **families** screen (`push('families', { listId })`, family lists only)
  mirrors Sentences: status ring (ready / total), step 1 Copy prompt (Level,
  "Vietnamese translations" = setting `familyTranslate`, "Redo every family"
  shown once some are ready and off by default — otherwise only pending words
  are asked for), Open Claude, Show prompt; step 2 Paste reply with a live
  check (ready / skipped / "Kept, but worth a check" / "No families found" /
  "This is the prompt, not the reply" / "Still missing: …" with "Copy prompt
  for the missing ones", which copies first and then saves the ready
  families — not one flagged "is the word number right?", which it asks
  for again); footer "Save 5 families"; a collapsible "Families" list. Only
  **complete** families are saved: a lone word without a note is listed under
  "… will be skipped" and never replaces a saved family, and a word whose
  family is already saved is never "Still missing". Copy prompt is disabled
  while every word has its family and Redo is off; saving writes
  `applyFamilies(latest.items, families)`.
  localStorage: `vs.families.draft.<listId>` (reply text),
  `vs.families.redo.<listId>` (`{ redo, at }`, 12 h),
  `vs.families.copied.<listId>` (time of the last copy: the screen opens at
  step 2 for an hour); saving clears all three.
- **List detail** of a family list: hero "Make word families" (button "Make
  families", or "2 of 5 families ready" + "Finish the families") while any
  family is pending, else a compact "5 families · 21 forms" row; modes Word
  families + Word formation (an empty mode reads "Needs families" / "Needs
  examples" and opens the families screen, its icon dimmed); rows show the
  other forms, or the meaning with a "Waiting" badge in the title (no badge
  while every family is waiting); the family sheet shows every member (pos,
  IPA, Vietnamese, hint, example with the form in bold, translation, speaker)
  and lets the learner remove a doubtful member (confirm first). Removing the
  first form of a family pasted written out stores its name as `root` /
  `rootPos`, so the family keeps its name and can be asked for again.
- **List detail** of a vocabulary list: "Make word families" in the … menu
  and as a row under Practise ("From these 11 words"; aria-label "Make word
  families from these words"). It creates a linked family list
  (`sourceListId`, title "<list> · families", rawText in the one-line format
  so Edit list reads the same roots) and opens its families screen; once it
  exists the row reads "Word families" with its status and opens that list.
  A linked list is not updated when the vocabulary list changes later.

### Practice
- `MODES.formation = { key: 'formation', label: 'Word formation', short: 'Use
  the right form', icon: 'textInput', color: 'var(--purple)', kinds: ['family'] }`
  (right after `family`; purple is also Word → Meaning's, which only shows on
  vocabulary lists).
- `buildCards(list, 'formation')`: one card per member with a blank, in
  families of 2+ members, skipping a member whose blank is just the root →
  `{ type: 'formation', listId, itemId, member, word }`. `familyRoot(item)`,
  `formationMembers(item)` and `formationTarget(card, item)` (session.js)
  find the root, the members with a card and a card's member (by `word`).
- formation.js: caption "WORD FORMATION", the root in capitals, the example
  with a blank, a typed answer field (focused; Enter checks). Hints: 1) the
  part of speech needed + the Vietnamese meaning, 2) the family's forms as
  chips that fill the field without dropping the keyboard (not the member
  asked for when the sentence needs it unchanged), 3) the first letter. Results: right, "Right word, wrong form" ('The sentence needs
  "x".'), "Almost — check the spelling" (orange) or "Not quite". After Check:
  the answer in the blank, the translation, the member with IPA and speaker;
  autoSpeak reads the sentence. "Practise mistakes" asks only the missed
  members.
- family.js uses `modelIndex`, labels two members with the same pos by
  Claude's hints when every member of that pos has a different one (else the
  contextual/numbered labels), shows the model's Vietnamese meaning, and after
  Check shows each example (form in bold) and its translation. Families with
  fewer than 2 members are skipped.
- Neither mode updates spaced repetition.
