# Persona Gaps and Humanizer — Implementation Plan (Plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six gaps the 2026-09-10 review found in Byline's "personalised post, in a persona's voice, on the user's own platforms" objective, then build the humanizer pass into the brief and the scorer so every article reads like its author and not like a model.

**Architecture:** Six phases, each shippable alone, in the order the user set: voice samples → taxonomy → article ledger → series planner → export platforms and a LinkedIn API platform → humanizer. Nothing here changes the rule that the host model writes and Byline touches the outside world. Every new rule lives in exactly one place — the scorer's arrays feed the brief's text, the profile drives platform-specific prose, the plugin registry is the only place a platform is wired in. `src/cli/` gains no platform branch.

**Tech Stack:** TypeScript (ESM, `node:` builtins only), zod 4, `yaml`, `@modelcontextprotocol/sdk`, vitest. No new runtime dependencies.

**Decisions taken by the user on 2026-09-10:** gap 3 (post read tools) and gap 9 (restrictive WordPress probe) are out of scope. Platforms: Medium, Substack, LinkedIn — no fourth. Medium and Substack are copy-and-paste exports into `~/Documents/byline-post/`. LinkedIn is both an export (articles) and an API-connected feed post that summarises a published article, links back to it, carries its hero image and hashtags, for a person or an organisation. Ghost newsletter email is exposed and OFF unless the user asks.

## Global Constraints

- **Node ≥ 20**, ESM, `.js` extension on every relative import.
- **`src/cli/` gains no platform-, provider- or library-specific branch.** Two named exceptions exist today (`status`'s legacy `imageProviders`, `doctor`'s `generate_image` warning); this plan adds none.
- **One rule, one definition.** Every list the brief prints and the scorer grades is one exported array in `src/craft/score.ts`, imported by `src/craft/brief.ts`. Every threshold is in `THRESHOLDS`. No retyped copies, in code or in prose.
- **Never encode an unverified external fact.** LinkedIn's API shapes, Medium's, Substack's and LinkedIn's paste behaviour are UNVERIFIED at the time of writing. Mark them `UNVERIFIED` in code comments, in `HtmlProfile.verified: false`, in the platform README and in `docs/platforms/*.md`. Do not remove a marker without a probe.
- **`healthCheck()` must gate on something that genuinely requires the credential.** For an export platform there is no credential; the check verifies the folder is writable and *says that is all it verifies*.
- **Nothing fails silently.** Unsupported fields produce a warning naming the field. A ledger write that fails produces a warning on the publish result, never a failed publish.
- **Secrets never appear in `config.yaml`.** `CredentialField.secret` decides `.env` versus literal, through `buildSiteBlock` only.
- **Assume a profile's collections can be empty.** Three new profiles have no `table` in `visualContainers`. Read the English the brief and scorer produce for each one.
- **Never hardcode a future date in a test.** Derive from `Date.now()`.
- **Never write `process.env = { ...saved }`.** Restore per key.
- **No test deleted or weakened.** Floor is stated in `CLAUDE.md` only; raise it there when the suite grows.
- **No AI attribution trailers on commits.** No `Co-Authored-By`, no `Claude-Session`, no generated-with footer. Author and committer are the user.
- Run after every task: `npm run typecheck && npm test && npm run build`.
- **Read the actual brief and the actual scorecard** after every phase that touches `src/craft/`. `npx tsx` a small script that calls `buildBrief` with each profile and prints it; read the English.

## Pre-existing defect to fix first (Task 0)

`tests/tools.test.ts` lines 2593–2733 hardcode `2026-09-04` as a scheduled publish time. It is in the past, so three tests fail on a clean tree. Replace with a date derived from the clock.

---

## File structure

| Phase | File | Responsibility |
|---|---|---|
| 0 | `tests/tools.test.ts` | future-date fixtures derived from `Date.now()` |
| 1 | `src/craft/voice.ts` | `voiceFingerprint`, `compareVoice` — measurable rhythm facts about a text |
| 1 | `src/craft/brief.ts` | `voice_samples` wired extra, VOICE SAMPLES block |
| 1 | `src/craft/score.ts` | `voice_rhythm` advisory check |
| 1 | `src/tools/craft-tools.ts` | `score_draft` gains optional `persona` |
| 1 | `personas/_template.yaml`, `README.md` | document `voice_samples` |
| 2 | `src/plugins/platforms/types.ts` | `categories`, `newsletter`, `email_segment` on `PostInput`; optional `listNewsletters` on adapter |
| 2 | `src/plugins/platforms/ghost/index.ts` | newsletter query params, `GHOST_UNSUPPORTED_FIELDS`, `listNewsletters` |
| 2 | `src/plugins/platforms/wordpress/index.ts` | `resolveTermIds` generalising tags to categories; unsupported newsletter |
| 2 | `src/tools/post-tools.ts`, `src/tools/site-tools.ts` | schema fields; `list_newsletters` tool |
| 3 | `src/config/atomic.ts` | `writeJsonAtomic` extracted from `src/media/store.ts` |
| 3 | `src/articles/types.ts`, `store.ts`, `ledger.ts` | per-persona article ledger |
| 3 | `src/craft/brief.ts`, `src/craft/dimensions.ts` | anti-repeat draw, RECENT ARTICLES block |
| 3 | `src/tools/craft-tools.ts`, `src/tools/post-tools.ts`, `src/tools/persona-tools.ts` | read ledger for brief; write ledger on publish; article counts |
| 4 | `src/craft/series.ts` | `planSeries` — distinct seeds per slot |
| 4 | `src/tools/craft-tools.ts` | `plan_series` tool; `series` passthrough |
| 4 | `.claude/commands/write-series.md` | N-article flow |
| 5 | `src/plugins/platforms/export/{adapter,handoff-page,markdown,types}.ts` | shared export engine |
| 5 | `src/plugins/platforms/{medium,substack,linkedin-article}/` | export plugins, one folder each |
| 5 | `src/plugins/platforms/linkedin/` | API plugin (feed post) |
| 5 | `src/craft/html-profile.ts` | `kind: 'article' \| 'social'` |
| 5 | `src/craft/dimensions.ts`, `src/craft/brief.ts` | no-table variants; LINKEDIN POST section; HAND-OFF note |
| 5 | `src/plugins/registry.ts` | four new lines |
| 5 | `docs/platforms/{medium,substack,linkedin}.md`, plugin READMEs, `README.md`, `CONTEXT.md`, `docs/ADDING-A-PLATFORM.md` | help files and architecture notes |
| 6 | `src/craft/score.ts` | graduated lexicon, `HUMANIZER_PATTERNS`, seven new advisory checks, `CHECK_GUIDANCE` |
| 6 | `src/craft/brief.ts` | HUMANISING rewritten from the arrays; REVISION PASS section; conflict rules |
| 6 | `src/craft/schema.ts`, `src/tools/post-tools.ts` | `datePublished`, `inLanguage`, author `sameAs` |
| 6 | `.claude/skills/humanizer/SKILL.md`, `.gitignore` | the attributed skill, tracked |
| all | `CHANGELOG.md`, `CLAUDE.md` floor | per phase |

---

## Phase 0 — Fix the time-bomb test

### Task 0: Derive scheduling fixtures from the clock

**Files:**
- Modify: `tests/tools.test.ts:2586-2740`

- [ ] **Step 1:** At the top of the `describe('a wall-clock publish_at is read in the blog’s timezone')` block add:

```ts
// A wall-clock date ten days out, with no offset. Hardcoding `2026-09-04`
// here expired on 2026-09-04 and failed three tests on a clean tree.
const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
const ymd = future.toISOString().slice(0, 10); // YYYY-MM-DD
const wall = `${ymd}T10:00`;
```

- [ ] **Step 2:** Replace every `'2026-09-04T10:00'` with `wall`, `'2026-09-04T10:00:00Z'` with `` `${ymd}T10:00:00Z` ``, and each expected instant with a computed one. For Asia/Kolkata: `` `${ymd}T04:30:00.000Z` ``; Asia/Dubai: `` `${ymd}T06:00:00.000Z` ``; local echo: `` `${ymd} 10:00:00 (Asia/Kolkata)` ``. Line 2593's `publish_at: '2026-09-04T09:00:00Z'` becomes `` `${ymd}T09:00:00Z` `` with the same `ymd` hoisted to that describe.

