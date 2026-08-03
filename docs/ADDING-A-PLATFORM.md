# Adding a platform

This is written from actually adding one — WordPress, against the probed WordPress install
— not from how the architecture was supposed to work. It reports what that took,
including the parts that went wrong, so the next platform doesn't repeat them.

## The claim, and how far it actually holds

The claim: adding a platform means adding a folder under `src/plugins/platforms/`
that exports a `PlatformPlugin`, plus one line in `registry.ts`. Nothing outside
that folder should need to change.

**For WordPress, the adapter itself did meet that claim.** Four files —
`index.ts`, `auth.ts`, `html-profile.ts`, `plugin.ts` — under
`src/plugins/platforms/wordpress/`, plus two lines in `src/plugins/registry.ts`
(the import and the registry entry). Nothing in `src/tools/`, `src/craft/`, or
`src/config/` was needed for `WordPressAdapter` to authenticate, create a post,
upload an image, or resolve tags.

**But the claim holds only under two conditions, and WordPress broke both of
them** — not because the architecture was wrong, but because "the adapter
compiles and its own tests pass" is not the same claim as "the feature works,"
and the gap between those two only shows up when you go looking for it.

### Condition (a): the platform needs nothing the shared interfaces lack

WordPress's `featured_media` field wants an **integer media attachment id** —
not the URL that `PostInput.feature_image` already carried for every platform.
Ghost has no equivalent field and was never going to need one. That single
difference cost **four edits, not one**:

1. **Widen `platforms/types.ts`.** Add `feature_image_id?: string` to
   `PostInput`, with a doc comment explaining what it's for and why it's a
   *companion* to `feature_image` rather than a replacement (a URL can't be
   turned back into an id after the fact — there is no reverse lookup).
2. **Update every existing adapter to stay correct under the wider type.**
   Ghost now receives a field it has nowhere to put. `GhostAdapter.toGhostPost`
   was changed to drop `feature_image_id` before sending anything to Ghost
   (Ghost silently ignores unknown fields, which would otherwise risk
   `droppedFields` misreporting a field Ghost was never asked to store), and
   `droppedFields` was changed to exclude it from the comparison for the same
   reason.
3. **Widen the MCP tool schema *and* handler in `src/tools/`.** This is the
   step that was missed the first time. `create_post` and `update_post`'s zod
   `inputSchema` had no `feature_image_id` field, and the MCP SDK's zod parsing
   **silently strips unknown keys** before the handler ever sees them. Adding
   the field to `PostInput` and to `WordPressAdapter.applyFeatureImage` did
   nothing for a real caller — the value never survived the trip from tool
   call to adapter. Both schemas needed the field added, and both handlers
   needed to forward it into the adapter call.
4. **Add a test that the field is actually SET, not that a warning was
   suppressed.** The adapter's own unit tests called `WordPressAdapter`
   directly, bypassing the tool layer entirely — they proved
   `applyFeatureImage` works *if* `feature_image_id` reaches it, which is
   exactly the assumption that was false. The test that caught this went
   through the real MCP tool layer (`callWith`, the same path a real client
   uses) and asserted `featured_media` actually appeared in the request body
   WordPress received.

**The first attempt did (1) and (2) and skipped (3).** The feature typechecked
(`PostInput.feature_image_id` is a valid, optional string field). It built. Every
`WordPressAdapter` unit test passed, because those tests called the adapter
directly with `feature_image_id` already present in the input object, which is
not how a real MCP client calls it. The feature **did nothing** — WordPress's
hero image silently never got set — and that was caught only by reading a
published post back from the live site and noticing `featured_media` was
absent from the response.

### Condition (b): the profile's VALUES are shaped like the existing ones

`HtmlProfile` (`src/craft/html-profile.ts`) is a general shape — `preserved`,
`unwrapped`, `visualContainers`, and so on are typed to hold whatever a real
platform's ingest behaviour turns out to be, including an empty set. But the
*code that renders a profile* (`src/craft/score.ts`, `src/craft/brief.ts`) was
written and tested only against Ghost's actual values, where `unwrapped` and
`visualContainers` are both always non-empty. Nothing in the type system
distinguishes "a set that happens to be non-empty for every profile tested so
far" from "a set that is allowed to be empty."

WordPress was the first profile to actually exercise that gap:

- Its **permissive** branch (an account holding `unfiltered_html`) has an
  **empty `unwrapped` set** — nothing is unwrapped on ingest for that account,
  unlike Ghost, which always unwraps something.
