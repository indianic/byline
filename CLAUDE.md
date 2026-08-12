# Rules for working in this repository

Nine defects reached working code here. Every one typechecked, built, and passed its
tests. Not one was caught by the suite. These rules are what they cost.

## Verification

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

## Design

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

## Release

- **Run the artifact gate before any publish** — grep the staged tree *and* the extracted
  tarball for credentials and personal identifiers. It caught two real leaks on 1.0.0,
  including hostnames compiled into `dist/*.d.ts`.
- **`npmnic publish` bumps the version itself** (`--patch` default, `--minor`, `--major`).
  Set `package.json` to the version *before* the one you want.

## Testing

- `npm test` (unit, no network), `npm run typecheck`, `npm run build`. Integration behind
  `RUN_INTEGRATION=1`.
- **1228 passing tests is the floor, not the target.** Never delete a test to make a change
  pass.
- **`npm run typecheck` covers `src/**/*` only** — test files are not typechecked. A double
  can cast past an interface it does not satisfy. Assert behaviour at runtime.
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
