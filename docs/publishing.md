# Publishing

VerifyFlow is prepared to publish as `@humanbased-ai/verifyflow`.

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

- `NPM_TOKEN` with publish permission for `@humanbased-ai/verifyflow`
- `RELEASE_TOKEN` with permission to push release commits/tags to `main`
- optional `MAIL_USERNAME` and `MAIL_PASSWORD` if email release notifications are enabled later

GitHub environments:

- `alpha`: publishes `@alpha` from the `alpha` branch
- `staging`: publishes `@beta` from the `staging` branch
- `production`: approves and publishes `@latest` from `main`

## Channels

| Branch | npm tag | Use |
| --- | --- | --- |
| `alpha` | `alpha` | experimental cuts |
| `staging` | `beta` | post-review integration builds |
| `main` | `latest` | approved stable releases |

## Manual first publish

After `NPM_TOKEN` is configured, run the `Release` workflow manually with `exact_version` set to
the desired first version, for example `0.1.0`.

Then verify:

```bash
npm view @humanbased-ai/verifyflow version
npx @humanbased-ai/verifyflow doctor
```

