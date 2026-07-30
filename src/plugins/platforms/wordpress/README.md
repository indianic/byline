# WordPress plugin

## Credentials

Two fields, one click-path:

| Field | Secret? | Example | Where to get it |
|---|---|---|---|
| `username` | no | `editor` | The username you log in with — not the display name, and not the email unless that is your login. |
| `app_password` | yes | `xxxx xxxx xxxx xxxx xxxx xxxx` | WP Admin → **Users → Profile → Application Passwords** → enter a name → **Add**. Copy it with the spaces. This is **not** your login password. |

No plugin is required — WordPress core (5.6+) ships Application Passwords and the
REST API. `app_password` is a secret field: in `sites.yaml` it is written as
`${SOME_ENV_VAR}`, and the real value lives only in `.env`. `username` is not
secret and is written literally.

`api_url` is optional and derives to `{url}/wp-json` when omitted; set it
explicitly if the REST API is not at the site root.

## Quirks

The full, sourced list is `docs/WORDPRESS-NOTES.md`. Load-bearing ones:

- **Everything about styled HTML depends on the authenticated account's
  `unfiltered_html` capability**, read from `GET /wp/v2/users/me?context=edit`.
  Administrators and editors hold it on a single-site install; on a **multisite**
  network, only Super Admins do. This is why the HTML profile cannot be a
  constant the way Ghost's is — it is resolved per authenticated user, per site
  (`resolveWordPressProfile` in `html-profile.ts`), and a failed capability read
  fails toward the restrictive profile, never the permissive one.
- WordPress core has **no fields** for `meta_title`, `meta_description`,
  `canonical_url`, `og_*`, `twitter_*`, or `codeinjection_head` — these need an SEO
  plugin (Yoast, RankMath). `create_post`/`update_post` report every one of these
  as a warning naming the field, never silently dropping it, and `schema_injected`
  reports `false` for exactly this reason on a WordPress site.
- `featured_media` wants an **integer media attachment id**, not the URL that
  `feature_image` carries — `upload_image`'s `id` result (via
  `PostInput.feature_image_id`) is what supplies it.
- Media upload **requires** an explicit `Content-Type` header — omit it and
  WordPress returns a hard 400, not a soft failure.
- `GET /wp/v2/tags?search=` is a **substring** match, not an exact one — the
  adapter requires an exact, case-insensitive match before trusting a hit, or two
  similarly-named tags will collide.

## How this was verified — and what was not

**Covered:** an **administrator** account on a **single-site** (not multisite)
WordPress core install, holding `unfiltered_html: true`, probed live against
the probed WordPress install on 2026-07-29. Every "permissive" behaviour recorded in
`docs/WORDPRESS-NOTES.md` and in `html-profile.ts`'s `PERMISSIVE_*` constants —
inline styles and classes surviving, no element being unwrapped, a styled
blockquote passing through, hand-written heading ids surviving, `target="_blank"`
surviving — was confirmed by publishing a real post and reading it back through
`content.raw`, not by reading WordPress's documentation. The self-cleaning suite in
`tests/integration/wordpress.integration.test.ts` (`RUN_INTEGRATION=1`) re-runs the
full tag list against the live site on every run.

**UNVERIFIED, plainly:**

- The **restrictive** path — an account that genuinely lacks `unfiltered_html`
  (an Author/Contributor role, or any non-Super-Admin account on a multisite
  network) — was never exercised. No such account was available to probe. Every
  claim about that path (`RESTRICTIVE_*` in `html-profile.ts`, the restrictive
  branch of `buildProfile`) is reasoned from WordPress's documented KSES
  behaviour, not measured, and is marked UNVERIFIED in the code for that reason.
- **All multisite behaviour.** No multisite network was available to probe at
  all. The "only Super Admins hold `unfiltered_html` on multisite" claim is
  WordPress's own documented behaviour, not something this project measured.

Do not remove either UNVERIFIED marker on the strength of the single-site
administrator probe above — they require their own probe against an account that
actually exercises that path.
