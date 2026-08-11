# Local media library — design

**Date:** 2026-08-11
**Status:** approved, not yet implemented
**Affects:** `src/media/` (new), `src/plugins/images/`, `src/plugins/platforms/`, `src/craft/brief.ts`, `src/tools/`, `src/config/`

---

## The problem

Byline can only illustrate an article one way: generate a photograph. A writer with their
own photographs — event shots, office photos, product stills, screen recordings — has no
way to use them, and no way to ask for a generated image that matches the look of one.

Nothing in the codebase reads local media. `PlatformAdapter` exposes exactly one media
method, `uploadImage`, and Ghost's implementation posts to `images/upload/`.

## What this builds

A **media library**: one or more folders of images and video that byline indexes, searches
by keyword, uploads, and tracks so the same file is never published twice by accident. Plus
two derived capabilities — generating an image in the *look* of a library photo, and
generating a variation *from* one.

## Non-goals

- **No embeddings or vector search in v1.** Deterministic token ranking over keywords,
  caption, filename and folder. A vector store is a new dependency, a new build step and a
  new staleness problem, for libraries that are typically a few hundred files. Revisit when
  a real library demonstrates that ranking is the bottleneck.
- **No editing of media.** No cropping, resizing, transcoding, or watermarking.
- **No writing to the user's library folder, ever.** See "Usage lifecycle".

---

## Concepts

### Library

A named folder, declared in `config.yaml` beside `sites`:

```yaml
media:
  default_library: my-shots
  reuse_scope: site
  libraries:
    - name: my-shots
      path: ~/Pictures/blog-media
      recursive: true
```

`reuse_scope` decides what "already used" means. `site` (default) — an asset published on
`personal` remains available for `nicgulf`. `global` — used once, anywhere, ever.

Library names follow the existing `SLUG_PATTERN` from `src/config/sites.ts`. One rule, one
definition; a second pattern here would drift the way `SLUG_PATTERN` already drifted once.

### Asset identity is a content hash

An asset is identified by the SHA-256 of its bytes, never by its path. A renamed file, a
file moved between folders, and two copies in different folders all resolve to one asset,
so usage tracking survives every one of those. Path-keyed tracking survives none of them.

Hashing is cached on `(path, mtime, size)`. A rescan only rehashes what changed.

### Two state files, deliberately separate

Both live under `~/.byline/media/`, never inside the user's library folder.

| File | Holds | If deleted |
|---|---|---|
| `<library>.index.json` | Derived data: hashes, dimensions, keywords, captions | A rescan rebuilds it exactly |
| `<library>.usage.json` | Source data: what was used, where, when | Unrecoverable |

They are separate because `scan` rewrites the index. Storing an unrecoverable ledger inside
a file that a routine command overwrites is a data-loss defect waiting for its first user.

A library may set `index_path` to relocate both files — for a team sharing one library over
a network share. Default is `~/.byline/media/`.

---

## The index entry

```json
{
  "id": "sha256:9f2c1a…",
  "path": "portraits/team-standup-01.jpg",
  "kind": "image",
  "mime": "image/jpeg",
  "bytes": 2481920,
  "width": 4032,
  "height": 3024,
  "aspect": "4:3",
  "duration_s": null,
  "captured_at": "2026-03-14T09:12:00+05:30",
  "scanned_at": "2026-08-11T12:40:11Z",
  "source": {
    "filename_tokens": ["team", "standup"],
    "folder_tokens": ["portraits"],
    "exif": { "camera": "…", "lens": "…" }
  },
  "enriched": {
    "by": "gemini",
    "at": "2026-08-11T12:44:02Z",
    "caption": "Four people standing around a whiteboard mid-discussion",
    "keywords": ["standup", "whiteboard", "team", "meeting", "office"],
    "look": "Shot on a 35mm lens at f/2, available window light from one side…",
    "has_people": true,
    "text_in_image": false
  }
}
```

`enriched` is absent until `byline media enrich` runs. Everything else comes from the file
itself and needs no API key.

