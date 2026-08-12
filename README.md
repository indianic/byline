# Byline

**Say what you want to say. Byline writes it in your voice and publishes it where it
belongs.**

You have the idea. Byline turns it into a finished, credible piece — researched,
written as *you*, illustrated with real photographs — and puts it live. You talk to it
in plain English inside the AI tool you already use. There is no dashboard, no editor,
no config file to maintain.

> Built and open-sourced by **[IndiaNIC](https://www.indianic.com)** — the team that
> builds MCP servers and AI agents into other people's workflows for a living. This one
> we gave away.

```
Write a post about why our migration took nine months, as me, and publish it
to the company blog as a draft.
```

That is the whole interface.

Today it publishes to **Ghost** and **WordPress**. The architecture is
channel-agnostic on purpose: adding a destination is one folder and one line, so a
newsletter, a local paper's submission inbox, a social channel, or an email to your
team are all the same shape of problem. Every one of them has a byline.

**Many voices, many destinations.** Write as yourself on one blog and as your company
on another — each persona carries its own writing style, tone, sentence rhythm, and
the things it would never say. You pick both in the same sentence: *"as jordan, to
the personal blog"*. See [Author personas](#author-personas-optional).

- **[60-second quickstart](#60-second-quickstart)** — nothing to a published post
- **[Where to get each key](#where-to-get-each-key)** — click-paths, with the one trap
- **[Add Byline to any AI tool](#add-byline-to-any-ai-tool)** — including ones it cannot auto-detect
- **[Troubleshooting](#troubleshooting)** — real failures, real fixes

---

## What you need

- **Node 20 or newer.** Check with `node --version`. Anything older prints one clear
  line telling you so — not a stack trace.
- **A blog you can publish to** — Ghost or WordPress, either self-hosted or managed.
- **An AI tool** — Claude Code, Claude Desktop, Cursor, Windsurf, Gemini CLI, or Codex.

You do **not** need to know what MCP is, edit any JSON, or write any code.

---

## 60-second quickstart

**1. Point npm at the registry** — one line, once, in `~/.npmrc`:

```bash
echo '@indianic:registry=https://npm.indianic.in/' >> ~/.npmrc
```

That registry is **anonymously readable**. There is no login, no `npm adduser`, and no
auth token — people assume otherwise and go looking for credentials that do not exist.

**2. Install and run the setup wizard:**

```bash
npm install -g @indianic/byline
byline init
```

**3. Answer the questions.** It finds the AI tools already on your machine, then asks you
to give this blog a **short name** — `myblog`, `work`, whatever you like — followed by
its address and one key. It checks that key against your live blog before accepting it.
Every question can be skipped by pressing Enter on an empty line.

**4. Restart your AI tool**, then type the sentence `init` printed for you at the end:

```
Write a blog post about <your topic> and publish it to myblog as a draft.
```

`myblog` there is the short name you chose in step 3. Saying **draft** means nothing
goes live and no subscriber is emailed — start there.

That is the whole thing. Everything below is detail for when you want it.

---

## What is an MCP server?

If you have used Claude or Cursor, you have noticed they cannot touch anything outside
the chat. They can write you a blog post, but they cannot put it on your blog.

MCP is the standard that fixes that. An **MCP server** is a small program that runs on
your own machine and hands your AI tool a set of things it is allowed to do. byline
hands it fourteen: look up your blogs, check they are reachable, build a writing brief,
score a draft, generate and upload images, create and update posts, and — only if you
configure a key for it — fetch dated, citable research on a topic.

Two consequences worth knowing:

- **It runs locally.** Your AI tool starts it on your machine. Nothing about byline
  is a hosted service, and there is no account to create.
- **Your keys stay on your machine.** They are read from a file only you can read, and
  sent only to the blog and image APIs you configured. See
  [Where your secrets live](#where-your-secrets-live).

"Registering" byline with an AI tool just means adding a few lines to that tool's
config file so it knows the server exists. `byline init` does that for you, and
backs up the file first.

---

## Install

### The one-line registry config

`@indianic/byline` is published to a private-namespace registry, so npm needs to be
told where the `@indianic` scope lives:

```bash
echo '@indianic:registry=https://npm.indianic.in/' >> ~/.npmrc
```

**No authentication is required.** The registry is readable anonymously. If you find
yourself hunting for a token or an `npm login`, stop — you do not need one.

### Install it

```bash
npm install -g @indianic/byline
```

Or skip the install entirely and let `npx` fetch it on demand:

```bash
npx -y @indianic/byline init
```

Both give you the `byline` command.

## Add Byline to any AI tool

`byline init` detects and configures **Claude Code, Cursor, Windsurf, Gemini CLI and
Codex** automatically. Any other MCP-capable tool — Antigravity, Claude Desktop, Zed,
Continue, JetBrains AI, or something released next month — takes one manual step,
because Byline will not write to a config file it has not verified exists.

Open that tool's MCP settings and add one server. Almost every tool uses this shape:

```jsonc
{
  "mcpServers": {
    "byline": {
      "command": "npx",
      "args": ["-y", "@indianic/byline"]
    }
  }
}
```

A few tools use TOML instead (Codex is one):

```toml
[mcp_servers.byline]
command = "npx"
args = ["-y", "@indianic/byline"]
```

Three things worth knowing:

- **`npx` keeps you current.** It resolves the latest published version each time. If
  you would rather pin it, install globally and use the absolute path from
  `which byline` — but note that path is tied to your Node version and breaks when you
  switch with `nvm`.
- **Restart the tool afterwards.** MCP configs are read once, at startup.
- **Confirm it worked** with `byline status`, which reports every tool it can see and
  which scope each registration is in.

To do the same thing from the command line for a tool Byline *does* know:

```bash
byline register --tools claude,cursor        # specific tools
byline register --tools all                  # every tool found on this machine
byline register                              # just print the command, change nothing
```

### Installing from source

You do not need this to use Byline — it is here for contributors and for anyone who
wants to pin an exact build.

```bash
git clone https://github.com/indianic/byline.git && cd byline
npm install && npm run build
npm pack                                   # produces indianic-byline-1.0.0.tgz
npm install -g ./indianic-byline-1.0.0.tgz
```

Then register with the absolute path rather than the `npx` form:

```bash
claude mcp add byline -- "$(which byline)"
```

Note that path is tied to your current Node version — if you switch Node versions with
`nvm`, re-run `byline register --tools all`.

### Staying up to date

Byline checks the registry at most once a day and tells you, after a command finishes,
when a newer version exists:

```
●  A newer version is available: 1.0.0 → 1.1.0. Run `byline update` to upgrade.
```

`byline update` re-installs using whichever package manager put it there — npm, pnpm or
yarn, detected rather than assumed. If you use the `npx` form, you are always on the
latest and nothing is needed.

Silence it with `BYLINE_NO_UPDATE_CHECK=1`. It is skipped automatically in CI, and it
never runs while Byline is serving your AI tool.

---

## `byline init`

One command sets everything up. Here is a real run, start to finish.

> Home directory paths and the blog hostname below are substituted for examples —
> everything else is verbatim output.

### It finds the AI tools you already have

```
┌  byline — first-run setup
│
◆  Register byline with which AI tools? (space to toggle, enter to confirm)
│  ◼ Claude Code
│  ◼ Cursor
└
```

Only tools whose config files actually exist on your machine are offered, and all of
them start ticked. It never creates a config for a tool you do not have.

```
◆  Config scope
│  ● Global — available in every project (recommended)
│  ○ This project only — writes into the current folder
```

### It backs up before it writes

```
◆  AI tool config
│  Claude Code: updated /Users/you/.claude.json
│    backup: /Users/you/.claude.json.byline-bak
│  Cursor: updated /Users/you/.cursor/mcp.json
│    backup: /Users/you/.cursor/mcp.json.byline-bak
```

Your existing MCP servers and settings are left alone — the file is merged, not
replaced.

### It asks for your blog

```
◆  Which kind of blog?
│  ● Ghost
│  ○ WordPress

◇  Short name for this blog, used when you say "publish to …" (Enter nothing to skip)
│  myblog

◆  Your blog address (Enter nothing to skip)
│  https://blog.example.com
```

The short name is what you will say to your AI tool — *"publish it to myblog"*. Use
lowercase letters, digits, and hyphens.

### It tells you exactly which key to get

```
●  Admin API key — Ghost Admin → Settings → Integrations → Add custom integration.
   Copy the ADMIN API key, not the Content API key — they are not interchangeable.
   (looks like: id:secret)
│
◆  Admin API key (Enter nothing to skip)
│  _
```

Your typing is masked. **Every prompt can be skipped** by pressing Enter on an empty
line — you can set up the rest now and come back.

### It checks the key against your real blog before accepting it

This is the part worth trusting. Enter a wrong key and you find out immediately, from
your blog, in its own words:

```
◇  Admin API key (Enter nothing to skip)
│  ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪
│
◇  Could not connect to https://blog.example.com
■  Ghost rejected these credentials (HTTP 401):
│  Unknown Admin API Key
│
◆  What now?
│  ● Try again (re-enter the credentials)
│  ○ Skip this site
```

And a key that works says so:

```
◇  Connected to https://blog.example.com — Example Blog (Ghost 6.44.1)
```

A key that has not been proven to work is never written to your config. This check is
made against an endpoint that genuinely requires the credential — not one that answers
anybody — which is a distinction this project learned the hard way.

### It tells you where everything went

```
◆  blog "myblog"
│  config    /Users/you/.byline/config.yaml
│  secret    /Users/you/.byline/.env   (MYBLOG_ADMIN_API_KEY)

◆  author profile
│  /Users/you/.byline/personas/_template.yaml   — copy it to <your-name>.yaml and
│  fill it in to shape how drafts sound

◆  everything written
│  /Users/you/.byline/config.yaml
│  /Users/you/.byline/.env
│  /Users/you/.byline/personas/_template.yaml

◆  what to say in your AI tool
│  Write a blog post about <your topic> and publish it to myblog as a draft.
│
└  Done. Restart your AI tools so they load byline, then paste the line above.
```

**Restart your AI tool.** It reads its MCP config at startup, so byline will not
appear until you do.

---

## Where to get each key

### Ghost — the Admin API key

**Ghost Admin → Settings → Integrations → Add custom integration**, give it any name,
then copy the **Admin API Key**.

> **The trap, and it catches almost everyone.** That screen shows you *two* keys. The
> **Content API key** is a single string and is **read-only** — it cannot publish, and
> byline will reject it. The **Admin API key** is two parts joined by a colon:
>
> ```
> 6612abcd1234ef567890abcd:9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a09
> ```
>
> If yours has no colon in it, you have copied the wrong one.

The integration is what has permission, not you — so you can revoke it from that same
screen at any time without touching your own account.

### WordPress — an Application Password

**WP Admin → Users → Profile → Application Passwords**, enter any name, click **Add New
Application Password**.

- This is **built into WordPress core** since 5.6. You do **not** need a plugin.
- The password is displayed in space-separated groups, like
  `abcd EFGH ijkl MNOP qrst UVWX`. **Copy it with the spaces.** byline sends it
  exactly as you paste it; reformatting is a silent way to break a paste that worked.
- It is shown **once**. If you lose it, revoke it and make a new one.
- You will also be asked for your WordPress **username** — the login name, not your
  display name and not your email.

### Google Gemini — for images (optional)

**Google AI Studio → Get API key → Create API key** (<https://aistudio.google.com/apikey>).
The free tier is enough to start.

### xAI / Grok — the image fallback (optional)

**console.x.ai → API Keys → Create API key.** Only used when Gemini fails.

Skip both and everything still works — you just get posts without generated hero
images.

---

## Research (optional — you probably do not need this)

**Byline works without a research key, and most people should leave it that way.** If the
agent you are talking to already has web access, use it: search however you like, paste
what you find as `research` (at least 200 characters), and news mode is satisfied.
Evergreen posts (`mode: "blog"`) need no research at all, and `byline init` never requires
a research key to finish.

A research provider buys two things that path cannot give you:

- **Recency you can check.** A finding carries a `publishedAt` where the provider gives one
  — it can be absent, which is exactly what `RESEARCH_UNDATED` catches — and news mode
  refuses a set where nothing is recent enough, rather than trusting whatever the model
  recalls.
- **Checkable provenance.** Every finding arrives with its URL and, where the provider
  gives one, its publication date — so `score_draft` can afterwards tell you which of the
  URLs your draft links were actually in that research.

### What Byline checks, and what it simply trusts

This distinction is the whole point of the feature, so it is worth being exact about.

**Provider `findings` are checked.** Byline refuses a result with no findings in it at
all, in any mode. In **news mode only**, it additionally requires at least one finding
carrying a readable publication date inside the window the result declares — allowing six
hours' grace, because providers round timestamps to the hour and a publisher's date is
often the article's rather than its last update. If nothing is dated you are told so; if
everything dated is older than the window, you are told the newest date it found.
Individual findings that are undated or out of window are **accepted, not rejected one by
one**: an article legitimately cites background alongside its breaking sources. Each is
marked as such next to its own entry on the brief, and counted in a warning.
**Blog mode applies no recency check at all.**

**A `research` string you paste is trusted, not verified.** In news mode it is checked for
one thing — substance, currently 200 characters — and nothing else. Byline did not fetch
it, **cannot confirm it is recent, and cannot confirm the text matches any source it
names.** The brief says so on its face — the research block is headed `ORIGIN: supplied by
the caller — TRUSTED, NOT VERIFIED BY BYLINE` — so the writer treats every figure in it as
your claim rather than a measured fact. That is not a criticism of the path; it is the
honest description of it.

**`score_draft`'s `citation_provenance` check is advisory.** Pass the research `findings`
to it and it compares the absolute `http(s)` URLs in your draft's `<a href>` links against
the findings' URLs, then reports which cited URLs were not in the research and which
research sources went uncited. It never blocks — a writer legitimately links a homepage or
a definition no search returned. Pass no findings and it reports **"not evaluated"** rather
than passing, because a silent pass would read as "the citations were verified" when
nothing was. And note what it does *not* do: it checks where a URL came from, never
whether the page at that URL says what your article claims it says.

### One article, one origin

Pass `research` **or** `findings`, never both. Supplying both is refused, naming which to
drop. Merging them would make provenance unanswerable — you could not tell which claim
came from where, so nothing could be cross-checked and a later correction could not be
traced to a source.

### Brave or Tavily — pick one, there is no fallback

They do not return the same kind of thing:

| | Returns | Use when |
|---|---|---|
| **Tavily** | A synthesized answer plus dated sources | You want orientation as well as sources |
| **Brave** | Ranked results with snippets, no synthesis | You want the raw result list |

Byline **never** substitutes one for the other. Naming a provider whose key is missing is
refused, not redirected, and a failed search is reported rather than retried against the
other one. An automatic fallback would silently change what the writer receives —
sometimes a summary, sometimes a list.

```bash
byline init          # offers both; configure either or both, or neither
```

```
BRAVE_API_KEY=BSA…
TAVILY_API_KEY=tvly-…
BYLINE_RESEARCH_PROVIDER=tavily   # optional: the default when both are configured
```

With both configured and no default pinned, registry order decides — and that order was
set by measuring which provider dates a minutes-old event more reliably. On one live query
inside one two-minute window, Brave's freshest result was ~55 minutes old and Tavily's
freshest on-topic dated result was ~4h39m, so **Brave is registered first**. That is a
measurement, not a preference; Tavily's snippets are richer and its synthesis is a
capability Brave lacks. The full table is in
**[docs/RESEARCH-NOTES.md](docs/RESEARCH-NOTES.md)**.

**Where to get each key**

- **Brave** — `brave.com/search/api` → subscribe to the free *Data for Search* plan → API
  Keys → Add API key (<https://api-dashboard.search.brave.com/app/keys>).
- **Tavily** — `tavily.com` → sign up → API Keys (<https://app.tavily.com>). The free tier
  gives 1,000 credits a month and needs no card.

Neither key is a failure to be missing. `byline doctor` reports an unconfigured research
provider as a note, not an error.

### What it looks like in practice

```
Write about last night's match for personal.
```

The agent decides whether the topic turns on recent events, calls `research_topic`, passes
the whole result to `build_writing_brief` as `findings`, and passes the findings again to
`score_draft` so citations can be traced. Both tool descriptions **tell it to ask you**
rather than guess when it is unclear whether you mean the live event or the history —
that is an instruction to the agent, which is as far as an MCP server's reach goes.

---

## Your own photos (optional)

Point Byline at a folder of your own images and it will search them, upload the ones you
pick, and **keep a record of which photograph went into which post so the same one is not
published twice.** Nothing is generated, nothing is uploaded to a third party, and Byline
**never writes inside your library folder** — the index and the usage record live under
`~/.byline/media/`.

### Adding a library

```
byline media add ~/Pictures/blog
```

This adds the folder to `config.yaml`, derives a library name from the folder's own name
(override with `--name`), and scans it immediately — one command, and the library is
searchable right away. `byline media` also has `list`, `scan`, `status`, `release`, and
`remove`; every flag is documented in [`docs/CLI.md`](docs/CLI.md#byline-media).

**Restart your AI tool afterward.** `loadContext()` reads `config.yaml` once, at MCP
server startup — a library added from a terminal is invisible to an already-running
server until you restart the AI tool talking to it.

### Configuring a library by hand

`byline media add` writes the same `media:` block shown below, so editing it directly is
still a supported path — for a field the command does not expose (`index_path`,
`reuse_scope`), or if you would rather edit YAML than run a command:

```yaml
media:
  default_library: shots          # optional; the library used when none is named
  reuse_scope: site               # "site" (default) or "global" — see below
  libraries:
    - name: shots                 # lowercase letters, digits and hyphens
      path: ~/Pictures/blog       # the folder of your own images
      recursive: true             # walk sub-folders too; default true
    - name: archive
      path: /Volumes/Photos/2019
      index_path: ~/byline-index  # optional; where the index and usage record go
```

| Field | What it does |
|---|---|
| `name` | How you refer to the library. Same rules as a site slug: lowercase letters, digits, hyphens. |
| `path` | The folder to index. `~` is expanded. Must exist and be a directory, or the library is reported as unavailable and the others keep working. |
| `recursive` | Walk sub-folders. Defaults to `true`. |
| `index_path` | Where the derived index and the usage record are written. Defaults to `~/.byline/media/`. Set it with `byline media add --index-path <folder>`. It may **not** be inside the library folder — that is refused both when it is written and when it is read, so Byline never writes into your photos. |
| `default_library` | Which library is used when a tool call does not name one. With exactly one library you never need it. |
| `reuse_scope` | `site` (default) — a photo used on one blog is still free for another. `global` — used once, ever, anywhere. |

`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` and `.avif` are indexed as images; `.mp4`,
`.m4v`, `.mov` and `.webm` as video. Dotfiles are skipped. Anything else is ignored — an
allow-list, so sidecars, RAW files and half-finished exports never fill your search
results.

### The three tools

- **`list_media_libraries`** — what is configured, how many assets each library holds, and
  when it was last scanned. Pass `scan: true` to walk the folder and build the index; **that
  is how a new or changed library becomes searchable from inside your AI tool**.
  `byline media scan` does the same thing from a terminal, and `byline media add` scans the
  folder it has just added.
- **`find_media`** — search by keyword and get ranked candidates back, each with a `why`
  naming the tokens that matched, so you can judge the match rather than trust a score.
  Already-used assets are excluded by default.
- **`use_media`** — upload the assets you picked to a site and record them as used. It
  returns a hosted URL per asset, ready for `feature_image` or an inline `<img>`.

In practice you never name them:

```
Find a photo of the harbour in my library and use it as the hero for that post.
```

### What "already used" means, exactly

A photograph is **used** from the moment its bytes reach your blog — not from the moment a
post goes live. `use_media` records a *reservation*; publishing a post that carries the
hosted URL turns it into a *published* record naming the post. Both count as used, because
a reservation means the image is already sitting in your media library on the platform.

`use_media` **refuses** an asset the record says has been used, names where it went, and
carries on with the rest of the batch. Pass `allow_reuse: true` when publishing the same
photograph twice is what you actually want.

Under the default `reuse_scope: site`, "used" means used *on that site* — the same photo is
still free for a different blog. Set `reuse_scope: global` if a photo should be published
once and never again anywhere.

### What this release does not do

Stated plainly, because a promise is worse than a missing feature:

- **No enrichment.** Nothing writes captions or keywords, so ranking is based on what your
  files and folders are *named*. `beach-sunset-goa.jpg` inside `2024/holiday/` searches
  well; `IMG_4821.jpg` inside `Camera Roll/` does not.
- **No video upload.** Videos are indexed and searchable so you can see what you have, and
  `use_media` refuses to upload one — the upload path handles images only.
- **No way to cancel a reservation from an MCP tool.** If `use_media` succeeds and the post
  then fails to publish, that asset stays reserved — no tool clears one. From a terminal,
  `byline media release <id>` does (see [`docs/CLI.md`](docs/CLI.md#byline-media));
  without terminal access, `list_media_libraries` still reports the count and names the
  ledger file to edit by hand.

The usage record is **not recoverable** if you delete it, which is why it is kept in a
separate file from the index (`<name>.usage.json` beside `<name>.index.json`) — a rescan
rewrites the index and never touches it.

---

## Video (optional)

Byline does not upload video — that was dropped as a goal entirely. Instead, `embed_video`
turns a YouTube, Vimeo, or Bunny Stream URL into the `<iframe>` HTML for an article:

```
Embed https://youtu.be/dQw4w9WgXcQ in the post, captioned "Watch the full talk".
```

It normalises whatever form you paste — a `watch?v=` link does not work inside an
`<iframe>`; `/embed/ID` does — and refuses anything that is not one of the three
supported providers rather than passing an unrecognised URL through as-is:

| Provider | Accepted forms |
|---|---|
| YouTube | `youtube.com/watch?v=ID`, `youtu.be/ID`, `youtube.com/shorts/ID`, `youtube.com/embed/ID` (with or without `www.`/`m.`; a `t=`/`start=` value is preserved) |
| Vimeo | `vimeo.com/ID`, `vimeo.com/channels/NAME/ID`, `player.vimeo.com/video/ID` |
| Bunny Stream | `iframe.mediadelivery.net/embed/LIBRARY/GUID` or `/play/LIBRARY/GUID` |

Verified by live probe on 2026-08-12: both Ghost and WordPress (for an account holding the
`unfiltered_html` capability) keep the `<iframe>` and its `<figure>`/`<figcaption>` wrapper
unchanged on ingest — Ghost additionally wraps it in its own `kg-embed-card` figure. A
plain `<video>` tag is a separate, worse option: **Ghost strips it completely**, with
nothing surviving; WordPress keeps it, for the same account.

**For a WordPress account WITHOUT `unfiltered_html`, whether the `<iframe>` survives is
UNVERIFIED** — WordPress's KSES filter is documented to strip `<iframe>` for such an
account, but no probe has confirmed it, because no such account has ever been available.
Pass `site` naming the WordPress site and `embed_video` adds that caveat to its
`warnings`; it does not change the HTML produced.

---

## Using it

Talk to your AI tool in plain English. It figures out which tool to call.

> Write a blog post about why microservices fail for small teams and publish it to
> myblog as a draft.

> Draft an article on AI agents in fintech for myblog, as jordan.

> Take the same topic and write a shorter version for the company blog, in the
> company voice.

> Check my blogs are working.

**Name the voice and the destination in the same sentence.** *"as jordan, to the personal blog"* picks a persona and a site together. Different personas produce
genuinely different articles from the same topic — different structure, different
sentence rhythm, different opinions — because each one carries its own writing style,
tone, risk tolerance, and the things that person would never say.

**Say "draft" and you get a draft.** Nothing goes live, and no subscriber is emailed,
unless you ask for a published post. Start there.

**Ask it to check first.** *"Check my blogs are working"* runs `health_check` against
every configured site and tells you which ones authenticate.

**News articles always need real research.** If you ask for a piece about recent events,
the brief tool refuses to proceed on the model's training data alone — you have to give
it actual research, either as your own notes or from a research provider. Evergreen posts
have no such requirement, and neither path needs a key you do not already have. See
[Research](#research-optional--you-probably-do-not-need-this).

### Author personas (optional)

A persona is what makes an article sound like a person instead of a content mill. Byline
writes **in first person as that author**, and carries roughly fifteen traits into every
draft: writing style, tone, communication style, storytelling approach, sentence
structure, focus areas, research methodology, personality traits, bias tendency, how much
risk they take in an opinion, cultural context, and their own free-text instructions.

**`byline init` asks for it directly** — five questions (name, role, writing style and
tone, years of experience, subject expertise), each skippable. Answering them writes a
real, working persona; skipping goes straight to a template you fill in by hand. Either
way, `init` prints the exact file path so you always know where to look. Add as many as
you like — copy `~/.byline/personas/_template.yaml` to `your-name.yaml` and fill it in;
the filename must match the `slug` field inside:

```
~/.byline/personas/
  jordan-reyes.yaml     # you, on your own blog
  company-editorial.yaml  # the house voice, on the company blog
```

Then choose per article: *"write this as company-editorial and publish to the company
blog."* You never edit a config file to switch — you say which one.

The one field worth spending time on is `persona_specific_instructions_for_ai`. It goes
into the brief verbatim, so it is where a real constraint belongs:

```yaml
persona_specific_instructions_for_ai: |
  Ground every claim in delivery experience. Name the real trade-off, not the
  marketing version. Never write a paragraph that could apply to any company.
```

#### The persona shapes the writing — it does not get announced in it

A persona pasted into a prompt has a signature: every article opens by introducing the
same person the same way. *"As a CEO with 25 years in enterprise delivery…"* Once, that
reads as authority. Every week, it reads as a template.

So how much of you reaches the page is **drawn fresh per article**, like the hook and the
structure already were. Across articles: **20%** state your credential outright — once,
early, and never again — **20%** bury it in a subordinate clause of a sentence about
something else, and **60% never state your role or your years at all.** Those carry
authority the way a regular columnist does: through a detail only somebody who has done
the work would know, through the scale of the decisions described, through simply
assuming the reader knows who is talking.

None of that weakens the byline. Generative engines weight unrepeatable first-hand
specificity far above a stated job title — every competing article already has the job
title. Your profile still governs tone, judgement, and subject matter on every single
piece; what varies is how much of it is said out loud.

Alongside it, each article draws a prose texture — uneven rhythm, conceding the strongest
counter-argument before answering it, visibly changing your mind mid-piece, refusing
abstraction, writing sentences you could say aloud. Every article also carries a fixed
standard aimed at what actually gives machine-written prose away: paragraphs of uniform
length, relentlessly parallel lists, and an argument that never once commits to
anything — plus a long list of words and constructions to avoid outright.

> It will not fake being human by breaking things. Introducing typos, padding for rhythm,
> or inventing a statistic, a client, a date, or a prior article you never wrote are all
> forbidden explicitly. An invented specific is the one mistake here you cannot take back
> after publishing.

**Byline doesn't have your keys or your voice until you give them.** `init` collects
credentials interactively and validates each one against the live platform before
accepting it. You can skip every prompt and fill things in later — everything lives in
two files it will tell you the path of, and `byline status` prints them any time.

---

## How it works

When you ask for a post, your AI tool does the thinking and byline does everything
that touches the outside world:

1. **`build_writing_brief`** produces a brief tailored to the target platform — because
   what survives publication differs between platforms, and the brief says so up front
   rather than letting the writer discover it afterwards.
2. **Your AI tool writes the draft.** That part is not byline's job.
3. **`score_draft`** grades it — sentence-length variety, AI tells, whether claims carry
   evidence, whether the HTML will survive this platform's ingest.
4. **`generate_image`** and **`upload_image`** create hero and inline images and put
   them in your blog's own media library. Gemini first, Grok as fallback; when it falls
   back it tells you it did and why.

   **Images are on by default whenever an image key is configured** — you do not have
   to ask for them. Say nothing about images and you still get a hero and an inline
   photograph; say "no images" or "just the hero" or hand it your own image
   instructions and that's what happens instead. Your instruction always wins over the
   default. If no image key is set up, no image is attempted and none is expected.

   Images are **photographs, not AI art**, and the rules are fixed rather than improvised
   per article: every prompt names the article's actual subject, in a real setting, with no
   text anywhere in the frame and no glowing-circuitry abstraction. The **hero image always
   contains people** doing the work the article is about, since it is what appears on the
   post card and every social share.

   **Four independent axes decide how it is shot**, so a blog's images do not read as one
   template:

   | axis | varies across |
   |---|---|
   | **Light and camera** | window light, hard midday sun, after dark by screen glow, warm tungsten, cool office fluorescent, blue hour, high-key bright — plus macro close-ups, overhead aerials and low-angle handheld frames |
   | **Scene** | open-plan floors, glass meeting rooms, private cabins, neighbourhood cafes, building forecourts, lunch tables, stairwells, rooftops, canteens, home workspaces |
   | **City** | Bengaluru, Singapore, Berlin, São Paulo, Nairobi, Tokyo, Dubai, Toronto, Amsterdam, Mexico City, Warsaw, Ho Chi Minh City |
   | **Moment** | mid-laugh, mid-argument, deep concentration, relief when something finally works, the tail end of a long day, coffee and thinking |

   The axes move **independently** — 400 sample subjects reach 128 of the 144 possible
   city-and-scene pairs, and effectively every combination is distinct. Naming a real city
   is also what carries who is in the frame: asking a model for "diverse people" in the
   abstract produces a stock-library composite, while naming Nairobi or Ho Chi Minh City
   produces architecture, clothing, light and faces that genuinely belong together.

   Roughly **one image in twelve is an editorial illustration** instead — hand-drawn ink
   line with flat washes and a limited palette, the kind a newspaper opinion page runs.
   Both images in a single article always share one city and one medium, so they read as
   a set rather than two unrelated stock pictures.

   Image models sometimes refuse a prompt asking for people. If **every** provider refuses,
   byline retries once without people and tells you it did, naming the providers' own
   reason — you never get a silently peopleless image. A provider that *broke* rather than
   refused is reported as the failure it is, not quietly worked around.
5. **`create_post`** publishes — now, as a draft, or at a time you choose. Then it
   **reads the response back** and compares it to what was sent, and reports any field
   the platform quietly dropped.

That last point is the design rule everywhere in this project: **nothing fails
silently.** Every tool returns a result or an error naming the API and its HTTP status.

### Scheduling

> Write this up and publish it at 10 AM tomorrow.

Say a time and byline publishes then, on either platform.

**The time you say is the time on the blog.** Not your laptop's timezone, not the
server's, not UTC — the blog's own. "10 AM tomorrow" means 10 AM as that blog's
readers experience it, and byline looks the blog's timezone up from the platform
itself rather than guessing. Send the identical instruction to two blogs in two
countries and they publish at two different instants, on purpose:

| blog | its timezone | you say | it publishes at |
|---|---|---|---|
| a Ghost blog set to `Asia/Kolkata` | IST | `2026-08-04T10:00` | `04:30Z` |
| a WordPress blog set to UTC | UTC | `2026-08-04T10:00` | `10:00Z` |

You can still pin an exact instant by writing the offset yourself —
`2026-08-04T10:00:00+05:30` or `...Z` — and byline takes that at face value without
consulting the blog. Only do that if you actually meant a specific timezone.

Under the hood that is `status: "scheduled"` plus `publish_at`, which becomes Ghost's
`scheduled` / `published_at` or WordPress's `future` / `date_gmt`. `update_post`
schedules a draft you already have, and unschedules one. A **past** time with
`status: "published"` backdates a post instead. The result reports
`publish_at_local` — the time as the blog's clock reads it — alongside the UTC instant
the platform actually stored.

Three things byline refuses rather than guessing at:

- **A time under two minutes away.** WordPress does not reject a scheduled post whose
  date is too close. It publishes it immediately, returns `201`, and reports no error
  at all. Measured 2026-08-03: 45 seconds of lead went live, 60 seconds scheduled.
  After writing, byline re-reads the post and fails loudly if the platform published it
  anyway — naming the post, its live URL, and the platform's own clock. It does **not**
  unpublish it for you; that is your call, not a tool's.
- **A future time with `status: "published"`.** The identical request publishes
  immediately on Ghost and schedules on WordPress. One input cannot be allowed to mean
  two opposite things, so byline asks you to say `"scheduled"` if that is what you meant.
- **A local time that does not exist.** On a blog whose timezone observes daylight
  saving, the clocks skip an hour each spring. Asking for a time inside that hour is
  refused rather than quietly moved.

If the blog does not report a timezone at all, byline says so and asks for an explicit
offset — it never falls back to UTC, because that would publish five and a half hours
early for an Indian blog while reporting success.

### The platforms really do differ

Measured on 2026-07-29 by publishing the same HTML to both:

| | Ghost | WordPress (account with `unfiltered_html`) |
|---|---|---|
| Styled `<table>` | survives | survives |
| Styled `<div>` | **unwrapped** — text survives, all styling lost | survives, styles intact |
| `target="_blank"` | **stripped** | survives |
| Hand-written heading `id` | **overwritten** — Ghost generates its own | kept |
| JSON-LD into `<head>` | supported | **not supported by core** — reported as a warning, not silently dropped |

This is why the brief is platform-aware. On Ghost, a `<div>` summary card publishes as
unstyled text, so the brief asks for a `<table>` instead.

> **A limit worth stating.** The WordPress column was measured on a **single-site
> administrator account**, which always holds the `unfiltered_html` capability. Accounts
> *without* it (Author, Contributor, or an ordinary Editor on a multisite network) are
> expected to have some of that markup filtered — but that path has **never been
> measured**, only reasoned from WordPress's documented behaviour. Treat it as
> unverified. See `docs/WORDPRESS-NOTES.md`.

### What each article ships with

Summary block above the first heading; headings phrased as questions a reader would
actually type, answered in the first 40–60 words; a closing FAQ; statistics attributed
inline with a source and date; Article and FAQPage JSON-LD; and full metadata —
excerpt, meta title and description, Open Graph and X card titles, descriptions, and
images.

---

## Checking on things

```bash
byline status    # what is configured, and where every file lives
byline doctor    # probe every blog, image and research provider; print a fix per failure
```

`doctor` on a healthy install:

```
┌  byline — doctor (v1.1.0)
│
◆  environment
◇  Node v22.23.1
│
◆  secrets
◇  /Users/you/.byline/.env is owner-only (or absent)
│
◆  blogs
◇  myblog (ghost) — Example Blog (Ghost 6.44.1)
│
◆  image generation
◇  gemini — gemini-2.5-flash-image reachable
│
◆  research
◇  brave — Brave Search reachable, key accepted
│
◆  AI tools
◇  Claude Code   /Users/you/.claude.json [global]
◇  Cursor        /Users/you/.cursor/mcp.json [global]
■  Gemini CLI    not registered
■  Windsurf      not registered
■  Codex         not registered
│
└  All checks passed.
```

Every failure names its own fix. Full command reference: **[docs/CLI.md](docs/CLI.md)**.

---

## Troubleshooting

Every row here is a failure that actually happened during this project's development,
with the fix that actually resolved it.

| Symptom | Cause | Fix |
|---|---|---|
| Ghost: `401 Unknown Admin API Key` on a key that looks right | You pasted the **Content API key**. It has no colon in it. | Get the **Admin API key** — `id:secret` — from Settings → Integrations. |
| Ghost: `Admin key secret is not hexadecimal` | Same cause, caught before any network call: the half after the colon must be hex. | As above. |
| Ghost: `404` on an otherwise-valid key | The Admin API is served on a different host or path than the public site. | Set `api_url` for that site in `~/.byline/config.yaml`. |
| Ghost: post publishes but the body is **empty** | Ghost expects Lexical JSON unless told the body is HTML. | byline always sends `?source=html`. If you see this, something else is posting — this is the single most consequential parameter against Ghost, and its absence does not error. |
| Ghost: a styled `<div>` card renders as plain text | Ghost **unwraps** `div section aside span small pre mark` on ingest. The text survives; the styling does not. | Use a `<table>` — the only container that survives Ghost's ingest with styling intact. |
| Ghost: image upload `415 Please select a valid image` | The upload carried no MIME type. | Handled automatically. If you hit it, the filename has an extension byline does not map. |
| Ghost: `target="_blank"` disappears | Ghost strips it on ingest. `rel="noopener noreferrer"` does survive. | Nothing to fix — do not ask for `target`. |
| WordPress: `400 rest_upload_no_content_type` | The media upload sent no `Content-Type`. WordPress does not guess. | Handled automatically; same cause as the Ghost 415 above. |
| WordPress: `schema_injected: false` | WordPress core has **no field for injecting into `<head>`**. | Not a failure — an honest warning. The JSON-LD was not silently dropped; you were told. Use an SEO plugin's own fields if you need it. |
| WordPress: the wrong tag gets applied | WordPress's tag search is a **substring** match — searching `AI` also returns `AI Ethics`. | Handled: byline requires an exact, case-insensitive match before reusing a tag, and creates a new one otherwise. |
| WordPress: styles stripped even though it worked before | Your account may lack `unfiltered_html` — role-dependent, and on multisite only Super Admins hold it. | Publish from an account that holds it. **Note: this path is unverified — see above.** |
| `RESEARCH_PROVIDER_UNCONFIGURED` on a provider you named | That provider's key is unset. Byline will not quietly use the other one — they return different shapes. | Set that key, or name the one you did configure, or drop the research provider and paste your own notes as `research`. |
| `RESEARCH_CONFLICT` — both `research` and `findings` | An article has exactly one research origin. | Drop whichever you did not mean. The error names both. |
| `RESEARCH_STALE` or `RESEARCH_UNDATED` in news mode | Not one provider finding carries a readable date inside the window asked for — often the event is not indexed yet. | Widen the window, try the other provider, or write it as `mode: "blog"`. |
| `doctor` says "not registered" but it clearly works | The registration is **project-scoped**, not global. | Not a problem. `status` and `doctor` now report which scope they found. |
| `npx -y @indianic/byline` → `E404` | npm has not been told where the `@indianic` scope lives. | Add the one `.npmrc` line from [Install](#install). No login is needed. |
| The AI tool does not see byline | Its MCP config is read at startup. | Restart the tool. Then `byline status` to confirm it is registered. |
| `byline` in a terminal just prints help | Intended. Over a pipe it starts the MCP server; in a terminal it shows help rather than hanging. | Nothing to fix. |
| `byline requires Node >= 20` | Your shell's `node` is older. | `nvm use 20` (or newer) and re-run. |
| An unexpected error with no detail | The stack trace is suppressed by default — it is noise for someone who just wants their setup fixed. | Re-run with `BYLINE_DEBUG=1` for the full trace. |

---

## Where your secrets live

Two files, in `~/.byline/`:

**`.env`** — every secret, and nothing else. Created **mode 600**: readable and writable
by your user only.

```
MYBLOG_ADMIN_API_KEY=<your key>
```

**`config.yaml`** — everything else. Secrets appear only as `${VARIABLE}` references,
never as values:

```yaml
sites:
  myblog:
    platform: ghost
    url: https://blog.example.com
    admin_api_key: ${MYBLOG_ADMIN_API_KEY}
default_site: myblog
```

That split is deliberate: `config.yaml` can be shared, committed, or pasted into a bug
report without leaking anything. `doctor` checks that `.env` is still owner-only and
tells you if it is not.

**Nothing leaves your machine** except the requests byline makes to the APIs you
configured — your blog, and your image provider if you set one up. There is no
telemetry, no hosted component, and no account. Your keys are read from `.env` at
startup and sent only in the `Authorization` header of requests to your own blog.

To see exactly where everything resolved from, run `byline status`. To remove it
all, `byline reset --yes`.

---

## Documentation

| | |
|---|---|
| **[docs/CLI.md](docs/CLI.md)** | Every command, flag, and environment variable |
| **[CONTEXT.md](CONTEXT.md)** | Architecture, for contributors and agents |
| **[CONTRIBUTING.md](CONTRIBUTING.md)** | How to work on this |
| **[docs/GHOST-NOTES.md](docs/GHOST-NOTES.md)** | Verified Ghost behaviour, and why each one matters |
| **[docs/WORDPRESS-NOTES.md](docs/WORDPRESS-NOTES.md)** | The same for WordPress, with the unverified parts marked |
| **[docs/RESEARCH-NOTES.md](docs/RESEARCH-NOTES.md)** | Measured Brave and Tavily behaviour, and the recency table that set the registry order |
| **[docs/ADDING-A-PLATFORM.md](docs/ADDING-A-PLATFORM.md)** | Adding a third platform, written from actually doing it |
| **[CLAUDE.md](CLAUDE.md)** | The rules for changing this repository, and what each one cost |
| **[CHANGELOG.md](CHANGELOG.md)** | Release history |

---

## Built by IndiaNIC

Byline is developed and maintained by **[IndiaNIC](https://www.indianic.com)** and given
away under MIT. Everything in it — the platform probes, the measured behaviour in
`docs/*-NOTES.md`, the refusals that stop a post publishing at the wrong hour — came out
of work we do for clients, and it is here in full rather than as a demo.

That is also what we do commercially: **MCP servers and AI agents that fit the way a team
already works**, and the integration work that decides whether they survive contact with
production rather than stopping at a convincing pilot.

If you have a workflow worth automating, we would like to hear about it.

**[Talk to us →](https://www.indianic.com/contact)**  ·  [www.indianic.com](https://www.indianic.com)

---

## License

MIT — see [LICENSE](LICENSE).
