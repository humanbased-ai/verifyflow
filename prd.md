# VerifyFlow PRD

## Summary

VerifyFlow validates whether a pull request delivers the scoped intent and acceptance criteria of its linked Linear ticket. It runs after a PR has been reviewed and marked merge-ready by Crosscheck, or independently through a standalone command.

VerifyFlow is not a code review agent. It is a delivery verification agent.

## Problem

Teams increasingly use agentic code review and CI to improve implementation quality. These systems can still miss product-delivery failures:

- code is technically sound but does not satisfy the ticket
- acceptance criteria are only partially covered
- UI implementation is present but disconnected from real backend behavior
- backend behavior works in isolation but fails inside a user journey
- integrations or downstream effects are not validated
- human evaluators lack durable evidence and repeatability

The result is a gap between "PR approved" and "ticket delivered."

## Goals

- Validate PR delivery against a linked Linear ticket.
- Convert acceptance criteria into evaluable checks.
- Support three simple evaluation depths: `functional`, `ui`, and `journey`.
- Produce evidence-backed verdicts.
- Integrate with standalone runs, Crosscheck, and Jazzband.
- Accumulate structured logs for quality intelligence.
- Recommend repo-wide and system-wide improvements over time.

## Non-Goals

- Replace Crosscheck or code review.
- Become a general-purpose test framework.
- Require every repository to use the same test stack.
- Guarantee correctness where acceptance criteria are missing or ambiguous.
- Mutate production data.
- Silently approve delivery without evidence.

## Users

- Engineering leads who want PRs validated against ticket outcomes.
- Product engineers who want fast feedback before merge.
- QA and release owners who need reproducible evidence.
- Agent orchestration systems such as Jazzband.
- Crosscheck workflows that need a post-review delivery gate.

## Primary Workflow

```text
Linear ticket -> PR -> Crosscheck review -> fix/recheck loop -> approval -> VerifyFlow -> delivery verdict
```

## Inputs

Required:

- Linear issue URL or issue key
- GitHub PR URL or repository plus PR number
- evaluation level: `functional`, `ui`, or `journey`

Optional:

- commit SHA
- execution backend: Codex, Claude Code, Antigravity, local, CI
- policy: advisory or merge gate
- app URL or preview deployment URL
- test account and fixture profile
- evidence storage target

## Outputs

Each run must produce:

- evaluation plan
- criterion-level verdicts
- holistic delivery verdict
- evidence artifacts
- structured event log
- human-readable Markdown report
- machine-readable JSON report

## Evaluation Levels

### functional

Validates implementation behavior below the UI.

Examples:

- API endpoint behavior
- service logic
- database persistence
- migrations
- validation and error handling
- auth and permission checks
- relevant automated tests

### ui

Validates issue-scoped user-facing behavior.

Examples:

- browser or mobile flow
- form submission
- visible success, error, empty, and loading states
- network calls
- screenshot and trace evidence
- persistence after refresh or reopen when relevant

### journey

Validates the broader product outcome across upstream, current, and downstream steps.

Examples:

- setup/precondition flow
- primary feature flow
- downstream status, notification, event, webhook, or persisted business result
- role-based or account-state variation
- neighboring regression checks

## Verdicts

Criterion-level verdicts:

- `pass`: criterion is satisfied with evidence
- `fail`: criterion is not satisfied
- `partial`: criterion is partially satisfied or only works in limited conditions
- `blocked`: environment, credential, dependency, or infrastructure issue prevented evaluation
- `not_evaluable`: criterion is too vague, missing, contradictory, or not observable

Run-level verdicts:

- `accept`
- `accept_with_risks`
- `needs_fix`
- `manual_review_required`

## Policies

Advisory policy:

- never blocks merge
- posts report and evidence
- logs quality data

Merge-gate policy:

- blocks when required acceptance criteria fail
- requires manual review for not-evaluable critical criteria
- distinguishes product failure from infrastructure failure

## Evidence Requirements

Every pass or fail must reference evidence.

Evidence may include:

- command output
- test report
- API response
- database assertion
- screenshot
- browser trace
- video
- console log
- network log
- device log
- link to CI artifact

## MVP Scope

The first implementation should target:

- GitHub PR intake
- Linear issue intake
- Markdown and JSON reports
- `functional` and `ui` levels
- Playwright-backed web UI evaluation
- local artifact storage
- JSONL event logging
- PR comment publishing

## Later Scope

- `journey` level
- mobile app evaluation through Maestro, Appium, or Detox
- artifact object storage
- trend dashboards
- automatic Linear issue creation for recurring quality problems
- multi-agent backend comparison
- Crosscheck and Jazzband native adapters

## Success Metrics

- percentage of approved PRs with evidence-backed delivery verdicts
- acceptance-criterion pass rate
- approved-but-not-delivered detection rate
- average time from Crosscheck approval to VerifyFlow verdict
- manual review escalation rate
- repeated failure pattern detection rate
- reduction in recurring delivery failures over time
