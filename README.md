# VerifyFlow

**Evidence-backed delivery verification for ticket-driven pull requests.**

VerifyFlow answers one question that linters, tests, CI, and code review leave open:

> Does this PR actually deliver what its linked Linear issue asked for?

It is **not** a code-review tool. It runs *after* review (e.g. Crosscheck) has judged a PR
merge-ready, then checks out the PR, **executes** the acceptance criteria against the running
code or UI, captures evidence, and produces a criterion-by-criterion delivery verdict.

```
Linear issue + GitHub PR + level  →  real execution  →  evidence  →  delivery verdict
```

The command is `verifyflow`, aliased to `vf`.

---

## Quickstart — 3 steps

The shortest path for someone trying VerifyFlow for the first time:

```bash
# 1. Check your toolchain (Node ≥ 20, gh, claude, LINEAR_API_KEY)
npx github:humanbased-ai/verifyflow doctor

# 2. Guided first-run setup — interactive wizard fills the rest in
npx github:humanbased-ai/verifyflow onboard

# 3. Verify a real PR
npx github:humanbased-ai/verifyflow run \
  --linear IN-318 \
  --pr https://github.com/acme/app/pull/69 \
  --level auto \
  --checkout --comment
```

`onboard` is the friendliest entry point — it walks new users through tool
checks, credentials, and a first verification run. The sections below cover
the full install and option surface.

---

## Where it fits

VerifyFlow is the last gate in the HumanBased delivery chain:

```
Symphony (orchestration)  →  Crosscheck (code review, merge-readiness)  →  VerifyFlow (delivery verification)
```

Symphony is the current orchestration layer. It is expected to be refactored into **Jazzband**,
an open JavaScript implementation of the same workflow idea. VerifyFlow should remain useful
before and after that refactor: it talks through GitHub PR metadata, Linear issues, CLI JSON, and
evidence files rather than through Symphony internals.

It runs three ways:

- **Standalone** — `vf run …` for manual validation and debugging.
- **Orchestrated step** — `vf step …`, the advisory adapter Symphony invokes after Crosscheck
  (auto-resolves the Linear issue, executes, comments back on the PR, prints one JSON line).
- **Watcher** — `vf watch …`, an independent daemon that watches Crosscheck-approved PR heads
  and verifies them once per SHA.
- **Library** — the pipeline (`src/core/pipeline.ts`) behind the commands.

---

## Install

When published to npm:

```bash
npm install -g @humanbased-ai/verifyflow
vf doctor
```

Until the first npm release is published, run directly from GitHub:

No clone, no build — run it straight from GitHub with `npx` (Node ≥ 20):

```bash
# 1. Check your environment is ready (gh / claude / LINEAR_API_KEY / playwright)
npx github:humanbased-ai/verifyflow doctor

# 2. Try it offline with bundled fixtures — zero credentials needed
npx github:humanbased-ai/verifyflow run \
  --fixtures fixtures/example-cli --linear EX-1 --pr example/greet#7 --level functional

# 3. Verify a real PR (needs gh auth + LINEAR_API_KEY)
npx github:humanbased-ai/verifyflow run \
  --linear IN-123 --pr owner/repo#456 --level functional --checkout --comment
```

`npx` builds the CLI on first fetch (via the `prepare` script) and exposes the `vf` /
`verifyflow` commands. Pin a version with `npx github:humanbased-ai/verifyflow#<tag>`.

