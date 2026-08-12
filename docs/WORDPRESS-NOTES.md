# WordPress — hard-won platform knowledge

**Probed:** 2026-07-29, against the probed WordPress install. A follow-up probe on
2026-08-12, a different single-site administrator account (still holding
`unfiltered_html`), measured video embed survival (the `<iframe>`/`<video>` row below).
**Account:** `indianic`, role **administrator**.
**Install type:** single-site (**not** multisite).
**WordPress core REST API** (`/wp-json/wp/v2/...`), no SEO/ACF plugin installed.

This file exists for the same reason `docs/GHOST-NOTES.md` does: every line below is
traceable to a real request made against a real WordPress install during this probe,
not to documentation or memory. Nothing here should be widened without another probe
that proves the change.

**Read the first row before anything else — it changes every other row in this
table.**

## What was and was not covered

Only one account was available to probe: a **single-site administrator**, who always
holds WordPress's `unfiltered_html` capability. Every "permissive" behaviour below —
inline styles, classes, un-unwrapped `<div>`s, and so on — is measured from that
account. **No account lacking `unfiltered_html` was available**, so the *restrictive*
path (an Author/Contributor role, or an ordinary Editor on a multisite network, where
only Super Admins hold the capability) is still reasoned from WordPress's documented
KSES behaviour, never measured. Every restrictive-path claim carries an **UNVERIFIED**
marker in code and below — do not remove those markers on the strength of this probe.

## Behaviour → consequence

