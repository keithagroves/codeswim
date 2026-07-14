---
name: deploy
description: Cut and publish a new codeswim release (version bump, tag, watch CI, publish the draft, verify the landing page). Use when the user wants to ship a release, cut a version, or "deploy". Takes an optional version or bump type (patch/minor) as argument.
---

Ship a new codeswim release end to end. The version source of truth is
`apps/desktop/package.json` (NOT the repo-root package.json — that stays at
0.1.2 and is ignored). Releases trigger on a pushed `v*` git tag.

Publishing is now automatic: `release.yml` has a `publish` job that flips the
draft to published once the mac/win builds pass, and the Linux `.deb` failure
is tolerated (`continue-on-error` on that leg) so the run goes green. So the
happy path is just bump → tag → push → watch it go green → verify. Step 9
below (manual publish) is now only a fallback if that job is ever removed or
fails.

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
   - **Expected outcome: the run goes GREEN.** The Linux leg's `.deb` step still crashes (pre-existing electron-builder `fpm` bug) but is marked non-fatal via `continue-on-error`, so it no longer reddens the run; the AppImage still uploads. Mac and Windows must genuinely succeed — a real failure there still fails the run and (correctly) blocks the `publish` job.

7. **Verify the mac build is signed + notarized** (the whole reason signing exists — friend's Gatekeeper block):
   `gh run view <id> --log | grep -iE "Developer ID Application|notarization successful"`
   Expect "Developer ID Application: Osphor Labs LLC" and "notarization successful".

8. **Check the assets landed and the release auto-published:**
   `gh release view v<X.Y.Z> --json isDraft,publishedAt,assets --jq '{isDraft,publishedAt,assets:[.assets[].name]}'`
   Expect `isDraft: false` (the `publish` job flipped it) and: mac `.zip`+`.dmg`(+blockmaps), win `-setup.exe`, linux `.AppImage`, plus `latest-mac.yml` and `latest.yml` (the electron-updater feeds — without these the in-app updater can't see the release).

9. **Fallback only — if the release is still a draft** (the `publish` job was removed or failed):
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

- Never `git push` the tag before the bump commit, or the tagged tree won't contain the new version.
- The mac build takes ~7 min (notarization round-trip). Budget for it when watching.
- The `publish` job only runs on tag pushes (`if: startsWith(github.ref, 'refs/tags/v')`) and only if `build` passed — so a genuine mac/win failure correctly leaves the release unpublished.
- The real remaining wart is the Linux `.deb` itself. If you'd rather not ship `.deb` at all, drop `deb` from `linux.target` in `apps/desktop/electron-builder.yml` and the `continue-on-error` hack becomes unnecessary.