- Its **restrictive** branch, as first written, had an **empty
  `visualContainers`** — reasoning at the time was "nothing is confirmed to
  survive with styling, so recommend nothing."

Both broke shared renderers that had only ever seen non-empty values:

- `score_draft`'s `ai_summary_block` check built its advice with
  `[...profile.unwrapped][0] ?? 'div'` to name the tag that "would be
  stripped." With WordPress's permissive profile's `unwrapped` empty, this
  **fabricated** `'div'` — producing a real, shipped message: *"Add a styled
  `<div>` summary block above the first H2 (a `<div>` card would be
  stripped)."* On the one platform where `<div>` is exactly what survives
  ingest with its styling intact, the check recommended a `<div>` and warned
  in the same sentence that a `<div>` would be stripped.
- With `visualContainers` forced empty on the restrictive branch, the same
  BLOCKING `ai_summary_block` check became **impossible to ever pass**:
  `[].some(...)` is always `false`. Worse, that empty-`visualContainers`
  profile is also the fail-safe branch returned on any capability-read error —
  so one transient network blip would have permanently bricked `score_draft`
  for a site until the process restarted.

`tsc` cannot see either of these — both profiles are structurally valid
`HtmlProfile` values. The platform's own tests cannot see them either, because
they test the adapter and the profile in isolation, never the shared renderer
consuming a profile shaped differently than the one it was written against.
**The only way either was found was rendering a brief and scoring a draft with
the new profile, and reading what came out** — not running the suite, reading
the actual English sentence a writer would see.

The fix in both cases was the same kind of fix: stop assuming a profile's
collections are non-empty. Every `?? 'div'` / `?? 'table'` fallback in
`score.ts` and `brief.ts` that fabricated a tag name when a profile had nothing
to offer was replaced with an explicit empty-case branch that says less rather
than something false. And the restrictive profile's `visualContainers` was
corrected to `['table']` — reasoning that KSES strips *attributes* it doesn't
allow, not the *element*, so a plain unstyled `<table>` is a real, always-valid
choice — not an invented one.

## `healthCheck()` must gate on an endpoint that requires authentication

This is the newest rule in this document and it was bought at the same price as
the two above: a feature that typechecked, built, passed its tests, and was
wrong. It is stated separately because it is the only rule here that can make
the *installer* lie.

`healthCheck()` is not a connectivity check. It is the only thing in this
codebase that answers "does this credential actually work?", and three separate
callers act on its answer:

- `health_check` (the MCP tool) reports the site green.
- `doctor` reports the site green.
- **the `init` credential walk decides whether to ACCEPT a key the user just
  typed.** This is the consequential one. Phase 4's headline promise was "every
  credential is validated live at entry; a key not proven to work is not
  accepted" — and that promise is `healthCheck()`, nothing else.

`GhostAdapter.healthCheck()` probed `GET /site/`. Ghost serves `/site/` with no
authentication at all. Probed live on 2026-07-29 against a real install, a
fabricated-but-well-formed key — `'0'.repeat(24) + ':' + 'a'.repeat(64)` —
returned **`ok: true`, status 200, and the real site title**, a response
byte-comparable to the genuine key's. Ghost's own auth was working perfectly;
the adapter was simply asking a question that did not involve the credential.

The consequences ran the whole length of the product. `init` would accept a
wrong Ghost key and congratulate the user on it. `doctor` and `health_check`
would both stay green afterwards. The first failure the user would ever see was
their first `create_post`, by which point nothing on screen pointed at the key
they had entered days earlier. A malformed key was still caught — but only
client-side, by `ghostToken`'s hex check, which never reaches the network and
says nothing about whether a well-formed key is the *right* one.

The fix was to gate on `GET /config/`, which does require the signed JWT: the
real key gets 200, the fabricated key gets a real 401
`UNKNOWN_ADMIN_API_KEY`. `/site/` is still called — but only *after* auth has
already succeeded, and only to recover the friendly site title for the success
message, so it can never turn a bad key into `ok: true`.

**The rule, for every platform:**

1. The endpoint `healthCheck()` gates on must require authentication. Verify
   that by **probing it live with a deliberately fabricated but well-formed
   credential and confirming a non-2xx.** Reading the platform's documentation
   is not verification; "this endpoint looks authenticated" is precisely what
   was believed about `/site/`.