- [ ] **Step 3:** Run `npx vitest run tests/tools.test.ts` → expect `131 passed`.

- [ ] **Step 4:** Run `npm test` → expect `1263 passed`. Commit: `test: derive scheduling fixtures from the clock`.

---

## Phase 1 — Voice samples (gap 1)

A persona is all adjectives today. This phase lets the author paste two paragraphs of their own writing, renders them into the brief with measured facts about them, and lets `score_draft` compare a draft's rhythm against them.

### Task 1.1: `src/craft/voice.ts`

**Files:**
- Create: `src/craft/voice.ts`
- Test: `tests/craft/voice.test.ts`

**Interfaces (produces):**

```ts
export interface VoiceFingerprint {
  sentences: number;
  meanLength: number;      // words per sentence, 1 decimal
  sd: number;              // sentence-length standard deviation, 1 decimal
  contractionRate: number; // share of sentences containing an apostrophe contraction, 0..1
  firstPersonRate: number; // share of sentences containing I/we/my/our/me/us, 0..1
}
export function voiceFingerprint(text: string): VoiceFingerprint;
export function compareVoice(sample: VoiceFingerprint, draft: VoiceFingerprint): { ok: boolean; findings: string[] };
export function normaliseSamples(raw: string | undefined): string[]; // splits on blank lines; trims; drops empties
```

Rules in `compareVoice` (all from `THRESHOLDS`, added in this task to `score.ts`: `voiceLengthTolerance: 0.35`, `voiceContractionHigh: 0.2`, `voiceContractionLow: 0.05`):
- `meanLength` of draft outside `sample.meanLength × (1 ± voiceLengthTolerance)` → finding `Sentences average N words; the author's samples average M. Shorten/lengthen toward that.`
- `sample.contractionRate ≥ voiceContractionHigh && draft.contractionRate < voiceContractionLow` → `The author contracts in X% of sentences; the draft in Y%. Write "doesn't", not "does not".` and the mirror case.
- `ok` when `findings.length === 0`. Sentence splitting uses the same regex as `score.ts`'s `sentences()`; export that helper from `score.ts` rather than copying it.

- [ ] **Step 1:** Write tests: fingerprint of a known 4-sentence text has `sentences: 4`, correct mean; contraction rate 0.5 for a text where two of four sentences contain `don't`/`it's`; `compareVoice` returns a finding for a 9-word-mean draft against a 20-word-mean sample and none for 18 vs 20; `normaliseSamples` of `"a\n\nb\n\n\n"` is `['a','b']`.
- [ ] **Step 2:** Run, expect failure on missing module. Implement. Run, expect pass.

### Task 1.2: Brief renders VOICE SAMPLES

**Files:**
- Modify: `src/craft/brief.ts` (`WIRED_EXTRAS`, new `voiceBlock(p)` rendered directly after `SPECIFIC AUTHOR INSTRUCTIONS`)
- Test: `tests/craft/brief.test.ts`

Block text (exact):

```
=== VOICE SAMPLES — HOW THIS AUTHOR ACTUALLY WRITES ===
Below are passages the author wrote. They are the voice; everything else in this
brief is a default. Match their rhythm, sentence length, diction and use of
contractions. Where a sample contradicts a TEXTURE or HUMANISING instruction, the
sample wins. Never quote, reuse or paraphrase a sentence from them, and never
mention that samples exist.
Measured from the samples: {n} sentences, {mean} words per sentence on average,
spread {sd}, contractions in {pct}% of sentences, first person in {fp}%.

--- sample 1 ---
{text}
--- sample 2 ---
{text}
```

- [ ] Tests: persona with `voice_samples` (YAML list of two strings) renders the header and both samples and the measured line; persona without it renders no `VOICE SAMPLES` text; `voice_samples` does not appear in `ADDITIONAL AUTHOR DIRECTION`.

### Task 1.3: `score_draft` gains `persona` and a `voice_rhythm` check

**Files:**
- Modify: `src/craft/score.ts` (`scoreDraft` signature gains `opts?: { voiceSample?: VoiceFingerprint }`), `src/tools/craft-tools.ts`
- Test: `tests/craft/score.test.ts`, `tests/tools.test.ts`

Check: `name: 'voice_rhythm'`, `blocking: false`. With no sample → `ok: true, evaluated: false, detail: 'no persona with voice_samples passed — not evaluated'`. With a sample → `compareVoice` result.

`score_draft` input: `persona: z.string().optional().describe('Persona slug. When that persona has voice_samples, the draft's sentence rhythm is compared against them (voice_rhythm). Without it that check reports "not evaluated".')`.

- [ ] Tests: score without persona → `voice_rhythm.evaluated === false`; through the tool layer with the `jane-doe` fixture extended with `voice_samples`, a draft of uniformly 8-word sentences against 22-word samples → `voice_rhythm.ok === false` with a finding naming both numbers. Update the "thirteen" count in the `score_draft` description — replace the literal with `${CHECK_NAMES.length}` where `CHECK_NAMES` is a new exported `readonly string[]` in `score.ts`; add a test that `scoreDraft` returns exactly `CHECK_NAMES` in order.

### Task 1.4: Docs

- [ ] `personas/_template.yaml`: add to the wired list comment `voice_samples — two or three passages of your own writing; the brief carries them and score_draft compares rhythm against them`, and a commented example block using a YAML list of two `|`-strings.
- [ ] `README.md` "Author personas": one paragraph, "Give it two paragraphs you actually wrote", stating exactly what is compared (sentence length, contraction use) and that nothing else about voice is machine-checked.
- [ ] `CHANGELOG.md` Unreleased → Added. Commit: `feat(craft): persona voice_samples, rendered into the brief and compared by score_draft`.

---

## Phase 2 — Taxonomy: WordPress categories, Ghost newsletter (gap 4)

### Task 2.1: Widen `PostInput`; map in both adapters

**Files:**
- Modify: `src/plugins/platforms/types.ts`, `ghost/index.ts`, `wordpress/index.ts`
- Test: `tests/plugins/platforms/ghost.test.ts`, `wordpress.test.ts`

`PostInput` additions:

```ts
/** Category names. WordPress resolves them to term ids; platforms without categories warn and drop. */
categories?: string[];
/** Ghost newsletter slug. When set on a publish or schedule, Ghost EMAILS the post. Never set by default. */
newsletter?: string;
/** Ghost segment filter: 'all' | 'status:free' | 'status:-free' | a label filter. Requires `newsletter`. */
email_segment?: string;
```

`PlatformAdapter` gains `listNewsletters?(): Promise<Array<{ id: string; name: string; slug: string; status: string }>>`.

Ghost:
- `toGhostPost` drops `categories`, `newsletter`, `email_segment` from the body (they are not body fields).
- `createPost`/`updatePost` build the path: `posts/?source=html` plus `&newsletter=${encodeURIComponent(slug)}` plus `&email_segment=${encodeURIComponent(seg)}` when `newsletter` is set AND `status` is `published` or `scheduled`. On a `draft`, do not send them and push warning `newsletter: ignored on a draft — Ghost emails only when a post is published or scheduled. Pass newsletter again on the update_post that publishes it.`
- `email_segment` without `newsletter` → `ToolError` code `NEWSLETTER_REQUIRED`.
- New `GHOST_UNSUPPORTED_FIELDS: Record<string,string> = { categories: 'Ghost has no categories — use tags. Nothing was sent for this field.' }` producing warnings the same way WordPress's `UNSUPPORTED_FIELD_REASONS` does.
- Read-back: when `newsletter` was sent on a publish, and the returned post's `newsletter` is null/undefined, warn `newsletter: Ghost returned no newsletter on the post; the email may not have been queued. Check Ghost Admin → Posts → this post → Email.` Mark in a comment: **UNVERIFIED that Ghost echoes `newsletter` on the create response — confirm with a live draft probe and record the row in `docs/GHOST-NOTES.md`.**
- `listNewsletters`: `GET newsletters/?limit=all` → map `{id,name,slug,status}`.

