# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Persona files accept any field you want.** Anything the schema does not name is kept
  and carried into the writing brief as your own standing direction, instead of being
  silently dropped. Previously zod stripped unknown keys, so a 51-field persona loaded as
  27 and the other 24 vanished with no error — adding a field and having it ignored is a
  silent failure, which this project's rules forbid.
- **Eleven of those fields are wired to specific machinery** rather than printed as free
  text: `preferred_article_length` sets the default word count (first number wins, an
  explicit `word_count` still overrides), `avoid_in_writing` joins the banned list,
  `target_audience` and `reading_level` set the register, `citation_preference` /
  `fact_checking_level` / `preferred_quotes_from` / `quote_usage_frequency` shape the
  sourcing rules, and `favorite_rhetorical_devices` / `commonly_used_transitions` /
  `use_of_humor` join the per-article texture. The rest render under ADDITIONAL AUTHOR
  DIRECTION. Nothing is stated twice in one prompt.
- **News mode is now actual news writing.** It was one paragraph about recency; it is now
  a reporting brief — third person, attribution in the same sentence or the next, neutral
  verbs, short paragraphs, no fabricated quotes, dateline convention, and no call to
  action. Two new per-article dimensions draw the lede (5 forms) and the report structure
  (4 inverted-pyramid shapes), so reports vary the way blog posts already did.
- `personas/_template.yaml` documents the optional fields, which are wired where, and
  warns against pinning the opening/ending/shape — that would undo the per-article
  variety.

### Changed

- **News mode suppresses every blog-only section instead of contradicting it.** A news
  brief no longer carries HOOK, STRUCTURE ARC, NARRATIVE VOICE, AUTHOR PRESENCE,
  MICRO-STORY or CONCLUSION AND CTA, and "Write in FIRST PERSON" becomes "Write in the
  THIRD PERSON". The EVIDENCE and GEO sections swap their first-hand-experience
  requirements for sourcing ones. Leaving both in and relying on "this section wins" would
  put two contradictory instruction sets in one prompt and let the model choose.
- **`score_draft` takes `mode`.** A report is judged by the opposite standard to a blog
  post: `experience_markers` becomes `reporter_voice` (first person is now the defect),
  and a new advisory `attribution` check measures attributed claims per 200 words and
  counts "experts say" / "reports suggest" against the draft. Scoring a correct report as
  a blog post reported its third-person voice as a failure — the same brief-versus-scorer
  contradiction fixed in 1.5.1.

## [1.6.1] - 2026-08-03

### Fixed

- **Releases were published without an author.** `package.json` had no `author` field at
  all — `npm view @indianic/byline` reported `author: null`, where every sibling package
  on the registry reports one. Added.
- Recorded, because it is not fixable from inside this repo: a publish is attributed to a
  user only when `~/.npmrc` carries the `username=` + `_password=` + `always-auth=true`
  credentials that `npmnic login` writes. The older `//npm.indianic.in/:_auth=` form
  reaches Verdaccio as `user: null`, so the package is never associated with an account —
  `npmnic packages` omitted `@indianic/byline` entirely through 1.6.0, despite
  `npmnic whoami` reporting the right user the whole time. `npmnic publish` shells out to
  plain `npm publish`, so the npmnic session is not what authenticates the upload. Re-run
  `npmnic login` after upgrading npmnic; nothing in this package can detect or repair it.

## [1.6.0] - 2026-08-03

### Changed

- **Images stopped looking like one template.** Every image was previously drawn from four
  looks — *all four of them daylight* — plus one fixed setting sentence and one fixed
  people sentence, so a whole blog's images shared one camera setup and one mood. There
  are now **four independent axes**: light and camera (14 options, including after-dark
  screen glow, tungsten, cool fluorescent, blue hour, high-key, hard midday sun, macro
  close-up, overhead aerial and low-angle handheld), scene (12), city (12), and human
  moment (10 — mid-laugh, mid-argument, concentration, relief, the tail end of a long day).
- **Who appears is now carried by naming a real city** rather than by asking for
  demographic variety in the abstract, which produces a stock-library composite. Twelve
  cities across five continents; both images in one article always share one.
- **Roughly one image in twelve is an editorial illustration** — hand-drawn ink line with
  flat washes and a limited palette, specified against the flat-corporate-vector and
  cartoon-mascot defaults. The camera register is dropped for those, since a drawing has
  no lens, and "not an illustration" is dropped from its negatives.

### Fixed

- **The image axes were correlated, not independent.** FNV-1a's low bits are its weak
  point and `% 12` reads exactly those, so 400 subjects reached only **36 of 144** possible
  city-and-scene pairs — scene and region moved in lockstep and most combinations were
  unreachable. The hash now finalises before the modulo; the same measurement now reaches
  **128 of 144**.
