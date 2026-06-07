# VerifyFlow

Evidence-backed delivery verification for Linear-driven pull requests.

VerifyFlow answers one question:

> Did this PR actually deliver what the linked ticket asked for?

It is not code review. Crosscheck reviews code and merge readiness; VerifyFlow runs after that,
executes the ticket acceptance criteria, captures evidence, and reports the delivery verdict.

```text
Linear issue + GitHub PR -> execution evidence -> delivery verdict
```

The CLI is `verifyflow`, with the short alias `vf`.

## Install

After the first npm release:

```bash
npm install -g @humanbased-ai/verifyflow
vf doctor
```

Before npm publish, run from GitHub:

```bash
npx github:humanbased-ai/verifyflow doctor
npx github:humanbased-ai/verifyflow run \
  --fixtures fixtures/example-cli \
  --linear EX-1 \
  --pr example/greet#7 \
  --level functional
```

## Use

Verify a real PR:

```bash
vf run \
  --linear IN-123 \
  --pr humanbased-ai/monorepo#456 \
  --level auto \
  --checkout \
  --comment
```

Preview what VerifyFlow would do without checking out or executing:

```bash
vf run --linear IN-123 --pr humanbased-ai/monorepo#456 --level auto --dry-run
```

Run as an orchestrator step:

```bash
vf step --pr https://github.com/humanbased-ai/monorepo/pull/456
```

Watch Crosscheck-approved PRs:

```bash
vf watch --repo humanbased-ai/monorepo
```

## What Works Today

- One Linear issue against one GitHub PR.
- Acceptance-criteria extraction from the Linear issue.
- `functional`, `ui`, `journey`, and `auto` levels.
- Real command/test execution against a checkout or workdir.
- Browser-backed UI and journey checks through Playwright.
- Markdown and JSON reports, screenshots, traces, command logs, and reusable test memory.
- Idempotent PR comments and optional Linear writeback.
- Standalone CLI, orchestration step, and Crosscheck-approved watcher modes.

VerifyFlow is conservative: uncertainty becomes `blocked` or `not_evaluable`, not a fake product
failure.

## Requirements

VerifyFlow stores no secrets. It reuses local tools and environment variables.

| Tool | Needed for |
| --- | --- |
| Node.js >= 20 | CLI runtime |
| `gh` authenticated | GitHub PR context and comments |
| `LINEAR_API_KEY` | Linear issue reads |
| `claude` authenticated | LLM planning and judging; otherwise rules-only fallback |
| Playwright | `ui` and browser-backed `journey` runs |
| `npm`, `uv`, etc. | Target repo setup and tests |

## Roadmap

Next major layer: project-level verification.

```text
Linear project -> ticket/PR matrix -> leveled runs -> evidence bundle -> project report
```

Planned work:

- Read a Linear project and map tickets to PRs.
- Generate a coverage matrix across tickets, criteria, PRs, SHAs, and evidence.
- Run per-ticket functional/UI/journey checks.
- Produce one project-level implementation gap report.
- Keep stronger sandbox isolation for untrusted PR execution.
- Add opt-in Linear status transitions and follow-up issue filing.

## Boundaries

VerifyFlow does not:

- review code or decide merge readiness; that is Crosscheck
- decompose tickets or dispatch coding agents; that is Symphony today and Jazzband next
- move money, send production email, or perform irreversible side effects
- replace CI
- provide native mobile evaluation yet

## Toolchain Fit

```text
Symphony / Jazzband -> Crosscheck -> VerifyFlow
orchestration          code review    delivery verification
```

Symphony is the current Python orchestration layer. Jazzband is the planned open TypeScript/npm
successor. VerifyFlow should work with both, and also run alone, by using public artifacts:
GitHub PR metadata, Linear issue links, SHA-bound comments, CLI JSON, and evidence files.

More detail:

- [End-to-end auto evaluation](docs/end-to-end-auto-evaluation.md)
- [Coordination contract](docs/coordination-contract.md)
- [Publishing](docs/publishing.md)
- [UI level](docs/ui-level.md)

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```