| Behaviour | Consequence |
|---|---|
| **`capabilities.unfiltered_html` decides everything.** `GET /wp/v2/users/me?context=edit` returns it as a boolean. `true` for this account (single-site admin); on a **multisite** network, only Super Admins hold it — an ordinary Editor who publishes a styled post fine on single-site gets it silently flattened on multisite. | The HTML profile cannot be a platform-wide constant the way Ghost's is — it must be resolved **per authenticated user, per site** (`html-profile.ts`'s `resolveWordPressProfile`), and a failed capability check must fail toward the restrictive profile, never the permissive one. |
| For an account **holding** `unfiltered_html` (measured): `content.raw` round-trips **byte-identical** to what was sent — inline `style=` on `<p>`, `<div>`, `<td>`, `<table>`, `<blockquote>`; `<div> <section> <aside> <span> <small> <mark> <pre>` kept as elements, **not unwrapped**; `<table> <thead> <tr> <th> <td> <figure> <figcaption> <code> <ul> <ol> <li> <hr> <strong> <em> <h3> <h4> <img>`; `class="myclass"`. Only `div section aside span small mark pre table td p blockquote a h2` were exercised by the original human-run probe below — the rest of this list (`h3 h4 strong em ul ol li img hr code thead th figure figcaption`) is now covered instead by the automated, self-cleaning probe in `tests/integration/wordpress.integration.test.ts` (`RUN_INTEGRATION=1`), which round-trips the complete tag list against the live site on every run. | Unlike Ghost (where `<div>` is unwrapped to bare text and `<table>` is the only reliable styled container), a WordPress admin can build a visual block out of a styled `<div>` — the natural first choice here. Nothing in `PERMISSIVE_PRESERVED` needed an `unwrapped` counterpart: for this account, WordPress core does not unwrap any element on ingest. |
| A standalone `<blockquote style="...">` **with its inner `<p>` intact** survived passthrough — not rebuilt as a native node (measured). | Unlike Ghost, which reconstructs a standalone blockquote and discards both the style and the inner `<p>`, a styled WordPress blockquote is a second usable visual container, not just a fallback. `blockquote: 'passthrough'`. |
| A hand-written `<h2 id="myid">` kept its id in `content.raw`, unchanged. That is the ONLY thing this probe measured. Whether the *rendered* output (`content.rendered`, theme HTML) auto-generates ids for headings that lack one was **not tested** — no claim about `content.rendered` belongs on this row. | `generatesHeadingIds: false` — WordPress does not generate/overwrite ids in the **stored** content for this account, so hand-writing a heading id is safe (opposite of Ghost, which always generates its own and discards a hand-written one). |
| `target="_blank"` survived; `rel="noopener noreferrer"` survived. | `keepsLinkTarget: true` for this account — again the opposite of Ghost, which strips `target=` on ingest. |
| `excerpt` is **writable** and round-tripped. | Unlike Ghost, where `excerpt` is read-only and `custom_excerpt` is the writable field, WordPress's own `excerpt` field is the one to send `custom_excerpt` into — see `buildBaseBody`. |
| Media upload **without** an explicit `Content-Type` → **400** `{"code":"rest_upload_no_content_type","message":"No Content-Type supplied."}`. | Harder failure than Ghost's 415 for the same class of mistake ("no MIME type on the blob"). `uploadImage` always sets `Content-Type` explicitly from the filename extension — never left to guesswork. |
| Media upload **with** `Content-Type: image/png` and `Content-Disposition: attachment; filename="..."` → **201**, returns `id` and `source_url`. | This is the shape `uploadImage` sends: raw bytes in the body (not multipart, unlike Ghost), with both headers set explicitly. |
| `alt_text` is **not** accepted on the upload request; a follow-up `POST /wp/v2/media/{id}` with `{ alt_text }` → **200**, works. | `uploadImage` always makes this as a second request when `alt` is given — never attempted inline on the upload. |
| `featured_media` on a post accepts the integer attachment `id` from the upload response → **201**, stored correctly. | `PostInput.feature_image_id` (the id `uploadImage` returns) is what `applyFeatureImage` sets `featured_media` to directly, when present — a URL alone (`feature_image`) can never be resolved back to that id. |
| `GET /wp/v2/tags?search=ProbeAI` returned **both** `ProbeAI` and `ProbeAI Ethics` — a **substring** match. | Taking the first search result would silently tag a post with the wrong term. `resolveTagIds` requires an exact, case-insensitive match before trusting a search hit; only when none exists is a new tag created. |
| Basic auth with a WordPress core Application Password (no plugin) authenticated successfully across every endpoint probed (`users/me`, posts, tags, media). | No plugin is required for API auth — `WP Admin → Users → Profile → Application Passwords` is enough. |
| `GET /wp/v2/posts/{id}?context=edit` is what returns `.raw` fields; the default response returns `content.rendered` with `wpautop` applied. | Every write-back diff (`diffReadBack`) reads back with `?context=edit` — diffing against `.rendered` would manufacture a false warning on every single call. |
| `PUT /wp/v2/posts/{id}` accepted a title update; read back and verified. | Confirmed by `tests/integration/wordpress.integration.test.ts`'s update step, not by the human-run probe above — recorded here as its own line for that reason. |
| Endpoints reachable: posts, tags, media, users — all `200`. | Baseline connectivity for `health_check`. |
| **Scheduling** (probed 2026-08-03): a scheduled post is `status: "future"` with the time in **`date_gmt`** — naive ISO with no offset marker, UTC by definition (`"2026-08-04T09:00:00"`). A trailing `Z` is accepted on the way in but never comes back. The sibling `date` field is the same instant in the *site's* timezone. | `WordPressAdapter.STATUS` maps Byline's `scheduled` → `future`, and `buildBaseBody` writes `date_gmt`, never `date` — `date` would land the post at the wrong hour on any site not set to UTC, and the probed site *was* UTC (`gmt_offset: 0`), which is exactly the configuration where that mistake is invisible. |
| **`status: "future"` with a date that is not far enough ahead is silently rewritten to `publish` and the post goes live immediately** — `201`, no error, nothing in the body naming the change. Measured against WordPress's own clock (`Date` response header, same request): **45 s of lead published immediately; 60 s scheduled**. Same result from two different points within the minute, so it is a lead-time rule, not a minute-boundary artefact. Identical silent publish for a **past** date and for `status: "future"` with **no date at all**. | The reason `MIN_SCHEDULE_LEAD_MS` (2 min) exists in `src/plugins/platforms/schedule.ts`, and the reason `verifyPublishTime` re-reads the post and throws `SCHEDULE_NOT_APPLIED` rather than trusting the write. The floor is measured against the *local* clock and WordPress decides using its own, so the read-back is what holds when the two disagree. |
| `status: "publish"` with a **future** `date_gmt` is silently converted to `future` — WordPress schedules it. **Ghost does the opposite with the same input** (publishes immediately). | `resolveTiming` refuses that combination outright (`SCHEDULE_STATUS_MISMATCH`) rather than letting one request mean two different things on two platforms. |
| **The blog's timezone** is on the REST root `GET /wp-json/`, stated two ways of which a site uses exactly one: `timezone_string` is an IANA name when the site was configured by city, and **empty** when it was configured by raw UTC offset, in which case `gmt_offset` carries the hours. Measured 2026-08-03: `timezone_string: ""` with **`gmt_offset: "0"` — a STRING, not the documented number**. `GET /wp/v2/settings` exposes a `timezone` field too, but returned `""` with **no `gmt_offset` at all**, so it cannot answer for an offset-configured blog. | `WordPressAdapter.siteTimezone()` reads the ROOT endpoint, prefers `timezone_string`, and accepts `gmt_offset` as either a string or a number — a `typeof === 'number'` check would have rejected this very install, and arithmetic on `"0"` would concatenate rather than add. Hours are converted to minutes rather than assumed whole: India is 5.5, Nepal 5.75, Chatham 12.75. |
| **Backdating** works on create and on update: `status: "publish"` with a past `date_gmt` stores the date exactly as given, to the second, arbitrarily far back (3 years probed). `publish` → `future` via `PUT` also works, as does `future` → `draft`. | Backdating and unscheduling both go through the ordinary `create_post`/`update_post` paths; no special casing. Sub-second precision is truncated, which is why `toWholeSecondIso` normalises before sending. |
| **Video is embedded by URL, never uploaded — a `<video src>` tag survives on WordPress, unlike Ghost.** Probed 2026-08-12, account holding `unfiltered_html`: a bare `<iframe>` was KEPT verbatim; `<figure><iframe>…</iframe><figcaption>` was KEPT; a Bunny-style `iframe.mediadelivery.net/embed/…` iframe was KEPT; a `<!-- wp:embed … -->` block was KEPT; and `<video src="https://example.com/x.mp4" controls>` was ALSO KEPT — the one point of divergence from Ghost, which strips `<video>` completely. A bare YouTube URL inside a `<p>` was NOT converted to an embed, same as Ghost. **This account holds `unfiltered_html` — whether `<iframe>` survives for an account that does NOT is UNVERIFIED**, same status as every other permissive-vs-restrictive claim in this file; no such account has ever been available to probe. | `iframe` was added to `PERMISSIVE_PRESERVED` in `html-profile.ts`, and deliberately NOT to `RESTRICTIVE_PRESERVED` — that set stays UNVERIFIED for `iframe` pending a probe against an account that genuinely lacks the capability. `embed_video` (`src/media/embed.ts`) is the tool that emits the `<iframe>`; its `warnings` name this exact caveat when called with `site` naming a WordPress site. byline still never uploads a `<video>` file — the `<video>` survival measured here matters only for a hand-written tag, not for anything byline itself emits. |

