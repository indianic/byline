# Ghost plugin

## Credentials

One field, one click-path:

| Field | Secret? | Example | Where to get it |
|---|---|---|---|
| `admin_api_key` | yes | `id:secret` | Ghost Admin → **Settings → Integrations → Add custom integration** → copy the **Admin API Key**. |

The Admin API key is *not* the Content API key shown on the same screen — they are
not interchangeable, and pasting the wrong one produces a 401 with no other signal
(see `docs/GHOST-NOTES.md`'s "hex secret" row). `admin_api_key` is a secret field: in
`sites.yaml` it is written as `${SOME_ENV_VAR}`, and the real value lives only in
`.env`.

`api_url` is optional and derives to `{url}/ghost/api/admin` when omitted. Set it
explicitly if the Admin API lives on a different host or path than the public
site — two of the three real sites this project was built against needed that
override; a 404 on `/site/` with an otherwise-correct key is the signature of this
mismatch.

## Quirks

The full, sourced list is `docs/GHOST-NOTES.md`. The two that will bite you fastest:

- `POST /posts/` **requires** `?source=html`, or Ghost silently expects Lexical
  JSON instead and drops the HTML body with no error.
- Ghost **unwraps** `<div>`/`<section>`/`<aside>`/`<span>`/`<small>`/`<pre>`/`<mark>`
  and a handful of other structural tags on ingest — the inner text survives, the
  element and every style is discarded, and the post still publishes. A styled
  `<table>` is the only container that survives with its styling intact.

`html-profile.ts` encodes every measured behaviour as data (`GHOST_HTML_PROFILE`),
consumed by `score_draft` and `build_writing_brief` so the writing brief and
scorecard reflect what Ghost actually does, not what its documentation claims.

## How this was verified

Every behaviour recorded in `docs/GHOST-NOTES.md` and in the comments of
`html-profile.ts` was confirmed by a **live probe** against a real Ghost install
(Ghost 6.44) on 2026-07-28 — publishing a real post and reading it back, not reading
Ghost's documentation. Ghost's ingest behaviour does not vary by account or
install, so `GHOST_HTML_PROFILE` is a constant (`htmlProfile` in `plugin.ts` ignores
the adapter argument entirely) — unlike WordPress, whose profile must be resolved
per authenticated user.
