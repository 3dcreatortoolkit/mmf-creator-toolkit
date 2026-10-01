# Maintainer guide

Users install the ready-to-use ZIP described in the [main README](../README.md). They do not need Node.js or this source tree.

## Build and verify

From the project root, with Node.js 20 or newer:

```powershell
npm install
npm test
npm run build
```

`npm run build` creates the unpacked browser extension in `dist/`, including PNG icons rasterized from `extension/icons/cube.svg`. To test that build locally, load `dist/` in Brave or Chrome's extensions page.

## Automatic GitHub releases

The `.github/workflows/release.yml` workflow runs on pushes to the repository's default branch (`master` or `main`) and can also be started manually. It runs `npm ci` and `npm test`, assigns a new patch version using the workflow's unique `GITHUB_RUN_NUMBER`, builds and validates a ZIP, tags the versioned source, and publishes `3d-creator-toolkit.zip` on the GitHub Releases page. Tests must pass before a tag or release is created. GitHub's provided `GITHUB_TOKEN` with `contents: write` is used; no MyMiniFactory login or extra release token is needed.

The source versions in `extension/manifest.json`, `package.json`, and `package-lock.json` are the **base version**. Workflow run 1 publishes the base version `v0.0.1`, run 2 publishes `v0.0.2`, and so on. For later runs the workflow commits matching version metadata **to the release tag only**, not to the default branch; the first run simply tags the source without making an empty commit. Failed runs can leave gaps. Rerunning an already released run uses the same tag and will stop rather than overwrite an existing release. When you intentionally change major/minor versions, update all three base-version files and ensure the resulting tag will not collide with an existing one.

The workflow checks `github.event.repository.default_branch`, so pushes to other branches do not publish releases. If the default branch is renamed to something other than `master` or `main`, update the branch list in the workflow. GitHub Actions cannot run until this repository is committed and pushed to GitHub; it currently has no remote configured. In repository settings, ensure GitHub Actions is enabled and the workflow has permission to create tags and releases.

Locally generated archives under `releases/` are ignored by Git. Distribute the ZIP as a GitHub Release asset rather than committing binaries on every push. The user-facing README describes how to replace an unpacked extension **in the same installed directory** to preserve its Brave download job.

## Package a release manually

After updating the version in `extension/manifest.json` and `package.json` (and the npm lockfile if needed), run:

```powershell
./scripts/package.ps1
```

This rebuilds the extension and creates `releases/3d-creator-toolkit-<version>.zip`. The ZIP must contain `manifest.json` **at its root**. Extract it before selecting **Load unpacked**; browsers cannot load the ZIP directly. Verify the ZIP in a clean browser profile. Do not use a manual release tag that will collide with a future automated run.

The extension icon is generated at 16, 32, 48, and 128 px. The automated tests use fixtures; also test CSV collection, directory permission, asset downloads, and resume manually with a signed-in MyMiniFactory creator account before publishing.
