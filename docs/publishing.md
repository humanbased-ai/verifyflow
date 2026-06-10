# Publishing

VerifyFlow is prepared to publish as `@humanbased/verifyflow`.

## Local preflight

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The package exposes both commands:

```bash
verifyflow --help
vf --help
```

## GitHub secrets and environments

The release workflows expect:

- `NPM_TOKEN` with publish permission for `@humanbased/verifyflow`
- `RELEASE_TOKEN` with permission to push release tags and create GitHub releases
- optional `MAIL_USERNAME` and `MAIL_PASSWORD` if email release notifications are enabled later

GitHub environments:

- `alpha`: publishes `@alpha` from the `alpha` branch
- `staging`: publishes `@beta` from the `staging` branch
- `production`: approves and publishes `@latest` from `main`

Before the first release, verify the npm token locally or from a temporary shell:

```bash
npm whoami --registry=https://registry.npmjs.org/
```

Then store it in GitHub Actions:

```bash
gh secret set NPM_TOKEN --repo humanbased-ai/verifyflow
```

The stable release workflow stamps the package version in the runner and publishes that stamped
workspace; it does not write version-bump commits to `main`. It prepares and dry-runs the release
tag before publishing, then pushes the `vX.Y.Z` tag after npm accepts the package. The tag is the
GitHub-side release marker.

## Channels

| Branch | npm tag | Use |
| --- | --- | --- |
| `alpha` | `alpha` | experimental cuts |
| `staging` | `beta` | post-review integration builds |
| `main` | `latest` | approved stable releases |

## Manual first publish

After `NPM_TOKEN` is configured, run the `Release` workflow manually with `exact_version` set to
the desired first version, for example `0.1.0`.

```bash
gh workflow run Release \
  --repo humanbased-ai/verifyflow \
  --ref main \
  -f exact_version=0.1.0
```

Automatic `main` push releases are disabled until a stable `vX.Y.Z` tag exists. This prevents the
first merge after adding the workflow from publishing a default initial version instead of the
package's intended `0.1.0` seed. After the manual first publish creates `v0.1.0`, subsequent pushes
to `main` can publish by conventional commit detection.

Watch and verify:

```bash
gh run list --repo humanbased-ai/verifyflow --workflow Release --limit 1
npm view @humanbased-ai/verifyflow version
npx @humanbased-ai/verifyflow doctor
```