`aspect` is the **nearest of the three buckets the image tools already accept** — `16:9`,
`4:3`, `1:1` — chosen by closest ratio, with the exact `width`/`height` kept beside it. Real
photographs are rarely exactly any of the three, and inventing a fourth vocabulary here
would leave `find_media`'s filter speaking a different language from `generate_image`'s
`aspect` argument.

`captured_at` comes from EXIF when present and falls back to the file's mtime. Which one
was used is recorded in `source`, because an mtime is a much weaker claim about when a
photograph was taken and a ranking tiebreak should not silently pretend otherwise.

Three fields earn their place:

- **`look`** is written in the vocabulary of `IMAGE_LOOKS` in `src/craft/image-style.ts`.
  Extracting it once at enrich time means "generate an image inspired by this photo" costs
  no vision call at write time.
- **`text_in_image`** lets search exclude assets the brief already forbids — every image
  prompt in this project bans readable text.
- **`has_people`** distinguishes a `photoreal_people` candidate from a `photoreal_scene`
  one, matching the two styles the image tools already accept.

---

## Module layout

```
src/media/
  library.ts   resolve and validate libraries from config
  scan.ts      walk, hash, extract metadata for images and video
  index.ts     read/write the index, atomically
  ledger.ts    read/write usage, atomically
  search.ts    rank assets against a query
  enrich.ts    vision keywording, through the images provider family
  types.ts
```

This sits under `src/media/`, not `src/plugins/`. A local folder has no credentials, no
remote API and no health check, so it is not a provider; it is infrastructure at the same
tier as `src/config/`. It *consumes* the image providers rather than being one.

`src/cli/` gains no knowledge of any specific library, platform or provider, per the
standing rule.

---

## Provider capability changes

No new provider family and no new API key. `ImageProvider` in
`src/plugins/images/types.ts` gains two optional methods:

```ts
export interface AssetDescription {
  caption: string;
  keywords: string[];
  look: string;
  has_people: boolean;
  text_in_image: boolean;
}

export interface ImageProvider extends KeyedProvider {
  withKey(key: string): ImageProvider;
  generate(prompt: string, aspect: Aspect): Promise<{ data: Buffer; mime: string }>;

  /** Optional. Presence of the method IS the capability flag. */
  describe?(file: Buffer, mime: string): Promise<AssetDescription>;

  /** Optional. Presence of the method IS the capability flag. */
  generateFrom?(
    ref: { data: Buffer; mime: string },
    prompt: string,
    aspect: Aspect,
  ): Promise<{ data: Buffer; mime: string }>;
}
```

An optional method as the capability flag cannot drift from a separate boolean, because
there is only one fact.

### Fallback rules

`generate` keeps the existing Gemini → Grok chain: both return a photograph, so
substitution is invisible and harmless.

`generateFrom` **never falls back**. Only providers declaring the method are eligible; if
the selected provider lacks it, the call fails with a named error. Degrading silently to a
derived-look generation would return a visibly different picture while reporting success —
the same defect class as substituting Brave for Tavily, which
`src/plugins/research/` already refuses for exactly this reason.

`describe` may fall back, because every implementation returns the same
`AssetDescription` shape and enrichment is advisory metadata rather than a delivered
artifact. The provider that produced it is recorded in `enriched.by`.

---

## Platform adapter changes: video

`PlatformAdapter.uploadImage` becomes `uploadMedia(file, filename, mime, alt?)`, dispatching
on MIME type. Both adapters live in this repo, so this is an internal rename with no
external consumers. `docs/ADDING-A-PLATFORM.md` must be updated in the same change — it is
the gate for this interface, not a description of it.

`HtmlProfile` in `src/craft/html-profile.ts` gains a video descriptor stating what each
platform does with a `<video>` element on ingest. Both `build_writing_brief` and
`score_draft` read `HtmlProfile`, so the measured behaviour drives what writers are asked
to produce and what `platform_html` accepts.

### The probe gate — BLOCKING

**No video code ships before these five probes run against real installs, and no claim
about video appears in any tool description, brief or doc until the probe that proves it is
recorded.** Each result goes into `docs/GHOST-NOTES.md` or `docs/WORDPRESS-NOTES.md` with
its date, per the standing rule that every line in those files traces to a real request.

