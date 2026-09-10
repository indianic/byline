---
description: Write and publish one article end-to-end through Byline, in the fewest tool calls that still verify the result.
argument-hint: <site> <persona> <topic or theme> [--count N] [| publish_at ...]
---

Write and publish through Byline. Arguments: $ARGUMENTS

Without `--count` (or with `--count 1`), write and publish ONE article on the given
topic — skip straight to **Per-article steps** below and run it once.

With `--count N` (N from 2 to 12), the argument after site/persona is a THEME, not a
single topic: plan a pillar-and-spokes series of N articles on that theme, get the
user's approval on the titles, then run **Per-article steps** once per article.

## Step 0 — Plan the series (only when `--count` > 1)

Call `plan_series` with the persona, the theme, `count`, and the target site. It
returns a `brief` (prose instructing you how to propose titles), a `series_id`, and
one seed per slot — each slot already carries a distinct hook, arc, texture and
author presence, so the titles you propose do not need to worry about sounding alike.
Planning never fails: if the series runs longer than one of those dimensions has
options, some slot is forced to repeat it, and that slot's `repeats` array names
which dimension — check it, and vary that slot's title angle a little harder by hand
if it's non-empty.

Follow the returned `brief` exactly: propose article 1 as the pillar (the theme's head
question, for a reader who knows nothing) and every later slot as a spoke (one
long-tail question, answered in depth, linking back to the pillar once). Give each
title its primary keyword and the question it answers. **Then stop and show the list
to the user before writing anything else.** Byline does not invent the titles —
you do, from the brief — and nothing gets written until the user approves the list
or asks for changes.

Once approved, run **Per-article steps** once per slot, in order, passing that slot's
`seed` as `build_writing_brief`'s `seed`, `plan_series`'s `series_id` as `series`
throughout, and that slot's approved title/keyword/question as the topic for step 1.

## Per-article steps

The point of this command is that a correct article costs **six tool calls**, not the
eighteen a series run used to take. Do not add calls the steps below do not ask for.

### 1. Brief — one call

`build_writing_brief` with the persona, topic, target site, and `word_count`. In a
series, also pass `seed` (the slot's seed from `plan_series`) and `series` (the
series id) — this is what makes the slot draw the exact shape it was planned with,
and what lets this article link back to its pillar and siblings.

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

### 2. Write the draft

Write the full HTML now, to the brief and to those targets. Two things people get wrong:

- The **NEVER USE THESE** list in the brief is the exact lexicon that is graded. It is
  printed from the scorer's own array, so there is no second list to guess at.
- Leave exactly one `[[content_image]]` placeholder for the in-body image.

### 2b. Revision pass

Apply the REVISION PASS section of the brief to body prose only; leave the summary
block, tables, callouts, FAQ and JSON untouched; add no facts. Read the whole draft
once first, then mark the tells — a single sighting of staging-instead-of-stating is
enough to rewrite; every other group needs two tells in the same passage. See the
`humanizer` skill for the full definitions behind the brief's compressed version.

### 3. Images — one call

`generate_images` with every image the article needs in a single call: a hero, the in-body
image, and any gallery frames. Pass the same `look` to each, and give each a distinct
`slot`.

**Do not read the generated files back.** The result already carries `width`, `height`,
`format` and `mime`, read from the image bytes. Reading a PNG through a vision model to
confirm its dimensions is the single most wasteful thing this pipeline used to do.

Check every entry: a batch reports `ok: false` per image rather than failing as a unit. If
one was refused on safety grounds, reword that prompt and re-run **only that slot** with
`generate_image`.

### 4. Upload — one call

`upload_images` with all the local paths for the target site. Substitute the returned URLs
into the HTML, replacing the `[[content_image]]` placeholder with a real `<figure>`.

### 5. Score — ONE call

`score_draft` with the final HTML, the matching `mode`, the `feature_image`, and the
research `findings` if the article had any.

Then read `publishable` and `summary`, **not the verdict alone**:

- `publishable: true` → **publish**. Verdict `advisory` means the listed items are
  optional improvements, not failures. Apply any that are a cheap inline edit. **Do not
  rewrite the article and do not score again in a loop** — advisory findings never block
  publication, and chasing them is what turned a one-pass article into three.
- `publishable: false` → fix the named blocking checks and score once more. Only
  `platform_html`, `structure` and `ai_summary_block` can block.

### 6. Publish — one call

`create_post` with the site, title, HTML, feature image and alt text, excerpt, meta
fields, tags, author persona, FAQ, keywords — and an explicit **`slug`**. In a series,
also pass `brief_seed` (the brief's `seed`), `brief_choices` (the brief's `choices`),
`topic`, `primary_keyword` and `series` (the series id) — this is what records the
article against the right series and shape in the persona's ledger, so a later brief
for a sibling slot sees it correctly.

Set the slug deliberately: 3–6 words. Omit it and the platform builds one from the whole
headline, which is how a seven-word title becomes a seventy-character URL that cannot be
changed through the API afterwards. Check the result for a `slug` warning — a counter
suffix means the slug was taken and the post lives at a different URL than you intend to
share.

If the user gave a `publish_at`, pass `status: "scheduled"` with that wall-clock time
**verbatim**, in the blog's own timezone. Do not convert it and do not ask which timezone
is meant.

### 6b. LinkedIn — optional, one or two extra calls

If a LinkedIn site is configured — step 1's brief carried a LINKEDIN POST section
and its JSON included a `linkedin_post` field when one is — and the user asked for
a LinkedIn post about this article, share it now:

Take `linkedin_post.text` from step 1's output and replace the literal
`[[article_url]]` with the URL step 6 just returned — `create_post` refuses html
still containing that placeholder, on purpose, so this substitution happens here,
not inside Byline. If the article has a hero image, `upload_image(site: <linkedin
site>, path: <hero image local path>)` first; LinkedIn's `upload_image` returns an
image **urn**, not a URL — pass it as `feature_image_id`, not `feature_image`.

Then `create_post(site: <linkedin site>, html: <one <p> per paragraph from
linkedin_post.text>, canonical_url: <the article's URL>, tags:
linkedin_post.hashtags, feature_image_id: <the urn, if uploaded>)`. LinkedIn feed
posts publish immediately — there is no draft or schedule to choose.

Report both URLs to the user: the article's, and the LinkedIn post's
(`https://www.linkedin.com/feed/update/<id>/`).

### 7. Report

Tell the user: the live URL, the scheduled time as the blog's clock reads it
(`publish_at_local`), the verdict, and any warnings. If anything was skipped or a slot
failed, say so plainly rather than reporting a clean run.

In a series, report per article as each one finishes rather than waiting for all N —
so a failure on slot 3 doesn't hide that slots 1 and 2 already published.
