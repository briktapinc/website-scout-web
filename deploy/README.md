# Release and recovery gates

Production currently runs security-r18-20261020. These tools do not deploy automatically.

## Clean builds

Run from a secret-free source checkout on Linux amd64 with Docker:

```sh
docker build --no-cache --platform linux/amd64 --target test -t bitpype-ci:test .
bash deploy/verify-release.sh bitpype-ci:test evidence
docker build --no-cache --platform linux/amd64 --target test -t bitpype-ci:repeat .
docker run --rm --network none -v "$PWD/deploy/build-fingerprint.cjs:/fingerprint.cjs:ro" --entrypoint node bitpype-ci:test /fingerprint.cjs > evidence/fingerprint-first.json
docker run --rm --network none -v "$PWD/deploy/build-fingerprint.cjs:/fingerprint.cjs:ro" --entrypoint node bitpype-ci:repeat /fingerprint.cjs > evidence/fingerprint-repeat.json
node deploy/compare-builds.cjs evidence/fingerprint-first.json evidence/fingerprint-repeat.json
docker build --platform linux/amd64 --target production -t bitpype:candidate .
```

Runtime and test targets share one runtime stage. Use the production target for deployment; tests are excluded from its filesystem. Compare the production candidate's source and package versions with the tested runtime before promotion. Keep the previous image and a fresh verified recovery set. Record the final image ID and deploy that exact artifact, rather than rebuilding on the deployment path. Canonical production Compose must keep its loopback binding and retained data volumes.

Node is pinned by architecture-specific digest, Debian packages by dated signed repository snapshots, npm packages by lockfile and integrity, and SheetJS by a vendored official archive. Deliberately update these pins in reviewed maintenance changes; frozen inputs do not receive security updates automatically. npm audit requires network access and is a separate time-specific check. Native packages can also depend on third-party downloads; retain verified image archives to recover if upstream downloads disappear.

The comparison covers runtime file bytes, permissions, symlinks, OS package versions and Chromium. It does not assert identical OCI image digests, build attestations or filesystem timestamps. BuildKit metadata and transient OS files may differ.

`verify-release.sh` runs the existing regression allowlist, real Chromium against synthetic routes, isolated MySQL OAuth/migration and job concurrency/crash fixtures, synthetic PNG OCR, and the npm dependency audit. Its MySQL database is temporary, has no external networking and publishes no ports. OCR alone needs an external trained-data download. Never run operational scripts under `scripts/` as a wildcard test suite.

## Isolated recovery

The root-only fresh set verified October 20, 2026 (New York time) is:

`/root/bitpype-backups/20261021T002007Z-before-release-hardening`

It contains source/config, all-database MySQL dump, three online SQLite snapshots, workspace assets, exports, Nginx config, container metadata and the saved app/MySQL images. Preserve all three checksum manifests. These files contain customer data and secrets: keep them root-only and outside Git/CI artifact uploads.

On the trusted recovery host, after verifying the image-archive checksum:

```sh
docker load -i /path/to/recovery-set/recovery-images.tar.gz
bash deploy/restore-isolated.sh /path/to/recovery-set /root/bitpype-recovery/NEW-UNUSED-DIRECTORY
```

The rehearsal refuses existing target directories/container names. It restores into separate files and a temporary MySQL container with network disabled, loads the dump, explicitly reloads MySQL privileges, checks restored tables, replaces raw SQLite files with online snapshots, and verifies their integrity and exact snapshot bytes. It retains original encryption keys, changes the app URL to a reserved test hostname, disables scheduler/IMAP dispatch through a rehearsal-only preload, starts the backed-up app image and checks health, shells and authentication rejection. It exposes no ports and stops/removes only its named rehearsal containers on exit. Recovered data and private logs remain in the protected rehearsal directory.

Run `deploy/recovery-encryption-check.cjs` inside the isolated backed-up app image with the restored environment and workspace mount to validate encrypted submissions without printing payloads. The completed rehearsal found no historical encrypted submission rows; a synthetic round-trip verified the restored key.

This verifies application recovery, not a full VPS disk restore or DNS/TLS failover. The backup is online and is not an atomic cross-MySQL/SQLite snapshot. Reissuing TLS certificates and testing a replacement host, off-host encrypted backup delivery, and live external integrations require separate checks. Do not enable outbound networking or background dispatch on recovered customer data.

## Remaining staging / CI work

The workflow at `.github/workflows/regression.yml` has pinned actions, read-only repository permissions, bounded execution, cancellation of superseded runs, and evidence upload on failure. Its equivalent commands passed on the VPS. It is not active in GitHub until the reviewed source snapshot and workflow are committed to the intended branch and a hosted run passes. The live checkout has substantial pre-existing uncommitted changes; do not stash/reset that checkout or blindly commit all files.

Still uncompleted: reconcile the reviewed source snapshot into GitHub; confirm a hosted CI run and required branch checks; provision dedicated staging domain/accounts/credentials for payment sandbox, SMTP/SMS sinks, OAuth callbacks, CAPTCHA and AI provider tests. Do not reuse production recipients, charges, webhooks or customer uploads for those tests. Provider tests must fail on missing test credentials, rather than quietly count skipped checks as passes.

References: [Docker reproducible build controls](https://docs.docker.com/build/ci/github-actions/reproducible-builds/), [Debian snapshot repositories](https://snapshot.debian.org/).
