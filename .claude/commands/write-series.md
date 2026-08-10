---
description: Write and publish one article end-to-end through Byline, in the fewest tool calls that still verify the result.
argument-hint: <site> <persona> <topic> [| publish_at YYYY-MM-DDTHH:MM]
---

Write and publish ONE article using the Byline MCP tools. Arguments: $ARGUMENTS

Run these steps in order. The point of this command is that a correct article costs
**six tool calls**, not the eighteen a series run used to take. Do not add calls the
steps below do not ask for.

## 1. Brief — one call

`build_writing_brief` with the persona, topic, target site, and `word_count`.

Choose `mode` deliberately. `blog` for anything evergreen; `news` only when the piece
genuinely turns on events of the last 30 days, and then research is mandatory and must
come from exactly one origin. If it is unclear which, **ask the user** rather than
guessing.

Read the **SCORECARD TARGETS** block in the returned brief. It prints the exact integers
`score_draft` will measure this article against — evidence items, attribution markers,
question headings, first-hand moments, sentence-length spread, paragraph-run cap — already
computed for your word count. Hitting them while writing is the whole reason a revision
round is avoidable. Note the `look` value from the IMAGES block; every image in this
article must use it.

## 2. Write the draft

Write the full HTML now, to the brief and to those targets. Two things people get wrong:

- The **NEVER USE THESE** list in the brief is the exact lexicon that is graded. It is
  printed from the scorer's own array, so there is no second list to guess at.
- Leave exactly one `[[content_image]]` placeholder for the in-body image.

## 3. Images — one call

`generate_images` with every image the article needs in a single call: a hero, the in-body
image, and any gallery frames. Pass the same `look` to each, and give each a distinct
`slot`.

**Do not read the generated files back.** The result already carries `width`, `height`,
`format` and `mime`, read from the image bytes. Reading a PNG through a vision model to
confirm its dimensions is the single most wasteful thing this pipeline used to do.

Check every entry: a batch reports `ok: false` per image rather than failing as a unit. If
one was refused on safety grounds, reword that prompt and re-run **only that slot** with
`generate_image`.

## 4. Upload — one call

`upload_images` with all the local paths for the target site. Substitute the returned URLs
into the HTML, replacing the `[[content_image]]` placeholder with a real `<figure>`.

## 5. Score — ONE call

`score_draft` with the final HTML, the matching `mode`, the `feature_image`, and the
research `findings` if the article had any.

Then read `publishable` and `summary`, **not the verdict alone**:

- `publishable: true` → **publish**. Verdict `advisory` means the listed items are
  optional improvements, not failures. Apply any that are a cheap inline edit. **Do not
  rewrite the article and do not score again in a loop** — advisory findings never block
  publication, and chasing them is what turned a one-pass article into three.
- `publishable: false` → fix the named blocking checks and score once more. Only
  `platform_html`, `structure` and `ai_summary_block` can block.

## 6. Publish — one call

`create_post` with the site, title, HTML, feature image and alt text, excerpt, meta
fields, tags, author persona, FAQ, keywords — and an explicit **`slug`**.

Set the slug deliberately: 3–6 words. Omit it and the platform builds one from the whole
headline, which is how a seven-word title becomes a seventy-character URL that cannot be
changed through the API afterwards. Check the result for a `slug` warning — a counter
suffix means the slug was taken and the post lives at a different URL than you intend to
share.

If the user gave a `publish_at`, pass `status: "scheduled"` with that wall-clock time
**verbatim**, in the blog's own timezone. Do not convert it and do not ask which timezone
is meant.

## 7. Report

Tell the user: the live URL, the scheduled time as the blog's clock reads it
(`publish_at_local`), the verdict, and any warnings. If anything was skipped or a slot
failed, say so plainly rather than reporting a clean run.
