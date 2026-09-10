# Medium plugin

For the user-facing how-to-connect/how-to-paste guide, see
[`docs/platforms/medium.md`](../../../../docs/platforms/medium.md). This file is
the developer-facing notes on what was verified and how.

Medium has no publishing API. This plugin does not call Medium at all — it writes
a hand-off folder to disk (`ExportAdapter`, `src/plugins/platforms/export/`) and
the user pastes the result into Medium's own editor by hand.

## Credentials

One field, and it is not a secret:

| Field | Secret? | Example | Where to get it |
|---|---|---|---|
| `export_dir` | no | `~/Documents/byline-post` | Any folder you can write to. Byline creates `<export_dir>/<site-slug>/<date>-<slug>/` per article. |

`url` is still required by the shared `SiteConfig` shape but is never used to make
a request — set it to Medium's own URL or your profile page, whichever you prefer
to see in `list_sites`.

## Quirks

- **No tables.** Medium's editor has no pasted-`<table>` support — `visualContainers`
  has no `table`, so the writing brief and `score_draft` both steer toward a
  bulleted list for comparison data instead.
- **Title and Subtitle are separate fields** in Medium's own editor, set outside
  the pasted body. Never put the article title inside the HTML body.
- **Two visual heading sizes on paste.** Medium's editor preserves H1–H3 as
  elements, but visually distinguishes only two sizes — write H2 for section
  headings and do not rely on H3 for meaningful hierarchy.
- **A `file://` image does not survive a paste.** `create_post` moves every
  uploaded image into the export folder's `images/` directory and replaces its
  `<img>`/`<figure>` in the *copyable* HTML with a `[Insert image: images/<file>]`
  marker; the hand-off page's preview still shows the real image, and each
  image has its own download link.

## How this was verified — and what was not

**Nothing here was verified by an actual paste.** Medium has no publishing API,
so there is no live probe this plugin's tests can run the way Ghost's and
WordPress's `healthCheck` regression tests do. Every claim in `html-profile.ts`
— the preserved/unwrapped tag sets, the two-heading-size limit, the
title/subtitle fields, the lack of tables — is reasoned from Medium's own
documented paste and Markdown-import behaviour, not measured against a real
draft. `MEDIUM_HTML_PROFILE.verified` is `false` for exactly this reason, and
`build_writing_brief`'s HTML RULES header for this profile reads
"UNVERIFIED — REASONED FROM DOCUMENTED PLATFORM BEHAVIOUR, NOT MEASURED".

Promoting any of this to verified requires an actual paste into a real Medium
draft, read back and compared byte-for-byte the way `docs/GHOST-NOTES.md` and
`docs/WORDPRESS-NOTES.md` record for the other two platforms.
