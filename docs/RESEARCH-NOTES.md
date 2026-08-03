# Research providers — hard-won API knowledge

**Probed:** 2026-07-30, against the live Brave Search API and Tavily API.
**Auth:** Brave — `X-Subscription-Token` header. Tavily — `Authorization: Bearer`.

This file exists for the same reason `docs/GHOST-NOTES.md` does: every line below is
traceable to a real request made during this probe, not to documentation or memory. Nine
defects reached production in this project because a mocked test agreed with an
assumption about a remote system's behaviour. Do not widen a claim here without another
probe that proves the change.

The live event used for every recency measurement: the query `"Sensex Nifty stock market
live updates today"`, chosen by first probing Brave's `/news/search` with broad terms
("breaking news", "live score today", "stock market today") and reading actual `age`
values until one surfaced under two hours old. Every provider was probed against this
exact query within the same two-minute window (2026-07-30T08:47–08:49Z) so the recency
comparison between providers is apples-to-apples.

## Behaviour → consequence

| Behaviour | Consequence |
|---|---|
| **Brave** auth is `X-Subscription-Token`. `GET /res/v1/news/search?q=ok&count=1` with the real key → **200**. Fabricated-but-well-formed key (`'BSA' + 'a'.repeat(29)`) → **422** `{"error":{"code":"SUBSCRIPTION_TOKEN_INVALID","detail":"The provided subscription token is invalid."}}`. Reproduced exactly on this probe run. | Brave has a real auth gate. `healthCheck` (`src/plugins/research/brave/index.ts`) can call `GET /news/search?q=ok&count=1` and treat non-200 as `ok: false`. |
| **Tavily** auth is `Authorization: Bearer`. `POST /search` with `{"query":"cricket score"}` and the real key → **200**. Fabricated key (`'tvly-' + 'a'.repeat(32)`) → **401** `{"detail":{"error":"Unauthorized: missing or invalid API key."}}`. Reproduced exactly on this probe run. | Tavily has a real auth gate. `healthCheck` (`src/plugins/research/tavily/index.ts`) sends `Authorization: Bearer`, never the legacy `api_key` body field, and treats non-200 as `ok: false`. |
| **Tavily rejects a query under 2 characters with 400 for every key**, real or fabricated — `{"detail":{"error":"Query is too short. Min query length is 2 characters."}}`. (Carried from the pre-probe key confirmation; not re-derived this run per the task brief.) | `healthCheck` must probe with `'ok'`, not a 1-character string — a 1-char probe would report every valid key as broken and make `byline init` refuse real keys. |
| **Tavily's `answer` field is `null` only when `include_answer` is not sent at all.** Reproduced verbatim: `POST /search {"query":"cricket score"}` (no `include_answer`, no `topic`) → 200, `answer: null`, 10 results present. But `POST /search {"query":"Sensex Nifty stock market live updates today","include_answer":true}` (default/general topic) → 200, `answer` populated with a real synthesized sentence. The already-measured claim in the task brief did not specify `include_answer`; this probe confirms it is the missing parameter, not a topic restriction. | `include_answer: true` must be sent on every Tavily call that wants a summary; `answer` must still be read defensively, since a query with no synthesizable fact can plausibly return `null` even when requested. **Corrected:** this row originally prescribed `answer ?? undefined`; the shipped adapter deliberately does otherwise, OMITTING the key entirely when there is no answer (`src/plugins/research/tavily/index.ts`, pinned by `'answer' in out` in `tests/plugins/research/tavily.test.ts`). `build_writing_brief` branches on the field's *presence*, and `answer: undefined` survives a JSON round trip as a missing key anyway — so setting it explicitly would make the in-process object and the wire envelope disagree for no gain. |
| **Brave's two search endpoints put results at different JSON paths.** `GET /res/v1/web/search` nests results at **`body.web.results[]`**. `GET /res/v1/news/search` puts results at the **top-level `body.results[]`** — there is no `news` wrapper key. Both confirmed by reading full, untruncated response bodies. | Moot for the shipped adapter: `src/plugins/research/brave/index.ts` calls `/news/search` only, so it reads `body.results` alone. The `body.web.results` path was a live concern while both endpoints were candidates for the adapter; it is not a branch that exists in the code. |
| Brave result fields (both endpoints, same shape): `title`, `url`, `description`, `age` (human string, e.g. `"9 hours ago"`), `page_age` (ISO 8601 **with no timezone suffix**, e.g. `"2026-07-30T07:52:29"` — no `Z`, no offset), plus `profile`, `meta_url`, `thumbnail`. | Field mapping in the Brave adapter: `title→title`, `url→url`, `description→snippet`, `page_age→publishedAt`. Because `page_age` carries no explicit timezone, the adapter must treat it as UTC by construction (append `Z` before `new Date()`), matching what the lag math below assumes — an unverified assumption otherwise. |
| **Brave `/web/search` `description` can contain embedded raw HTML** (`<strong>` tags wrapping matched query terms) — confirmed on a live result: `"...the <strong>Sensex rallied over 800 points and the Nifty reclaimed the 24,000 mark</strong>, snapping a..."`. The `/news/search` descriptions probed did not show this, but the field is untyped free text from the same backend and must be treated the same way on both endpoints. | The Brave adapter must strip HTML tags from `description` before it reaches a snippet or writing brief — passing it through raw leaks markup into generated content, the same class of defect as Ghost's silently-stripped `<div>` (see `GHOST-NOTES.md`). |
| Tavily result fields (`POST /search`, both topics): `url`, `title`, `content` (long, markdown-flavored — this is the snippet field, not a short excerpt), `score`, `raw_content` (`null` unless requested). **`published_date` is present only when `topic: "news"` is set** — confirmed absent on every result under the default/general topic, present on every result under `topic: "news"`, format RFC 1123 with explicit `GMT`, e.g. `"Thu, 30 Jul 2026 04:00:00 GMT"`. | The Tavily adapter must always pass `topic: "news"` when a `publishedAt` is required (i.e., whenever the news guard needs to date a finding) — the default topic gives no date field to read, not a null one. `content` must be treated as a snippet source needing truncation, not a short description. |
| **Brave's `freshness` param and Tavily's `days` param are candidate-pool *filters*, not sort orders.** Neither returns results newest-first. Measured on the identical live query: `freshness=pd` returned page_ages in the order `[2026-07-29T10:09:15, 2026-07-30T07:52:29, 2026-07-30T01:11:00, ...]` — a day-old result ranked ahead of a 55-minute-old one. `freshness=pm` similarly interleaved a 1-day-old result between two same-day ones. Tavily's `topic=news` (no `days`) returned `[04:00:00, 02:35:54, 04:08:04, 02:00:00, 04:00:00]` — not monotonic either. | No code may assume the first result is the newest. **The resolution was NOT to sort.** Neither adapter re-orders what the provider returned, because provider order is relevance order, and that ranking is the only defence against the backfilled off-topic filler measured in the next row — sorting by date would promote exactly that filler to the top of the brief. Instead, anything needing "the newest" computes it without reordering: `tallyWindow` in `src/plugins/research/window.ts` scans for the maximum timestamp numerically (not by string sort, which would break on Tavily's RFC 1123 weekday prefix). `tests/craft/brief.test.ts` pins the preserved order. |
| **Tavily's `days=1` filter backfilled with off-topic results carrying a same-day `published_date` despite unrelated content** — two of five results under `days=1` for the Sensex/Nifty query were `"The Economic Times: October 2024 News"` and `"Asus Pad unboxing ASMR"`, both timestamped `Thu, 30 Jul 2026` in `published_date` despite having nothing to do with the query. | `published_date` alone is not evidence a result is *about* the event — but **the resolution was NOT to gate on `score`**, for the same reason the adapters do not sort: no relevance threshold has been measured, and inventing one would be exactly the "never encode an unverified external fact" defect this file exists to prevent. `Finding.relevance` surfaces Tavily's `score` on the brief in prose instead, so the writer can discount an off-topic-but-dated result themselves; nothing in code filters or gates on it. See the row above (order) and `:100-102` below (the same measurement reconfirmed) — same defect class, same resolution. |
| Both fabricated keys returned a real auth error, never 2xx: Brave **422**, Tavily **401**. No `/site/`-style unauthenticated-but-200 endpoint was found on either provider across every endpoint probed (`/web/search`, `/news/search`, `POST /search`). | Both providers have a usable `healthCheck` gate as designed; no defensive fallback endpoint is needed the way Ghost's `/config/` was needed after `/site/` proved unauthenticated. |

