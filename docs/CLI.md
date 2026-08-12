# CLI reference

Every command, every flag, and what each one writes. Checked against
`src/cli/main.ts`, not from memory.

```
byline <command> [...args]
```

| Command | What it does |
|---|---|
| [`init`](#byline-init) | First-run wizard: register your AI tools and add your first blog |
| [`status`](#byline-status) | What is configured right now, and where each file lives |
| [`doctor`](#byline-doctor) | Probe every configured API and print a fix per failure |
| [`media`](#byline-media) | Add, list, scan, inspect, release, and remove local photo libraries |
| [`register`](#byline-register) | Register with AI tools |
| [`migrate`](#byline-migrate) | Copy a repo-local config into `~/.byline/` |
| [`reset`](#byline-reset) | Wipe `~/.byline/` |
| [`update`](#byline-update) / `upgrade` | Self-update the global install |
| [`help`](#byline-help) | The command list, or `help <command>` |

Top-level flags: `--version` / `-v`, `--help` / `-h`.

## Bare `byline`

The binary decides what you are by whether it has a terminal.

- **In a terminal** (`stdin.isTTY && stdout.isTTY`): prints help and exits. It does not
  hang waiting for MCP traffic that a human is never going to type.
- **Over pipes**: starts the stdio MCP server. This is how your AI tool launches it.

Before either, the **Node version guard** runs — it is the literal first statement in
`bin/byline.js`, above any `import`, so it works on runtimes too old to parse the
rest of the file:

```
byline requires Node >= 20, but this command is running on Node 18.20.4.
Your shell's `node` is too old — switch to Node 20+ (e.g. `nvm use 20`) and re-run.
```

Exit code 1. `package.json`'s `engines` field is advisory — npm warns, it does not
enforce at runtime — which is why this guard exists.

---

## `byline init`

**Flags:** none.

The setup wizard — for the first run **and every run after it**. Requires a terminal.
Steps, in order:

1. **Offers to migrate** a repo-local config if it finds one (see
   [`migrate`](#byline-migrate)).
2. **Detects installed AI tools** by config path and offers only those, all
   pre-selected. Backs each file up to `<file>.byline-bak` before merging.
3. **Walks your blogs.** With nothing configured: platform picker, short name, address,
   then that platform's fields in order, every prompt skippable with an empty Enter.
   With blogs already configured: a menu of *Add a new blog* plus every configured
   short name, each showing its platform and address. Picking one enters the update
   walk, where an empty Enter **keeps** the current value instead of skipping, and a
   stored secret is shown only as a masked fingerprint (`0000••••••aaaa`). Either way
   the credentials are **validated against the live platform before being accepted** —
   including a credential you kept without retyping — and the platform's own error is
   shown on failure with a retry/skip choice.
4. **Offers each provider family in turn** — image generation (Gemini, then Grok), then
   research (Brave, then Tavily) — each with its own yes/no question, defaulting to No,
   and each key validated the same way. A key already in `.env` is never asked for
   again: it is shown as a masked fingerprint and offered **keep / replace / remove**,
   with keep first so Enter changes nothing. Keeping still probes it, and a stored key
   the provider no longer accepts is reported with an offer to replace. Both families
   are optional; declining either leaves a fully working install. Families come from
   `src/plugins/providers.ts`, so `init` names none of them itself.
5. **Asks about your author persona** — checking for existing ones *before* asking
   anything. With none: the five-question walk. With one or more: a menu of *Keep as
   they are*, *Update "<name>"* per persona, and *Add another*. An update pre-fills
   every answer from the file and merges back into it, so fields the five questions
   never ask about survive.
6. **Seeds the persona template** and prints every file it wrote.
7. **Closes with a copy-pasteable sentence** to type at your AI tool.

**Writes:** `~/.byline/config.yaml`, `~/.byline/.env` (mode 600),
`~/.byline/personas/_template.yaml`, and the config file of each AI tool you picked.

**Does not write** `~/.byline/` at all if you decline everything — an empty config
directory would permanently shadow a working repo-local config.

**Never replaces a blog by accident.** A short name already present in `config.yaml` is
still refused on the *new blog* path; updating one is only ever reached by picking it
off the menu. Adding a blog does not move `default_site` off one you already had.

**A half-entered NEW blog is still abandoned.** Skipping any field of a blog being
created discards it — a config that loads "usable" with a blank credential fails at
publish time. "Empty means keep" applies only where there is a stored value to keep.

---

## `byline status`

**Flags:** none. Never fails, never gated — it works with no config at all.

Reports, in order: the four resolved paths with **per-field provenance**; configured
blogs; author personas; one section per provider family (image generation, then research);
AI tool registrations with their **scope** and file; and any config problems, each with
its fix.

```
◆  paths   (base resolved from: home)
│  config    /Users/you/.byline/config.yaml   [home]
│  personas  /Users/you/.byline/personas     [home]
│  secrets   /Users/you/.byline/.env         [home]
│  images    /Users/you/.byline/runs         [home]
│
◆  blogs
◇  myblog       ghost      https://blog.example.com
│
◆  image generation
◇  gemini    key set
■  grok      XAI_API_KEY not set
│
◆  research
◇  brave     key set
■  tavily    TAVILY_API_KEY not set
│
◆  AI tools
◇  Claude Code   registered [global] — /Users/you/.claude.json
■  Codex         not registered
│
└  Ready to publish.
```

Provenance is **per field**, not one global line: with `BYLINE_SITES` set, that one
row reads `[override via BYLINE_SITES]` while the others still read `[home]`. A
single source line would be false in exactly that case.

Registrations are detected at **both** global and project scope. Reporting only global
made `register --scope project` look like it had done nothing.

---

## `byline doctor`

**Flags:** `--offline` — skip every network probe, for a fast config-only run.

Everything `status` reports, plus a live probe of every blog and of every provider in
every family — image generation **and** research — plus the Node version and a check that
`.env` is still owner-only. Every failure prints its own fix line.

An **unconfigured research provider is not a failure.** Research is optional, one provider
is enough, and Byline never substitutes the other one for a missing key — so the row reads
as a note with the click-path to the key, not an error. That wording comes off the family
descriptor rather than being written per family: the image family's note reads "not a
failure — the second image provider is a fallback most users skip", which is false for
research, where there is no fallback.

**Exit code 1** when any check fails, 0 otherwise. What counts as failure was settled
deliberately:

| Condition | Fails? |
|---|---|
| Zero blogs configured | **yes** — nothing can be published |
| Zero AI tools registered | **yes** — nothing can call it |
| One tool unregistered among several | no — a Cursor-only setup is a working setup |
| No image provider configured | no — posts work fine without generated images |
| No research provider configured | no — research is optional, and BYOR research still satisfies news mode |
| A blog's credential rejected | **yes** |
| A configured image or research key rejected by its API | **yes** — a key that is present and wrong is worse than one that is absent |

`doctor` never throws. Every probe is wrapped; a provider that raises is reported, not
propagated.

---

## `byline media`

Add, list, scan, inspect, release, and remove entries in the `media:` block of
`config.yaml` — the local photo libraries `find_media` and `use_media` search and upload
from. Before this command existed, adopting the library meant hand-editing
`config.yaml` directly and restarting the MCP server just to get a folder registered.

```
byline media <command> [...args]
```

| Command | What it does |
|---|---|
| `add <folder> [--name <slug>] [--no-recursive] [--default]` | Add a library and scan it immediately |
| `list` | Every configured library, with asset counts |
| `scan [<name>]` | Rescan a library (or every library) and report what changed |
| `status` | Like `list`, plus index/ledger file locations and stale reservations |
| `release <id> [--library <name>]` | Clear a reservation stuck by a failed publish |
| `remove <name> [--yes]` | Forget a library (the folder itself is left alone) |

Bare `byline media`, or an unrecognised subcommand, prints this list.

**Every write-through-config subcommand (`add`, `remove`) prints a restart notice.**
`loadContext()` reads `config.yaml` once, at MCP server startup, so a library added or
removed from a terminal is invisible to an already-running server until you restart your
AI tool:

```
▲  A running MCP server only reads config.yaml at startup, so this change is invisible
   there until you restart your AI tool.
```

### `byline media add <folder>`

**Flags:** `--name <slug>` (override the derived name), `--no-recursive` (do not walk
sub-folders), `--default` (make this library the default even if it is not the first one
added).

Requires an existing `config.yaml` — run `byline init` first if none exists yet; `add`
writes into that file, it does not create one from nothing.

The folder is resolved to an absolute path (`~` expanded, a relative path resolved
against the current directory) before anything else runs, so the entry that lands in
`config.yaml` is never ambiguous about which directory it means.

Without `--name`, the library's name is derived from the folder's basename: lowercased,
runs of non-alphanumeric characters collapsed to a single `-`, leading/trailing `-`
trimmed. If that derivation cannot produce a legal name — a folder named only in symbols,
for instance — `add` refuses and asks for `--name` explicitly rather than inventing one:

```
■  Could not derive a usable library name from "📷". Names use lowercase letters, digits and hyphens.
●  Pass --name with a name of your choosing.
```

The folder must already exist and be a directory, and the name must not collide with a
library already configured — both checks run before anything is written. The **first**
library added becomes `default_library` automatically, so a single-library setup never
needs to name it on later commands; adding a second library never moves the default
unless `--default` is passed explicitly.

Scans immediately — one command makes the folder usable, not two:

```
┌  byline — media add
│
◆  library "shots"
│  /Users/you/Pictures/blog
▲  "shots" is now the default library.
◇  Scanned: 42 assets (38 images, 4 videos).
▲  A running MCP server only reads config.yaml at startup, so this change is invisible
   there until you restart your AI tool.
│
└  Added "shots".
```

### `byline media list`

**Flags:** none.

Every configured library, its path, and its asset counts as of the last scan. A library
whose folder is missing or not a directory is reported as unavailable rather than
silently dropped:

```
┌  byline — media list
│
◆  media libraries
◇  shots   /Users/you/Pictures/blog
│    42 assets (38 images, 4 videos), scanned 2026-08-12T08:19:19.541Z
■  archive
│  /Volumes/Photos/2019 does not exist.
│
└  `byline media add <folder>` to add another.
```

A library that has never been scanned reports that instead of counts, with the command
to fix it.

### `byline media scan [<name>]`

**Flags:** none.

Rescans one named library, or every configured library when no name is given. Reports
what changed since the previous scan — added, removed, and unchanged asset counts — not
just a new total:

```
┌  byline — media scan
│
◆  media scan
◇  shots   3 added, 1 removed, 41 unchanged (44 total)
│
└  Scan complete.
```

Scanning every library at once does not stop at the first failure: one broken library is
reported inline and the rest still scan.

### `byline media status`

**Flags:** none.

Everything `list` reports, plus where each library's index and ledger files live on disk
and how many stale reservations it is carrying — a reservation whose `use_media` upload
never turned into a published post, most often because the publish step failed
afterward:

```
┌  byline — media status
│
◆  media libraries
◇  shots   /Users/you/Pictures/blog
│    42 assets (38 images, 4 videos), scanned 2026-08-12T08:19:19.541Z
│
◆  files and reservations
│  shots   index: /Users/you/.byline/media/shots.index.json
│          ledger: /Users/you/.byline/media/shots.usage.json
▲  shots: 1 stale reservation(s) — run `byline media release <id> --library shots` to clear one.
│
└  `byline media release <id>` clears a reservation stuck by a failed publish.
```

### `byline media release <id> [--library <name>]`

**Flags:** `--library <name>` — which library's ledger to look in. Optional when exactly
one library is configured, or when `default_library` is set; required when several
libraries exist and neither applies, and `release` refuses rather than guessing which one
you meant.

Clears a **reservation** — an asset `use_media` uploaded whose post then failed to
publish — so the asset is free for `use_media` again. It does **not** touch a
`published` record; releasing one would put a photograph that is genuinely live on a
page back into the unused pool, so a request naming one is refused with no change made:

```
┌  byline — media release
│
◆  library "shots"
◇  Released 1 reservation(s) for "a1b2c3". It is free for use_media again.
│
└  Done.
```

Naming an id with no matching reserved record changes nothing and says so, rather than
failing:

```
┌  byline — media release
│
◆  library "shots"
│  No reserved record for "a1b2c3" was found — nothing changed. A "published" record is
│  never released this way; release only clears a reservation that never became a post.
│
└  Nothing released.
```

### `byline media remove <name> [--yes]`

**Flags:** `--yes` — required to actually remove; without it this is a dry run that
shows what would happen.

Forgets the `config.yaml` entry only. Byline never writes inside a library folder, and
that includes deleting it — the folder and every file in it are left exactly where they
were:

```
┌  byline — media remove
│
◆  library "shots"
│  /Users/you/Pictures/blog
▲  This forgets the config entry only. Byline never writes inside a library folder, so
   the folder and its files are not deleted — left alone at the path above.
◇  Removed "shots" from config.yaml. The folder at /Users/you/Pictures/blog was left
   untouched — not deleted.
▲  A running MCP server only reads config.yaml at startup, so this change is invisible
   there until you restart your AI tool.
│
└  Removed "shots".
```

If `name` was the `default_library`, that setting is cleared along with the entry — it
is never left pointing at a library that no longer exists. The library's index and
ledger files under `~/.byline/media/` (or a custom `index_path`) are **not** deleted by
`remove` — only the config entry goes. Re-adding a library of the same name resolves to
the same file paths again: `add` always writes a fresh index (it scans, it does not
merge), but the ledger — the record of what has already been used — is untouched by
either `remove` or `add`, so re-adding does not un-reserve or un-publish anything.

---

## `byline register`

Register with AI tools after the fact, or re-register after moving things.

| Form | Behaviour |
|---|---|
| `byline register` | Prints the command to run manually. No files touched. |
| `byline register -i` / `--interactive` | The multiselect wizard. Needs a terminal. |
| `byline register --tools <a,b>` | Non-interactive. Comma-separated ids. |
| `byline register --tools all` | Every tool **actually installed on this machine**. |
| `... --scope global` | User-level config (default). |
| `... --scope project` | Writes into the current folder. |

**Tool ids:** `claude`, `cursor`, `gemini`, `windsurf`, `codex`. Unrecognised ids are
silently dropped from the list.

**Config paths written:**

| id | Global | Project |
|---|---|---|
| `claude` | `~/.claude.json` | `./.mcp.json` |
| `cursor` | `~/.cursor/mcp.json` | `./.cursor/mcp.json` |
| `gemini` | `~/.gemini/settings.json` | user-level only |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | user-level only |
| `codex` | `~/.codex/config.toml` | user-level only |

Every write is preceded by a backup to `<file>.byline-bak`, and the file is parsed
*before* the backup is taken — malformed JSON fails without leaving a stray backup
behind. Existing MCP servers and unrelated settings are merged around, not replaced.
Codex's TOML is edited with a line-anchored table match, and re-running is idempotent.

### Sharp edges

- **`--scope` silently falls back to `global`** for any value other than `project`.
  There is no error for a typo'd scope.
- **`--tools all` means "all the tools you have"**, not all five. It used to create
  `~/.gemini`, `~/.codeium`, and `~/.codex` from nothing and then report all five
  registered. An explicitly named tool is still honoured even if absent.
- **The command it writes is `npx -y @indianic/byline`**, which does not resolve
  until the package is published. Until then, register the absolute path of the
  installed binary instead — and note that path is nvm-version-specific and breaks on a
  Node version switch until you re-register.

---

## `byline migrate`

Copy a repo-local `config/sites.yaml`, `.env`, and `personas/` into `~/.byline/`.

**Flags:** `--yes` — actually perform the plan. Without it, this is a dry run.

```
┌  byline — migrate
│
◆  plan
│  copy    sites.yaml → /Users/you/.byline/config.yaml
│  copy    .env → /Users/you/.byline/.env
│  copy    _template.yaml → /Users/you/.byline/personas/_template.yaml
●  Nothing has been copied yet. Re-run with --yes to perform the plan above.
   Your checkout is never modified.
│
└  Dry run.
```

Guarantees, all enforced in code rather than by ordering:

- **Copy, never move.** Your checkout is never modified.
- **Never overwrites.** Enforced with `COPYFILE_EXCL` — a syscall-level exclusive
  create, so there is no window between deciding and doing.
- **`.env` always lands mode 600**, whatever the source file's mode was.
- **Nothing is written at all without `--yes`.**
- One failed item does not abort the rest; each is reported with its own cause.

---

## `byline reset`

Delete `~/.byline/` entirely.

**Flags:** `--yes` — **required**. There is no confirm prompt to accept by reflex.

This runs a recursive delete, so it refuses anything that is not plausibly a byline
config directory. The guard asks what the path **is**, not how it was resolved:

- **Your home directory itself**, or any ancestor of it. Compared by `{dev, ino}` via
  `statSync`, not by string — macOS APFS is case-insensitive, so a case-mangled
  `$BYLINE_HOME` compared as a string slipped past an earlier version and reached a
  delete of the real home directory.
- **Any immediate child of the filesystem root** — `/Users`, `/home`, `/tmp`. No
  hardcoded name list; it is derived.
- **Any directory containing `.git` or `package.json`.** This runs regardless of how the
  path resolved, so `BYLINE_HOME=<repo root>` cannot delete a source tree.

Each refusal names the path and points at what to do instead.

---

## `byline update`

Alias: `byline upgrade`. **Flags:** none.

Looks up the latest published version and re-installs the global package with whichever
package manager installed it — **npm, pnpm, or yarn**, detected rather than assumed.
Detection reads the real path of the running binary first, then
`npm_config_user_agent`, then falls back to npm. This matters because a pnpm global
install lives outside npm's prefix, so `npm install -g` would leave a second, shadowed
copy and the update would appear to do nothing.

Until the package is published this fails cleanly: one `■` row naming the registry
error, no stack trace, exit code 1.

---

## `byline help`

`byline help` lists every command. `byline help <command>` shows one. An unknown
command gets a suggestion within edit distance 2:

```
┌  byline
■  Unknown command: stauts
│  Did you mean `byline status`?
│
└  Run `byline help` for the full command list.
```

Exit code 1 for an unknown command.

---

## Environment variables

| Variable | Effect |
|---|---|
| `BYLINE_HOME` | Override the config directory base. Everything else derives from it unless separately overridden. |
| `BYLINE_SITES` | Override the path to `config.yaml` alone. |
| `BYLINE_PERSONAS` | Override the personas directory alone. |
| `BYLINE_ENV` | Override the `.env` path alone. |
| `BYLINE_DEBUG` | Set to anything truthy to print the full stack trace on an unexpected error. |
| `BRAVE_API_KEY` | Brave Search API key. Optional — research is optional. |
| `TAVILY_API_KEY` | Tavily API key. Optional — research is optional. |
| `BYLINE_RESEARCH_PROVIDER` | `brave` or `tavily` — the default when both are configured. Falls back to `WRITEBLOGS_RESEARCH_PROVIDER`. Naming a provider whose key is unset is refused, never redirected to the other one. |
| `RUN_INTEGRATION` | Set to `1` to include `tests/integration/**` in the test run. Unset, they are excluded entirely. |

Each `BYLINE_*` path override is reported separately by `status` and `doctor`, so
you can always see which one is in effect.

## Config resolution order

1. A `BYLINE_*` override, per field.
2. `~/.byline/` — the normal case.
3. A repo-local `config/sites.yaml` relative to the current working directory — the
   dev-checkout fallback.

Branch 3 depends on where the process was started, and an MCP host picks that directory,
not you. `doctor` names which branch matched and warns when it is this one.

## Errors

Every command runs inside a top-level error boundary. No command, present or future, can
emit a raw Node stack trace at a user who is trying to get set up. A thrown error's
`hint` — the field that exists to say what to do next — is always shown. The stack is
not printed by default but is never discarded: re-run with `BYLINE_DEBUG=1`.