- **"No text in the frame" was not enough on its own.** A generated illustration came back
  with four lines of confident gibberish on a document in the centre of the frame, with the
  instruction already present. Prompts now say what paper, screens and signs must
  positively look like — blank, or indistinct marks — which is a far more reliable
  instruction than a prohibition. Verified by regenerating the same image: the gibberish
  is gone.
- Two `IMAGE_LOOKS` entries named subject matter ("desk lamp", "office fluorescents"),
  which the existing contract forbids because a look that names objects fights the
  article's own subject. Caught by the test that guards exactly this.

## [1.5.1] - 2026-08-03

### Fixed

- **`score_draft` scored a correctly-written article as having zero first-hand
  moments.** Its `experience_markers` check matched a fixed verb list that none of
  1.5.0's new persona-presence worked examples hit — "We killed the pilot in week six.",
  "The team pushed back hard on that." A real 1,000-word draft written exactly to that
  instruction scored **0** and was told to add first-hand moments; it now scores 7. The
  brief and the scorer disagreed about what a first-hand moment is. A test now runs the
  brief's own option strings through the scorer's own regex so the two cannot drift
  apart again, and a companion test keeps bare opinion ("I think", "we believe") at zero.

## [1.5.0] - 2026-08-03

### Added

- **The persona stops introducing itself on every article.** `build_writing_brief` gains
  a `personaPresence` dimension, drawn per article like the hook and arc already were.
  Only one of its five variants states the author's credential outright; **60% of
  articles now never state a role or tenure at all**, carrying authority through
  first-hand specificity instead — a detail only someone who did the work would know,
  the scale of decisions described, or a credential buried in a subordinate clause.
  Someone who blogs weekly does not reintroduce themselves weekly.
- **A `humanTexture` dimension plus a fixed humanising standard.** The texture varies per
  article (asymmetric rhythm, conceding the counter-case, visibly changing your mind
  mid-argument, refusing abstraction, spoken cadence). The fixed half targets what
  actually gives machine prose away — uniform paragraph length, relentlessly parallel
  lists, an argument that never concedes or commits — alongside a much longer banned
  word and construction list. It explicitly forbids fabricating a statistic, client,
  date, or prior article in the name of sounding human.

### Changed

- The GEO section no longer orders "State the author's credential once, early, in the
  first person" on every article; it defers to `personaPresence` and notes that
  generative engines weight unrepeatable first-hand detail over a stated job title,
  which every competing article already has.
- The author profile block is now labelled as input to the writer's judgement, with an
  explicit instruction that none of its labels may appear as text in the article.

## [1.4.0] - 2026-08-03

### Added

- **Scheduled publishing on Ghost and WordPress.** `create_post` and `update_post` take
  `status: "scheduled"` with a `publish_at` time, mapped to Ghost's `scheduled` /
  `published_at` and WordPress's `future` / `date_gmt`. `update_post` also schedules an
  existing draft, and unschedules one (`status: "draft"`).