## Recency, measured

Live query: `"Sensex Nifty stock market live updates today"`. Probe window: 2026-07-30T08:47–08:49Z.

| Provider | Control | Freshest result returned | Lag behind probe time |
|---|---|---|---|
| Brave `/news/search` | no `freshness` param | `page_age: 2026-07-30T07:52:29` (NDTV live-updating blog page) | **~55 minutes** |
| Brave `/news/search` | `freshness=pd` | same article, ranked 2nd of 5 (not sorted newest-first) | ~55 minutes |
| Brave `/news/search` | `freshness=pw` | same article, ranked 2nd of 5 | ~55 minutes |
| Brave `/news/search` | `freshness=pm` | same article, ranked 1st of 5 | ~55 minutes |
| Tavily `POST /search topic=news` | no `days` | `published_date: Thu, 30 Jul 2026 04:08:04 GMT` (on-topic result) | **~4h39m** |
| Tavily `POST /search topic=news` | `days=1` | `published_date: Thu, 30 Jul 2026 03:30:00 GMT` (on-topic result; ranked 1st) | ~5h17m |
| Tavily `POST /search topic=news` | `days=7` | `published_date: Thu, 30 Jul 2026 04:00:00 GMT`, ranked 2nd of 5 (a 4-day-old result ranked 1st) | ~4h52m |
| Tavily `POST /search` default topic | any | no `published_date` field at all | not measurable |
| Brave `/web/search` | none | `page_age: 2026-07-29T23:25:03` | ~9h22m |

