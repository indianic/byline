# Image providers — hard-won API knowledge

**Probed:** 2026-08-10, against the live xAI (Grok) image API.
**Auth:** `Authorization: Bearer <XAI_API_KEY>`.

This file exists for the same reason `docs/GHOST-NOTES.md` does: every line below is
traceable to a real request made during this probe, not to documentation or memory. Do
not widen a claim here without another probe that proves the change.

## Behaviour → consequence

| Behaviour | Consequence |
|---|---|
| **`GET /v1/image-generation-models` with the real key → 200**, body `{"models":[{"id":"grok-imagine-image",…},{"id":"grok-imagine-image-quality",…}]}`. `grok-imagine-image` carries `max_prompt_length: 8000` and aliases `grok-imagine-image-2026-03-02`. The deprecated `grok-2-image-1212` is absent from the list entirely. | `healthCheck` (`src/plugins/images/grok/index.ts`) probes this endpoint and asserts `MODEL` is in the returned list, rather than probing `/v1/models` — which answers 200 for any valid key regardless of which models exist. Confirmed correct as shipped in 1.7.1. |
| **`POST /v1/images/generations` with `model: "grok-imagine-image"` → 200** and a populated `data[0].b64_json` (≈520 KB base64 for a 16:9 photographic prompt). Grok generation is **working**, not deprecated. | The "Grok reports reachable but fails in practice" discrepancy observed on 2026-08-10 was **not** a live-API problem. The machine was running the globally-installed `@indianic/byline@1.6.1`, which predates the 1.7.1 model fix and still sent `grok-2-image-1212`. Diagnosis: check the INSTALLED version before re-probing a provider. |
| **`data[0]` carries a `mime_type` field**, and for `grok-imagine-image` its value is **`"image/jpeg"`** — confirmed against the bytes, which begin `ff d8 ff e0 00 10 4a 46 49 46` (JFIF) and decode as a 1280×720 JPEG. | The adapter previously hardcoded `mime: 'image/png'` for every response, so **every Grok fallback image was a JPEG announced as a PNG**. Because both platform adapters derive the upload `Content-Type` from the *filename extension* (`mimeFor` in the WordPress adapter, `IMAGE_MIME` in the Ghost one) and `generate_image` wrote every file as `.png`, the mislabelling propagated all the way to the media store. Now read from `mime_type`, falling back to `image/png` only when the field is absent. |
| **xAI's image model has no aspect-ratio parameter.** The 16:9 prompt suffix produced 1280×720. | The ratio is steered by the prompt only, as the adapter's comment already stated. The returned size is not guaranteed to match the requested aspect, which is why `generate_image` now reports the ACTUAL width and height read from the bytes rather than echoing the request. |

## Why `inspectImage` exists

`src/plugins/images/inspect.ts` reads format and dimensions out of the image bytes
(PNG IHDR, JPEG SOF chain, GIF header). Two measured reasons:

1. The mime a provider claims and the extension a file is given were allowed to
   disagree, as above. Reading the magic bytes makes the filename follow the content.
2. Callers were reading whole generated images back through a vision model purely to
   confirm the dimensions — an expensive way to read two integers at a fixed offset.

It reports `null` dimensions for anything it does not genuinely parse (WebP's three
chunk layouts are detected as WebP but not measured). A fabricated dimension would be
worse than none, because a caller would act on it.
