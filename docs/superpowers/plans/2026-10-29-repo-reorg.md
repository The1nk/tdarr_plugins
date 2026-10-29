# Repository Reorganisation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plugins in `plugins/`, flow exports in `flows/`, the two unused plugins out of the repo (but still in Tdarr), and a README that maps the whole repository.

**Decisions (made with the user):**
- `plugins/` holds every plugin file; `flows/` holds the five `flow*.json` exports and their gitignored `flow*.local.json` copies.
- `Tdarr_Plugin_MP01_MichPasCleanSubsAndAudioCodecs.js` and `Tdarr_Plugin_the1nk_break_hardlink.js` are removed from the repo, untracked, and gitignored. They stay in Tdarr's plugins folder. Because `pull.ps1` copies every plugin from Tdarr, they'll reappear in `plugins/` after a pull, but git ignores them, and `push.ps1` only ever copies them back unchanged.
- The saved job logs in the root are already deleted (they were untracked).
- `docs/superpowers/` (specs and plans) stays where it is. These are historical records, so their file paths describe the layout at the time they were written and aren't rewritten. The untracked `docs/superpowers/plans/2026-10-12-convert-unsupported-subs.md` gets committed.

## Background

- Repo `C:\git\tdarr plugins` (Windows, Git Bash and PowerShell). Work on branch `repo-reorg`, which is already created from `main`. Commit at the end of each task and never push. Commit messages end with a blank line, then `Claude-Session: https://claude.ai/code/session_016ziVwwvkMXfjNotbAoqpyw`.
- **Never redirect to `/dev/null`.** Never print the contents of `flow*.local.json` (they hold real API keys) or `path.env`.
- Use `git mv` so history follows the files. Keep line endings as they are: the flow files are CRLF, while plugins and tests are LF (check with `git diff --stat`; a move must show 0 changed lines).
- `path.env` (gitignored) holds the Tdarr plugins folder path. `push.ps1` copies the plugins there and `pull.ps1` copies them back.

### Task 1: Move the files

- [ ] **Step 1: Plugins.** `mkdir plugins`, then `git mv` every `Tdarr_Plugin_*.js` in the root into `plugins/`, except the two unused ones.
- [ ] **Step 2: Remove the unused plugins from the repo.** Run `git rm` on `Tdarr_Plugin_MP01_MichPasCleanSubsAndAudioCodecs.js` and `Tdarr_Plugin_the1nk_break_hardlink.js`. Then add to `.gitignore`:

  ```
  # In Tdarr's plugins folder but not kept in this repo (unused by the flows); pull.ps1 brings them back.
  plugins/Tdarr_Plugin_MP01_MichPasCleanSubsAndAudioCodecs.js
  plugins/Tdarr_Plugin_the1nk_break_hardlink.js
  ```

- [ ] **Step 3: Flows.** `mkdir flows`, then `git mv flow*.json flows/` for the five tracked files. Use plain `mv` for the five untracked `flow*.local.json` files. The existing `*.local.json` ignore rule still covers them; confirm with `git check-ignore -v flows/flowMovies.local.json`.
- [ ] **Step 4: Scripts.** Make both scripts work from any current directory by using `$PSScriptRoot`:

  `push.ps1`:
  ```powershell
  # Copies the plugins to the Tdarr plugins folder named in path.env.
  $path = (Get-Content -Raw -Path (Join-Path $PSScriptRoot 'path.env')).Trim().TrimEnd('\', '/') + '\'
  Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\*.js') -Destination $path
  ```

  `pull.ps1`:
  ```powershell
  # Copies the plugins from the Tdarr plugins folder named in path.env into plugins/.
  $path = (Get-Content -Raw -Path (Join-Path $PSScriptRoot 'path.env')).Trim().TrimEnd('\', '/') + '\*.js'
  Copy-Item -Path $path -Destination (Join-Path $PSScriptRoot 'plugins')
  ```

- [ ] **Step 5: Code paths.**
  - In `tests/*.test.js`, every `path.join(__dirname, '..', '<plugin>.js')` becomes `path.join(__dirname, '..', 'plugins', '<plugin>.js')`. This includes the file-reading lines in `tests/repair_framerate.test.js` (the source-parity test) and `tests/convert_unsupported_subs.test.js`.
  - In `tools/check-video.js`, `require('../Tdarr_Plugin_the1nk_detect_damaged_video.js')` becomes `require('../plugins/Tdarr_Plugin_the1nk_detect_damaged_video.js')`.
  - In the headers of `tests/container/*.itest.js`, the `docker cp` source paths become `plugins/<plugin>.js`. The container paths stay the same.
  - Search for any other references with `grep -rn "Tdarr_Plugin_" tests tools *.ps1 CLAUDE.md` and fix them.
- [ ] **Step 6: Verify.**
  - `node --test tests/*.test.js` must report fail 0.
  - `node tools/check-video.js --help` must exit 0.
  - `git diff --stat main` must show only renames (0 lines changed) for the moved files, apart from the edits above.
- [ ] **Step 7: Commit** the moves, the scripts, `.gitignore`, the tests, the tool and the itests: "Move plugins to plugins/ and flows to flows/; drop the two unused plugins from the repo".

### Task 2: Docs

- [ ] **Step 1: README.**
  - Directly under the title, add a short intro paragraph followed by a `## Repository layout` section: a tree of the top level, a one-line description per entry, and a link to the section that covers each. The entries to cover:
    - `plugins/`
    - `flows/`, including the `.local.json` copies with their real API keys
    - `tools/`
    - `tests/` and `tests/container/`
    - `docs/superpowers/` (design specs and implementation plans, historical)
    - `push.ps1` / `pull.ps1`
    - `path.env` (gitignored)
    - `CLAUDE.md`
  - Then add a short `## Contents` list linking to the main sections.
- [ ] **Step 2: Update every path in the README.**
  - Flow file names become `flows/flowMovies.json`, …, and `flows/flow*.local.json`.
  - Plugin paths appear in the itest commands (`docker cp plugins/…`).
  - The Deployment section should describe `push.ps1` / `pull.ps1` with `plugins/`.
  - Remove the Break Hardlink plugin section and the MichPas row in "Local copies of community plugins".
  - Reword the ordering-rule sentence "That's why the flows don't need Break Hardlink, which used to cost a full copy of every file." so it no longer names a plugin that isn't in the repo. For example: "…don't need to break hardlinks first, which used to cost a full copy of every file."
  - Add one line in the plugins part saying that two older plugins (MichPas Clean Subs, Break Hardlink) remain in Tdarr's plugins folder but aren't kept in this repo.
  - Check that every anchor link still resolves.
- [ ] **Step 3: CLAUDE.md.** Update the Deployment and Plugin Architecture sections so plugins live in `plugins/` and flows in `flows/`; pull and push copy between `plugins/` and the Tdarr folder. Keep its other guidance unchanged.
- [ ] **Step 4: Commit the old plan.** Commit `docs/superpowers/plans/2026-10-12-convert-unsupported-subs.md` (currently untracked) as is.
- [ ] **Step 5: Verify.** Run `grep -rn "flowMovies.json\|Tdarr_Plugin_" README.md CLAUDE.md` and check every path is current. Run `node --test tests/*.test.js` again (fail 0). Commit README, CLAUDE.md and the old plan: "Map the repository in the README and update paths".
