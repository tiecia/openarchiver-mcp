# Runtime release bundles

This fork distributes a runtime **inside the existing Hermes image**, not a separate
MCP image and not the upstream npm package. Node is not bundled: the consumer must
provide a separately pinned Linux x64 Node >=26 runtime (a private install is fine).
The upstream MIT license/author and dependency licenses remain in the archive.

## Contract

Releases in `tiecia/openarchiver-mcp` use `bundle-v1.0.N`, independent of the upstream
package version (currently 1.3.3). The main workflow uses its real
`github.run_number` for N; the initial explicitly approved local bootstrap uses 0.
Assets have stable names:

- `openarchiver-mcp-linux-x64.tar.gz`
- `SHA256SUMS`: exactly `<64 lowercase hex>  openarchiver-mcp-linux-x64.tar.gz\n`

The archive has one `openarchiver-mcp/` root containing compiled non-test `dist/`
(including the relative MIME worker), production `node_modules/`, `package.json`,
the reviewed `package-lock.json`, `LICENSE`, `SECURITY-HARDENING.md`,
`scripts/verify-runtime-bundle.mjs`, and `BUILD-INFO.json`. Production dependencies
are freshly installed with `npm ci --omit=dev --include=optional --ignore-scripts`.
No runtime npm/npx install or network access is needed.

`BUILD-INFO.json` records `releaseTag`, full `sourceSha`, source commit timestamp,
`workingTreeDirty`, package/Node/npm versions, runtime requirements,
`sourceInputsSha256` and `payloadSha256`. The latter covers every regular payload
file except BUILD-INFO itself (which is covered by the archive checksum). Working
tree packaging additions are explicitly identified, never represented as a new
commit or fabricated CI run. Source inputs and compiled payloads are hashed.

The build refuses native `.node` addons and ELF/PE/Mach-O binaries, all symlinks
and hardlinks, and unsupported file types. Unneeded npm `.bin` links are removed
before hashing; consumers invoke Node entrypoints directly. A future dependency requiring native
code must fail rather than silently produce an allegedly portable bundle. This
bundle is verified on Linux x64; it is not a promise of other platforms.

## Local build and verification

Run from this checkout on Linux x64 with Node >=26, npm, git, GNU tar and gzip:

```sh
npm ci --ignore-scripts
npm test
node scripts/smoke.mjs
npm audit
npm audit --omit=dev
node --test scripts/runtime-bundle-safety.test.mjs scripts/publish-runtime-release.test.mjs
node --test scripts/runtime-bundle.test.mjs
node scripts/build-runtime-bundle.mjs \
  --output-dir /absolute/empty/output-directory \
  --release-tag bundle-v1.0.0 --source-sha "$(git rev-parse HEAD)"
```

The builder clears stale `dist/`, builds TypeScript, installs production dependencies
in a temporary stage, hashes inputs, scans portability, archives, **extracts that
exact archive**, and tests CLI version, MCP initialization/four tools/default-disabled
attachments and an actual HTML MIME parse through the packaged relative worker.
It emits assets only after verification, refuses nonempty output directories and
requires `--source-sha` to equal the full checked-out HEAD. Temporary directories
use `TMPDIR` if set; use an approved scratch directory locally.

Ordering, timestamps (source commit time), uid/gid (0), permissions and gzip headers
are normalized. The regression test builds twice and compares archive bytes. Use
the same Node/npm/toolchain and inputs to reproduce; different toolchains or dirty
metadata can legitimately change the checksum.

After checksum verification and safe extraction, the image build can run the bundled
verifier from **any cwd**, using its private Node path:

```sh
/private/node/bin/node /opt/openarchiver-mcp/dist/index.js --version
/private/node/bin/node /opt/openarchiver-mcp/scripts/verify-runtime-bundle.mjs
```

The verifier resolves only installed-tree dependencies, hashes its regular payload,
launches stdio with `process.execPath`, strips OpenArchiver credentials, asserts all
four tools and disabled attachments, and exercises the real relative MIME worker.
It needs a writable private/sticky temporary directory. It does not call a real
OpenArchiver API and does not establish production authorization/integration.

## Automation and bootstrap

`.github/workflows/runtime-release.yml` is the fork's only Actions workflow. The inherited CI, integration, npm-release and snapshot-check workflows are removed; this workflow retains unit, MCP smoke, audit and packaging coverage without upstream snapshot PR automation or npm publication. Pull requests
build/test/audit/package without publishing. Only successful main push/manual runs
in **exactly** `tiecia/openarchiver-mcp` reach a separate `contents: write` job.
Build jobs have only `contents: read`; there is no npm OIDC permission, npm publish,
container push or secret access. Actions are pinned to inspected commit SHAs. The
publish job downloads this run's immutable artifact; it does not rebuild or install
application dependencies with a write token.

Merge the workflow onto main and activate fork workflows before relying on future
runs. If the initial merge was not executed, dispatch it on main afterward; that
produces the real run-number tag, not the local bootstrap tag.

The initial manual bootstrap must be built **after independent review and commit**
of the producer packaging files, from a clean checkout of that exact commit.
The operator records `git rev-parse HEAD`, builds `bundle-v1.0.0` with that full SHA,
independently verifies the archive, and may then explicitly invoke:

```sh
node scripts/publish-runtime-release.mjs \
  --artifact-dir /absolute/verified/bootstrap-output \
  --release-tag bundle-v1.0.0 --source-sha "$(git rev-parse HEAD)"
```

The release targets that actual producer commit, not the earlier security-only
commit. There is no dirty-tree override. The builder may produce truthfully marked
dirty artifacts for local testing, but the publisher always rejects them.
Publishing is an explicit external write, never performed by the bundle builder
or test suite. Publisher tests use an isolated subprocess fixture and do not
contact GitHub. Merge the reviewed producer PR before enabling consumers.

The publisher checks both release **and tag** absence, validates checksum/metadata,
creates a draft, uploads assets without `--clobber`, checks the uploaded names, then
publishes and reads it back. Existing releases/tags are never overwritten, including
reruns of a completed run. Failed upload cleanup deletes only its newly created
release ID if it is still a draft; it never deletes a published release or any tag.
If creation/cleanup was interrupted or a tag remains, inspect it manually before
retrying; use a fresh workflow dispatch/run-number rather than deleting published
history. Renovate should consume only published bundle releases and pin both tag
and archive SHA-256 in the Hermes image repository; never use a mutable latest URL.
