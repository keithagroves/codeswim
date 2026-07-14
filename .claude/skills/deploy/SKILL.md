---
name: deploy
description: Cut and publish a new codeswim release (version bump, tag, watch CI, publish the draft, verify the landing page). Use when the user wants to ship a release, cut a version, or "deploy". Takes an optional version or bump type (patch/minor) as argument.
---

Ship a new codeswim release end to end. The version source of truth is
`apps/desktop/package.json` (NOT the repo-root package.json — that stays at
0.1.2 and is ignored). Releases trigger on a pushed `v*` git tag.

The single most important thing this skill exists to remember: **CI uploads
the artifacts to a GitHub _draft_ release and nothing promotes it. You must
publish the draft by hand at the end.** A finished run with a lingering draft
looks like success-but-nothing-shipped; publishing is also what fires the
landing-page refresh.

## Steps

1. **Preconditions.**
   - On `main`, and `git status` is clean except possibly `.codeswim/agent-state.json` (runtime churn — never commit it in a release).
   - `git log origin/main..HEAD` is empty (everything pushed) — or push first.
   - Show the user what will ship: `git log --oneline "$(git describe --tags --abbrev=0)"..HEAD`.

2. **Pick the version.** Current: `node -p "require('./apps/desktop/package.json').version"`. If the user gave an explicit version use it; if they said "patch"/"minor" bump accordingly; otherwise default to a patch bump and state it.

3. **Bump** (no tag yet, so we control staging):
   `npm version <X.Y.Z> --workspace @codeswim/desktop --no-git-tag-version`
   This edits `apps/desktop/package.json` + `package-lock.json`.

4. **Commit just the version files** (leave agent-state.json out):
   `git add apps/desktop/package.json package-lock.json`
   `git commit -m "chore: bump version to <X.Y.Z>"`

5. **Tag and push** both the branch and the tag:
   `git tag v<X.Y.Z> && git push origin main && git push origin v<X.Y.Z>`

6. **Watch the run.** `gh run list --workflow=Release --limit 3` to get the id, then `gh run watch <id> --exit-status --interval 30`.
   - **Expected outcome: the run shows FAILURE, and that is fine.** Only the Linux job fails — the pre-existing electron-builder `fpm` crash building the `.deb`. The AppImage still uploads. Mac and Windows must succeed. Confirm exactly that shape; a mac or windows failure is a real problem.

7. **Verify the mac build is signed + notarized** (the whole reason signing exists — friend's Gatekeeper block):
   `gh run view <id> --log | grep -iE "Developer ID Application|notarization successful"`
   Expect "Developer ID Application: Osphor Labs LLC" and "notarization successful".

8. **Check the assets landed on the (draft) release:**
   `gh release view v<X.Y.Z> --json isDraft,assets --jq '{isDraft,assets:[.assets[].name]}'`
   Expect `isDraft: true` and: mac `.zip`+`.dmg`(+blockmaps), win `-setup.exe`, linux `.AppImage`, plus `latest-mac.yml` and `latest.yml` (the electron-updater feeds — without these the in-app updater can't see the release).

9. **Publish the draft** (the manual step CI omits):
   `gh release edit v<X.Y.Z> --draft=false`
   Then confirm: `gh release view v<X.Y.Z> --json isDraft,publishedAt`.

10. **Verify the landing page redeploys.** Publishing dispatches `codeswim-release` to keithagroves/codeswim-landing:
    - `gh run list --workflow="Refresh landing page" --limit 2` (this repo's dispatcher — should show the new version, success)
    - `gh run list --repo keithagroves/codeswim-landing --limit 2` (the actual Pages rebuild — wait for success)
    - Then confirm the live link flipped: `curl -s "https://codeswim.xyz?cb=$(date +%s)" | grep -oE "codeswim-[0-9.]+\.dmg"` should show the new version.

## Report

Tell the user: the release URL, that mac is signed+notarized, that the landing
page shows the new dmg, and — if relevant — that users on the *previous*
version only get the in-app auto-update if that previous version already
shipped the updater (v0.1.6+). Mention the Linux `.deb` job failed as expected.

## Notes / gotchas

- Don't be alarmed by the red ✗ on the Release run — it's Linux-only. Read the per-job status, not the overall.
- Never `git push` the tag before the bump commit, or the tagged tree won't contain the new version.
- If `gh release edit --draft=false` says the release doesn't exist yet, the mac/win jobs haven't finished uploading — wait for step 6 to complete first.
- The mac build takes ~7 min (notarization round-trip). Budget for it when watching.
- To make this fully automatic later, add a publish step to `.github/workflows/release.yml` after the matrix (e.g. `gh release edit "$TAG" --draft=false`) — until then this manual step is load-bearing.