## The three traps, verbatim

**1. Media upload with no `Content-Type` is a hard failure, not a soft one.**

```
400 {"code":"rest_upload_no_content_type","message":"No Content-Type supplied."}
```

There is no fallback or default MIME sniffing on WordPress's side for this — the
caller must always supply it. `mimeFor()` maps the file extension to a MIME type
before every upload for exactly this reason.

**2. Tag search is a substring match — taking the first result tags the wrong term.**

`GET /wp/v2/tags?search=ProbeAI` returned:

```json
[{ "id": 1, "name": "ProbeAI" }, { "id": 2, "name": "ProbeAI Ethics" }]
```

Both names contain the search string. An implementation that used `matches[0]` would
tag a post about "ProbeAI" with "ProbeAI Ethics" (or vice versa, depending on
WordPress's internal ordering) roughly as often as it got the right term. The fix is
an exact, case-insensitive comparison against `name` before trusting a hit; only when
nothing matches exactly is a new tag created.

**3. A scheduled post whose date is too close does not fail — it publishes.**

Probed 2026-08-03. Lead times measured against WordPress's own clock, read from the
`Date` header of the very same response, so clock skew is excluded rather than
assumed away:

```
POST /wp/v2/posts  {"status":"future","date_gmt":"…+45s"}  -> 201  {"status":"publish"}   LIVE
POST /wp/v2/posts  {"status":"future","date_gmt":"…+60s"}  -> 201  {"status":"future"}    scheduled
POST /wp/v2/posts  {"status":"future"}                     -> 201  {"status":"publish"}   LIVE
POST /wp/v2/posts  {"status":"future","date_gmt":"…-1h"}   -> 201  {"status":"publish"}   LIVE
```

There is no error, no warning, and no field in the response naming the change — only
`status`, which the caller has no particular reason to re-read after a `201`. A caller
who asked to schedule an article for next Tuesday gets a success and a live article.

Ghost, for the same class of mistake, returns a **422** and writes nothing. This is the
sharpest disagreement between the two platforms in this codebase, and it is why
scheduling is not simply forwarded to whatever the platform does:
`src/plugins/platforms/schedule.ts` refuses a too-close time before the request, and
`WordPressAdapter.verifyPublishTime` re-reads the post afterwards and throws
`SCHEDULE_NOT_APPLIED` if WordPress published it anyway. The first check uses this
machine's clock; the second uses WordPress's answer. Only the second is true when the
two clocks disagree, which is the case the first cannot cover.

## What remains UNVERIFIED

The design's central claim is that WordPress strips `style=` (and, by extension,
`class=`, `target=`, and hand-written heading ids) via KSES for an account **without**
`unfiltered_html`, and that on a multisite network only Super Admins hold it. **This
probe could not test that** — the only account available was a single-site
administrator, who holds the capability unconditionally. Specifically UNVERIFIED,
pending a probe with an account that genuinely lacks the capability:

