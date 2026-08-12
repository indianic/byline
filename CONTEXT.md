# CONTEXT

Orientation for someone — human or agent — about to change this codebase.

`README.md` is for people who want to publish a blog post. This is for people who want
to modify how that happens. It carries forward what the design and planning documents
know, so the code is not the only surviving record of *why* it is shaped this way.

---

## Read this part first

**Nine defects reached working code in this project. Every one of them typechecked,
built, and passed its tests.**

Not one was caught by the test suite. Each was caught by a real API call, by reading the
English a tool actually printed, or by running the binary the way a user runs it. The
signature is always the same:

> **The mocks agreed with the author's assumption.**

A mock encodes what you believe the remote system does. When the belief is wrong, the
mock is wrong in exactly the same direction, and a green suite confirms the mistake
instead of catching it. The three that cost the most:

1. **`?source=html`.** Ghost's Admin API defaults to expecting Lexical JSON. `POST
   /posts/` without `?source=html` returns **201**, creates the post, and silently has
   no body in it. No error, anywhere. The most consequential query parameter in the
   codebase, and its absence does not fail — it succeeds emptily.

2. **`feature_image_id` never arrived.** WordPress's `featured_media` needs an integer
   attachment id. The field was added to `PostInput` and to the WordPress adapter, and
   the feature did nothing — because the MCP SDK's zod parsing **silently strips keys
   the input schema does not declare**, so the value never survived the trip from tool
   call to adapter. The adapter's own unit tests passed, because they called the adapter
   directly with the field already present. Found by reading a published post back off
   the live site.

3. **`healthCheck` probed an unauthenticated endpoint.** Ghost's `GET /site/` requires
   no auth at all. A fabricated-but-well-formed key returned `ok: true, status: 200`
   with the real site title. So `init` accepted wrong keys, and `doctor` and
   `health_check` stayed green, until the user's first `create_post`. This one is worse
   than a bug: it hollowed out the installer's central promise, quietly.

**The working rule this produced:** a mocked test proves the code does what you told it
to. It cannot prove you told it the right thing. For anything that crosses a boundary —
an HTTP API, the MCP tool layer, the filesystem, a terminal — the test that counts is
the one that goes through the real thing and reads back what actually happened.

`docs/ADDING-A-PLATFORM.md` is this rule turned into a checklist. It is the actual gate
for adding a platform, not a suggestion.

---

## Architecture

```
bin/byline.js          Node-version guard (literal first statement), then TTY dispatch
src/
  index.ts                 the MCP server — `main()` is exported and called by the shim
  cli/                     everything a human at a terminal touches
    main.ts                dispatch, help, levenshtein typo suggestions, error boundary
    init.ts                the setup wizard, first run and every re-run — composition only
    credentials.ts         the credential walk, with an injectable Prompter seam
    editor-config.ts       5 AI tools, JSON + Codex TOML merge, backup before write
    status.ts doctor.ts migrate.ts reset.ts register.ts update.ts
    tree.ts                the shared output vocabulary (◆ ◇ ▲ ■ ●)
  tools/                   the 20 MCP tools — schemas and handlers
  media/                   the local media library: a user's own folder of photographs
    types.ts               Asset, MediaIndex, UsageLedger, LibraryConfig — the shapes
    library.ts             the `media:` config block, and where the index and ledger live
    scan.ts                the folder walk — content-hash ids, magic-byte mime, tokens
    search.ts              deterministic keyword ranking; no embeddings, no network
    store.ts               atomic reads and writes for both files
    ledger.ts              isUsed / reserve / promote / release — what "used" means
    embed.ts               URL -> <iframe> embed HTML for YouTube/Vimeo/Bunny Stream; pure,
                            no network, no fs — video is embedded by URL, never uploaded
  plugins/
    platforms/             ghost/ and wordpress/, each a self-contained folder
    images/                gemini/ and grok/, with fallback
    research/              brave/ and tavily/, EITHER/OR — no fallback
    providers.ts           the provider FAMILIES the CLI walks — images, research
    registry.ts            the one place a plugin is wired in
  craft/                   brief.ts, score.ts, html-profile.ts — the writing logic
  config/                  paths.ts, dotenv.ts, sites.ts, personas.ts, site-block.ts
  context.ts               loadContext() — assembles everything the tools need
  errors.ts                ToolError, and the ok()/error envelope
