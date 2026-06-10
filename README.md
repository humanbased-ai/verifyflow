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

## Quickstart

The fastest way to see a full run — no credentials, no checkout, fully offline:

```bash
npx github:humanbased-ai/verifyflow demo
```

`vf demo` runs bundled fixtures through the whole pipeline and writes a report you can read.

Then check your environment and (optionally) get a guided setup:

```bash
vf doctor      # are gh / claude / LINEAR_API_KEY / Playwright / a sandbox runtime ready?
vf onboard     # guided first-run setup; prints the exact fix command for anything missing
```

`vf onboard` can save your Linear key to `~/.verifyflow/credentials.json` (mode 0600). At runtime
`LINEAR_API_KEY` is resolved from the environment first, then that credentials file — so you never
have to export it again.

## Install

After the first npm release:

```bash
npm install -g @humanbased/verifyflow
vf doctor
```

Before npm publish, run straight from GitHub:

```bash
npx github:humanbased-ai/verifyflow doctor
npx github:humanbased-ai/verifyflow run \
  --fixtures fixtures/example-cli \
  --linear EX-1 \
  --pr example/greet#7 \
  --level functional
```

## Verify a PR — `vf run`

```bash
vf run \
  --linear IN-123 \
  --pr humanbased-ai/monorepo#456 \
  --level auto \
  --checkout \
  --comment
```

- `--linear` is optional: if omitted, VerifyFlow derives the issue from the PR body's Linear link
  or the branch name.
- `--checkout` clones the repo and checks out the PR head for real execution. Or point at an
  existing checkout with `--workdir <dir>`, or run offline with `--fixtures <dir>`.
- `--comment` posts the markdown report as a PR comment (idempotent — updates in place).
- `--linear-writeback` also posts the delivery verdict back to the linked Linear issue.

Preview what VerifyFlow would do without checking out or executing anything (exits 0):

```bash
vf run --linear IN-123 --pr humanbased-ai/monorepo#456 --level auto --dry-run
```

Verify a PR that has no resolvable ticket, against its own description (verdict capped at
`manual_review_required`):

```bash
vf run --pr humanbased-ai/monorepo#456 --allow-no-ticket
```

### Levels — `--level`

| Level | What it does | Needs |
| --- | --- | --- |
| `functional` | Command/test probes against a checkout | checkout/workdir |
| `ui` | AI-driven browser checks via Playwright | Playwright + a running app |
| `journey` | Multi-step end-to-end (backend + browser) | checkout + Playwright |
| `auto` | Picks the level from the ticket; downgrades to `functional` if no browser is available, and says why | — |

For `ui` / `journey`, point at the app with `--base-url <url>` (otherwise VerifyFlow tries to find a
deployment preview from the PR's checks), and supply an authenticated session with
`--ui-auth <storageState.json>` (create it with `playwright codegen --save-storage=auth.json`).

### Merge policy — `--policy`

| Policy | Behavior |
| --- | --- |
| `advisory` | Default. Reports only, never blocks. |
| `merge_gate` | Exits non-zero on `needs_fix`, so a failing verdict blocks merge. |
| `strict` | Also blocks on `manual_review_required` / `accept_with_risks`. |

## Other commands

| Command | What it does |
| --- | --- |
| `vf run` | Verify one PR against its Linear ticket (see above). |
| `vf step` | Orchestrator-facing step (Symphony/Jazzband): advisory-only, auto-resolves the issue, checks out + executes + comments, and prints one machine-readable JSON line to stdout. Never blocks. |
| `vf watch` | Independent daemon: watch a repo's Crosscheck-approved PRs, verify delivery, and (with `--auto-merge`) squash-merge on a clean `accept`. |
| `vf report` | Aggregate accumulated runs into quality metrics; `--trend`, `--since`, `--repo`, `--level`, `--json` filters. |
| `vf replay <runId>` | Re-run the verdict engine against a past run's stored evidence — no probes/tests re-execute. |
| `vf show <runId>` | Re-render a past run's `report.md` (or `report.json`). |
| `vf signal <runId>` | Pretty-print a past run's improvement-signal. |
| `vf memory` | Inspect reusable test-point memory: `vf memory ls`, `vf memory show <key>`, `vf memory clear [--repo <o/r>] [--yes]`. |
| `vf init` | Scaffold a `verifyflow.config.json` in the target repo (auto-detects npm / uv / go / cargo / make). |
| `vf doctor` | Check that the tools/env VerifyFlow relies on are ready. |
| `vf onboard` | Guided first-run setup; `--non-interactive` to skip prompts. |
| `vf demo` | Offline demo with bundled fixtures; `--open` to open the report. |

Full flag-by-flag reference: **[`docs/commands.html`](docs/commands.html)**. Run `vf --help` for the
same usage in the terminal.

Watch a repo's Crosscheck-approved PRs:

```bash
vf watch --repo humanbased-ai/monorepo --interval 120              # monitor + verify + comment
vf watch --repo humanbased-ai/monorepo --auto-merge --interval 120 # also squash-merge on accept
```

## What works today

- One Linear issue against one GitHub PR.
- Acceptance-criteria extraction from the Linear issue (or the PR description with `--allow-no-ticket`).
- `functional`, `ui`, `journey`, and `auto` levels.
- Real command/test execution against a checkout or workdir.
- Browser-backed UI and journey checks through Playwright.
- Markdown and JSON reports, screenshots, traces, command logs, and reusable test memory.
- Idempotent PR comments and optional Linear writeback.
- `advisory` / `merge_gate` / `strict` merge policies.
- Standalone CLI, orchestration step, and Crosscheck-approved watcher modes.
- Colorized terminal output in an interactive shell (auto-disabled when piped or under `NO_COLOR`).

VerifyFlow is conservative: uncertainty becomes `blocked` or `not_evaluable`, not a fake product
failure.

## Requirements

VerifyFlow stores no secrets. It reuses local tools and environment variables.

| Tool | Needed for | Required? |
| --- | --- | --- |
| Node.js >= 20 | CLI runtime | required |
| `gh` authenticated | GitHub PR context and comments | required |
| `LINEAR_API_KEY` (env or `~/.verifyflow/credentials.json`) | Linear issue reads | required (or use `--fixtures`) |
| `claude` authenticated | LLM planning and judging; otherwise rules-only fallback | optional |
| `docker` or `podman` | Sandbox isolation for executing PR code (IN-555); without it, probes run on the host | optional |
| Playwright | `ui` and browser-backed `journey` runs | optional |
| `npm`, `uv`, etc. | Target repo setup and tests | as the target needs |

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

## Toolchain fit

```text
Symphony / Jazzband -> Crosscheck -> VerifyFlow
orchestration          code review    delivery verification
```

Symphony is the current Python orchestration layer. Jazzband is the planned open TypeScript/npm
successor. VerifyFlow works with both, and also runs alone, by using public artifacts: GitHub PR
metadata, Linear issue links, SHA-bound comments, CLI JSON, and evidence files.

More detail:

- [Command reference](docs/commands.html)
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