- That inline `style=` is actually stripped (not just theoretically KSES-filtered) for
  such an account.
- That `class=` attributes are stripped as well, rather than allowed through
  (WordPress's default `wp_kses_allowed_html('post')` list does permit `class` on some
  tags even without `unfiltered_html` — this was not tested either way).
- Which specific elements are unwrapped versus rejected versus silently stripped —
  `RESTRICTIVE_UNWRAPPED`/`RESTRICTIVE_PRESERVED` in `html-profile.ts` are reasoned from
  KSES's documented allowed-tag list, not measured. In particular: `table`, `thead`,
  `tbody`, `tr`, `th`, `td`, `figure`, and `figcaption` are classified as *preserved*
  (the element survives, only `style=` is stripped), not *unwrapped* — KSES's
  documented behaviour strips attributes it does not allow without deleting the
  element itself. An earlier version of this project put the table family in
  `RESTRICTIVE_UNWRAPPED` and left `visualContainers` empty for the restrictive path,
  which made `score_draft`'s BLOCKING `ai_summary_block` check impossible to ever pass
  on that path and told a writer in the same breath that a `<table>` summary block was
  both required and forbidden. Do not reintroduce that without a probe that actually
  shows the table family being deleted, not merely destyled, for an account lacking
  the capability.
- Whether `target="_blank"` and hand-written heading ids survive or are stripped for
  such an account.
- Anything about multisite itself — no multisite network was available to probe at
  all, so the "only Super Admins hold `unfiltered_html` on multisite" claim is
  WordPress's own documented behaviour, not something this project measured.

Every one of these stays marked UNVERIFIED in `src/plugins/platforms/wordpress/html-profile.ts`
and must not be promoted to a measured fact without a probe against an account that
actually exercises that path.

### Scheduling on a site that is not UTC — UNVERIFIED

The site every scheduling behaviour above was measured on reports
`gmt_offset: 0` and an empty `timezone_string`. It is UTC, so its `date` and
`date_gmt` are the same string, and **no probe here could tell the two fields apart**.

The adapter writes `date_gmt` and never `date`, which is correct by construction:
`date_gmt` is UTC by definition and needs no knowledge of the site's offset. But that
is reasoning, not measurement.

The same gap applies to `siteTimezone()`. Only the **`gmt_offset` = 0** branch was
measured; the `timezone_string` branch — a site configured by city, where WordPress
returns e.g. `"Asia/Kolkata"` — was **never exercised against a live WordPress site**,
because no such site was available. (The equivalent code path *is* exercised live via
Ghost, which always returns an IANA name, and offline by unit tests across a
daylight-saving boundary — but not through this adapter's own parsing of
`timezone_string`.) Specifically UNVERIFIED, pending a probe against a site with a
non-zero `gmt_offset` or a set `timezone_string`:

- That `timezone_string` really is an IANA name on a city-configured site, and that it
  and `gmt_offset` are never both meaningfully populated in a way that would make
  preferring `timezone_string` wrong.
- That a non-zero `gmt_offset` arrives in hours (`"5.5"`) rather than minutes or
  seconds. Zero is the one value that reads identically under all three.

- That `date_gmt` is honoured as UTC on such a site (rather than being reinterpreted in
  site-local time).
- What `date` alone does there — the 2026-08-03 probe sent `date` once and WordPress
  filled in a matching `date_gmt`, but on a UTC site that proves nothing about which
  field was authoritative.
- Whether the `future`-to-`publish` lead-time boundary is evaluated in UTC or in
  site-local time. `verifyPublishTime`'s read-back check does not depend on the answer —
  it compares what was stored against what was sent — but the 2-minute floor in
  `schedule.ts` implicitly assumes UTC.
