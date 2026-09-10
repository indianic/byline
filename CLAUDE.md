# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                              # unit suite, no network (vitest)
npx vitest run tests/tools.test.ts                    # one file
npx vitest run tests/tools.test.ts -t "schedule"      # one test by name
RUN_INTEGRATION=1 npx vitest run tests/integration/   # live Ghost/WordPress/research APIs; self-skips without a configured site
npm run typecheck                                     # tsc --noEmit, src/ only
npm run build                                         # tsc -> dist/
npm run dev                                           # tsx src/index.ts (MCP server over stdio)
BYLINE_DEBUG=1 byline <cmd>                           # CLI with stack traces
```

Two entry points, one binary: `bin/byline.js` dispatches to the CLI when stdin and stdout
are a TTY, otherwise to the MCP server. Its Node-version guard must stay free of `import`,
`node:` and top-level `await`.

## Architecture in one screen

The host model does the thinking; Byline does everything that touches the outside world.
A post moves through the MCP tools in `src/tools/` in this order: `research_topic`
(optional, `src/plugins/research/`) → `build_writing_brief` (`src/craft/brief.ts` +
`dimensions.ts`, seeded random per-article hook/arc/voice/texture/author-presence) → the
host writes HTML → `score_draft` (`src/craft/score.ts`, mechanical regex checks; only
platform_html, structure and ai_summary_block block) →
`generate_image(s)`/`upload_image(s)`/`find_media`/`use_media` → `create_post`
with write-back diffing. Personas are YAML in `~/.byline/personas/` (`src/config/personas.ts`;
unknown fields are kept as `extras` and rendered into the brief, never dropped).

Three invariants shape the code more than anything else:

- **Brief and scorer share one definition.** `BANNED`, `BANNED_CONSTRUCTIONS` and
  `THRESHOLDS` live in `score.ts`; `brief.ts` imports them so what the writer is warned
  about and what it is marked down for cannot drift.
- **`HtmlProfile` drives platform-specific prose.** Ghost's is a constant; WordPress's is
  resolved per user from `unfiltered_html` and fails toward restrictive. `src/cli/` names
  no platform or provider; `src/craft/` and `src/tools/` take platform-specific prose from
  `HtmlProfile` rather than branching on the platform, with one documented exception in
  `media-tools.ts`.
- **Plugins register in one place each**: platforms in `src/plugins/registry.ts`, provider
  families (images, research) in `src/plugins/providers.ts`. `src/cli/` walks their
  `CredentialField` descriptors and names no platform or provider.

`CONTEXT.md` holds the full architecture and the reasons behind it. The rules below are
the short version.

---

## Rules for working in this repository

Nine defects reached working code here. Every one typechecked, built, and passed its
tests. Not one was caught by the suite. These rules are what they cost.

### Verification

- **A mocked test proves the code does what you told it. It cannot prove you told it the
  right thing.** For anything crossing a boundary — HTTP, the MCP tool layer, the
  filesystem, a terminal — the test that counts goes through the real thing and reads back
  what happened.
- **Read the actual output.** The English a tool prints, the image generated, the post read
  back off the live site, the brief a writer will act on. Four separate defects were
  visible only that way.
- **Never encode an unverified external fact** — an API shape, a config path, an endpoint's
  auth requirement. Probe it live first.
- **`healthCheck()` must gate on an endpoint that genuinely requires authentication.**
  Verify with a fabricated-but-well-formed credential and confirm a non-2xx. Ghost's
  `GET /site/` needs no auth; probing it reported fabricated keys as valid for four
  phases, and `init` accepted them.
- **Mark UNVERIFIED claims UNVERIFIED**, in code and in docs, and never promote one on the
  strength of a probe that did not exercise it. The restrictive WordPress path is still
  unmeasured.
- **A NOTES file's *consequence* column is a claim about the code.** When the code
  deliberately does the opposite, correct the file and say why — a prescription nobody
  implemented reads as a to-do.

### Design

- **A guard satisfiable by any non-empty string is not a guard.** Name what it actually
  checks, in the code and in the docs. Say plainly when something is trusted rather than
  verified.
- **A tool description that promises unbuilt behaviour is worse than a missing feature.**
  The host model repeats it to the user, so an overclaim there tells someone their work was
  verified when nothing checked it. Three such claims had to be walked back in one phase.
- **One rule, one definition — and this applies to prose, not just code.** Two
  hand-maintained copies drift: `SLUG_PATTERN`, `IMAGE_LOOKS`, and the providers' env var
  names all proved it in code, and the news-mode boundary proved it in English — stated in
  three places, and the third copy was the wrong one.
- **`src/cli/` contains no platform- or provider-specific branches, with two named
  exceptions, both anchored to one legacy field.** Plugins describe themselves via
  `CredentialField`; the installer walks whatever it is given. The exceptions are
  `status`'s legacy `imageProviders` field, frozen to `images` by definition and kept
  verbatim beside the family-generic `providers` array, and `doctor`'s warning that
  `generate_image` will refuse — keyed off that same already-images-specific field,
  because that one tool genuinely is image-specific. Nothing else in `src/cli/` may name
  a family, a platform, or a provider.
- **Assume a profile's collections can be empty.** A `?? 'div'` fallback that fabricates a
  tag name shipped a sentence telling a WordPress writer a `<div>` would be stripped, on
  the one platform where it survives.
- **Nothing fails silently.** Every tool returns a result or a `ToolError` naming the
  failing API and its status. Write-back diffing exists because Ghost accepts read-only
  fields with a 201 and discards the value.
- **Research is either/or.** One article, one origin: a BYOR `research` string or provider
  `findings`, never both. Never a fallback between Brave and Tavily — they return
  different shapes, and substituting one silently changes what the writer receives.

### Release

- **Run the artifact gate before any publish** — grep the staged tree *and* the extracted
  tarball for credentials and personal identifiers. It caught two real leaks on 1.0.0,
  including hostnames compiled into `dist/*.d.ts`.
- **`npmnic publish` bumps the version itself** (`--patch` default, `--minor`, `--major`).
  Set `package.json` to the version *before* the one you want.

### Testing

- `npm test` (unit, no network), `npm run typecheck`, `npm run build`. Integration behind
  `RUN_INTEGRATION=1`.
- **1532 passing tests is the floor, not the target.** Never delete a test to make a change
  pass.
- **`npm run typecheck` covers `src/**/*` only** — test files are not typechecked. A double
  can cast past an interface it does not satisfy. Assert behaviour at runtime.
- **Never hardcode a future date in a test.** `tests/tools.test.ts` scheduled posts for
  `2026-09-04`; the day that date passed, three tests failed on a clean tree because the
  scheduler correctly refuses a `publish_at` in the past. Derive dates from `Date.now()` or
  use fake timers.
- **Never write `process.env = { ...saved }`.** It detaches the object from the process
  environment and `os.homedir()` goes stale for every later test in the worker. Restore per
  key.

See `CONTEXT.md` for architecture, `docs/ADDING-A-PLATFORM.md` for the extension gate, and
`docs/GHOST-NOTES.md`, `docs/WORDPRESS-NOTES.md`, `docs/RESEARCH-NOTES.md`,
`docs/IMAGE-NOTES.md` for measured remote behaviour — every line in those four is
traceable to a real request.

- **Check the INSTALLED version before re-probing a provider.** A "the fix is in but the
  behaviour persists" report on 2026-08-10 was the global `@indianic/byline@1.6.1` running
  as the MCP server while the repo sat at 1.7.1. The live API was fine.