```

**Two entry points, one binary.** `bin/byline.js` checks `stdin.isTTY &&
stdout.isTTY`: a terminal gets the CLI, a pipe gets the MCP server. The version guard
above that must stay free of any `import`, `node:` scheme, or top-level `await`, or it
cannot run on the old runtimes it exists to catch.

> A trap already sprung here: the shim originally started the server with `await
> import('../dist/index.js')`, and `src/index.ts` guarded `main()` on `import.meta.url
> === file://${process.argv[1]}`. Under a dynamic import from the shim, `argv[1]` is the
> *shim's* path, so the guard was always false and bare `byline` over pipes produced
> **no output at all**. Typechecked, built, 290 tests green, did nothing. `main` is now
> exported and called explicitly.

### The plugin boundary

Adding a platform means adding a folder under `src/plugins/platforms/` and one line in
`registry.ts`. That claim held for WordPress — but only for the adapter. Read
`docs/ADDING-A-PLATFORM.md` for the two conditions under which it does *not* hold, both
of which WordPress broke, and what each cost.

**`src/cli/` contains no platform-specific branches, and must not gain any.** The
installer walks whatever `credentialFields` a plugin declares — prompt order, which
prompts are masked, what help text appears. A new platform shows up in the wizard for
free, correctly or incorrectly, exactly as its descriptors describe it. `ImageProvider`
was widened to carry the same `CredentialField` type for exactly this reason: one walk
serves both, and `GEMINI_API_KEY` never has to be named inside `src/cli/`.

### The image contract

`src/craft/image-style.ts` is the single definition of what a generated image must look
like: `IMAGE_LOOKS` (the per-article camera register, which varies) and
`composeImagePrompt` (the invariants, which do not). `dimensions.ts` **imports**
`IMAGE_LOOKS` rather than declaring its own copy — the composer needs the list as much as
the brief does, since its whole purpose is to work for a caller who never ran
`build_writing_brief`, and two hand-maintained copies of one rule is how `SLUG_PATTERN`
and the providers' env var names drifted before.

The contract exists because images were the one visual element here left to improvisation:
`TABLE_THEMES` pins a table's box-shadow blur to the hex digit while an image was
specified as *"detailed prompt for the hero image, 16:9, no text in image"*.

Three defects in that contract were found by **generating an image and looking at it**,
none by a test: the subject spliced in without a terminator so it ran into the next
clause; the brief displaying a camera register the tool would then ignore; and every
person coming back as the same demographic because nothing said otherwise.

### Research: either/or, and no fallback

`src/plugins/research/` mirrors `images/` — same `CredentialField`, same `configured()`,
`withKey()`, `healthCheck()` — with one deliberate difference: **there is no chain.**

The image providers fall back Gemini→Grok because both return the same shape — a PNG,
substitutable without the caller noticing. Brave returns ranked snippets and Tavily returns
a synthesis plus sources: two different shapes, so substituting one for the other would
silently change what the writer receives, not merely which vendor served it.
`selectProvider()` picks exactly one, resolved from configuration alone *before* any
request, which is what makes the rule enforceable: no runtime failure is visible from the
point where the choice is made. A named provider whose key is unset is refused, and a
search that throws is rethrown, never retried against the other.

An article has exactly one research origin — a BYOR `research` string or provider
`findings`, never both. `BriefInput` is a union so `tsc` refuses both, and the tool handler
refuses them again because MCP input is runtime data. Merging them would make provenance
unanswerable, which would leave `score_draft`'s `citation_provenance` check nothing solid
to check against.