| # | Probe | Decides |
|---|---|---|
| 1 | Ghost `POST /media/upload/` with a small MP4 | Whether Ghost accepts video at all, and the response shape |
| 2 | Publish HTML containing `<video src>` to Ghost, read the post back | Whether the tag survives, becomes a native card, or is stripped |
| 3 | WordPress `POST /wp/v2/media` with an MP4 | Acceptance, and the `source_url` shape |
| 4 | WordPress read-back of `<video>`, with and without `unfiltered_html` | Whether KSES strips it on a restricted account |
| 5 | Upload size limits, both platforms | The pre-flight refusal threshold |

If probe 2 shows Ghost strips `<video>` from HTML source, the video half of this design
changes shape and must be re-agreed before implementation continues.

Probe 4's restricted-account arm inherits the existing limitation recorded in `CONTEXT.md`:
no account without `unfiltered_html` has ever been available. If one cannot be obtained,
that arm stays **UNVERIFIED** and is marked as such in the code and in
`docs/WORDPRESS-NOTES.md`. It is not promoted on the strength of the administrator-account
probe.

---

## Tools

Three new, two extended. The MCP tool count goes from 16 to 19.

### `list_media_libraries`

Returns each configured library: name, path, asset counts by kind, unused count, whether
the index is stale (files changed on disk since the last scan), and the count of stale
reservations.

### `find_media`

The workhorse. Takes a query plus optional filters (`kind`, `aspect`, `has_people`,
`unused_only`, `library`) and returns ranked candidates. Each result carries the asset's
local path, caption, keywords, dimensions, and a `why` field naming the tokens that
matched — so the calling model judges the match itself rather than trusting a score it
cannot see into.

`unused_only` defaults to `true`. `library` defaults to `media.default_library`; passing
`library: 'all'` searches every configured library and labels each result with the library
it came from.

### `use_media`

Uploads chosen assets to a site, returns hosted URLs and native ids, and writes the ledger.
Batched, mirroring `upload_images`. Refuses before uploading when an asset exceeds the
platform's measured size limit, rather than surfacing a 413.

### `generate_image` and `generate_images` — extended

Two new optional parameters:

- `reference` — a media id, or a local path.
- `reference_mode` — `'look'` or `'image'`.

A path outside every configured library is accepted. It is read for its look or its bytes
and nothing more: it is not indexed, not hashed into the library, and not written to the
ledger. Referencing a photo is not using it, and a generated image is a new asset regardless
of what inspired it.

`'look'` reads `enriched.look` from the index (or derives it with `describe` if the asset
is not enriched) and passes it as the existing `look` argument to `composeImagePrompt`.
Nothing else in the generation path changes.

`'image'` calls `generateFrom`, and fails by name if the provider does not declare it.

### `build_writing_brief` — extended

One new parameter: `media: 'generate' | 'library' | 'either'`, defaulting from config and
ultimately to `'either'`.

The brief's IMAGES block is already the single place image policy is stated to the writing
model. `'library'` makes it instruct the model to call `find_media` and not to call
`generate_image`. Adding a second switch elsewhere would be a second copy of one rule.

`create_post` needs no change. Its image gate checks that a `feature_image` and an inline
`<img>` exist and has never cared where they came from.

### CLI

```
byline media add <path> [--name <slug>]   register a library
byline media scan [<library>]             walk, hash, index
byline media enrich [<library>]           vision keywording for un-enriched assets
byline media status                       counts, staleness, stale reservations
byline media release <id>                 clear a stale reservation
```

---

## Search ranking

Deterministic and dependency-free. Token overlap between the query and four fields, each
weighted:

1. `enriched.keywords` — highest
2. `enriched.caption`
3. `source.filename_tokens`
4. `source.folder_tokens` — lowest

Ties break on `captured_at`, most recent first. Filters apply before ranking. The `why`
field lists the matched tokens per field so a poor ranking is diagnosable rather than
mysterious.

An un-enriched library still searches, on filename and folder alone. It works badly, and
`find_media` says so in its result rather than returning weak matches silently.