2. Never derive `ok: true` from the credential merely being present, or
   well-formed, or parseable. A client-side format check is a useful early exit,
   never a substitute for a round trip the server had to authorise.
3. If you want a friendlier `detail` string than the authenticated endpoint can
   give you, fetch it in a **second, best-effort call made only after the first
   one succeeded**, inside its own `try`. Never let it affect `ok`.
4. Write a regression test that asserts a fabricated key produces `ok: false` —
   as a unit test against a mocked non-2xx, and as a live integration test.
   Ghost has both (`tests/plugins/platforms/ghost.test.ts` and
   `tests/integration/ghost.integration.test.ts`).

Both platforms now carry that pair of tests. WordPress's `healthCheck` gates on
`GET /wp/v2/users/me?context=edit`, which was **believed** to require Basic auth
and, as of 2026-07-29, is **measured** to: a fabricated-but-well-formed
application password (`aaaa bbbb cccc dddd eeee ffff`) returns a real 401 from
the live install. That test was written precisely because "it looks
authenticated" is what was believed about `/site/` for four phases, and belief
is not what this rule accepts.

## Checklist

Treat this as the actual gate, not a suggestion. Every step exists because
skipping it once already shipped a broken or silently-wrong feature.

1. **Create the folder.** `src/plugins/platforms/<name>/` with `index.ts`
   (the adapter), `auth.ts` (if auth needs its own module), `html-profile.ts`,
   and `plugin.ts` (the `PlatformPlugin` export). Add the two lines to
   `registry.ts`.
2. **Write `credentialSchema` and `credentialFields` first**, verified against
   the real auth mechanism (not documentation). `credentialFields` (name,
   label, secret, example, help) has **two** consumers, and both are only as
   honest as this data:
   - `add_site` (the MCP tool) builds its prompts and error messages from it.
   - **`byline init`'s credential walk** (`src/cli/credentials.ts`) drives
     the entire interactive installer from it — the order fields are asked in,
     which prompts are masked (`secret: true`), and what help text a stuck user
     sees are all read straight off these descriptors. There is no
     platform-specific branch in `src/cli/` and there must not be one: a new
     platform appears in the installer for free, correctly or incorrectly,
     exactly as this array describes it.

   Two consequences worth stating outright. `secret: true` is what stops a
   credential being echoed to the terminal, so getting it wrong leaks. And
   `example` matters most on the fields where it is hardest to show: `@clack`'s
   masked `password()` prompt has no placeholder at all, so the walk folds the
   example into the note printed immediately above the prompt. Ghost's
   `id:secret` example is the single thing that stops a user pasting a Content
   API key — a documented, repeatedly-observed failure mode for this project.
3. **Probe the real API, live, before writing the adapter's logic.** Every
   verified behaviour in `docs/GHOST-NOTES.md` and `docs/WORDPRESS-NOTES.md`
   came from an actual request against an actual install, not from the
   platform's documentation. Assume the docs are wrong until a live response
   proves them right — that discipline is *why* WordPress's own probe caught
   its `Content-Type`-required media upload and its substring-match tag search
   before either shipped silently broken.
4. **Make `healthCheck()` gate on an endpoint that requires authentication,
   and prove it with a fabricated key.** See the section above this checklist.
   Probe the real endpoint with a deliberately fabricated but well-formed
   credential and confirm a non-2xx before you trust it; add the fabricated-key
   regression test as a unit test *and* a live integration test. This is the
   step that decides whether `byline init` can honestly refuse a wrong key,
   so getting it wrong makes the installer's central promise hollow for your
   platform — silently, and only for your platform.
5. **Ask whether the platform needs anything the shared interfaces
   (`PostInput`, `PostResult`, `HtmlProfile`) don't already carry.** If yes —
   as WordPress's `featured_media` did — widen the shared type, then work
   through **all four** of condition (a)'s edits above, in order:
   `types.ts` → every existing adapter → the MCP tool schema *and* handler in
   `src/tools/` → a test through the real tool layer proving the value is SET,
   not merely that a warning was suppressed. Stopping after the first two is
   the mistake that shipped a feature which typechecked, built, and did
   nothing.
