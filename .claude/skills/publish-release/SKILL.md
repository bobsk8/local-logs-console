---
name: publish-release
description: Use when cutting a release of this extension and publishing it to the VS Code Marketplace — bumping the version, updating the CHANGELOG, building and inspecting the VSIX, publishing with vsce, and tagging the GitHub release. Covers the exact repo layout (files allow-list, no .vscodeignore, manual vsce publish, publisher bobsk8) and the one step the agent cannot do (the secret-PAT publish).
---

# Releasing Local Logs Console to the Marketplace

Publishing is **manual** — there is no publish CI job. Publisher is **`bobsk8`**, Marketplace item id **`bobsk8.local-log-viewer`**. `npm run package` / `vsce publish` auto-run `vscode:prepublish` (clean + production build), so you never build by hand for the VSIX. Packaging uses the **`files` allow-list** in `package.json` — do **not** add a `.vscodeignore` (vsce refuses to build with both, and the CLAUDE.md forbids it).

> The one thing the agent cannot do: the actual `vsce publish` needs a secret Azure DevOps PAT. The agent does everything up to and after it; **the user runs the publish command** (via `! …` in the prompt, or with their PAT). Never ask for, print, or commit the PAT.

## 1. Decide the version (semver)

- **patch** (`1.4.0 → 1.4.1`): bug fixes only.
- **minor** (`1.3.0 → 1.4.0`): new backward-compatible features (new MCP tool, new setting, new command).
- **major**: a real breaking change to users.

Note: dropping `structuredContent` / other MCP-client-facing tweaks are *minor* for the extension's own semver — the extension stays backward compatible for its users.

## 2. Bump version + CHANGELOG (must land on `main` first)

Cut this on a branch, PR it, merge to `main`, then publish **from the merged main** — `main` is branch-protected (the 3 CI checks must pass). Never publish from an unmerged branch.

```bash
npm version <patch|minor|major|X.Y.Z> --no-git-tag-version
```

This keeps **package.json** and **package-lock.json** in sync — both the lock's root `version` and `packages[""].version`. Do NOT hand-edit the lock: a blanket find/replace on the old version string corrupts dependency versions (e.g. `es-errors@1.3.0`). Then add a top entry to **CHANGELOG.md** (Keep a Changelog format: `## [X.Y.Z] - YYYY-MM-DD`, then `### Added` / `### Changed` / `### Fixed`) describing what's new for users since the last *published* version — not raw commit messages.

## 3. Verify + build the VSIX

```bash
npm run compile && npm test && npm run lint   # 17+ suites, lint clean
npm run package                               # -> local-log-viewer-X.Y.Z.vsix (runs prepublish build)
```

Then **inspect what shipped** — the size guard matters (CLAUDE.md: keep the VSIX small; `docs/demo.gif` is referenced by absolute URL and must stay OUT of the package):

```bash
npx @vscode/vsce ls        # list files that will be published
ls -lh *.vsix              # sanity-check size (should be well under ~1 MB, not 4 MB+)
```

If the VSIX ballooned, something outside the `files` allow-list leaked in — fix `files` before publishing, don't add a `.vscodeignore`.

## 4. Publish (user runs this — secret PAT)

The PAT is an **Azure DevOps** Personal Access Token for the `bobsk8` publisher, scope **Marketplace → Manage**. Three ways to auth (the user picks one, all run in their terminal):

```bash
# one-time login (stores the PAT in the OS keychain), then publish:
npx @vscode/vsce login bobsk8
npx @vscode/vsce publish

# or non-interactive:
npx @vscode/vsce publish -p <PAT>
# or: VSCE_PAT=<PAT> npx @vscode/vsce publish
```

`vsce publish` with no version arg publishes the current `package.json` version (which you already bumped) — do NOT pass a version bump to `vsce publish`, that path skips the CHANGELOG/lock steps above. Suggest the user run it as `! npx @vscode/vsce publish` so the output lands in the session and the agent can confirm success.

Verify it went live: `https://marketplace.visualstudio.com/items?itemName=bobsk8.local-log-viewer` (the version badge in the README updates from the Marketplace shield).

## 5. Tag + GitHub release (agent can do this)

After a successful publish, tag the exact commit and cut a GitHub release with the CHANGELOG section:

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" --notes "<the CHANGELOG [X.Y.Z] section>"
```

(No tags exist yet in this repo — `vX.Y.Z` is the convention to start.)

## Gotchas

- **Publish from `main`, tagged.** Never from a feature branch. The published bits must equal what's on `main` at the tag.
- **`vscode:prepublish` is the real build** — it runs `--production` (minified). `vsce package`/`publish` invoke it; don't publish a dev `out/`.
- **`files` allow-list, not `.vscodeignore`.** New shipped assets (e.g. `media/**`, an icon) must be added to `files` or they won't be in the VSIX; adding a `.vscodeignore` breaks the build.
- **Optional Open VSX** (for Cursor/VSCodium users): not currently published there. If ever wanted: `npx ovsx publish -p <OVSX_TOKEN>` — a separate token/registry, mention it but don't assume it's set up.
- The agent must not touch the PAT/OVSX token in any form.