WordPress:
- Rename `resolveTagIds(names)` to `resolveTermIds(taxonomy: 'tags' | 'categories', names)` with the identical exact-match-then-create logic against `wp/v2/${taxonomy}`; keep a `resolveTagIds` wrapper so existing tests and call sites compile. `createPost`/`updatePost` set `body.categories = ids` when given.
- `UNSUPPORTED_FIELD_REASONS` gains `newsletter` and `email_segment`: `WordPress core has no newsletter; nothing was sent.`
- `listNewsletters` not implemented (leave undefined).

- [ ] Tests (mocked fetch, through the adapters): Ghost publish with `newsletter:'weekly'` hits a URL containing `newsletter=weekly`; Ghost draft with newsletter does NOT include the param and warns; `email_segment` alone throws `NEWSLETTER_REQUIRED`; Ghost with `categories` warns and body has no `categories` key; WordPress `categories:['Engineering']` GETs `wp/v2/categories?search=Engineering` and sends `categories:[id]`; WordPress with `newsletter` warns naming the field.

### Task 2.2: Tool layer

**Files:**
- Modify: `src/tools/post-tools.ts` (both tools), `src/tools/site-tools.ts` (`list_newsletters`)
- Test: `tests/tools.test.ts`

Schema additions to `create_post` and `update_post`:

```ts
categories: z.array(z.string()).optional().describe('Category names, for platforms that have categories (WordPress). Others warn and ignore.'),
newsletter: z.string().optional().describe('Ghost only. The slug of the newsletter to EMAIL this post to when it publishes. OFF unless set — never set it unless the user asked for the post to be emailed. Run list_newsletters to see slugs.'),
email_segment: z.string().optional().describe("Ghost only, with newsletter. 'all', 'status:free', 'status:-free' (paid), or a label filter. Defaults to Ghost's own default when omitted."),
```

`list_newsletters({site})`: calls `adapter.listNewsletters` when present; otherwise `ToolError` code `UNSUPPORTED` message `${label} has no newsletters.`

- [ ] Tests: through `callWith`, `create_post` with `categories` reaches the WordPress body (this is the MCP-strips-unknown-keys class of defect — assert on the request body, not the adapter); `newsletter` reaches the Ghost URL; `list_newsletters` on the WordPress fixture returns `UNSUPPORTED`.

### Task 2.3: Brief JSON contract and docs

- [ ] `brief.ts` OUTPUT FORMAT: add `"categories": ["one or two broad categories — used where the platform has them, ignored elsewhere"],` after `tags`.
- [ ] `docs/GHOST-NOTES.md`: add a row `newsletter= / email_segment= query params — UNVERIFIED: shapes from Ghost's Admin API docs; the create-response echo of newsletter has not been probed. Do not promote.` `docs/WORDPRESS-NOTES.md`: row for `wp/v2/categories?search=` — note the substring-match behaviour is assumed identical to tags until probed (mark UNVERIFIED).
- [ ] `README.md` "How it works": two sentences on categories and on email ("Byline never emails your subscribers unless you say so.").
- [ ] Integration: `tests/integration/ghost.integration.test.ts` gains `listNewsletters` returns ≥1 on the configured blog, and a DRAFT created with `newsletter` set carries no `email` object and is deleted. **Do not write a test that publishes with a newsletter**; that sends real email.
- [ ] CHANGELOG. Commit: `feat(platforms): WordPress categories; Ghost newsletter email, off by default`.

---

## Phase 3 — Article ledger: memory across articles (gap 2)

### Task 3.1: Extract `writeJsonAtomic`

**Files:**
- Create: `src/config/atomic.ts` with `export function writeJsonAtomic(file: string, data: unknown): void` — the body of `writeAtomic` in `src/media/store.ts`, verbatim including the cleanup comment.
- Modify: `src/media/store.ts` imports it; delete the private copy.
- Test: `tests/config/atomic.test.ts`: writes a file and leaves no `.tmp`; a throwing `writeFileSync` (point `file` at a path under a non-existent device, e.g. `/dev/null/x`) rethrows and leaves no `.tmp`.

### Task 3.2: Ledger types, store, operations

**Files:**
- Create: `src/articles/types.ts`, `src/articles/store.ts`, `src/articles/ledger.ts`
- Test: `tests/articles/ledger.test.ts`, `tests/articles/store.test.ts`

```ts
// types.ts
export interface ArticleShare { site: string; platform: string; url: string; at: string }
export interface ArticleRecord {
  id: string;                 // `${site}:${post_id}`
  persona: string;
  site: string;
  platform: string;
  post_id: string;
  url: string;
  title: string;
  slug?: string;
  topic?: string;
  primary_keyword?: string;
  tags: string[];
  seed?: number;
  choices?: Record<string, number>;   // DimensionName → index, as build_writing_brief returned them
  series?: string;
  status: string;                     // what the platform returned
  publish_at?: string;                // UTC ISO when known
  recorded_at: string;
  shares: ArticleShare[];
}
export interface ArticleLedger { version: 1; persona: string; records: ArticleRecord[] }

// store.ts — mirrors media/store.ts's ledger rules: missing → empty; corrupt → THROW LEDGER_UNREADABLE
export function articleLedgerPath(home: string, persona: string): string; // join(home, 'articles', `${persona}.json`)
export function readArticleLedger(file: string, persona: string): ArticleLedger;
export function writeArticleLedger(file: string, ledger: ArticleLedger): void;

// ledger.ts — pure
export function recordArticle(ledger: ArticleLedger, rec: Omit<ArticleRecord,'recorded_at'|'shares'>): ArticleLedger; // upsert by id
export function recentArticles(ledger: ArticleLedger, n: number): ArticleRecord[]; // newest first by recorded_at
export function recentChoices(ledger: ArticleLedger, n: number): Record<string, number[]>; // union of choices over the last n records
export function recordShare(ledger: ArticleLedger, articleUrl: string, share: ArticleShare): { ledger: ArticleLedger; matched: boolean };
export function siblings(ledger: ArticleLedger, series: string): ArticleRecord[];
```

- [ ] Tests: upsert replaces a record with the same id; `recentChoices` over 2 of 3 records unions only the last two; `recordShare` on an unknown URL returns `matched:false` and an unchanged ledger; corrupt JSON throws `LEDGER_UNREADABLE`; missing file returns an empty ledger with the persona set.

### Task 3.3: Brief consumes history

**Files:**
- Modify: `src/craft/brief.ts` (`BriefBase.history?: { recent: ArticleRecord[]; avoid: Record<string, number[]>; siblings?: ArticleRecord[] }`; `Brief.avoided: Record<string, number[]>`), `src/craft/dimensions.ts` (export `ANTI_REPEAT_DIMENSIONS = ['hook','arc','voice','story','cta','personaPresence','humanTexture','newsLede','newsStructure'] as const`)
- Test: `tests/craft/brief.test.ts`

Draw rule in `buildBrief`, replacing the plain `Math.floor(next() * options.length)` for dimensions in `ANTI_REPEAT_DIMENSIONS` only:

```ts
let idx = Math.floor(next() * options.length);
const avoid = input.history?.avoid[name] ?? [];
if (avoid.length < options.length) {
  let guard = 0;
  while (avoid.includes(idx) && guard++ < options.length) idx = (idx + 1) % options.length;
}
```

The RNG still consumes exactly one draw per dimension, so every existing seed keeps resolving identically when `history` is absent. Document on `Brief.seed`: "Reproducible given the same seed AND the same ledger state for this persona."

Render after the research block when `history.recent.length > 0`:

```
=== YOUR RECENT ARTICLES — DO NOT REPEAT, DO LINK ===
You published these recently. Do not reuse their opening device, their central
example, or their primary keyword. Where this article genuinely depends on ground
one of them covers, link to it ONCE with descriptive anchor text — an internal link
counts as a citation link. Do not link to one that is not relevant.
- {title} — {url} — keyword: {primary_keyword or '—'} — {publish_at date or recorded date}
```

And when `history.siblings` is non-empty: `=== THIS SERIES SO FAR ===` listing them with the line `Link to the pillar article and to one sibling where it fits; never to all of them.`

- [ ] Tests: same seed with and without history changes only avoided dimensions; with `avoid.hook = [0,1,2,3,4]` (every option) the draw is untouched; the RECENT block lists titles and URLs; no block when `history` is absent.

### Task 3.4: Tools write and read the ledger

**Files:**
- Modify: `src/context.ts` (`Context.articlesDir: string` = `join(paths.home,'articles')`), `src/tools/craft-tools.ts`, `src/tools/post-tools.ts`, `src/tools/persona-tools.ts`
- Test: `tests/tools.test.ts`, `tests/context.test.ts`