6. **Map every member of `PostStatus`, and measure what the platform does with
   a publish time — including the cases that should fail.** `PostStatus` has
   three members and the platforms agree on none of the names (`published` is
   Ghost's `published` and WordPress's `publish`; `scheduled` is Ghost's
   `scheduled` and WordPress's `future`). Write the mapping as a **total
   record**, never a ternary chain: WordPress's used to be
   `status === 'published' ? 'publish' : 'draft'`, which folded every
   unrecognised status into a draft, so adding `scheduled` would have silently
   drafted every scheduled post with no error and no failing test.

   Then probe, live, all four of: a scheduled post with a *valid* future time; a
   scheduled post with **no** time; a scheduled post with a **past** time; and a
   `published` post with a **future** time. Do not assume a platform rejects the
   bad ones. Ghost returns 422 for the middle two — WordPress returns **201 and
   publishes the article immediately**, and the same `published`-plus-future-date
   request that publishes instantly on Ghost schedules on WordPress. Record the
   measured lead time the platform needs (WordPress: 45 s published, 60 s
   scheduled, measured against *its* clock via the `Date` response header) and,
   if it is above `MIN_SCHEDULE_LEAD_MS`, raise that constant.

   Finally, implement the read-back check: after writing, confirm the platform
   really scheduled it and call `assertScheduleApplied` if it did not. A fixed
   lead-time floor is measured against *this* machine's clock while the platform
   decides using its own; only the read-back is true when the two disagree.
7. **Implement `siteTimezone()`, and make it throw rather than default.** A
   `publish_at` like `2026-08-04T10:00` is read in the **blog's** timezone —
   not the caller's, not the host's — so every platform must be able to report
   its own. Find where the platform states it and probe the shape rather than
   trusting its docs: Ghost puts an IANA name under the `timezone` key of
   `GET /settings/`; WordPress puts `timezone_string` on `GET /wp-json/` and
   falls back to `gmt_offset`, which the probed install returned as the
   **string** `"0"` despite being documented as a number.

   Prefer an IANA zone name over a numeric offset whenever the platform offers
   one — an offset cannot express daylight saving, so a blog in
   `America/New_York` captured as `-05:00` publishes an hour wrong for half the
   year. And do **not** return UTC when the lookup fails. Assuming UTC for a
   blog in Kolkata publishes five and a half hours early while reporting
   success; throwing turns that into a refusal that tells the caller to pass an
   explicit offset.
8. **Never let unsupported fields disappear silently.** Every field the new
   platform's core can't store must produce a warning naming the field (see
   `UNSUPPORTED_FIELD_REASONS` in `wordpress/index.ts`), not a silent drop —
   and if you're deriving something like `schema_injected` from whether a
   field was accepted, derive it from that warning mechanism, not from whether
   the value was merely built.
9. **If the platform's ingest behaviour is not a fixed constant** (varies by
   account, role, or install — as WordPress's does by `unfiltered_html`),
   resolve the `HtmlProfile` per site/account, cache it per the caching
   contract on `PlatformPlugin.htmlProfile`, and mark every UNVERIFIED branch
   as UNVERIFIED in both the code comments and the platform's own README —
   don't let an unmeasured guess read as a measured fact.
10. **Assume the new profile's `preserved` / `unwrapped` / `visualContainers`
   might be empty, and check that the shared renderers in `src/craft/` don't
   fabricate a tag name or become impossible to satisfy when they are.** This
   is condition (b) above — it will not show up in `tsc` or in the platform's
   own unit tests.
11. **Render a brief and score a draft with the new profile, and READ the
   output.** Not "the tests pass" — read the actual English sentences
   `build_writing_brief` and `score_draft` produce for this profile, including
   its empty-collection edge cases, the way you'd read it as the writer who
   has to act on it. This is what caught both `score.ts` defects above; a
   green test suite did not.
12. **Publish one real post end to end and read it back from the live site.**
   Not the adapter's own mocked unit tests — an actual `create_post` against a
   real, throwaway install, followed by actually fetching the created post and
   confirming every field landed the way the response claimed it did. This is
   what caught `feature_image_id` silently not reaching WordPress; a green
   test suite did not catch that either, because the test that would have
   caught it didn't exist yet.

Steps 11 and 12 are not optional polish at the end — they are the only two steps
in this whole checklist that would have caught either of WordPress's two real
defects. Everything before them (`tsc`, unit tests, `npm run build`) passed
while both defects were still live in the code.

Step 4 is the same kind of step, moved earlier because it has to be: it is a
live probe with a deliberately wrong credential, and nothing offline can stand
in for it. `tsc`, the unit tests, and `npm run build` all passed while Ghost's
health check was reporting a fabricated key as valid, too.
