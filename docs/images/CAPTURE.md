# Screenshots to capture

The README currently uses text transcripts. They are real output and they work, but a
few of these moments are much clearer as images. This is the shot list.

Text ships now; images replace or accompany the transcripts later. **A transcript is
never removed until its image is in place** — a README with a gap is worse than one with
plain text.

## Capture rules

These are not optional. The screenshots go in a public repo.

1. **Isolated `HOME`.** Never capture against your real home directory. Every path in
   the frame becomes public, and so does the list of AI tools you have installed.

   ```bash
   S=$(mktemp -d)
   mkdir -p "$S/work" "$S/.cursor"
   printf '{"mcpServers":{}}\n' > "$S/.claude.json"
   printf '{"mcpServers":{}}\n' > "$S/.cursor/mcp.json"
   cd "$S/work" && HOME=$S byline init
   ```

   Seeding those two files is what makes the tool-detection frame appear at all — an
   empty home finds nothing and skips straight past it.

2. **A throwaway blog only.** Never a real site, and never a site belonging to someone
   else. The blog's name and version appear in the success frame.

3. **Delete the scratch home afterwards.** It contains a working credential in
   `.env`.

4. **Check the frame before saving.** Real hostname, real username, real path, a visible
   key, a browser tab, a notification — any of these means recapture. Terminal width 100
   columns keeps paths from wrapping.

5. **Retina or 2x**, PNG, and crop to the terminal content. No desktop background.

## The shots

Ordered by where they appear in `README.md`.

### 1. `init` — tool detection

**Shows:** the multiselect with real tools found and pre-ticked.
**Why it earns an image:** it is the moment a reader realises they do not have to edit
any JSON. The ticked checkboxes carry that better than text.
**Where:** README → `byline init` → *It finds the AI tools you already have*.

```
◆  Register byline with which AI tools? (space to toggle, enter to confirm)
│  ◼ Claude Code
│  ◼ Cursor
```

### 2. `init` — the platform picker

**Shows:** Ghost / WordPress.
**Why:** proves at a glance that this is not a Ghost-only tool.
**Where:** README → *It asks for your blog*.

### 3. `init` — the masked credential prompt

**Shows:** the note above the prompt carrying the click-path, the ADMIN-not-Content
warning, and the `(looks like: id:secret)` example, with the input masked below it.
**Why this one matters most:** the Admin-vs-Content key mixup is this project's single
most common user failure, and that example line is the thing that prevents it. It sits
above the prompt rather than inside it because `@clack`'s masked `password()` has no
placeholder at all — worth seeing, because it looks like a design choice and is actually
a constraint.
**Where:** README → *It tells you exactly which key to get*.

### 4. `init` — a wrong key rejected

**Shows:** the masked entry, `Could not connect`, the platform's own 401 in its own
words, and the Try again / Skip choice.
**Why:** this is the credibility shot. "Validated live at entry" is a claim; this is the
evidence. It is also the frame that would have been *impossible* before the health-check
fix, because a fabricated key used to be accepted with a cheerful success message.
**Where:** README → *It checks the key against your real blog before accepting it*.

```
◇  Could not connect to https://blog.example.com
■  Ghost rejected these credentials (HTTP 401):
│  Unknown Admin API Key
│
◆  What now?
│  ● Try again (re-enter the credentials)
│  ○ Skip this site
```

### 5. `init` — the closing screen

**Shows:** the file list, the persona template line, and the copy-pasteable first
sentence.
**Why:** it answers "what just happened to my machine?" completely, in one frame.
**Where:** README → *It tells you where everything went*.

### 6. `doctor` — all green

**Shows:** a healthy install: Node version, owner-only `.env`, a blog authenticating
with its real title and version, and registered AI tools with their scope.
**Why:** the reassurance shot, and it demonstrates what to run when something breaks.
**Where:** README → *Checking on things*.

### 7. A published post

**Shows:** a finished article on a throwaway blog — the summary table above the first
heading, a question-phrased H2, the FAQ section, and the hero image.
**Why:** the README describes what each article ships with and never shows one. This is
the only shot that demonstrates the actual output rather than the setup.
**Where:** README → *How it works*, or near the top as the hero image.
**Note:** a throwaway blog with a default theme. Do not use a real published article.

## Optional, lower value

- `status` on a configured install — largely duplicates shot 6.
- `migrate` dry run — useful only to existing checkout users, a shrinking audience.
- The typo suggestion (`stauts` → `status`) — charming, but the text version is fine.

## Where they go

`docs/images/`, named for their shot: `init-tools.png`, `init-platform.png`,
`init-credential-prompt.png`, `init-wrong-key.png`, `init-done.png`, `doctor-green.png`,
`published-post.png`.

Reference them from `README.md` with alt text that describes what the image *shows*, not
what it is called — screen-reader users and anyone whose images fail to load should get
the same information the picture carries.
