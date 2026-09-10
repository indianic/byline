---
name: humanizer
description: Rewrite AI-sounding body prose in a Byline draft so it reads like the persona, without changing what it says or touching the structural blocks the scorer requires.
---

# Humanizer

This is the full version of the REVISION PASS printed at the bottom of every
`build_writing_brief` output. The brief carries a compressed, five-line form of
it and tells the writer to come here by name for the definitions. This file is
the one place the five groups are spelled out in full — do not re-derive them,
and do not shorten them back into the brief; one rule, one definition.

## The five groups

Read the whole draft once, start to finish, before touching anything. Then
mark every tell you find, grouped below in the order you act on them.

**1. Staging instead of stating.**
The sentence spends its first half setting up a rhetorical move instead of
just making the claim — "It's not just a tool, it's a platform," a one-line
paragraph that exists purely for cadence, a saying that sounds deep on first
read and empty on the second ("at its core," "make no mistake"), a run-up
before the actual point, or an argument answering an objection nobody in the
piece raised ("To be clear, this isn't about...").

**2. Rhythm by rule.**
The prose follows a pattern instead of a reason to be shaped that way —
three-item lists reached for out of habit rather than because the list has
three things in it, three sentences in a row opening with the same word, a
dash used as the universal connector between any two clauses instead of a
period, a comma, or a colon, two hedges stacked on one claim ("could
potentially"), a hyphenated compound in every other sentence, or a passive
construction that hides who did the thing ("mistakes were made" instead of
naming who made them).

**3. Inflation.**
A plain fact dressed in language sized for something bigger — "pivotal,"
"landscape," "testament," "crucial" applied to an ordinary detail, a routine
event framed as a turning point, "associated with" standing in for the actual
mechanism ("caused," "delayed," "replaced"), an expert who is never named, or
"serves as"/"stands as"/"boasts" used in place of a plain "is" or "has."

**4. Formatting by rule.**
Visual structure applied as decoration rather than to carry meaning — bold
text scattered through body paragraphs instead of reserved for the summary
block and the callout label, a heading in Title Case where the rest of the
piece is not, or a heading whose very next sentence just restates it instead
of answering it.

**5. Leftovers.**
Residue from writing without a persona or a reader in mind — a greeting or an
offer to help, "in this article we will explore," a knowledge-cutoff
disclaimer, or any other sentence that talks about the article instead of
being part of it.

## The four-step process

1. **Read the whole draft once, start to finish**, before editing anything.
   Editing sentence-by-sentence on a first pass misses the tells that are only
   visible at paragraph or section scale (repeated openers, matching section
   shapes, a rhythm that never varies).
2. **Mark every tell you find**, noting which group it belongs to. Do not fix
   anything yet — marking first stops you from over-editing a passage you
   happened to reach early and under-editing one you reached tired.
3. **Decide what earns an edit**, using the act-on-one-sighting rule below.
4. **Rewrite only what you marked**, then read the result aloud once. A
   sentence that is awkward to say aloud is usually the one still carrying a
   tell you missed on the page.

## Act on one sighting; groups 2-5 need company

A single sighting of **group 1** (staging instead of stating) is reason
enough to rewrite it — these are the tells a reader notices first, and one is
already too many in a piece meant to sound like a specific person wrote it.

Groups 2 through 5 need **two tells in the same passage** before you touch
it. One dash, one moment of inflated language, one stray heading in Title
Case — each in isolation is just how writing sometimes comes out, and editing
every single instance produces flat, over-scrubbed prose that reads as
machine-edited rather than machine-written. Two in the same paragraph or
section is the pattern this skill exists to catch.

## What this does not touch

Byline's structural blocks are graded and built for machine consumption, not
for a human reader's sense of rhythm — do not apply any of the above inside
them:

- The **summary block** (the styled table or blockquote above the first H2).
  Its bolded answer sentence and bolded bullet labels are the one place bold
  is supposed to live.
- The **callout panel**. Same reason: its label is meant to be bold.
- Any **table**, including a data table and a pull-quote table.
- The **FAQ** section and its mirrored `faq` JSON array — these are answer-
  engine contracts (see AEO/GEO in the brief), not body prose.
- Any other **JSON field** in the output (titles, descriptions, tags, etc.).
- The literal placeholder text `[[content_image]]`.
- The text inside an `<a href="...">` tag's `href` attribute. Anchor text
  itself is body prose and is fair game; the URL is not.

## Never add facts

Rewriting for rhythm and specificity is not licence to invent specificity.
Keep every sourced claim exactly as sourced. Add no name, number, date, quote,
or citation that was not already in the draft. An invented specific that gets
published is worse than a generic sentence that stays generic — the generic
sentence can be fixed later; the invented one cannot be un-published.

## Credit and scope

The five-group taxonomy above is adapted from `blader/humanizer` (MIT
licence) and from Wikipedia's "Signs of AI writing" article. This is a craft
standard for specific, well-rhythmed prose — writing that follows it reads
better to a person, which is the entire justification for it. It makes **no
claim about any AI-detection tool**, and none should be inferred from using
it: that claim could not be verified from inside this codebase, and nothing
here was built or tested against one.
