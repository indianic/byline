# Substack

## What Byline can do here, and what it cannot

Substack has no publishing API for third-party integrations — checked 2026-09-10,
by reading Substack's own documentation; there is nothing to probe live. Like
Medium, this plugin never makes a network request to substack.com. `create_post`
writes a folder to your own disk and **you** paste the result into Substack's own
post editor by hand.

What this means concretely:

- **No scheduling through Byline.** Substack has no clock Byline can read;
  `publish_at` is refused (`SCHEDULING_UNSUPPORTED`) — export as a draft and
  schedule inside Substack's own editor instead.
- **No SEO/Open Graph/Twitter Card fields, no newsletter-segment targeting, no
  per-post author.** Every `PostInput` field with nowhere to go on Substack
  produces a warning naming it, never a silent drop.
- **Buttons do not survive a paste.** A call-to-action `<button>` in the source
  HTML is dropped by Substack's editor — write a plain link instead.

## How to connect

Run `byline init`, choose **Add a new blog**, pick **Substack**, then answer:

1. **Short name** — e.g. `substack`.
2. **Address** — your Substack's own URL, e.g. `https://yourname.substack.com`.
   Shown in `list_sites`; never called.
3. **Folder for exported posts** — any writable folder, e.g.
   `~/Documents/byline-post`. Byline creates `<that folder>/<short name>/<date>-<slug>/`
   per article.

No credential is validated live: `healthCheck` only confirms Byline can write to
the configured folder — there is nothing on Substack's side to check.

## What a publish produces

`create_post` writes `<export_dir>/<site short name>/<YYYY-MM-DD>-<slug>/`, the same
five-item shape as every export platform:

| File | What it is |
|---|---|
| `article.html` | The article's HTML, with every uploaded image rewritten to `images/<file>` |
| `article.md` | The same content as Markdown |
| `meta.json` | Title, excerpt, tags, canonical URL, feature image, status |
| `images/` | Every uploaded image, moved here under a safe filename |
| `index.html` | The hand-off page — title, subtitle, tags, image previews with download links, and buttons that copy the rich HTML, Markdown, title, subtitle and tags |

## How to paste, step by step

1. Open your **Substack dashboard** and click **New post**.
2. On the hand-off page, click **Copy article**, click into the post editor, paste.
3. Type the title and subtitle into Substack's own fields — never inside the pasted body.
4. Wherever the pasted body shows the literal text `[Insert image: images/<file>]`,
   drag that exact file from the `images/` folder onto that line in Substack's
   editor, then delete the marker text.
5. Set the cover image and SEO fields under the post's own settings panel (the
   gear icon) — these are not part of the pasted body.
6. Add the tags shown on the hand-off page if you use Substack's tagging, then
   **Publish** or **schedule** from Substack's own editor.

## What is UNVERIFIED

**Everything about how Substack's editor treats the pasted HTML.** The wider
heading range (H4–H6 preserved, one level more than Medium), the pull-quote
`<blockquote>` styling, the lack of table support, and the dropped `<button>`
are all reasoned from Substack's own documented paste and Markdown-import
support — none of it has been confirmed by an actual paste into a real Substack
draft. `SUBSTACK_HTML_PROFILE.verified` is `false` in the code for exactly this
reason. As with Medium, there is no live API to probe; the only path to verified
is an actual paste, read back and compared.

## Troubleshooting

- **`EXPORT_DIR_MISSING`, or `health_check` reports a folder error** — `export_dir`
  is missing or not writable. Fix it in `config.yaml`, or run `byline init` again.
- **A `<button>` or a `<table>` disappears after pasting** — expected; Substack's
  editor does not preserve either. Use a plain link and a bulleted list instead.
- **`[Insert image: images/<file>]` is still visible after pasting** — the file was
  never dragged in before the marker was deleted; go back to `images/` and do it now.