**Be exact about what is checked, everywhere it is stated.** A result with no findings in
it is refused in any mode. In **news mode only**, at least one finding must carry a
readable date inside the window the result declares (plus `DATE_GRACE_MS`, a fixed six
hours, for provider timestamp coarseness) — and that window is the caller's own
claim about what was requested, since it arrives inside the payload; existence and
datedness are checkable outright, the window only relative to that claim. Findings that
are undated or out of window are accepted and marked individually on the brief, not
rejected one at a time, because an article legitimately cites background alongside its
breaking sources. Blog mode applies no recency check at all. A pasted `research` string is
checked for substance only, and every place it surfaces says so: **trusted, not verified.**
The old guard was satisfied by any non-empty string, which made the stated promise a speed
bump — and three separate overclaims about this boundary had to be walked back during the
phase that built it, so `one rule, one definition` applies to the prose here as much as to
`SLUG_PATTERN`.

`citation_provenance` is the only check in the project that speaks to provenance rather
than shape, and its limits are part of its definition: it compares absolute `http(s)` URLs
in `<a href>` against the findings' URLs, it is advisory rather than blocking (a writer
legitimately links a homepage no search returned), it reports "not evaluated" when no
findings are passed, and it says nothing about whether a source supports the claim made
from it.

`src/plugins/providers.ts` is the one place a provider *family* is registered. Adding one
is a single entry there — no edit anywhere under `src/cli/` is needed for `init`, `doctor`,
and `status` to pick it up, including the "unconfigured" wording, which comes off each
family's own descriptor rather than being written per family (images' `unconfiguredNote`
reads "not a failure — the second image provider is a fallback most users skip"; research's
says there is no fallback at all — substituting one provider for the other is false for one
of the two, so the wording cannot be shared).

The one bounded exception: `status.ts` also emits a legacy `imageProviders` field — the
pre-family output shape, filtered from the family list by `f.id === 'images'` and kept
verbatim so nothing already reading it breaks, with the family-generic `providers` array
added beside it for every new consumer. `doctor.ts`'s "no image provider configured"
warning is keyed off that same field. `imageProviders` is frozen to `images` by definition;
no other family will ever populate it, and it is not a platform- or provider-specific
branch reintroduced into `src/cli/` — it is one legacy field named for the one family it
was built before families existed.

Measured API behaviour lives in `docs/RESEARCH-NOTES.md`, including the registry order and
the measurement that decided it.

### The media library

`src/media/` indexes a folder of the user's own photographs so `find_media` can rank them
and `use_media` can upload them. Four rules carry the weight:

**`isUsed` is the one definition of used/not-used.** `find_media`'s exclusion,
`list_media_libraries`' `unused` count, and `use_media`'s refusal all call it. `use_media`
originally wrote the ledger without ever reading it, so `find_media({unused_only: false})`
— a legal escape hatch — handed an already-published photograph straight back and the
second upload was reported as a success.

**The ledger is a separate file from the index, and it is unrecoverable.** `scan` rewrites
`<name>.index.json` freely; `<name>.usage.json` records what has been published and cannot
be rebuilt from anything. That is also why `readLedger` throws on corruption where
`readIndex` returns null: continuing with an empty ledger would republish everything and
report success.

**Byline never writes inside the library folder.** The index and ledger default to
`<byline home>/media/`, and an `index_path` that resolves inside the library's own path is
refused at load.

**A reservation is made when the bytes reach the platform, and promoted when a post carries
the hosted URL.** Both states count as used: the image is in the platform's media library
either way. `release` exists to undo a reservation whose publish failed and **no tool or
command reaches it in this release** — the remedy is editing the JSON, which
`list_media_libraries` says out loud and names the file for. Enrichment (captions,
keywords, `has_people`) and video upload are likewise not built, and every string that
could imply otherwise says so.

**Video is embedded by URL, never uploaded — that goal was dropped entirely.**
`embed_video` (`src/media/embed.ts`) turns a YouTube, Vimeo, or Bunny Stream URL into
`<iframe>` embed HTML; it touches no library, no ledger, and no adapter. Verified by live
probe 2026-08-12: Ghost and WordPress (for an account holding `unfiltered_html`) both keep
an `<iframe>` on ingest, while a `<video src>` tag is stripped completely on Ghost — the
reason `iframe` was added to `GHOST_HTML_PROFILE.preserved` and to WordPress's permissive
`PERMISSIVE_PRESERVED`, and deliberately NOT to WordPress's restrictive set, which stays
UNVERIFIED for `iframe` the same way it does for everything else no non-`unfiltered_html`
account has ever been available to probe.