`create_post` new optional inputs: `brief_seed: z.number().int().optional()`, `brief_choices: z.record(z.string(), z.number().int()).optional()`, `topic: z.string().optional()`, `primary_keyword: z.string().optional()`, `series: z.string().optional()` — described as "from build_writing_brief's result; recorded so later briefs avoid repeating this article's shape and can link to it". After a successful publish, when `persona` resolved: read ledger, `recordArticle`, write; any thrown error becomes a warning `article ledger: could not record this post (<message>). Later briefs will not know about it.` When the target site's profile `kind === 'social'` (Phase 5) and `canonical_url` is set: `recordShare` on every persona ledger whose record matches the URL instead.

`build_writing_brief`: read the persona's ledger (missing → empty; corrupt → ToolError surfaced, since continuing would silently drop memory) and pass `history` with `recentArticles(ledger, 5)`, `recentChoices(ledger, 3)`, and `siblings(ledger, a.series)` when `series` given.

`list_personas`: add `articles: number` per persona (ledger record count; 0 when none).

- [ ] Tests through `callWith`: a `create_post` with `brief_choices:{hook:2}` writes `<home>/articles/jane-doe.json` containing the record (fixture `paths.home` is already a temp dir); a following `build_writing_brief` for `jane-doe` with a seed whose natural hook draw is 2 returns `avoided.hook` containing 2 and a different `choices.hook`; `list_personas` reports `articles: 1`; a read-only `articles` dir makes `create_post` succeed with a warning mentioning `article ledger`.

### Task 3.5: Docs and CONTEXT

- [ ] `CONTEXT.md`: new subsection "The article ledger" — what is recorded, that it lives under `<byline home>/articles/`, that it is unrecoverable like the media ledger, that seeds are reproducible only with the same ledger state, and that it is what makes "do not repeat yourself" and internal linking possible.
- [ ] `README.md`: a short "Byline remembers what you published" paragraph under Author personas.
- [ ] `docs/CLI.md` unchanged. CHANGELOG. Commit: `feat(articles): per-persona article ledger; briefs avoid repeating recent shapes and link back`.

---

## Phase 4 — Series planner (gap 6)

### Task 4.1: `src/craft/series.ts`

**Files:**
- Create: `src/craft/series.ts`
- Test: `tests/craft/series.test.ts`

```ts
export interface SeriesSlot { n: number; seed: number; choices: Record<string, number>; preview: Record<string, string> } // preview: first 70 chars of each picked dimension text for hook, arc, humanTexture, personaPresence
export interface SeriesPlan { series_id: string; seed: number; count: number; slots: SeriesSlot[]; brief: string }
export function planSeries(input: { persona: Persona; theme: string; count: number; mode: 'blog'|'news'; profile: HtmlProfile; seed?: number; history?: BriefBase['history'] }): SeriesPlan;
```

Algorithm: `seriesSeed = input.seed ?? random`. `series_id = 'srs-' + seriesSeed.toString(36)`. For slot `i`: try candidate seeds `seriesSeed + i * 1009 + k` for `k = 0..199`; call `buildBrief({...base, seed: candidate})` and accept the first whose `choices.hook`, `choices.arc`, `choices.humanTexture`, `choices.personaPresence` are each unused by earlier slots (for a dimension whose options are exhausted — count > options — allow the least-used index). `ToolError` `SERIES_UNPLANNABLE` if no candidate in 200 qualifies (cannot happen below count 6; test it with count 12 to prove the exhaustion path works).

`brief` text (exact):

```
=== SERIES PLAN — {count} ARTICLES ON: {theme} ===
Propose {count} article titles for {persona.name} that together cover this theme as a
pillar and spokes. Article 1 is the pillar: it answers the theme's head question for
a reader who knows nothing. Every later article is a spoke: it answers ONE long-tail
question a reader would type, in depth, and links back to the pillar once. No two
articles share a primary keyword. No two open with the same device — each slot below
has already been given a distinct hook, arc, texture and author presence; build the
brief for slot n with build_writing_brief({ seed: <slot seed>, series: "{series_id}" })
and it will draw exactly that shape. Return the titles as a numbered list with each
article's primary keyword and the question it answers, then stop and show the user
before writing anything.
{when history.recent non-empty: ALREADY PUBLISHED BY THIS AUTHOR — do not propose these angles again:\n- title — url}
```

- [ ] Tests: `count: 4` yields four slots with pairwise-distinct hooks and arcs; `buildBrief({seed: slot.seed})` reproduces `slot.choices`; same `seed` → same plan; `count: 12` completes with repeats only after options are exhausted.

### Task 4.2: `plan_series` tool and `series` passthrough

**Files:**
- Modify: `src/tools/craft-tools.ts`
- Test: `tests/tools.test.ts`

`plan_series` input: `persona`, `theme`, `count: z.number().int().min(2).max(12)`, `mode` default blog, `site?`, `seed?`. Description: "Plan a series of N articles as pillar and spokes. Allocates one seed per article so no two share a hook, arc, texture or author presence, and lists what this author already published so the plan does not repeat it. Returns slot seeds; pass each to build_writing_brief with the series id. Byline does not invent the titles — you do, from the returned brief, and you show them to the user first."

`build_writing_brief` gains `series: z.string().optional()`; it is passed to `history.siblings` lookup and echoed in the result so the host can relay it to `create_post`.

- [ ] Tests through `callWith`: plan then brief with `slot.seed` returns `choices` equal to the slot's; brief result echoes `series`.

### Task 4.3: `write-series` command supports N

- [ ] Rewrite `.claude/commands/write-series.md` argument hint to `<site> <persona> <topic or theme> [--count N] [| publish_at ...]`. When `--count` > 1: step 0 calls `plan_series`, shows titles, waits for approval, then runs steps 1–7 per article passing `seed`, `series`, `brief_seed`, `brief_choices`, `topic`, `primary_keyword` through to `create_post`. When the site list includes a LinkedIn API site (Phase 5) and the user asked for a LinkedIn post, add step 6b. Keep the six-tool-call discipline per article.
- [ ] CHANGELOG. Commit: `feat(craft): plan_series — distinct shapes per article, ledger-aware`.

---

## Phase 5 — Medium, Substack, LinkedIn (gap 7)

Two kinds of platform are added. **Export platforms** (Medium, Substack, LinkedIn Article) have no publishing API; `create_post` writes a folder the user pastes from. **LinkedIn** (API) publishes a feed post that summarises an article and links to it.

### Task 5.1: `HtmlProfile.kind` and no-table dimensions

**Files:**
- Modify: `src/craft/html-profile.ts` (add `kind: 'article' | 'social'`; set `'article'` on Ghost and both WordPress profiles), `src/craft/dimensions.ts`, `src/craft/brief.ts`, `src/craft/score.ts`
- Test: `tests/craft/brief.test.ts`, `tests/craft/score.test.ts`

`dimensionsFor(profile: Pick<HtmlProfile,'inlineStyles'|'visualContainers'>)`. Let `tables = profile.visualContainers.includes('table')`. Selection:
- `tableTheme`: styled when `inlineStyles && tables`; `PLAIN_TABLE_THEMES` when `tables` only; new `NO_TABLE_PRESENTATION` otherwise: `'DATA PRESENTATION — No tables: this platform has none. Present comparison data as a bulleted list, one bullet per row, each opening with the row label in bold, or as one short paragraph per row.'`
- `summaryBlock`: styled / `PLAIN_SUMMARY_BLOCKS` / new `QUOTE_SUMMARY_BLOCKS`: `'SUMMARY BLOCK — Quote: a <blockquote> containing ONE <strong>bolded one-sentence answer</strong> to the article\'s core question, immediately followed (outside the blockquote) by a <ul> of 3-4 takeaways each opening with a bolded 2-4 word label. No style attributes.'`
- `callout`: styled / plain / new `QUOTE_CALLOUTS`: `'CALLOUT PANEL — Quote: a <blockquote> with <strong>Short bolded label.</strong> then the point, two sentences at most.'`
- `blockquote`: unchanged rule on `inlineStyles`.