**Registry-order decision:** Brave returned a result **~55 minutes** behind probe time for
the live event; Tavily's freshest *on-topic, dated* result was **~4h39m** behind, roughly
5x staler, for the identical query probed in the same two-minute window. Because the news
guard refuses findings it cannot date closely enough to trust, **Brave is registered
first** in `researchProviders()`. This is a measured result, not a preference — Tavily's
`content` field is often richer (longer, markdown-structured) and its `answer` synthesis
is a real capability Brave lacks, but neither compensates for a 5x-staler `publishedAt`
on the exact axis the registry order is chosen for.

## The one trap, verbatim

**Tavily's `published_date` field does not exist unless `topic: "news"` is set, and even
then it is not proof of relevance to the query that produced it.**

A caller that sends the default (general) topic and reads `result.published_date` will
get `undefined` on every result, silently — there is no error, the field is simply
absent from the JSON. Switching to `topic: "news"` fixes that, but introduces a second,
sharper trap: under a narrow `days` filter, Tavily backfills the result count with
off-topic filler that still carries a same-day `published_date`. Two results for the
query `"Sensex Nifty stock market live updates today"` under `days=1` were about the
2024 Economic Times archive and an unrelated ASUS tablet unboxing video — both stamped
"today." Code that trusts `published_date` as evidence a result is *about* the live event,
without also checking Tavily's own relevance `score`, will let a freshly-dated but
irrelevant result through the news guard. This is the same class of defect as Ghost's
`GET /site/` accepting a fabricated key: a signal that looks like proof of the thing it's
being used to prove, but isn't.

## Follow-up probe, 2026-07-31 — Tavily `content`/`title` need no HTML stripping

Brave's `description` carries raw `<strong>` markup and required a tokenizer to strip it
(Task 4). Before writing the Tavily adapter (Task 5), the same question was probed against
Tavily directly: `topic: "news"`, `days: 1`, requested 8 results (6 returned) for the same
live-event query used throughout this file. **Zero** HTML tag-open sequences and **zero**
character-entity references were found across every `content` and `title` field in the
result set.

**This is a sample of 8 (6 returned), not a proof that Tavily never emits markup.** The
Tavily adapter (`src/plugins/research/tavily/index.ts`) therefore does NOT call Brave's
`stripHtml`, and that function is not hoisted to a shared module — it has one caller, and
moving it before a second caller has been shown to need it would be premature. If a later
probe ever finds markup in Tavily `content`, the honest fix is to hoist `stripHtml` then,
with that observation recorded here.

The same probe reconfirmed two other measurements from the 2026-07-30 run, against a fresh
live result set:

- **Relevance `score` range:** scores spanned **0.087 to 0.717** across one result set, and
  the lowest-scoring entries were the short, off-topic ones — consistent with the
  2026-07-30 finding that a fresh `published_date` is not evidence of aboutness. Still
  surfaced via `Finding.relevance`, still never gated or filtered on: no threshold has been
  measured, and inventing one would be the "never encode an unverified external fact"
  defect this file exists to prevent.
- **Content length:** the longest `content` field observed was 1434 characters (2026-07-30
  run: 1352), confirming the 1200-character truncation in the adapter does bite on real
  results, not just synthetic ones.
- **Auth and query-length gates:** re-run live immediately before writing the adapter — a
  fabricated-but-well-formed key (`'tvly-' + 'a'.repeat(32)`) against a 2-character query
  returned **401** (`Unauthorized: missing or invalid API key.`), and a real key against a
  **1-character** query returned **400** (`Query is too short. Min query length is 2
  characters.`), reproducing the 2026-07-30 result exactly. `healthCheck` probes with `'ok'`.

## Where this lives in code

- `src/plugins/research/brave/index.ts` — the Brave adapter: `X-Subscription-Token` auth,
  `/news/search` only (so `body.results`, never `body.web.results`), HTML stripping on
  `title` and `description`, UTC-assumed `page_age` parsing, `relevance: null` because
  Brave returns no score. **It does not sort**; see the freshness row above.
- `src/plugins/research/tavily/index.ts` — the Tavily adapter: `Authorization: Bearer`
  auth, `'ok'`-not-`'a'` health probe, forced `topic: 'news'` so a date exists at all,
  forced `include_answer: true`, `answer` read defensively, `content` truncated at 1200
  characters, and Tavily's own `score` surfaced as `Finding.relevance`. **The relevance
  score is surfaced, never gated on** — no threshold has been measured, so the
  fresh-but-off-topic cross-check is put to the writer in the brief's own words rather
  than performed by a number nobody probed. **It does not sort either.**
- `src/plugins/research/window.ts` — the shared date authority: `isoUtc`, the shape
  guards that stop `Date.parse` accepting `"2026"` as a date, `DATE_GRACE_MS`, and
  `tallyWindow`, which is what the news guard and the brief both read.
- `src/plugins/research/index.ts` — selection, no fallback. Brave registered first per the
  registry-order decision above.

Both adapters and the registry now exist (Tasks 3–5) and match this file; this file remains
the specification of record, and any future change to either adapter's behaviour needs a
new probe recorded here before the code changes, per the rule at the top of this file.
