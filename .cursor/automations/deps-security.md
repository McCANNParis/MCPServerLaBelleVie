# Dependabot overflow — majors, red CI, malware feed

Dependabot (`.github/dependabot.yml`) owns weekly version checks on `dev`.
Do **not** open a second weekly bump PR if Dependabot already has one covering
the same packages. Rebase or fix CI on that PR instead.

## When this automation runs

Cursor Automation (weekly Monday) on `McCANNParis/MCPServerLaBelleVie`,
branch `dev`. Optional webhook for an on-demand run. Not a GitHub Action.

## What to do

1. List open Dependabot PRs (`gh pr list --author app/dependabot --state open`).
   If CI is red, fix call-site breakages in this repo only. Do not weaken tests.
2. `npm outdated --json` and `npm audit --json` only to find **semver majors**
   (Dependabot ignores those) and advisories Dependabot missed.
3. Skip any version published fewer than **5 days** ago (Dependabot
   `cooldown.default-days: 5`; do not rely on `.npmrc` — npm 11.6 ignores
   project-level `min-release-age`). Critical/high advisories may bypass; say so in the PR body.
4. Download https://malware-list.aikido.dev/malware_predictions.json and compare
   locally against the lockfile (exact package name + version; feed `*` is
   package-wide). Stop on an exact match. Do not upload the dependency graph to
   a third-party lookup API.
5. Install with `sfw npm install` if `sfw` is on PATH, else `npm install`.
6. Run the CI gate and stop if it fails after a reasonable fix attempt:

   `npm run lint && npm run typecheck && npm test && npm run build:cli && npm run build`

7. For a Next / `mcp-handler` / `@modelcontextprotocol/*` / `zod` **major** that
   you cannot finish in-scope: open a **draft** PR into `dev` and do **not**
   enable auto-merge to `main`.
8. Never `git push --force`. Never touch `.env*`. Never merge Dependabot PRs —
   `.github/workflows/dependabot-auto-merge.yml` does that.

## Memories

Record the last bump set and any versions skipped for age or malware so the next
run does not re-apply them. Delete outdated notes.