Update every `dimensionsFor(` call and test. In `brief.ts` rename the heading `=== TABLE THEME — USE THESE EXACT COLOURS ===` to `=== DATA PRESENTATION ===` and make the EVIDENCE line `One data table: …` conditional: when `!tables` write `One comparison, as a list — this platform has no tables.` In `score.ts`, `ai_summary_block` needs no change (it already walks `visualContainers`); `platform_html` gains: when `!tables` and the HTML contains `<table`, finding `<table> — ${name} has no tables; it pastes as plain text lines. Use a list.`

`score_draft` on a `kind: 'social'` profile → `ToolError` `NOT_AN_ARTICLE_PLATFORM`: `${label} is a feed-post platform; score_draft grades articles. Score the article on the site it was published to.`

- [ ] Tests: a fabricated profile with `visualContainers: ['blockquote']`, `inlineStyles: false` yields a brief containing `SUMMARY BLOCK — Quote`, `No tables`, and no `TABLE THEME`; `scoreDraft` against it passes `ai_summary_block` with a leading `<blockquote>` and flags a `<table>`; `kind:'social'` profile throws.

### Task 5.2: Export engine

**Files:**
- Create: `src/plugins/platforms/export/types.ts`, `markdown.ts`, `handoff-page.ts`, `adapter.ts`
- Test: `tests/plugins/platforms/export/{markdown,handoff-page,adapter}.test.ts`

```ts
// types.ts
export interface ExportSpec {
  platformId: string;          // 'medium'
  label: string;               // 'Medium'
  /** Numbered, platform-specific paste steps shown on the hand-off page. */
  pasteSteps: readonly string[];
  /** What the editor does to pasted HTML — UNVERIFIED unless a README row says otherwise. */
  profile: HtmlProfile;
}
// markdown.ts — pure; h1..h4, p, strong/em, a, ul/ol/li, blockquote, img (as ![alt](src)), figure/figcaption, code/pre, hr, table → pipe table. Unknown tags unwrapped.
export function htmlToMarkdown(html: string): string;
// handoff-page.ts — pure; returns a complete HTML document string
export interface HandoffInput { label: string; title: string; subtitle?: string; tags: string[]; articleHtml: string; articleMarkdown: string; images: Array<{ file: string; alt: string; role: 'hero'|'inline' }>; pasteSteps: readonly string[]; meta: Record<string,string> }
export function renderHandoffPage(input: HandoffInput): string;
```

The hand-off page (`index.html`) is self-contained (inline CSS and JS, no CDN): title, subtitle, tags; a **Copy article** button that writes `text/html` and `text/plain` to the clipboard via `navigator.clipboard.write(new ClipboardItem({...}))` with an `execCommand('copy')` fallback on a hidden contenteditable; a **Copy Markdown** button; a **Copy title / subtitle / tags** row; each image shown with an `<a download>` link and the text "Insert this where the article says `[Insert image: {file}]`"; the paste steps; the rendered article with `<img>` tags replaced in the *copyable* HTML by `<p><em>[Insert image: images/{file}]</em></p>` markers (pasted `file://` images do not survive an editor paste, so the user drags them in). The rendered preview on the page shows the real images. Add `@media (prefers-color-scheme: dark)` and a viewport meta; the page is ~400px-safe.

`adapter.ts`:

```ts
export class ExportAdapter implements PlatformAdapter {
  constructor(site: SiteConfig, spec: ExportSpec)
  readonly platform: string; readonly slug: string;
  private root(): string;         // expandHome(site.credentials.export_dir) + '/' + site.slug
  async healthCheck()             // mkdir -p root; write + unlink `.byline-write-test`; ok with detail `Folder writable: ${root}. No credential is involved — this checks only that Byline can write here.`; failure → ok:false with the fs error
  async uploadImage(file, filename, alt) // writes root/_inbox/<sha256-8>-<filename>; returns { url: `file://${path}`, id: path }
  async siteTimezone()            // throws NO_SITE_TIMEZONE hint `${label} has no clock. publish_at is not supported; schedule inside ${label}'s editor.`
  async createPost(post)          // status 'scheduled' → ToolError SCHEDULING_UNSUPPORTED; else: folder = root/<YYYY-MM-DD>-<slug or slugified title>; move every `file://` image under root/_inbox referenced by feature_image or <img src> into folder/images/; rewrite srcs to `images/<file>`; write article.html, article.md, meta.json ({title, slug, custom_excerpt, meta_title, meta_description, tags, categories, canonical_url, feature_image_alt, status, exported_at}), index.html; return { id: folder, url: `file://${folder}/index.html`, status: 'exported', warnings }
  async updatePost(id, patch)     // id is the folder; re-read meta.json; merge; rewrite files
  async listTags() → []           // with a warning? No — returns [] honestly; description says export platforms have no tag list
  async listAuthors() → []
}
```

Unsupported fields on export (warn, never silently drop): `codeinjection_head`, `og_*`, `twitter_*`, `feature_image_id`, `newsletter`, `email_segment`, `authors`. `slug` is used for the folder name only — say so in the warning text (`slug: used to name the export folder; ${label} assigns its own URL`). `[[content_image]]` remaining → `UNRESOLVED_PLACEHOLDER` exactly as Ghost does.

Use the `~`-expansion helper that `src/media/library.ts` already has; export it from there if private — do not write a second one.

- [ ] Tests (real temp dirs): `healthCheck` ok on a writable temp dir and `ok:false` on a file path; `uploadImage` returns a `file://` URL under `_inbox`; `createPost` with that URL as `feature_image` moves the file into `images/`, rewrites the src in `article.html`, writes all four files, returns `status:'exported'`; `scheduled` throws; `og_title` produces a warning naming the field; `htmlToMarkdown` converts a fixture with a table, a figure and nested lists; the hand-off page contains the three copy buttons and the insert markers.

### Task 5.3: Medium, Substack, LinkedIn-article plugins

**Files:**
- Create: `src/plugins/platforms/medium/{plugin,html-profile,README.md}`, same for `substack/` and `linkedin-article/`
- Modify: `src/plugins/registry.ts`
- Test: `tests/plugins/registry.test.ts`, `tests/plugins/platforms/export-plugins.test.ts`

Each `plugin.ts`:

```ts
export const mediumPlugin: PlatformPlugin = {
  id: 'medium', label: 'Medium',
  credentialSchema: z.object({ platform: z.literal('medium'), url: z.string().url(), export_dir: z.string().min(1), default_author: z.string().optional() }),
  credentialFields: [{ name: 'export_dir', label: 'Folder for exported posts', secret: false, example: '~/Documents/byline-post',
    help: 'Medium has no publishing API, so Byline writes each article into a folder here — text, images and a page with copy buttons — and you paste it into Medium\'s editor. Any folder you can write to.' }],
  defaultApiUrl: (siteUrl) => siteUrl,   // nothing is called; kept so SiteConfig.apiUrl is defined
  makeAdapter: (site) => new ExportAdapter(site, MEDIUM_SPEC),
  isAuthorId: () => false,
  htmlProfile: async () => MEDIUM_HTML_PROFILE,
};
```

Profiles — ALL `verified: false`, `kind: 'article'`, `inlineStyles: false`, `classAttributes: false`, `generatesHeadingIds: true`, `keepsLinkTarget: false`, `blockquote: 'passthrough'`, `visualContainers: ['blockquote']`, and a `notes` entry beginning `UNVERIFIED — reasoned from ${label}'s editor, not measured by paste:`:
- Medium `preserved`: `p h1 h2 h3 strong em a blockquote ul ol li img figure figcaption code pre hr`; `unwrapped`: `div section aside span small mark table thead tbody tr th td h4`. Notes: no tables; Title and Subtitle are separate fields, so do not put the title in the body; two heading sizes only.
- Substack: same as Medium plus `h4 h5 h6` preserved; notes: no tables; pull-quote is a blockquote; buttons are not pasteable.
- LinkedIn Article: `preserved`: `p h1 h2 strong em a blockquote ul ol li img`; `unwrapped`: everything else including `code pre table* h3 h4 figure figcaption hr`; notes: no tables, no code, two heading levels, cover image is set in the editor not the body.