> Working in a clone instead? See [Local development](#local-development) below.

---

## What it can do today

- Verify one Linear issue against one GitHub PR.
- Use the Linear issue as the source of acceptance criteria.
- Infer the linked Linear issue from PR body or branch name when possible.
- Run `functional`, `ui`, `journey`, or `auto` evaluation.
- Execute real commands/tests against a checkout or existing workdir.
- Drive a browser with Playwright for UI and browser-backed journey checks.
- Capture command logs, test output, screenshots, browser traces, markdown reports, JSON reports,
  quality events, and reusable test-point memory.
- Post/update an idempotent PR comment with the delivery report.
- Optionally post a Linear comment with the verdict.
- Run standalone (`vf run`), as an orchestrated step (`vf step`), or as a watcher (`vf watch`).
- Stay conservative: uncertainty becomes `blocked` or `not_evaluable`, not a false product fail.

## Planned next

- Project-level verification: read a Linear project, map tickets to PRs, run leveled verification
  per ticket, and publish one end-to-end project report.
- A formal coordination contract for Symphony, Crosscheck, and VerifyFlow with separate configs,
  logs, state, and SHA-bound PR annotations.
- Stronger sandbox isolation for untrusted PR execution: container filesystem boundaries and
  network egress controls, beyond the current secret-stripping environment isolation.
- Live Linear status transitions behind explicit flags.
- Operation video capture for UI/journey runs.
- Opt-in Linear issue filing for recurring systemic quality patterns.

## Out of current scope

- Code review and merge-readiness. That belongs to Crosscheck.
- Ticket decomposition and coding-agent dispatch. That belongs to Symphony today and Jazzband in
  the planned open JavaScript implementation.
- Moving money, sending production emails, or performing irreversible side effects during
  verification. Use dry-run/smoke-test fixtures and sandbox data.
- Mobile-native evaluation, multi-agent backend benchmarking, dashboards, and long-term artifact
  object storage. These are useful adjacent areas, but not required for the current VerifyFlow
  contract.

---

## Prerequisites

VerifyFlow stores **no secrets**. It reuses CLIs you have already installed and authorized:

| Tool | Used for | Required |
| --- | --- | --- |
| Node.js ≥ 20 | runtime | yes |
| `gh` (authenticated) | GitHub PR context, posting comments | yes (live mode) |
| `claude` (authenticated) | LLM backend (criteria parsing, judging, UI agent) | recommended* |
| `LINEAR_API_KEY` env var | reading the Linear issue (the criteria source) | yes (live mode) |
| `uv` / `npm` / … | running the target repo's setup & tests | per target repo |
| `playwright` (+ browser) | `ui` / `journey` level browser checks | only for browser steps; an optional dependency (auto-installed by `npm install`), browsers via `npx playwright install` |

*Without `claude`, VerifyFlow falls back to a deterministic rules-only backend (reduced quality,
never a hard failure). Offline runs can replace GitHub/Linear with fixtures (`--fixtures`).

### Local development

Working from a clone (contributors, or to run from source):

```bash
npm install            # also builds dist/ via the prepare script
npm run build          # recompile dist/ after changes (provides the vf / verifyflow bins)
# or run from source without building:
npm run vf -- run --help
```

For `ui` / `journey` browser checks — `playwright` is an optional dependency, so `npm install`
already pulls the library; you only need to download the browser binary:

```bash
npx playwright install chromium
# (if the optional dep was skipped, e.g. --no-optional: npm i -D playwright first)
```

`vf doctor` reports whether Playwright is importable and prints this hint when it isn't.

---

## Quick start

**Functional** (backend / logic / API; real test execution against the checked-out PR):

```bash
vf run \
  --linear IN-318 \
  --pr https://github.com/acme/app/pull/69 \
  --level functional \
  --checkout \
  --comment
```

**UI** (AI-driven browser verifies user-visible behavior; needs a running app):

```bash
vf run \
  --linear IN-123 \
  --pr https://github.com/acme/app/pull/45 \
  --level ui \
  --base-url http://localhost:3000
```

If `--base-url` is omitted, VerifyFlow tries to discover a deployment preview from the PR's
GitHub checks. See [docs/ui-level.md](docs/ui-level.md).

---

## Commands

### `vf run` — standalone verification

```
vf run --linear <KEY|url> --pr <url|owner/repo#N|#N> --level <functional|ui|journey|auto> [options]
```

| Option | Meaning |
| --- | --- |
| `--linear <KEY\|url>` | Linear issue — the **primary** acceptance-criteria source. If omitted, derived from the PR body's Linear link. |
| `--pr <ref>` | GitHub PR URL, `owner/repo#N`, or `#N` (with `--workdir`/repo context). |
| `--level <level>` | `functional`, `ui`, `journey`, or `auto`. |
| `--base-url <url>` | Running app URL for `ui` checks (else preview auto-discovery). |
| `--ui-auth <file>` | Playwright `storageState` JSON for an authenticated `ui` session. |
| `--checkout` | Clone the repo and check out the PR head for real execution. |
| `--workdir <dir>` | Use an existing checkout instead of cloning. |
| `--policy <p>` | `advisory` (default, never blocks) · `merge_gate` (blocks on `needs_fix`) · `strict` (also blocks on `manual_review_required` / `accept_with_risks`). |
| `--comment` | Post/update the markdown report as a PR comment (idempotent). |
| `--linear-writeback` | Post the verdict back to the linked Linear issue. |
| `--fixtures <dir>` | Offline: read `issue.json` / `pr.json` from `<dir>`. |
| `--no-sandbox` | Pass host env (incl. secrets) to probes. Default strips secrets. |
| `--allow-no-ticket` | Degraded mode: verify against the PR's own description; verdict capped at `manual_review_required`. |
| `--out <dir>` | Output root for reports/artifacts/memory (default `./.verifyflow`). |
| `--model <m>` | Model for the `claude` backend. |
| `--dry-run` | Resolve criteria + build the plan and print it, **without executing** anything (no checkout). Cost-free "how would it verify this?" inspection; exits `0`. Combine with `--json` for a machine-readable preview. |

Exit code is `0` unless a gating policy blocks the merge (then `1`).

### `vf step` — orchestrator adapter (Symphony, advisory)

```
vf step --pr <url> [--crosscheck-verdict <v>] [--no-comment]
```

Advisory-only: defaults to live checkout + PR comment, auto-resolves the Linear issue from the
PR body or branch name, runs verification, and prints exactly one machine-readable JSON line to
stdout for the orchestrator. Exits `0` whenever verification completed (never gates).

### `vf watch` — independent Crosscheck-approved PR watcher

```
vf watch --repo <owner/repo> [--auto-merge] [--interval <seconds>] [--level <level>]
```

Watches open PRs, waits for the newest Crosscheck comment to approve the current head SHA, runs
VerifyFlow once per head, and optionally squash-merges only on `accept`. This keeps VerifyFlow
usable without Symphony/Jazzband while still interoperating with Crosscheck.

### `vf report` — quality-intelligence metrics

```
vf report [--out <dir>] [--json] [--since <date>] [--repo <owner/repo>] [--level <l>] [--trend]
```

Aggregates accumulated run events (`<out>/events.jsonl`) into metrics: acceptance-criterion pass
rate, not-evaluable rate, failure rate by component/level, probe reuse rate, and recurring
failure patterns. `--since` / `--repo` / `--level` scope the metrics to a subset of events;
`--trend` appends a per-day run-verdict trend.

### `vf memory` — inspect / prune the reusable test-point memory

```
vf memory ls                            # repos with stored test points + counts
vf memory show <key>                    # dump a single test point by id
vf memory clear [--repo <o/r>] [--yes]  # prune one repo's memory, or all (confirms unless --yes)
```

The memory is the "gets smarter as it runs" moat — probes captured on one run are reused on the
next. These subcommands view and prune the on-disk store under `<out>/memory/`.

### `vf replay <runId>` — re-run the verdict engine on stored evidence

```
vf replay <runId> [--out <dir>] [--json]
```

Re-derives a verdict from a past run's saved evidence (`<runId>/verdict-inputs.json`) **without
re-executing any probe or test** — cheap, repeatable iteration on verdict/judging logic.

### `vf show <runId>` / `vf signal <runId>` — review a past run

```
vf show   <runId> [--out <dir>] [--json]   # re-render the stored report.md / report.json
vf signal <runId> [--out <dir>] [--json]   # pretty-print improvement-signal.json
```

### `vf doctor` — environment readiness

```
vf doctor
```

Reports whether `gh`, `claude`, `uv`, and `LINEAR_API_KEY` are present, plus a Docker/Podman line
(sandbox isolation for executing PR code) and a Playwright line (`--level ui` browser checks).
Missing **required** tools exit non-zero; optional ones only warn.

---

## Evaluation levels

| Level | Question | Status |
| --- | --- | --- |
| `functional` | Does the capability work? (API, logic, data, auth, tests) | **Implemented** — real checkout + execution + evidence. |
| `ui` | Can a user use it? (browser flow, visible states) | **Implemented** — AI agent drives a real browser (Playwright); conservative verdicts. |
| `journey` | Does the whole product outcome work? (upstream→downstream) | **Implemented** — agentic multi-modal executor (backend shell steps + browser); async/downstream poll + variation/regression guidance. |

---

## Verdicts

**Per criterion:** `pass` · `fail` · `partial` · `blocked` (environment/credential issue) ·
`not_evaluable` (criterion too vague, missing, or unobservable).

**Per run:** `accept` · `accept_with_risks` · `needs_fix` · `manual_review_required`.

A core design rule keeps VerifyFlow trustworthy: it never turns its own uncertainty into a
failure. A probe whose command is quoted in the ticket is **authoritative** (its failure is a
real `fail`); an agent-invented probe only **corroborates** (its failure → `not_evaluable`,
never `fail`). UI checks follow the same rule — element-not-found, timeout, a login wall, or an
unreproduced failure all map to `blocked`, never a false `fail`.

---

## How it works

```
context (Linear issue + GitHub PR)
  → parse acceptance criteria
  → plan (level-aware; reuse remembered test points)
  → execute (command runner for functional · AI browser for ui · multi-step executor for journey)
  → collect evidence (command output, test reports, screenshots)
  → verdict engine (separates product failure / harness failure / environment / ambiguity)
  → report (markdown + JSON) + idempotent PR comment + optional Linear write-back
  → quality-intelligence event log + reusable memory
```

When a PR does not fully deliver, VerifyFlow also emits a machine-consumable
`improvement-signal.json` (per-criterion expected/observed/probe/evidence) so an orchestrator can
feed it back to a coding agent to fix the PR — the "bounce-back" loop.

---

## Output

Each run writes under `--out` (default `.verifyflow/runs/<runId>/`):

- `report.md` — human-readable report
- `report.json` — machine-readable report
- `artifacts/` — command logs, test reports, UI screenshots (referenced from the report)
- `improvement-signal.json` — bounce-back signal (only when something didn't fully deliver)

Plus, at the `--out` root: `events.jsonl` (quality-intelligence log) and reusable test-point
memory.

---

## Documentation

- [prd.md](prd.md) — product requirements
- [architecture.md](architecture.md) — system architecture
- [docs/evaluation-levels.md](docs/evaluation-levels.md) — `functional` / `ui` / `journey`
- [docs/end-to-end-auto-evaluation.md](docs/end-to-end-auto-evaluation.md) — long-term project-level report design
- [docs/evidence-schema.md](docs/evidence-schema.md) — evidence & verdict contract
- [docs/ui-level.md](docs/ui-level.md) — AI-driven UI verification
- [docs/symphony-integration.md](docs/symphony-integration.md) — wiring VerifyFlow into Symphony
- [docs/publishing.md](docs/publishing.md) — npm publishing and release workflow
- [docs/quality-intelligence.md](docs/quality-intelligence.md) — metrics & pattern detection

---

## Status

All three verification levels (`functional`, `ui`, `journey`) are implemented and validated
end-to-end. `functional` runs real checkout + test execution; `ui` drives a real browser via an
AI-powered Playwright agent; `journey` runs an agentic multi-modal executor (backend shell steps +
browser) with async/downstream poll support. A few robustness items remain in progress (full
container sandbox isolation, local-serve auto-start) — see the VerifyFlow project in Linear.