- **A publish time is read in the BLOG's timezone**, never the caller's and never the
  host's. `publish_at: "2026-08-04T10:00"` means 10 AM as that blog's readers experience
  it; the timezone is fetched from the platform (Ghost's `GET /settings/` → `timezone`,
  WordPress's `GET /wp-json/` → `timezone_string` / `gmt_offset`) and memoised per site.
  The same string sent to a `Asia/Kolkata` blog and a UTC blog is deliberately two
  different instants. A value carrying an explicit offset is still accepted and taken at
  face value. Daylight saving is resolved per instant rather than sampled, and a local
  time the clocks skip is refused rather than quietly moved.
- `publish_at_local` in the result — the stored instant as the blog's own clock reads
  it, e.g. `2026-08-04 10:00:00 (Asia/Kolkata)`, so a user who asked for 10 AM is told
  10 AM rather than a UTC value they have to convert back.
- `PlatformAdapter.siteTimezone()`, which every platform must now implement. It throws
  rather than defaulting to UTC: a blog whose timezone cannot be read is one Byline
  cannot schedule for, and assuming UTC would publish at the wrong hour while reporting
  success.
- **Backdating.** A *past* `publish_at` with `status: "published"` sets the post's date;
  measured identical on both platforms, on create and update, arbitrarily far back.
- `publish_at` in the result, reporting the time the platform actually stored — read back
  from its response, not echoed from the request, and normalised to UTC ISO so the same
  instant reads the same whichever platform it came from.
- Measured scheduling and backdating behaviour recorded in `docs/GHOST-NOTES.md` and
  `docs/WORDPRESS-NOTES.md`, including what stays UNVERIFIED (a WordPress site whose
  timezone is not UTC).

### Fixed

- **A scheduled WordPress post could go live immediately, reported as a success.**
  WordPress does not reject a `future` post whose date is too close or already past — it
  rewrites the status to `publish`, returns 201, and the article is live, with no error
  anywhere in the response. Byline now refuses a `publish_at` under 2 minutes ahead
  (measured: 45 s of lead published immediately, 60 s scheduled), and re-reads the post
  afterwards, failing with `SCHEDULE_NOT_APPLIED` — naming the post, its live URL, and
  the platform's own clock — rather than reporting a schedule that did not happen. The
  post is left exactly as it is; Byline does not unpublish it on its own.
- **`status: "published"` with a future `publish_at` is refused** rather than sent. The
  same request publishes immediately on Ghost and schedules on WordPress, so one input
  meant two opposite things depending on the target site.
- A `publish_at` with no offset is never handed to `Date.parse`, which reads it as the
  *sending machine's* local time — the same string would otherwise schedule an article at
  a different hour depending on which machine sent it. It is resolved against the blog's
  timezone instead.
- Ghost's `errors[0].context` is now surfaced as the error hint. Ghost puts the real
  reason for a 422 there and leaves `message` as the generic "Validation error, cannot
  save post." — both scheduling refusals were invisible without it.
- The WordPress status map no longer folds an unrecognised status into `draft`. It was
  `status === 'published' ? 'publish' : 'draft'`, so adding a third status would have
  silently drafted every scheduled post.

## [1.2.0] - 2026-07-31

`package.json` stays at 1.1.0 until release: `npmnic publish --minor` bumps it to 1.2.0
itself.

### Added

- **Research providers — Brave Search and Tavily, optional and either/or.** A new
  `research_topic` tool returns citable findings, dated where the provider gives one, so an
  article can be written about an event minutes old. Configure with `byline init`; pin a
  default with `BYLINE_RESEARCH_PROVIDER` (falling back to `WRITEBLOGS_RESEARCH_PROVIDER`).
- `build_writing_brief` accepts `findings` alongside `research`. **Supplying both is
  refused** — one article has one research origin.
- `score_draft` gains `citation_provenance`: pass the research `findings` and it compares
  the absolute `http(s)` URLs the draft links against them, reporting which cited URLs
  were not in the research and which sources went uncited. **Advisory, never blocking**,
  and it reports "not evaluated" rather than passing when no findings are given.
- `docs/RESEARCH-NOTES.md` — measured API behaviour for both providers, every line
  traceable to a real request.
- `CLAUDE.md` at the repo root.

### Breaking

- **`create_post` now enforces the images-by-default contract instead of only nudging
  toward it.** A new `images` parameter (`"both" | "hero" | "inline" | "none"`, default
  `"both"`) is enforced whenever an image provider is configured: the default refuses to
  publish unless `feature_image` is set AND `html` contains a real inline `<img ...src=...>`.
  The previous behaviour — a non-blocking warning that a caller could read and ignore — let
  a real post ship with no hero image and a stock photo standing in for a generated inline
  image; the warning was recorded as "expected" and nothing stopped the publish. **Opt out
  explicitly** by passing `images: "none"` (skip both), `images: "hero"` (hero only, no
  inline required), or `images: "inline"` (inline only, no hero required). Refusal is a
  `ToolError` with code `IMAGES_REQUIRED`, `HERO_IMAGE_REQUIRED`, or `INLINE_IMAGE_REQUIRED`,
  naming exactly which image is missing and how to fix it. **Unaffected when no image
  provider is configured** — the caller cannot comply in that case, so nothing is enforced,
  matching the pre-existing gate the old nudge used. `update_post` is untouched: it patches
  an existing post, and demanding images there would wrongly block a caller fixing a typo.

### Changed

- **News mode's research guard now checks something.** It was satisfied by any non-empty
  string. Provider findings are now checked to exist, and — in news mode — that at least
  one is dated and inside the window the result declares, allowing six hours' grace for
  provider timestamp coarseness; findings that are undated or out of window are accepted
  and marked on the brief rather than rejected one by one. A
  hand-supplied `research` string is checked for substance only, and the error, the brief,
  the tool descriptions, and the README all say plainly that it is **trusted, not
  verified**: Byline did not fetch it and cannot confirm it is recent or that its text
  matches any source it names. Blog mode applies no recency check at all.
- `byline init`, `doctor`, and `status` walk provider *families*, so registering one is a
  single entry in `src/plugins/providers.ts` with no change under `src/cli/`. An
  unconfigured research provider is reported as a note, not a failure.

### Notes

- **Research is entirely optional.** `blog` mode needs none, BYOR still works with no key
  configured, and no key is required to install or run `byline init`.
- **There is no fallback between Brave and Tavily.** They return different shapes — Brave
  ranked snippets, Tavily a synthesis plus sources — so substituting one would silently
  change what the writer receives. Registry order is Brave first, decided by measurement:
  see the recency table in `docs/RESEARCH-NOTES.md`.

## [1.1.0] - 2026-07-30

### Added

- **`byline init` asks for the author persona directly** — five skippable questions
  (name, role, writing style and tone, years of experience, subject expertise) instead
  of only seeding a template and hoping someone finds it. Skipping a required question
  aborts persona creation before anything is written, rather than saving a file that
  fails validation later; the template is still seeded either way, and `init` always
  prints the exact path to the file it produced.
- `create_post` warns, non-blockingly, when an image provider is configured and no
  `feature_image` was set — naming the provider and what to do. An MCP server cannot
  force the calling agent to call a tool first; this is the observable half of making
  images the default, not a guarantee.

### Fixed

- **Image generation is now an honest default.** `build_writing_brief` takes the
  configured image providers and states outright that a hero and inline photograph are
  generated by default whenever a provider is configured — overridable only by the
  user's own instruction, which is said explicitly rather than left implied. When no
  provider is configured, the brief no longer asks for a `[[content_image]]` placeholder
  or a `generate_image` call that would only fail with `SETUP_INCOMPLETE`.
- Every persona prompt now supplies a placeholder, matching the rest of the CLI. Without
  one, `@clack/prompts` rendered the literal string `undefined` as the confirmed value
  when a question was skipped — cosmetic only; verified by inspecting the written
  persona file that the actual skipped value was still correct either way.

## [1.0.0] - 2026-07-30

First public release. An MCP server and CLI that turns an idea into a finished,
published article in the author's own voice — today to Ghost and WordPress, from any AI
tool.

Previously developed under the name `writeblogs`. The product is not blog-shaped: it
takes someone's idea, writes it as them, and puts it where it belongs. Every destination
has a byline.

### Migrating from writeblogs

Nothing breaks and nothing moves on its own.

- `~/.writeblogs/` is still read if `~/.byline/` does not exist. `status` and `doctor`
  report the path as `[legacy]` and point at `byline migrate`, which is the only thing
  that relocates it — and only with `--yes`.
- Every `BYLINE_*` environment variable falls back to its `WRITEBLOGS_*` predecessor,
  and diagnostics name the variable you actually set.
- Re-run `byline register --tools all` to repoint your AI tools at the new package.

### Added

**Publishing**

- Ghost platform plugin — JWT auth, post create/update, image upload, tag and author
  resolution. Verified against Ghost 6.44.
- WordPress platform plugin — Application Password auth, post create/update, media
  upload with alt text, exact-match tag resolution, `featured_media` support. Verified
  against a live single-site install.
- Write-back verification on every post write: the request is diffed against the
  platform's own response, and any field the platform silently dropped is returned as a
  warning rather than disappearing.
- Per-platform `HtmlProfile`, driving both the writing brief and the draft scorer from
  what each platform actually does to HTML on ingest. Ghost's is a constant; WordPress's
  is resolved per authenticated user, since `unfiltered_html` changes the answer.

**Writing**

- `build_writing_brief` — persona-shaped, platform-aware briefs with a reproducible
  seed. Refuses `mode: "news"` without supplied research, so an article about recent
  events cannot be written from training data.
- `score_draft` — scores sentence-length variety, AI tells, evidence, and whether the
  HTML will survive the target platform's ingest.
- Author personas as YAML, with a template seeded on first run.

**Images**

- Gemini image generation with an xAI/Grok fallback. When it falls back it reports that
  it did, and why.
- **A photographic contract** (`src/craft/image-style.ts`), applied server-side by
  `generate_image` so it holds for any caller, not only one that used the writing brief.
  Every prompt names the article's actual subject in a real setting; no text in the frame;
  explicitly not an illustration, 3D render, vector art, or abstract technology
  background. `style` defaults to `photoreal_people`, so the **hero image always contains
  people** — it is the post card and the social share image. `style: 'diagram'` is the
  deliberate escape.
- People are asked to vary in age, ethnicity, and gender across images, appropriate to the
  setting, rather than taking the image model's default.
- A seeded `imageLook` dimension gives each article its own camera register, passed
  through to `generate_image` so every image in one article matches.
- When **every** provider refuses a prompt asking for people, one retry runs without them
  and the result reports `people_dropped` with the providers' own reason. A provider that
  broke rather than refused propagates as the failure it is — a 401 or a dead socket can
  no longer be mistaken for a safety refusal.
- `score_draft` accepts an optional `feature_image` and checks image presence and alt-text
  quality, including alt text copy-pasted from the headline. Non-blocking, and explicit
  that it cannot verify what an image depicts.

**Configuration**

- Config lives in `~/.byline/`. `config.yaml` holds only `${VAR}` references so it
  stays shareable; every secret lives in `.env` at mode 600.
- Per-field path resolution — `BYLINE_HOME`, `BYLINE_SITES`,
  `BYLINE_PERSONAS`, `BYLINE_ENV` — with per-field provenance reported by
  `status` and `doctor`.
- A site whose environment variable is missing still loads. It is marked unusable and
  reported, while every other site keeps working, so keys can be added one at a time.

**CLI**

- `byline init` — first-run wizard. Detects the AI tools actually installed, backs
  up each config before merging, and walks credentials with a working Skip on every
  prompt.
- **Every credential is validated against the live platform before it is accepted**, and
  the platform's own error is shown on failure with retry and skip offered.
- `status`, `doctor` (`--offline`), `register` (`--tools`, `--scope`, `-i`), `migrate`
  (`--yes`), `reset` (`--yes`), `update` / `upgrade`, `help`.
- Node version guard as the literal first statement of the bin shim: an old runtime gets
  one clear line, not `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
- TTY dispatch — a terminal gets help, a pipe gets the MCP server.
- A top-level error boundary around every command, so no command can show a raw stack
  trace. The stack is available via `BYLINE_DEBUG=1`.

**MCP tools** (13)

`health_check`, `list_sites`, `add_site`, `remove_site`, `list_personas`, `get_persona`,
`list_authors`, `build_writing_brief`, `score_draft`, `generate_image`, `upload_image`,
`create_post`, `update_post`.

### Security

- `healthCheck` on every platform gates on an endpoint that **requires authentication**.
  Ghost's previously probed `GET /site/`, which needs none, so a fabricated-but-
  well-formed key was reported valid — `init` accepted wrong keys and `doctor` stayed
  green until the first `create_post`. Both platforms now carry fabricated-credential
  regression tests, as unit tests and against their live installs.
- Site short names are constrained to lowercase alphanumerics and hyphens by both
  writers of `config.yaml`. Previously `add_site` accepted anything, so `my-blog` and
  `my_blog` derived the same environment variable name and the second silently
  overwrote the first's credential.
- `reset` refuses to delete a home directory, an ancestor of one, an immediate child of
  the filesystem root, or any directory containing `.git` or `package.json` — compared
  by inode rather than by string, since a case-insensitive filesystem made string
  comparison bypassable.
- `migrate` copies and never moves, never overwrites (enforced with `COPYFILE_EXCL`, not
  by ordering), and always lands `.env` at mode 600 regardless of the source's mode.
- No credential value appears in any diagnostic output.

### Changed since 0.x

- Renamed `writeblogs` → `byline`, with a full compatibility path (see above).
- `generate_image` takes the SUBJECT only and applies the photographic contract itself,
  so the guarantee holds for any caller rather than only one that used the brief.
- `score_draft` gained an optional `feature_image`, and `experience_markers` now fails an
  article with no first-person voice — the signature of a draft written without the
  brief, which is how a generic article reaches publication.
- WordPress accepts a `<table>` summary block, so one article can satisfy both platforms.
  Cross-posting was previously impossible: the same HTML scored `pass` on Ghost and
  `blocked` on WordPress.
- Both platforms now refuse HTML still containing `[[content_image]]`. WordPress
  previously published the literal placeholder as visible text.
- The CLI reports when a newer version is published, at most once a day, never on the
  MCP path and never on `--version`.

### Known limitations

- **The restrictive WordPress path is unverified.** Every claim about an account without
  `unfiltered_html`, and everything about multisite, is reasoned from WordPress's
  documented KSES behaviour and has never been measured — only a single-site
  administrator was available to probe. See `docs/WORDPRESS-NOTES.md`.
- WordPress core has no field for injecting into `<head>`, so JSON-LD structured data
  cannot be applied there. This is reported as a warning (`schema_injected: false`)
  rather than silently dropped.
- `npx -y @indianic/byline` cannot resolve until the package is published, and npx
  does not fall back to a global install.

[Unreleased]: https://github.com/indianic/byline/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/indianic/byline/releases/tag/v0.1.0