### `HtmlProfile`

`src/craft/html-profile.ts` defines what a platform does to your HTML on ingest —
what is preserved, what is unwrapped, which containers survive with styling. The brief
and the scorer both read it, so a platform's real behaviour drives what writers are
asked to produce.

Ghost's profile is a **constant**; its ingest behaviour does not vary. WordPress's is
**resolved per authenticated user per site**, because `capabilities.unfiltered_html`
decides everything, and a failed capability check must fail toward the *restrictive*
profile, never the permissive one.

**Assume a profile's collections can be empty.** Every shared renderer in `src/craft/`
was written against Ghost's values, where `unwrapped` and `visualContainers` are always
non-empty. WordPress was the first profile to have an empty one, and it produced a real,
shipped sentence telling a writer to *"add a styled `<div>` summary block (a `<div>`
card would be stripped)"* — on the one platform where a `<div>` is exactly what
survives. `tsc` cannot see this; both profiles are structurally valid.

---

## Config resolution

Four paths — config, personas, secrets, images — each resolved independently:

1. A `BYLINE_*` environment override, **per field**.
2. `~/.byline/` — the normal case.
3. A repo-local `config/sites.yaml` relative to the **current working directory** — the
   dev-checkout fallback.

Provenance is tracked per field and printed by `status` and `doctor`, because a single
global "source" line is false the moment one override is set: it would print a path the
loader never reads. `paths.provenance[field].path` is derived from the same value as the
plain field, so the two cannot drift.

Branch 3 depends on where the process was started, and **an MCP host picks that
directory, not the user**. `doctor` names which branch matched and warns when it is this
one.

**Secrets never appear in `config.yaml`.** A secret field is written as `${ENV_VAR}` and
its value goes to `.env` at mode 600; a non-secret field is written literally. That rule
lives in exactly one place — `src/config/site-block.ts`'s `buildSiteBlock` — because two
callers need it identical (`add_site` and the CLI installer) and a second hand-written
copy is how they would drift.

> They have already drifted once. `init` wrote a site unconditionally while `add_site`
> refused with `SITE_EXISTS`; re-adding an existing short name replaced a Ghost site
> with a WordPress one, overwrote its credential, and moved `default_site`, with no
> warning and no way back through the tool. Both writers now enforce the same
> `SLUG_PATTERN` from `src/config/sites.ts`, for the same reason.

---

## Error handling

**Nothing fails silently.** Every tool returns a result or a `ToolError` envelope naming
the failing API and its HTTP status. Two mechanisms are load-bearing:

- **Write-back diffing.** Every `create_post`/`update_post` compares what was sent
  against what the platform echoed back, and returns `warnings` naming any field that
  was quietly dropped. Ghost accepts `excerpt` (read-only; the writable field is
  `custom_excerpt`) with a 201 and discards the value. This is what makes
  `schema_injected` honest rather than optimistic.
- **`ToolError.hint`.** The field that exists to say what to do next. It is surfaced by
  the CLI's error boundary and folded into what `status` and `doctor` print — an earlier
  version dropped it, discarding the most useful part of the error.

`loadContext()` **never throws.** Problems are collected into `SetupState` so the
diagnostic tools can report them. A `doctor` that crashed on a broken config would be
useless precisely when it is needed.

The CLI has a **top-level error boundary** around every handler. No command, present or
future, can show a user a raw Node stack trace. The stack is not discarded — it is one
`BYLINE_DEBUG=1` re-run away.

---

## What is UNVERIFIED

Stated plainly so nobody promotes it by accident.

**The restrictive WordPress path has never been measured.** Only a single-site
administrator account was ever available, and that role always holds `unfiltered_html`.
Every claim about an account *without* it — that `style=` is stripped, that `class=` is
stripped, which elements are unwrapped versus destyled, whether `target=` and
hand-written heading ids survive — is reasoned from WordPress's documented KSES
behaviour and nothing else.

