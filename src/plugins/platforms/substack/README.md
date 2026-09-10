# Substack plugin

For the user-facing how-to-connect/how-to-paste guide, see
[`docs/platforms/substack.md`](../../../../docs/platforms/substack.md). This file
is the developer-facing notes on what was verified and how.

Substack has no publishing API. Like Medium, this plugin never calls Substack —
it writes a hand-off folder to disk (`ExportAdapter`,
`src/plugins/platforms/export/`) and the user pastes the result into Substack's
own post editor by hand.

## Credentials

One field, and it is not a secret:

| Field | Secret? | Example | Where to get it |
|---|---|---|---|
| `export_dir` | no | `~/Documents/byline-post` | Any folder you can write to. Byline creates `<export_dir>/<site-slug>/<date>-<slug>/` per article. |

`url` is still required by the shared `SiteConfig` shape but is never used to make
a request — set it to your Substack's own URL.

## Quirks

- **No tables.** Substack's editor has no pasted-`<table>` support — comparisons
  are steered toward a bulleted list instead, the same as Medium.
- **Wider heading range than Medium.** H4–H6 are preserved as elements (Medium
  unwraps H4), reasoned from Substack's own Markdown-import support — still
  UNVERIFIED by an actual paste.
- **Pull-quote is a `<blockquote>`.** Use it for the one visual callout the
  writing brief asks for.
- **Buttons are not pasteable.** A call-to-action `<button>` in the source HTML
  will not survive a paste — write it as a plain link instead.
- Image handling is identical to Medium's: `create_post` moves every uploaded
  file into the export folder's `images/` directory and marks its position in
  the copyable HTML with `[Insert image: images/<file>]`.

## How this was verified — and what was not

**Nothing here was verified by an actual paste.** Substack has no publishing
API, so there is no live probe to run. Every claim in `html-profile.ts` is
reasoned from Substack's own documented paste and Markdown-import behaviour,
not measured against a real draft. `SUBSTACK_HTML_PROFILE.verified` is `false`
for exactly this reason.

Promoting any of this to verified requires an actual paste into a real
Substack draft, read back and compared the way `docs/GHOST-NOTES.md` and
`docs/WORDPRESS-NOTES.md` record for Ghost and WordPress.
