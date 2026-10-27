# Covebird

Every identity. Its own lane.

Covebird is the confirmed product name. The current C monogram is a temporary placeholder; the final logo is awaiting selection from the four vector concepts in `logos/`. The existing petroleum/mint interface remains while the logo is reviewed. `brand.json` is the source of application metadata; `mark.svg` is the original vector source. Run `yarn brand:apply` to regenerate metadata and native icons. Display copy lives beside the components that use it. No domain or trademark ownership is asserted.

## Logo selection

![Four Covebird logo concepts](logos/options.png)

1. **Shelter**: a bird sheltered by a cove-shaped arc.
2. **Open Wing**: angular wings and separate planes suggesting profile isolation.
3. **Cove**: an open C containing a bird and a horizon.
4. **Pipit**: a friendly compact bird silhouette.

Each concept includes an SVG mark, a dark app-icon SVG and a 512px PNG. The comparison uses a shared palette and wordmark so the choice is about shape. `yarn brand:options` rebuilds the comparison and individual assets. No concept has been selected; `mark.svg` remains a temporary C monogram. Once selected, the chosen icon can become `mark.svg` and `yarn brand:apply` regenerates native assets.

## Compatibility

The display name is Covebird. The production bundle ID stays `com.multizen.desktop`. Existing profiles, settings, and credentials continue to use the `MultiZen` data directory and Safe Storage namespace. Electron receives the legacy name before ready, then the display name after ready. An explicit `--user-data-dir` selects an isolated test directory.

Internal `@multizen/*` package names, IPC channels, cloud object paths, archive extensions and managed agent configuration markers remain stable. These are persistence contracts, not user-facing branding. Cloud Sync, MCP gateway, OAuth and credential backups remain part of the fork and regression suite.

The GitHub repository and update channel remain `irensaltali/multizen-browser`. Release collection emits canonical Covebird artifacts plus byte-identical `MultiZen-mac-{arm64,x64}.dmg` aliases so 0.4.3 Mac clients retain a working upgrade link. Apple Developer ID signing and notarization are a separate release task; rebranding does not solve Gatekeeper warnings.

## Taking upstream improvements

Never reset the fork to upstream or blanket-select one side of a merge.

1. Commit local work. From the fork branch run `yarn upstream:prepare ../covebird-upstream-review`.
2. The script fetches original `master` without importing upstream tags, then merges in a separate Git worktree and `integrate/upstream-*` branch. Your current branch is untouched.
3. Conflicts and any changes to paths in `upstream-policy.json` stop for manual review. Resolve in the review worktree, retaining our behavior while adapting shared upstream code. A stopped review intentionally remains on disk.
4. In that worktree run `yarn install --immutable`, `yarn brand:apply`, `yarn brand:check`, `yarn test:fork`, `yarn typecheck`, `yarn test`, and `yarn workspace @multizen/desktop exec electron-vite build`.
5. Review the diff, commit the merge and push the review branch. Merge it into main only after review. Publish via the existing version/tag workflow when ready.

The weekly/manual `Prepare upstream review` GitHub workflow performs the same process and pushes a branch only after all checks pass. It never pushes main, force-pushes, merges a PR or publishes. It becomes scheduled after this workflow reaches the default branch. An existing review branch is not overwritten; finish or remove the previous review before retrying the same upstream revision.

`Fork compatibility` runs on PRs and fork branches. Checks cover identity, legacy storage, updater ownership, Sync refresh wiring, legacy managed markers and the existing feature suites. Tests cannot prove every semantic change safe: review shared code before merging. Repository administrators can still bypass ordinary CI; branch protection is not configured by these files.

## Validation

`yarn test:fork` exercises real temporary Git repositories, including clean merges, custom-feature deletions, conflicts, dirty worktrees and already-integrated upstream. Release tests validate both architectures, hashes and the legacy Mac download alias. `yarn test` exercises the existing Sync, gateway, OAuth, credentials, profiles, settings, renderer and Kopia behavior.

Original MultiZen attribution and MIT notices remain in the repository.
