# Medium

## What Byline can do here, and what it cannot

Medium has never published a public API for creating posts as a third-party
integration — checked 2026-09-10, by reading Medium's own developer documentation;
no live probe was possible because there is nothing to probe. `create_post` on a
Medium site therefore never makes a network request to medium.com. It writes a
folder to your own disk — text, images, and a page with copy buttons — and **you**
paste the result into Medium's own story editor by hand.

What this means concretely:

- **No scheduling.** Medium has no clock Byline can read or write to; `publish_at`
  is refused (`SCHEDULING_UNSUPPORTED`) — schedule inside Medium's own editor
  instead, from a draft export.
- **No SEO/Open Graph/Twitter Card fields, no newsletter, no per-post author.**
  Medium's own model has none of these; every one of `PostInput`'s fields that has
  nowhere to go on Medium produces a warning naming it, never a silent drop.
- **The canonical URL is not set by this export.** If the article was published
  elsewhere first, you set the canonical link inside Medium's own editor (see
  step 6 below) — Byline cannot set it through a paste.

## How to connect

Run `byline init`, choose **Add a new blog**, pick **Medium**, then answer:

1. **Short name** — whatever you want to call this blog in conversation, e.g. `medium`.
2. **Address** — your Medium profile or publication URL. It is shown in `list_sites`
   and is never called.
3. **Folder for exported posts** — any folder you can write to, e.g.
   `~/Documents/byline-post`. Byline creates `<that folder>/<short name>/<date>-<slug>/`
   per article.

There is no credential to validate live: Medium's `healthCheck` only confirms Byline
can write to the configured folder, and says exactly that — it verifies nothing
about Medium itself, because there is nothing on Medium's side to check.

## What a publish produces

`create_post` writes `<export_dir>/<site short name>/<YYYY-MM-DD>-<slug>/` containing:

| File | What it is |
|---|---|
| `article.html` | The article's HTML, with every uploaded image's `file://` reference rewritten to `images/<file>` |
| `article.md` | The same content, converted to Markdown |
| `meta.json` | Everything else Byline knows about the post — title, excerpt, tags, canonical URL, feature image, status |
| `images/` | Every uploaded image, moved here under a safe filename |
| `index.html` | **The page you actually open.** Shows the title, subtitle, tags, and every image with a download link; buttons copy the rich HTML, the Markdown, the title, the subtitle, and the tags to your clipboard |

`update_post` re-reads `meta.json` and rewrites all five, so editing an export and
re-running `create_post`'s companion call is safe.

## How to paste, step by step

1. Open **medium.com/new-story**.
2. On the hand-off page (`index.html`), click **Copy article**, click into the
   story body, paste.
3. Type the title and subtitle into Medium's own title/subtitle fields — **never**
   inside the pasted body; Medium keeps them as separate fields from the body text.
4. Wherever the pasted body shows the literal text `[Insert image: images/<file>]`,
   drag that exact file from the `images/` folder Byline wrote onto that line in
   Medium's editor, then delete the marker text. The hand-off page's own preview
   shows you which image goes where, with a working download link for each.
5. Add the tags shown on the hand-off page under **Publish → Add a topic**.
6. If this article was published elsewhere first, set the canonical link under
   **… → Customize → Advanced settings**.

## What is UNVERIFIED

**Everything about how Medium's editor treats the pasted HTML.** The preserved/
unwrapped tag sets, the two-visual-heading-size limit, the lack of table support,
and the title/subtitle-as-separate-fields behaviour are all reasoned from Medium's
own documented paste and Markdown-import behaviour — none of it has been confirmed
by pasting real HTML into a real Medium draft and reading the result back.
`MEDIUM_HTML_PROFILE.verified` is `false` in the code for exactly this reason.
Unlike Ghost and WordPress, there is no live API this plugin could ever probe to
promote these claims to "verified by live probe" — the only path to verified here
is an actual paste, read back and compared, the way `docs/GHOST-NOTES.md` and
`docs/WORDPRESS-NOTES.md` record for the platforms that do have one.

## Troubleshooting

- **`EXPORT_DIR_MISSING`, or `health_check` reports a folder error** — `export_dir`
  is missing or not writable. Fix it in `config.yaml`, or run `byline init` again
  and update this blog.
- **A paste loses formatting, or shows visible `<div>`/`<table>` text** — Medium's
  editor discards structure it does not support. Use the bulleted-list guidance the
  writing brief gives instead of a table, and do not rely on H3-or-deeper headings
  for meaningful hierarchy.
- **`[Insert image: images/<file>]` is still visible after pasting** — the matching
  file was never dragged in before the marker text was deleted. Go back to the
  `images/` folder and do it now; the marker text is never valid publishable content.
