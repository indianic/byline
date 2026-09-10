# LinkedIn (feed posts)

This is the `linkedin` API plugin — LinkedIn **feed posts**, published through
LinkedIn's own REST API. It is distinct from `linkedin-article`, LinkedIn's
long-form Article feature, which has no API and is a paste-based export platform
like Medium and Substack — see `src/plugins/platforms/linkedin-article/README.md`
for that one.

## What Byline can do here, and what it cannot

**Not checked live, as of 2026-09-10.** Everything below is reasoned from
LinkedIn's own published REST API documentation, never confirmed against a real
access token — `tests/integration/linkedin.integration.test.ts` is the probe that
would confirm it, and it has not been run. Treat every claim on this page as a
documented claim, not a measured one, until that changes.

What the plugin is designed to do:

- **Publish a feed post immediately.** `create_post` refuses anything but
  `status: "published"` — there is no LinkedIn draft this API can create through
  Byline, and no scheduling (`publish_at` throws `NO_SITE_TIMEZONE`).
- **One `commentary` string, optionally with one attached article link.** There is
  no title field, no SEO metadata, no Open Graph/Twitter card, no category, no
  newsletter — a feed post is plain text plus, at most, a link preview.
- **Upload an image and attach it as the article link's thumbnail** — not as an
  inline image in the post body; LinkedIn feed posts have no inline images through
  this API.

## How to connect

Run `byline init`, choose **Add a new blog**, pick **LinkedIn**, then answer:

1. **Short name** — e.g. `linkedin`.
2. **Address** — your LinkedIn profile or company page URL. Shown in `list_sites`;
   the API always lives at `api.linkedin.com` regardless of what this is set to.
3. **LinkedIn access token** — from **developer.linkedin.com → your app → Auth →
   OAuth 2.0 tools → generate a token** with the scopes `openid`, `profile`,
   `w_member_social`. Tokens last about 60 days; regenerate and update this field
   when one expires. Posting as an **organisation** (a company page) additionally
   needs the `w_organization_social` scope, which LinkedIn only grants after a
   separate **Community Management API** approval — posting as yourself needs no
   such approval.
4. **Author URN** — who the post is from. You can leave the literal placeholder
   `urn:li:person:me`; Byline resolves it to your real person URN at request time.
   Once setup finishes, run `list_authors` against this site to see your real URN
   and any organisation you administer, and paste one of those in if you want to
   post as an organisation instead.

`api_version` (a `YYYYMM` LinkedIn API version) is an advanced, optional field not
asked by the wizard — set it directly in `config.yaml` if you need to pin a
specific version.

## What a publish produces

A LinkedIn feed post: `commentary` (plain text — every HTML tag in `html` is
stripped, `</p>` becomes a paragraph break, entities are decoded), with the
`canonical_url` appended once if it is not already present in the text, then
hashtags built from `tags` (each converted to `#PascalCase` — `"machine
learning"` becomes `#MachineLearning`). The 3000-character LinkedIn limit is
enforced before anything is sent (`COMMENTARY_TOO_LONG`, naming the count).

When `canonical_url` is set, the post also carries an attached article-link
preview: the URL, the article's title, its excerpt as the description, and —
when `feature_image_id` (from `upload_image`) is set — a thumbnail.

## How to paste — not applicable

There is nothing to paste. Unlike Medium, Substack, and LinkedIn Article,
`create_post` on a LinkedIn site publishes directly through the API the moment
it is called; there is no hand-off folder and no manual step.

## What is UNVERIFIED

**Every single request and response shape in this plugin**, until
`tests/integration/linkedin.integration.test.ts` has actually run against a real
token. That includes: whether `healthCheck`'s probe (`GET /v2/userinfo`) really
requires the credential; the exact shape of `createPost`'s body and LinkedIn's
201 response; whether the post's id genuinely arrives in an `x-restli-id` response
header; the two-step image upload (`initializeUpload` then `PUT`); the
read-back comparison; and `updatePost`'s partial-update shape. See the header
comment in `src/plugins/platforms/linkedin/index.ts` and this plugin's own
`README.md` for the same caveat in the code. Nothing here should be repeated to a
user as a confirmed fact.

## Troubleshooting

- **401/403 from any call** — the access token has likely expired (about 60 days)
  or never had the required scope. Regenerate it at developer.linkedin.com.
- **`author_urn` refused, or organisation posts fail** — posting as an
  organisation needs `w_organization_social`, granted only after LinkedIn's
  Community Management API approval — a separate, manual grant from the basic
  posting scopes. Post as yourself (a `urn:li:person:...` URN) if that approval
  is not in place.
- **`DRAFTS_UNSUPPORTED`** — LinkedIn feed posts publish immediately; pass
  `status: "published"`. There is no draft state to create through this API.
- **`UNRESOLVED_PLACEHOLDER`** — the `html` still contains the literal text
  `[[article_url]]`. Swap it for the article's real, published URL before
  calling `create_post` — Byline never does this substitution for you.
- **`COMMENTARY_TOO_LONG`** — shorten the post text or trim the hashtag list;
  both count toward LinkedIn's 3000-character limit.
- **`list_authors` shows only your person URN, with a warning** — the
  organisation lookup (any company page your token administers) is
  best-effort; a personal token with no organisation access is the ordinary
  case and warns nothing. When the lookup genuinely fails (an expired token,
  a missing scope), `list_authors`' result carries a `warnings` entry naming
  the endpoint and the HTTP status, e.g. `organisations: GET
  /rest/organizationAcls failed (403) — organisation URNs need Community
  Management API approval; person URN listed only.` — it no longer
  disappears silently.
