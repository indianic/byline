# LinkedIn Article plugin

There is no separate user-facing help page for this platform yet — see
[`docs/platforms/linkedin.md`](../../../../docs/platforms/linkedin.md)'s intro for
how it relates to the `linkedin` feed-post plugin, which does have one.

This is `linkedin-article` — LinkedIn's long-form Article feature, published by
pasting into LinkedIn's own article editor. It is **not** the `linkedin` API
plugin (LinkedIn feed posts, `kind: 'social'`) — see
[`src/plugins/platforms/linkedin/README.md`](../linkedin/README.md) for that
one; the two are separate platforms with separate ids, separate profiles, and
separate folders.

LinkedIn has no article-publishing API for Byline to call, so this plugin never
makes a request — it writes a hand-off folder to disk (`ExportAdapter`,
`src/plugins/platforms/export/`) and the user pastes the result in by hand.

## Credentials

One field, and it is not a secret:

| Field | Secret? | Example | Where to get it |
|---|---|---|---|
| `export_dir` | no | `~/Documents/byline-post` | Any folder you can write to. Byline creates `<export_dir>/<site-slug>/<date>-<slug>/` per article. |

`url` is still required by the shared `SiteConfig` shape but is never used to
make a request.

## Quirks

LinkedIn Article's editor is the most restrictive of the three export platforms:

- **No tables.** Comparisons are steered toward a bulleted list instead.
- **No code blocks.** `<pre>`/`<code>` are unwrapped to plain text — the writing
  brief is never told to produce a code sample for this platform.
- **Two heading levels only** — H1 and H2. H3 and deeper are unwrapped to plain
  text, so `preserved` stops at H2.
- **The cover image is set in LinkedIn's own editor**, not in the article body —
  a `<figure>` in the pasted HTML is not the hero image, and the paste steps say
  so explicitly.

## How this was verified — and what was not

**Nothing here was verified by an actual paste.** LinkedIn's article editor has
no API to probe, so there is no live test the way Ghost's and WordPress's
`healthCheck` regression tests run. Every claim in `html-profile.ts` — the
narrow preserved tag set, the two-heading-level limit, the lack of tables and
code — is reasoned from LinkedIn's own documented article editor limits, not
measured against a real draft. `LINKEDIN_ARTICLE_HTML_PROFILE.verified` is
`false` for exactly this reason.

Promoting any of this to verified requires an actual paste into a real LinkedIn
article draft, read back and compared the way `docs/GHOST-NOTES.md` and
`docs/WORDPRESS-NOTES.md` record for Ghost and WordPress.
