# Your side of the Arch repository setup

Everything in the repo is done. These are the steps only you can do, in order.
Nothing here is reversible-unfriendly; you can redo any of it.

## 1. Create the signing key (~5 min)

```bash
gpg --batch --gen-key <<'KEY'
Key-Type: eddsa
Key-Curve: ed25519
Name-Real: Toolport Repository
Name-Email: repo@toolport.app
Expire-Date: 0
%no-protection
KEY
```

Drop `%no-protection` if you want a passphrase; if you do, set
`REPO_GPG_PASSPHRASE` below.

Get the fingerprint:

```bash
gpg --list-keys --with-colons repo@toolport.app | awk -F: '/^fpr:/{print $10; exit}'
```

Export both halves:

```bash
gpg --armor --export repo@toolport.app > toolport.gpg          # public, goes in the bucket
gpg --armor --export-secret-keys repo@toolport.app > private.asc  # goes in GitHub secrets, then delete
```

## 2. Pin the fingerprint in the installer

`scripts/install.sh` has:

```
REPO_SIGNING_KEY="REPLACE_ME_WITH_THE_REPO_SIGNING_KEY_FINGERPRINT"
```

Replace it with the fingerprint from step 1. The installer refuses to run the
Arch path while the placeholder is there, so this cannot ship half-done.

## 3. Create the R2 bucket

- Bucket name: whatever you like, e.g. `toolport-arch`.
- Give it a public custom domain of `repo.toolport.app`.
- Create an R2 API token with **Object Read & Write** on that bucket.
- Upload the public key to the bucket root as `toolport.gpg` (from step 1).
  The installer fetches it from `https://repo.toolport.app/toolport.gpg`.

## 4. Add the GitHub secrets

Settings, Secrets and variables, Actions:

| secret                 | value                                                       |
| ---------------------- | ----------------------------------------------------------- |
| `REPO_GPG_PRIVATE_KEY` | contents of `private.asc`                                   |
| `REPO_GPG_PASSPHRASE`  | the passphrase, or leave unset if you used `%no-protection` |
| `R2_ACCOUNT_ID`        | Cloudflare account id                                       |
| `R2_ACCESS_KEY_ID`     | from the R2 API token                                       |
| `R2_SECRET_ACCESS_KEY` | from the R2 API token                                       |
| `R2_BUCKET`            | the bucket name                                             |

Then `shred -u private.asc`.

## 5. Publish the release, then run the workflow

The workflow refuses drafts and prereleases on purpose.

```bash
gh release edit v1.18.0 --draft=false
gh workflow run arch-repo.yml -f tag=v1.18.0 -f dry_run=true   # build only, publishes nothing
gh workflow run arch-repo.yml -f tag=v1.18.0                    # for real
```

Do the dry run first. It builds and validates the package without needing the
R2 secrets, so it tells you the PKGBUILD is right before any credentials matter.

## 6. Ship the installer

`toolport.app/install.sh` serves a **pinned commit**, not main. Until you move
`INSTALL_SCRIPTS_REF` in the site repo's `worker/index.js` to the commit that
contains the Arch branch, the one-liner keeps serving the old script and none of
this reaches anyone.

## 7. Verify on a clean machine

```bash
curl -fsSL https://toolport.app/install.sh | bash
pacman -Q toolport
sudo pacman -Syu          # should offer nothing; you are current
```

## Later, not now

- **Omarchy inclusion.** Once they carry it, `omarchy-update` covers Toolport
  and even the one-time repo step disappears.
- **In-app update notice.** The GTK build has no version check at all, so a user
  only learns about a new version when pacman tells them. That is fine once the
  repo exists, but a passive notice would be better.
- **Old versions.** The workflow merges into the existing database, so previous
  versions stay installable. Nothing prunes the bucket; if it grows, delete old
  `.pkg.tar.zst` files and re-run the workflow to rebuild the database.