`pasteSteps` (Medium): 1. Open medium.com/new-story. 2. Click Copy article on this page, click into the story, paste. 3. Type the title and subtitle into their own fields. 4. Drag each image from the images folder onto its `[Insert image: …]` line and delete the marker. 5. Add the tags from this page under Publish → Add a topic. 6. Set the canonical link under … → Customize → Advanced settings if this was published elsewhere first. Write equivalents for Substack (Dashboard → New post; cover image; SEO settings) and LinkedIn Article (Write article; cover image; publish).

Registry: add `medium`, `substack`, `linkedin-article`, and (Task 5.4) `linkedin`.

- [ ] Tests: every registered plugin has ≥1 `credentialField` and a non-empty `label`; `loadSites` with a `medium` site whose `export_dir` is literal resolves `credentials.export_dir` and `unavailable` is undefined; `buildBrief` with each export profile contains `UNVERIFIED` in its HTML RULES header (the existing `htmlRules` renders it from `verified:false` — assert the exact header text), `SUMMARY BLOCK — Quote`, and `No tables`. **Then read all three briefs with `npx tsx`.**

### Task 5.4: LinkedIn API plugin (feed post)

**Files:**
- Create: `src/plugins/platforms/linkedin/{index,plugin,html-profile,auth,README.md}`
- Test: `tests/plugins/platforms/linkedin.test.ts`, `tests/integration/linkedin.integration.test.ts`

**Every request shape below is UNVERIFIED against a live token. The adapter ships marked so; the integration test is the probe; promotion to verified happens only when it has run.**

`plugin.ts`: `id: 'linkedin'`, `label: 'LinkedIn'`. Schema: `url` (profile or company page URL), `access_token` (secret), `author_urn` (non-secret, regex `^urn:li:(person|organization):[A-Za-z0-9_-]+$`), `api_version: z.string().regex(/^\d{6}$/).optional()`. Fields:

```ts
{ name: 'access_token', label: 'LinkedIn access token', secret: true, example: 'AQV…',
  help: 'developer.linkedin.com → your app → Auth → OAuth 2.0 tools → generate a token with the scopes openid, profile, w_member_social. Tokens last about 60 days; repeat when it expires. Posting as an organisation needs w_organization_social, which LinkedIn grants only after Community Management API approval.' },
{ name: 'author_urn', label: 'Author URN', secret: false, example: 'urn:li:person:AbC123 or urn:li:organization:12345',
  help: 'Who the post is from. Leave the placeholder, finish setup, then run list_authors against this site: it prints your person URN and any organisation you administer.' },
```

Because `collectCredentialValues` refuses a skipped field on a new site, the user can type the literal `urn:li:person:me` and the adapter resolves `me` to the `sub` from `userinfo` at request time (documented on the field and in the README).

`defaultApiUrl` → `https://api.linkedin.com`. `LINKEDIN_VERSION = '202509'` constant (UNVERIFIED — a released `YYYYMM`; `api_version` overrides). Headers on every `/rest/` call: `Authorization: Bearer`, `LinkedIn-Version`, `X-Restli-Protocol-Version: 2.0.0`, `Content-Type: application/json`.

Adapter:
- `healthCheck`: `GET /v2/userinfo`. 2xx → `ok:true, detail: "Authenticated as ${name} (${sub})"`; 401/403 → `ok:false` with LinkedIn's body `message`. Unit test with mocked 401 for a fabricated token is REQUIRED (rule 4 of ADDING-A-PLATFORM).
- `listAuthors`: `[{ id: 'urn:li:person:'+sub, name }]` plus, best-effort in its own try, organisations from `GET /rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&projection=(elements*(organization~(localizedName)))` mapped to `{ id: organization urn, name }`. A failure there becomes a warning in the tool result, not an error.
- `siteTimezone`: throws `NO_SITE_TIMEZONE` — `LinkedIn posts publish immediately; publish_at is not supported.`
- `uploadImage(file, filename, alt)`: `POST /rest/images?action=initializeUpload` body `{ initializeUploadRequest: { owner: authorUrn } }` → `value.uploadUrl`, `value.image` (urn). `PUT uploadUrl` with the bytes and `Content-Type` from `mimeFor(filename)` (import the WordPress one — move `mimeFor` to `src/plugins/images/inspect.ts` if it is not already shared; do not copy it). Return `{ url: imageUrn, id: imageUrn }` — LinkedIn exposes no public URL; the README says so.
- `createPost(post)`: refuse `status !== 'published'` with `ToolError` `DRAFTS_UNSUPPORTED` — `LinkedIn feed posts publish immediately. Byline does not create LinkedIn drafts.` Refuse HTML containing `[[article_url]]` (`UNRESOLVED_PLACEHOLDER`). `commentary = toCommentary(post)`: strip tags, `</p>` → `\n\n`, decode entities, collapse ≥3 newlines, trim; append `\n\n${post.canonical_url}` when set and not already present; append `\n\n` + hashtags from `post.tags` (`#` + each tag in PascalCase, non-alphanumerics removed). Length > 3000 → `ToolError` `COMMENTARY_TOO_LONG` naming the count. Body:

```ts
{
  author: authorUrn, commentary, visibility: 'PUBLIC',
  distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
  lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
  ...(post.canonical_url ? { content: { article: { source: post.canonical_url, title: post.title,
      ...(post.custom_excerpt ? { description: post.custom_excerpt } : {}),
      ...(post.feature_image_id ? { thumbnail: post.feature_image_id } : {}) } } } : {}),
}
```

`POST /rest/posts` → expect 201; id = `x-restli-id` response header (throw `NO_POST` if absent); `url = https://www.linkedin.com/feed/update/${id}/`. Read back `GET /rest/posts/${encodeURIComponent(id)}` and warn if `commentary` differs from what was sent. `UNSUPPORTED_FIELD_REASONS`: `slug meta_title meta_description og_title og_description og_image twitter_title twitter_description twitter_image codeinjection_head categories newsletter email_segment feature_image_caption feature_image_alt authors` — each `LinkedIn feed posts have no <field>; nothing was sent.` `feature_image` (the URL string) is accepted only as the urn's companion; when `feature_image` is set without `feature_image_id`, warn `feature_image: LinkedIn needs the image URN from upload_image's id (feature_image_id); a URL alone cannot be attached.`
- `updatePost`: `POST /rest/posts/${id}` with `{ patch: { $set: { commentary } } }` — UNVERIFIED; implement, mark, test against mock only.
- `listTags` → `[]`.

`html-profile.ts`: `LINKEDIN_POST_PROFILE`: `kind: 'social'`, `verified: false`, `preserved: new Set(['p'])`, everything else unwrapped, `visualContainers: []`, `inlineStyles: false`, notes: `This is a feed post, not an article. Formatting does not survive. 3000 characters maximum; the first ~210 show before "see more".`

- [ ] Unit tests (mocked fetch): fabricated token → `healthCheck().ok === false`; `createPost` with `canonical_url` and tags sends the body above and returns the `feed/update` URL from the header; missing header → `NO_POST`; 3001-char commentary → `COMMENTARY_TOO_LONG`; `status:'draft'` → `DRAFTS_UNSUPPORTED`; `og_title` → warning naming the field; `uploadImage` hits `initializeUpload` then PUTs the bytes.
- [ ] Integration (`RUN_INTEGRATION=1`, skips itself without a `linkedin` site in config): fabricated token → non-2xx from the live `/v2/userinfo`; real token → `ok:true`; `listAuthors` returns ≥1. Post creation ONLY behind an additional `RUN_INTEGRATION_LINKEDIN_POST=1`, because it publishes to a real feed and cannot be cleaned up through the API with certainty — and when it runs, it records the measured response shape in `docs/platforms/linkedin.md`.

### Task 5.5: The brief writes the LinkedIn post; create_post hands off

**Files:**
- Modify: `src/craft/brief.ts` (`BriefBase.socialTargets?: Array<{ site: string; label: string }>`), `src/tools/craft-tools.ts`, `src/tools/post-tools.ts` (description), `src/tools/image-tools.ts` (description)
- Test: `tests/craft/brief.test.ts`, `tests/tools.test.ts`

`build_writing_brief` computes `socialTargets` = usable sites whose resolved profile has `kind: 'social'`. When non-empty the brief renders:

```
=== LINKEDIN POST — WRITE THIS TOO ===
A LinkedIn site is configured ({sites}). After the article is published, the user may
ask for a LinkedIn post about it. Write it now, into the linkedin_post field, so it is
ready: 900–1,500 characters, first person as {persona.name}, ONE idea from the article
stated as a position — not a summary of everything. The first 200 characters must stand
alone, because that is all the feed shows before "see more". No "Excited to share", no
emoji rows, no hashtags in the body. End with the literal text [[article_url]] on its own
line — create_post replaces nothing; YOU swap it for the published URL before posting. Then
3–5 hashtags: one broad, the rest specific to the article's subject.
```

and adds to the JSON contract: `"linkedin_post": { "text": "…ends with [[article_url]]", "hashtags": ["Tag", "Tag"] }`.

`create_post` description gains: `On an export platform (Medium, Substack, LinkedIn Article) this writes a folder and returns its path as url — tell the user where it is and to open index.html. On a LinkedIn site this publishes a feed post: pass the linkedin_post text as html (one <p> per paragraph), the article's live URL as canonical_url, the hashtags as tags, and the image URN from upload_image as feature_image_id.` `upload_image` description: `On LinkedIn the returned url is an image URN, not a web address; pass it as feature_image_id.`

