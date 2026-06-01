# VerifyFlow

VerifyFlow is an evidence-backed delivery evaluator for Linear-ticket-driven pull requests.

It answers one product-critical question:

> Does this PR actually deliver what the linked ticket asked for?

VerifyFlow is designed to run after a rigorous code-review workflow such as Crosscheck has marked a PR merge-ready. Crosscheck focuses on code review and implementation risk. VerifyFlow focuses on product delivery: acceptance criteria, user-visible behavior, integration fit, and proof.

## Why VerifyFlow

Modern teams already have linters, tests, CI, review agents, and human reviewers. Even then, PRs can be approved while still missing the ticket outcome:

- the backend works but the UI is disconnected
- the UI path exists but persistence fails after reload
- the implementation covers one role but breaks another
- the acceptance criteria were vague or only partially delivered
- an integration works in isolation but fails inside the larger workflow

VerifyFlow closes that gap by comparing the PR against the Linear ticket and producing a criterion-by-criterion verdict with evidence.

## Product Chain

VerifyFlow fits naturally into the HumanBased AI agent workflow:

```text
Jazzband -> Crosscheck -> VerifyFlow
```

- **Jazzband** orchestrates multi-agent work.
- **Crosscheck** drives PR review, fixes, rechecks, and merge-readiness.
- **VerifyFlow** validates PR-versus-ticket delivery with proof.

## Command Name And Alias

The product name is `verifyflow`.

The short alias is `vf`.

```bash
verifyflow run --linear ENG-123 --pr https://github.com/acme/app/pull/456 --level ui
vf run --linear ENG-123 --pr https://github.com/acme/app/pull/456 --level ui
```

Both commands should be equivalent.

## Evaluation Levels

VerifyFlow keeps evaluation depth intentionally simple:

| Level | Purpose | Typical Use |
| --- | --- | --- |
| `functional` | Validate API, service, data, auth, and backend behavior | Backend tickets, logic changes, API-only work |
| `ui` | Validate issue-scoped user-facing behavior | Frontend work, product surfaces, form flows |
| `journey` | Validate upstream, current, and downstream product outcomes | High-risk workflows, integrations, release-critical changes |

These levels answer progressively stronger questions:

```text
functional: does the capability work?
ui: can a user use the capability?
journey: does the complete product outcome work?
```

## Core Inputs

VerifyFlow starts from two source-of-truth links:

```text
Linear issue + GitHub PR
```

Example:

```bash
vf run \
  --linear https://linear.app/acme/issue/ENG-123/add-billing-rule \
  --pr https://github.com/acme/app/pull/456 \
  --level journey
```

## Core Outputs

Each run produces:

- an evaluation plan
- acceptance-criterion verdicts
- evidence artifacts such as logs, screenshots, traces, videos, API responses, and command output
- a holistic delivery verdict
- structured logs for long-term quality intelligence

Verdicts are intentionally explicit:

```text
pass
fail
partial
blocked
not_evaluable
```

## Trigger Modes

VerifyFlow should support three first-class trigger styles:

### Standalone

```bash
vf run --linear ENG-123 --pr 456 --level ui
```

Useful for manual validation, debugging, and ad hoc rechecks.

### Crosscheck Step

```yaml
steps:
  - crosscheck
  - verifyflow:
      level: ui
      policy: merge_gate
```

Useful when a PR has already passed rigorous code review and now needs delivery verification.

### Jazzband-Orchestrated

```json
{
  "workflow": "ticket_delivery_validation",
  "steps": ["crosscheck", "verifyflow"],
  "verifyflow": {
    "level": "journey",
    "policy": "evidence_required"
  }
}
```

Useful when VerifyFlow is one agent inside a broader Symphony/Jazzband workflow.

## Execution Backends

VerifyFlow owns the harness, policy, evidence contract, and report format. Native coding agents are execution backends, not the source of truth.

Supported backend direction:

- Codex
- Claude Code
- Antigravity
- deterministic local or CI runner

The primitive remains:

```text
ticket + PR + level -> evidence-backed delivery verdict
```

## Documentation

- [prd.md](prd.md) defines the product requirements.
- [architecture.md](architecture.md) describes the system architecture.
- [docs/evaluation-levels.md](docs/evaluation-levels.md) defines `functional`, `ui`, and `journey`.
- [docs/evidence-schema.md](docs/evidence-schema.md) defines the evidence and verdict contract.
- [docs/quality-intelligence.md](docs/quality-intelligence.md) describes logging, pattern detection, and repo-wide improvement recommendations.

## Status

VerifyFlow is at product definition stage. The initial implementation target is:

```text
GitHub PR + Linear issue + web app + Playwright-backed UI evidence
```