---

## Usage lifecycle

**Byline never writes to the user's library folder.** No moving, no renaming, no sidecar
files, no `used/` directory. The library is read-only to this program. A folder under
Dropbox, Lightroom, or a shared drive is not byline's to reorganise, and a half-completed
move during a failed publish leaves an orphaned file with no way back.

The ledger provides the same no-duplicate guarantee without touching a byte:

1. `use_media` uploads and records the asset as **`reserved`**, with the site and hosted URL.
2. A successful `create_post` containing that hosted URL promotes the record to
   **`published`**, with the post URL.
3. `find_media` excludes both states when `unused_only` is true, scoped per `reuse_scope`.

### The accepted gap

If an upload succeeds and the publish then fails, the asset stays `reserved` and will not
resurface in search. This is deliberate: over-excluding one photo is recoverable, publishing
the same photo to two live posts is not.

It is made visible rather than silent. `list_media_libraries` and `byline media status`
both report the stale-reservation count, and `byline media release <id>` clears one.

---

## Error handling

Every failure returns a `ToolError` naming the failing subsystem and a `hint`, per the
standing rule that nothing fails silently.

| Condition | Behaviour |
|---|---|
| Library path missing or unreadable | Collected into `SetupState`; `loadContext()` still does not throw, so `doctor` still runs |
| Index stale (files changed since scan) | `find_media` returns results with `stale: true` and the changed count. It never serves known-wrong data silently |
| Indexed file deleted from disk | `use_media` fails naming the path; the asset is marked missing in the index |
| Asset exceeds platform size limit | Refused before upload, quoting the measured limit |
| `generateFrom` unsupported by provider | Explicit refusal naming the provider. Never a silent derived-look substitution |
| No image provider configured | `scan` works fully; `enrich` refuses with a hint. Search degrades to filename and folder tokens and says so |

---

## Testing

Unit tests run against a real fixture tree in a temp directory — real files, real
filesystem, real bytes. Hashing, metadata extraction, ranking and ledger transitions are
all verifiable without a network, and mocking the filesystem here would only prove that the
code does what it was told.

Integration tests, behind `RUN_INTEGRATION=1`, are the ones that count:

- Upload a real image and a real MP4 to Ghost and to WordPress.
- Publish a post embedding each, **read the post back off the live site**, and assert the
  element survived in the form the probe recorded.
- Self-cleaning: create, read back, assert, delete.

**No mocked platform for video.** A mocked video upload would encode the same assumption
the code encodes and pass for the same wrong reason — the exact shape of the
`feature_image_id` defect recorded in `CONTEXT.md`.

`npm test` stays network-free. The unit-test floor stated in `CLAUDE.md` rises with this
change and must be updated there, in the one place it is stated.

---

## Known UNVERIFIED at design time

Stated plainly so nothing is promoted by accident.

- **All five video probes are unrun.** Every statement in this document about what Ghost or
  WordPress does with video or with `<video>` is a question to be answered, not a claim.
- **WordPress without `unfiltered_html` remains unmeasured**, as it is today. Probe 4's
  restricted arm may not be runnable.
- **Frame extraction for video enrichment depends on `ffmpeg` being present.** When it is
  absent, video assets get metadata-only indexing — duration, dimensions, filename and
  folder tokens — and `enrich` reports them as skipped with the reason. Byline does not
  bundle or install `ffmpeg`.

---

## Build order

1. Config schema, library resolution, `src/media/types.ts`
2. `scan` + `index` + `list_media_libraries` — images only, no API key needed
3. `search` + `find_media`
4. `ledger` + `use_media` + `create_post` promotion
5. `describe` capability + `enrich` + `byline media enrich`
6. `reference` / `reference_mode` on the generate tools
7. `media` parameter on `build_writing_brief`
8. **Probe gate** — the five video probes, results written to the NOTES files
9. Video: `uploadMedia`, `HtmlProfile` video descriptor, `platform_html` rule, integration tests

Steps 1–7 deliver a complete, useful images-only feature. Step 8 decides the shape of step 9.