The `images` enforcement in `create_post` stays: a `file://` URL satisfies `feature_image` on export platforms; on LinkedIn `feature_image` is the URN string. The write-series command step 6b: after the article's `create_post`, if a LinkedIn site exists and the user asked, `upload_image(site: linkedin, path: hero)` then `create_post(site: linkedin, …)`, then report both URLs.

- [ ] Tests: brief with `socialTargets` contains the section and the JSON field; without, neither; `create_post` on a `linkedin` fixture with `html` containing `[[article_url]]` → `UNRESOLVED_PLACEHOLDER`; `create_post` on a `medium` fixture returns a `file://` url and writes the folder; ledger `recordShare` runs for the linkedin publish with a matching `canonical_url` (Phase 3 hook).

### Task 5.6: Help files and docs

**Files:**
- Create: `docs/platforms/medium.md`, `docs/platforms/substack.md`, `docs/platforms/linkedin.md`
- Modify: `README.md`, `CONTEXT.md`, `docs/ADDING-A-PLATFORM.md`, `docs/CLI.md` (init example for an export site), each plugin `README.md`

Each help file answers, in this order: What Byline can do on this platform and what it cannot (API or not, with the date that was checked and how). How to connect (the exact `byline init` answers; for LinkedIn the developer-portal click path, the scopes, token lifetime, person vs organisation). What a publish produces (folder layout for exports; feed post shape for LinkedIn). How to paste, step by step, with the image-marker rule. What is UNVERIFIED (paste behaviour; every API shape for LinkedIn until the integration test has run). Troubleshooting (folder not writable; token expired → 401; organisation URN refused → needs Community Management approval).

`README.md`: new section "Platforms without an API" after "Video", plus LinkedIn under "How it works" step 5. `CONTEXT.md`: "Export platforms" and "Social platforms" subsections under the plugin boundary; `HtmlProfile.kind`. `docs/ADDING-A-PLATFORM.md`: a short "Two kinds of platform" preface naming `ExportAdapter` and the `kind: 'social'` rule; the checklist otherwise stands.

- [ ] CHANGELOG. Commit: `feat(platforms): Medium and Substack exports, LinkedIn Article export, LinkedIn feed posts`.

---

## Phase 6 — Humanizer (gap 5 and the skill)

Adapted from `blader/humanizer` v3.0.0 (MIT) and Wikipedia's "Signs of AI writing". Byline keeps its own two halves: the brief instructs before the draft, the scorer measures after. The humanizer's contribution is a third: a **revision pass** the host performs between writing and scoring, plus mechanical checks for the tells that regexes can catch.

### Task 6.1: Graduate the lexicon; add pattern arrays

**Files:**
- Modify: `src/craft/score.ts`
- Test: `tests/craft/score.test.ts`

`BANNED` gains the words the brief currently lists as "not graded": `realm myriad plethora pivotal crucial vital elevate harness streamline cutting-edge foster bolster underscore embark meticulous intricate multifaceted holistic synergy leverage garner enduring landscape navigate unlock`. Remove `'unlock the power'`, `'navigate the landscape'`, `'the landscape of'`, `'leverage the power'` (now covered by their head word).

`BANNED_PATTERNS` becomes the home of every graded construction:

```ts
const BANNED_PATTERNS: Array<[RegExp, string]> = [
  [/it['’]s not just [^,.]{2,40}, it['’]s/i, '"it\'s not just X, it\'s Y"'],
  [/\bnot only [^,.]{2,40} but also\b/i, '"not only X but also Y"'],
  [/\bnot (just|merely|simply|about) [^.]{3,60}\b(but|rather|it['’]s|it is)\b/i, '"not X but Y" staging across a clause'],
  [/\bwhen it comes to\b/i, '"when it comes to"'],
  [/\bit['’]s worth noting\b/i, '"it\'s worth noting"'],
  [/\bat the end of the day\b/i, '"at the end of the day"'],
  [/\bin conclusion\b/i, '"in conclusion"'],
  [/\bone thing is clear\b/i, '"one thing is clear"'],
  [/\blet['’]s dive in\b/i, '"let\'s dive in"'],
  [/\bbuckle up\b/i, '"buckle up"'],
  [/\bthe bottom line\b/i, '"the bottom line"'],
  [/\b(moreover|furthermore)\b/i, '"moreover" / "furthermore"'],
  [/\b(the real question is|at its core|here['’]s the thing|the truth is|make no mistake|let that sink in)\b/i, 'a saying that sounds deep'],
  [/\b(to be clear|i['’]m not saying|this isn['’]t (mainly |really )?about|you might think)\b/i, 'arguing with no one'],
  [/\b(i hope this helps|great question|let me know if|in this (article|post),? (we|i)(['’]ll| will) (explore|cover|look at|walk through)|want me to)\b/i, 'chatbot residue'],
  [/\b(serves as|stands as|acts as a testament|boasts|is home to)\b/i, 'a dressed-up "is"'],
];
```

New `THRESHOLDS`: `emDashPerWords: 150`, `minRiderHits: 2`, `minHedgeHits: 2`, `sameOpenerRun: 3`, `maxBodyBold: 3`, `headingEchoOverlap: 0.7`. New exported arrays for the brief: `PARTICIPLE_RIDERS = ['highlighting','underscoring','reflecting','showcasing','signalling','signaling','emphasising','emphasizing','demonstrating','reinforcing','illustrating','marking','cementing','solidifying']`, `STACKED_HEDGES = ['could potentially','might possibly','may potentially','might arguably','it is possible that',"it's possible that",'arguably']`.

- [ ] Tests: each new pattern matches its own positive example and not a plain sentence; `BANNED_CONSTRUCTIONS` has one label per pattern; `"crucial"` is now an `ai_lexicon` hit.

### Task 6.2: Seven new advisory checks

**Files:**
- Modify: `src/craft/score.ts` (`CHECK_NAMES`, `CHECK_GUIDANCE`), `src/tools/craft-tools.ts` (`revision_guidance` in the result)
- Test: `tests/craft/score.test.ts`, `tests/tools.test.ts`

| check | rule | finding text |
|---|---|---|
| `em_dash_density` | count of `—`, `–`, ` -- ` in body text > `ceil(words / emDashPerWords)` | `N dashes in W words (max M). Replace most with a full stop, a comma, or a colon.` |
| `participle_riders` | hits of `,\s+(PARTICIPLE_RIDERS)\b` ≥ `minRiderHits` | `N participle riders (", highlighting…"). Cut the rider or make it its own sentence with a source.` |
| `stacked_hedges` | hits of STACKED_HEDGES ≥ `minHedgeHits` | `N stacked hedges. Say the claim or cut it; hedge once at most.` |
| `sentence_openers` | `sameOpenerRun` consecutive sentences share the same first word (case-insensitive; skip sentences under 3 words) | `N consecutive sentences open with "word". Vary where the subject lands.` |
| `bold_decoration` | `<strong>` inside `<p>` that is NOT within the preamble before the first H2 and NOT inside `<table>`/`<blockquote>`, count > `maxBodyBold` | `N bolded phrases in body prose (max M). Bold belongs in the summary block and callout labels only.` |
| `heading_echo` | for each h2/h3, content words (len > 3) of the heading ∩ first sentence after it / heading words ≥ `headingEchoOverlap` | `The first sentence after "heading" restates it. Start with the answer instead.` |
| `closer_fragments` | a `<p>` of one sentence under 8 words that immediately follows a `<p>` of ≥ 3 sentences AND shares ≥ 2 content words with it | `"fragment" restates the paragraph above it. A one-line paragraph must carry a new claim.` |

