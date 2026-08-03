# Contributing

Start with **[CONTEXT.md](CONTEXT.md)**. It explains why this codebase is shaped the way
it is, and the one rule that matters most here: *nine defects reached working code, and
none of them was caught by the test suite.* That rule shapes everything below.

## Setup

```bash
npm install
npm run build
npm test
```

Node 20 or newer. No other prerequisites — the unit suite touches no network.

## The three gates

Every commit must pass all three:

```bash
npm run typecheck    # tsc --noEmit
npm run build        # tsc
npm test             # vitest run — unit only
```

**The test count must not fall below the floor stated in `CLAUDE.md`.** It is a floor,
not a target. If a change reduces it, say why in the commit message. The number lives in
one file on purpose — it has already been stale in two places at once.

Note that `npm run typecheck` covers `src/**/*` only — `tsconfig.json` sets
`rootDir: src`, so test files are not typechecked by any script. A test double can cast
its way past an interface it does not satisfy and nothing will complain. Assert
behaviour at runtime rather than trusting a type annotation on a double.

## Integration tests

```bash
RUN_INTEGRATION=1 npx vitest run tests/integration/
```

These hit real APIs. They are excluded from the run entirely unless `RUN_INTEGRATION=1`
is set, so CI needs no secrets.

**Point them at your own throwaway site, never someone else's.** They skip themselves
with a named reason when your config has no site under the expected slug, which is the
normal case — that is working as intended, not a failure. They are self-cleaning:
create, read back, assert, delete.

## Security rules

**No real credential, personal site URL, or author id in a commit. Ever.**

- `.env`, `.env.*`, `config/sites.yaml`, and `personas/*.yaml` are gitignored — the
  persona rule covers *every* hand-written persona file, including yours, not just the
  maintainer's. `personas/_template.yaml` is the only tracked one.
- Test fixtures use fabricated keys from `tests/fixtures/keys.ts`. Use them; do not
  paste a real key into a test "just to check something."
- Before pasting terminal output into a doc or an issue, run it under an isolated
  `HOME`, and grep the result for your own hostnames and username. `config.yaml` is
  designed to be safe to share — it holds only `${VAR}` references — but transcripts are
  not.

## What "done" means here

A green suite is the start of the argument, not the end of it. Depending on what you
touched:

- **Changed something that talks to an HTTP API?** Make a real request against a real
  install and read the response back. Every verified line in `docs/GHOST-NOTES.md` and
  `docs/WORDPRESS-NOTES.md` came from an actual request, not from the platform's
  documentation. Assume the docs are wrong until a live response proves them right.
- **Changed an MCP tool?** Test through the tool layer, not by calling the adapter
  directly. The SDK's zod parsing **silently strips keys the input schema does not
  declare**, so a field can be plumbed correctly everywhere else and still never arrive.
- **Changed the brief or the scorer?** Read the English sentences they actually produce,
  including for a profile with empty collections. Both of the `score.ts` defects this
  project shipped were visible only by reading the output; the suite was green.
- **Changed the CLI?** Run the binary. A dynamic-import bug once made bare `byline`
  over pipes produce no output at all while 290 tests passed.
- **Adding a platform?** `docs/ADDING-A-PLATFORM.md` is the gate. Work the checklist —
  particularly step 4, which is why a wrong credential can no longer be accepted as
  valid.

## Commits

Small, reviewable, one concern each. Conventional-commit prefixes (`feat:`, `fix:`,
`docs:`, `test:`, `refactor:`, `chore:`).

Write the body for whoever has to understand this in six months. Say what was wrong and
how you know the fix works — *"verified the guard is load-bearing by disabling it and
watching all five cases fail"* is worth more than *"added validation."*

## Verifying a regression test actually regresses

If you add a test for a bug, prove it fails without the fix. Disable the fix, run the
test, watch it fail, restore. A regression test that has never failed is documentation,
not a test — and this project has shipped mocks that agreed with the bug.

## Adding a platform

See **[docs/ADDING-A-PLATFORM.md](docs/ADDING-A-PLATFORM.md)**. It is written from
actually adding WordPress, including the parts that went wrong, and every step exists
because skipping it once already shipped something broken or silently wrong.

The short version: a new platform is one folder under `src/plugins/platforms/` plus one
line in `registry.ts`. Nothing in `src/cli/` should need to change — and if you find
yourself adding a platform-specific branch there, that is the bug.