**Nothing about multisite was measured at all.** No multisite network was available. The
"only Super Admins hold `unfiltered_html` on multisite" claim is WordPress's own
documentation.

**Media promotion is measured on Ghost and unmeasured on WordPress.** `promote()` matches a
reservation's `hosted_url` against the image URLs a post carries, by exact string equality.
Every unit test of it hands the upload double a string and gets the identical string back,
which is structurally incapable of catching a platform that rewrites the URL — a
`__GHOST_URL__` placeholder, a protocol-relative form, a CDN host, a `/size/w1000/`
responsive prefix. `tests/integration/media.integration.test.ts` settles it for Ghost: run
against the live blog on 2026-08-12, the uploaded URL came back out of
`GET /posts/{id}/?formats=html` byte for byte, in both the rendered `<img src>` and
`feature_image`, and the reservation promoted to `published`. The row is in
`docs/GHOST-NOTES.md`. **No equivalent probe exists for WordPress** — nothing has confirmed
that a URL from its media endpoint survives into stored post content unaltered.

Those branches carry `UNVERIFIED` markers in
`src/plugins/platforms/wordpress/html-profile.ts` and in `docs/WORDPRESS-NOTES.md`. **Do
not remove a marker without a probe against an account that actually exercises that
path.**

One concrete reason to be careful here: an earlier version put the table family in
`RESTRICTIVE_UNWRAPPED` and left `visualContainers` empty for that path, reasoning that
nothing was confirmed to survive. That made `score_draft`'s BLOCKING `ai_summary_block`
check impossible to ever pass, and told a writer in one breath that a `<table>` summary
block was both required and forbidden. Reasoning conservatively is not automatically
safe.

---

## Testing

```bash
npm test                                          # unit only, no network
npm run typecheck                                 # tsc --noEmit
npm run build                                     # tsc
RUN_INTEGRATION=1 npx vitest run tests/integration/   # live APIs
```

**The unit-test count is a floor, not a target, and the number itself is stated in
`CLAUDE.md` and nowhere else — it has already gone stale in two files at once.** Integration tests are excluded from the
run entirely unless `RUN_INTEGRATION=1` is set, so CI needs no secrets. They are
self-cleaning — create, read back, assert, delete — and skip themselves with a named
reason when the config has no site by the expected slug, which is the normal case for
anyone but the maintainer.

Two things worth knowing before writing tests here:

- **`npm run typecheck` covers `src/**/*` only.** `tsconfig.json` sets `rootDir: src`,
  so test files are not typechecked by any script. A test double can cast past an
  interface it does not satisfy and nothing will complain. Prefer asserting behaviour at
  runtime over trusting the type annotation on a double. (Typechecking the test tree
  currently surfaces 14 pre-existing errors — an open decision, not a settled one.)
- **Never write `process.env = { ...saved }`.** It replaces the object and detaches it
  from the process's native environment, after which `os.homedir()` goes stale for the
  rest of the process — every later test file in the same worker included. Restore per
  key. `tests/context.test.ts` has both the pattern and a guard test.

---

## Where the hard-won knowledge lives

| File | What it holds |
|---|---|
| `docs/GHOST-NOTES.md` | Every verified Ghost behaviour, each paired with the code it forced |
| `docs/WORDPRESS-NOTES.md` | The same for WordPress, with the `unfiltered_html` rule stated first |
| `docs/RESEARCH-NOTES.md` | Measured Brave and Tavily behaviour, and the recency table that set the registry order |
| `docs/ADDING-A-PLATFORM.md` | The extension checklist, written from actually adding WordPress |
| `src/plugins/platforms/*/README.md` | Per-platform setup, quirks, and how each was verified |
| `docs/CLI.md` | Every command and flag |
| `CLAUDE.md` | The short, rule-shaped version of this file, loaded into every session |

**Every line in the three NOTES files is traceable to a real request against a real
install or API.** Not to documentation, not to memory. Do not widen a claim in them without
another probe that proves the change — and when a probe corrects one, correct the file.
`GHOST-NOTES.md` itself once documented the false claim that `/site/` "proves the signed
JWT is actually valid," written from reasoning and never probed. That sentence is how
defect 3 above survived four phases.
