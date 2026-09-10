# LinkedIn plugin (feed posts)

For the user-facing how-to-connect guide, see
[`docs/platforms/linkedin.md`](../../../../docs/platforms/linkedin.md). This file
is the developer-facing notes on what was verified and how.

**Every request shape in this plugin is UNVERIFIED.** It is reasoned from LinkedIn's
published REST API documentation, never measured against a real access token — unlike
Ghost's and WordPress's adapters, which carry a live-probed `docs/*-NOTES.md`. Nothing
here has actually posted to a real LinkedIn feed. `tests/integration/linkedin.integration.test.ts`
is the probe that can promote any of this to verified, and it self-skips without a
configured `linkedin` site — until it has run against a real token, treat every claim
below, and every comment in `index.ts`, as a documented claim, not a measured one.

NOTE: this is the `linkedin` API plugin — LinkedIn **feed posts**, `kind: 'social'`.
It is distinct from `linkedin-article`, the paste-based export platform for LinkedIn's
long-form Article feature (see `src/plugins/platforms/linkedin-article/README.md`).

## What this plugin does and does not do

- **Publishes a feed post immediately.** `create_post` refuses anything but
  `status: "published"` (`DRAFTS_UNSUPPORTED`) — LinkedIn has no draft state Byline can
  create through this API, and `siteTimezone` throws `NO_SITE_TIMEZONE`, so
  `publish_at`/scheduling are refused too.
- **One `commentary` string, optionally with one attached article link.** There is no
  title, slug, SEO metadata, Open Graph/Twitter card, or category on a feed post — every
  field `PostInput` carries that has nowhere to go produces a warning naming it
  (`UNSUPPORTED_FIELD_REASONS` in `index.ts`), never a silent drop.
- **Does not do the `[[article_url]]` substitution.** `create_post`'s `html` must not
  contain the literal text `[[article_url]]` — Byline refuses with
  `UNRESOLVED_PLACEHOLDER` rather than posting a link that was never filled in. The
  caller (the writer, following the brief's LINKEDIN POST section) swaps it for the
  real published URL before calling `create_post`.

## Credentials

| Field | Secret? | Example | Where to get it |
|---|---|---|---|
| `access_token` | yes | `AQV…` | developer.linkedin.com → your app → Auth → OAuth 2.0 tools → generate a token with scopes `openid`, `profile`, `w_member_social`. Lasts about 60 days; repeat when it expires. Posting as an organisation additionally needs `w_organization_social`, which LinkedIn grants only after Community Management API approval. |
| `author_urn` | no | `urn:li:person:AbC123` or `urn:li:organization:12345` | Who the post is from. You can also leave the literal placeholder `urn:li:person:me` — the adapter resolves it to your real person URN from `/v2/userinfo`'s `sub`, at request time, memoised per adapter instance (so one `create_post` call resolves it once even if it needs it twice). Run `list_authors` against this site once setup finishes to see your real URN and any organisation you administer. |

`url` is required by the shared `SiteConfig` shape (your LinkedIn profile or company
page URL) but is never called — the API always lives at `https://api.linkedin.com`
regardless of what `url` is set to.

`api_version` is optional, `YYYYMM` (e.g. `202509`). When unset, the adapter uses
`LINKEDIN_VERSION` in `index.ts` — itself UNVERIFIED, a plausible recent release, not
confirmed live. Set `api_version` explicitly once you know which version your app
was approved against.

## What a publish produces

A LinkedIn feed post: `commentary` (plain text, built from `html` — every tag is
stripped, `</p>` becomes a paragraph break, entities are decoded, 3+ blank lines
collapse to one), the canonical URL appended once if not already present, then hashtags
built from `tags` (each converted to `#PascalCase`, non-alphanumeric characters
dropped — `"machine learning"` → `#MachineLearning`). Over 3000 characters is refused
with `COMMENTARY_TOO_LONG` naming the count — LinkedIn's own limit.

When `canonical_url` is set, the post also carries an attached article link
(`content.article`) with `source`, `title`, and, when present, `custom_excerpt` as
`description` and `feature_image_id` as `thumbnail`. `feature_image` (a URL string) is
**not** enough on its own — LinkedIn's thumbnail wants the image's own urn, so a
`feature_image` set without a matching `feature_image_id` produces a warning naming
the field rather than silently doing nothing.

`upload_image` on a LinkedIn site returns the image's own **urn**, not a hosted URL —
LinkedIn exposes no public URL for an uploaded image. Pass that value as
`feature_image_id`, never as `feature_image`.

## Troubleshooting

- **401/403 from any call**: the access token has likely expired (about 60 days) or
  never had the required scope. Regenerate it at developer.linkedin.com and update the
  credential.
- **`author_urn` refused for an organization**: `w_organization_social` needs
  LinkedIn's Community Management API approval, which is a separate, manual grant —
  posting as a person works with no such approval.
- **`COMMENTARY_TOO_LONG`**: shorten the article's LinkedIn post text, or trim the
  hashtag list — both count toward the 3000-character limit.

## `list_authors`' organisation lookup warns rather than failing

`list_authors` always returns the authenticated person. It best-effort adds any
organisation the token administers (`GET /rest/organizationAcls?...`) — a personal
token with no organisation access is the ordinary case, not a failure. When that
lookup DOES fail (expired token, missing scope, a genuine error), it no longer
disappears: the adapter implements `PlatformAdapter.listAuthorsDetailed`, which
`list_authors` (`src/tools/persona-tools.ts`) prefers over the plain `listAuthors`
when a platform provides it, and its `warnings` array is included in the tool
result whenever it is non-empty — one entry naming the endpoint and the HTTP
status or error message, e.g.
`organisations: GET /rest/organizationAcls failed (403) — organisation URNs need Community Management API approval; person URN listed only.`
`listAuthors` itself still returns a bare array (the shape every other platform's
adapter implements) and simply drops the warnings — call `list_authors` through the
MCP tool, not the adapter's `listAuthors` directly, to see them.