All `blocking: false`. Append to `CHECK_NAMES` after `voice_rhythm`. Every `ai_lexicon` finding that comes from a pattern (not a word) is prefixed with its label so the host sees the family.

`CHECK_GUIDANCE: Record<string, string>` — one imperative sentence per advisory check (e.g. `burstiness` → `Put a four-word sentence next to a thirty-word one; read the paragraph aloud.`). `score_draft` returns `revision_guidance: string[]` = guidance for every failing advisory check, in `CHECK_NAMES` order, prefixed `Keep every sourced claim; add no facts.` when non-empty. The tool description says: `revision_guidance lists one edit per failing advisory check. Make those edits inline; do not rewrite the article.`

- [ ] Tests: a positive HTML fixture per check fails it and a clean article passes all seven; the summary block's bold labels do not count toward `bold_decoration`; `CHECK_NAMES` matches the returned order; tool result has `revision_guidance` only when something advisory failed.

### Task 6.3: The brief — HUMANISING from the arrays, REVISION PASS, conflict rules

**Files:**
- Modify: `src/craft/brief.ts`, `src/craft/dimensions.ts`
- Test: `tests/craft/brief.test.ts`

Rewrite `HUMANISING`:

```
=== NEVER USE THESE — GRADED ===
score_draft reports every hit. This list is printed from the scorer's own array:
{BANNED.join(', ')}.
Graded constructions: {BANNED_CONSTRUCTIONS.join('; ')}.
Also graded, by count: dashes (more than one per {THRESHOLDS.emDashPerWords} words), participle riders
after a comma ({PARTICIPLE_RIDERS.join(', ')}), stacked hedges ({STACKED_HEDGES.join(', ')}), three
sentences in a row opening with the same word, bold in body prose beyond the summary block and
callout labels, a heading restated by its first sentence, and a one-line paragraph that restates
the paragraph above it.

=== STRUCTURAL TELLS — THESE MATTER MORE THAN THE WORD LIST ===
(keep the existing eight bullets)
- These instructions use dashes freely. Your article may not: one per {emDashPerWords} words at most.
- A paragraph of one sentence is allowed only when it carries a claim the reader has not yet read.
  Never as a closer that restates the paragraph above.
- Bold is for the summary block's labels and the callout panel's label. Nowhere else.

=== REVISION PASS — DO THIS BEFORE score_draft ===
Read the whole draft once, start to finish. Then mark the tells, strongest first:
1. Staging instead of stating — "not X but Y", one-line closers, sayings that sound deep,
   run-ups before the point, arguing with an objection nobody raised.
2. Rhythm by rule — triads for their own sake, repeated sentence openings, dashes as the
   universal connector, stacked hedges, hyphenated pairs everywhere, passive voice hiding the actor.
3. Inflation — "pivotal", "landscape", "testament"; ordinary facts framed as turning points;
   "associated with" instead of the actual relationship; unnamed experts; "serves as" for "is".
4. Formatting by rule — bold as decoration, title-case headings, a heading repeated in its first line.
5. Leftovers — greetings, offers, "in this article we will", knowledge-cutoff disclaimers.
Act on a single sighting of group 1. Groups 2–5 need two tells in one passage before you edit.
Rewrite only what you marked. Keep every sourced claim. Add no name, number, date, quote or
citation that was not already there. Then read it aloud once.

=== WHAT NOT TO DO IN THE NAME OF SOUNDING HUMAN ===
(keep the existing paragraph)
```

Delete the "ALSO AVOID — NOT GRADED" section: everything in it is now graded. Amend `HUMAN_TEXTURES[0]` (Asymmetry) to end `…at least one paragraph must be a single sentence standing completely alone — one that carries a new claim, never a restatement of the paragraph before it — and at least one must run five or six lines…`.

A code comment above `HUMANISING` credits `blader/humanizer` (MIT) and Wikipedia's "Signs of AI writing" and repeats: **no claim about any detector**.

- [ ] Tests: brief contains `REVISION PASS`, contains every `BANNED` word and every `BANNED_CONSTRUCTIONS` label, does not contain `NOT GRADED`; the dash and bold rules appear exactly once each in the brief (no second definition).

### Task 6.4: Schema and GEO signals

**Files:**
- Modify: `src/craft/schema.ts` (`SchemaInput.inLanguage?: string; authorUrls?: string[]; wordCount?: number`), `src/tools/post-tools.ts`
- Test: `tests/craft/schema.test.ts`, `tests/tools.test.ts`

`buildArticleSchema` emits `inLanguage`, `wordCount`, and `author.sameAs` (array) when given. `create_post` passes `datePublished: timing.publishAtIso ?? new Date().toISOString()`, `inLanguage: persona?.language_written`, `authorUrls` from persona extras `profile_url` (string) and `social_profiles` (comma-separated or list — `asText` already joins lists with `, `; split on `, `), `wordCount` from the stripped HTML. Template comment gains `profile_url` and `social_profiles` under "wired to machinery". `update_post` does not set `datePublished` (it would overwrite the original date).

- [ ] Tests: schema JSON contains `sameAs`, `inLanguage`, `datePublished`; a persona without `profile_url` produces no `sameAs` key.

### Task 6.5: The skill file, the command, and docs

**Files:**
- Create: `.claude/skills/humanizer/SKILL.md`
- Modify: `.gitignore` (`!.claude/skills/`), `.claude/commands/write-series.md` (step 2b "Revision pass — apply the REVISION PASS section of the brief to body prose only; leave the summary block, tables, callouts, FAQ and JSON untouched; add no facts"), `README.md`, `CONTEXT.md`, `CHANGELOG.md`, `CLAUDE.md` (raise the floor to the new count)

`SKILL.md` frontmatter `name: humanizer`, `description: Rewrite AI-sounding body prose in a Byline draft so it reads like the persona, without changing what it says or touching the structural blocks the scorer requires.` Body: the five groups with two-line definitions each (this is the one place they are spelled out in full — the brief carries the compressed version and points here by name), the four-step process, the "act on one sighting / need company" rule, the Byline exclusions (summary block, callout, tables, FAQ, JSON fields, `[[content_image]]`, link hrefs), the "never add facts" rule, and a credit line to `blader/humanizer` (MIT) and Wikipedia. No detector claims.

`README.md`: rewrite the "persona shapes the writing" tail into "How Byline keeps prose human": what the brief instructs, what the revision pass does, what the scorer measures (name the new checks in a short table), and the sentence: "It makes no claim about any AI-detection tool; it is a craft standard." `CONTEXT.md`: update the craft section with the three halves and the conflict rules.

- [ ] Run the whole suite, typecheck, build. Generate one real brief for Ghost, one for WordPress restrictive, one for Medium, one for LinkedIn-as-target (expect the refusal), and read them. Commit: `feat(craft): humanizer — graded patterns, revision pass, seven new checks, GEO schema fields`.

---

## Self-review against the spec

- Gap 1 voice samples → Phase 1. Gap 2 memory → Phase 3. Gap 4 taxonomy → Phase 2. Gap 5 tells → Phase 6. Gap 6 series → Phase 4. Gap 7 platforms, export folder, LinkedIn API post with summary, image, link and tags, help files → Phase 5. Gap 8 (stock images) — **not requested in the user's list; omitted deliberately.** Gaps 3 and 9 — out of scope by decision. Humanizer → Phase 6. SEO/AEO/GEO → Task 6.4 plus the existing AEO/GEO sections.
- Type consistency: `history` shape is identical in Task 3.3, 4.1 and 5.5; `CHECK_NAMES` is defined in 1.3 and extended in 6.2; `dimensionsFor(profile)` changes in 5.1 and every caller is named there; `ExportAdapter` constructor is `(site, spec)` in 5.2 and 5.3; `recordShare` from 3.2 is the hook in 5.5.
- Unverified facts are marked where they are encoded: Ghost newsletter echo (2.1), WordPress categories search (2.3), every export paste behaviour (5.3), every LinkedIn request shape (5.4).
