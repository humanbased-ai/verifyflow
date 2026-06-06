# End-to-End Leveled Auto Evaluation

VerifyFlow's long-term goal is to produce evidence-backed validation reports for a scoped product
change with minimal human coordination.

```text
Linear project or issue scope
  + linked GitHub PRs
  + implementation artifacts
  + optional deployment or local app
  -> leveled validation plan
  -> execution evidence
  -> gap analysis
  -> actionable report
```

The current product verifies one issue against one PR. The next product layer verifies a complete
Linear project by mapping tickets to PRs and producing a project-level report.

## Current scope

The implemented pipeline can already:

- load one Linear issue and one GitHub PR
- extract acceptance criteria from the issue
- choose `functional`, `ui`, `journey`, or `auto`
- execute real probes/tests/browser steps
- collect command logs, test reports, screenshots, browser traces, and verdict inputs
- produce `report.md`, `report.json`, `improvement-signal.json`, and reusable memory
- comment on the PR and optionally comment on the Linear issue

This is enough for a ticket-level verification gate.

## Target scope

Project-level evaluation should add:

- Linear project ingestion: list scoped tickets, states, priorities, labels, and descriptions
- PR mapping: identify merged/open PRs linked from issue descriptions, PR bodies, branch names,
  GitHub references, or hidden orchestration markers
- coverage matrix: ticket -> PR -> criteria -> evidence -> verdict
- leveled plan generation: decide whether each ticket needs `functional`, `ui`, or `journey`
- dry-run/smoke-test setup: use sandbox users, test data, mock payments, and safe event fixtures
- report synthesis: summarize implemented, unimplemented, blocked, risky, and out-of-scope work
- follow-up issue suggestions: create or update Linear issues only when explicitly enabled

## Report levels

| Level | Purpose | Evidence |
| --- | --- | --- |
| Project readiness | Are all scoped tickets represented by PRs and verification runs? | ticket/PR matrix, missing links, stale SHAs |
| Functional | Do APIs, services, data, and business rules work? | commands, tests, API calls, logs |
| UI | Can a user complete the visible workflow? | screenshots, browser traces, console/network observations |
| Journey | Does the full user/business outcome complete across upstream and downstream systems? | setup steps, browser flow, async polls, downstream assertions |
| Gap analysis | What remains unimplemented, unverified, risky, or ambiguous? | failed/blocked criteria, ticket quality notes, improvement signals |

## Planned CLI shape

```bash
vf project plan \
  --linear-project "Finance OS Layer" \
  --repo humanbased-ai/monorepo \
  --out .verifyflow

vf project verify \
  --linear-project "Finance OS Layer" \
  --repo humanbased-ai/monorepo \
  --level auto \
  --checkout \
  --comment

vf project report \
  --linear-project "Finance OS Layer" \
  --out .verifyflow \
  --json
```

`plan` should execute nothing. `verify` should run the selected per-ticket checks. `report` should
aggregate stored run outputs without re-executing.

## Relationship to Symphony, Crosscheck, and Jazzband

VerifyFlow owns delivery verification.

Crosscheck owns code review and merge-readiness. VerifyFlow may wait for a Crosscheck APPROVE, but
it should not read Crosscheck's private config or logs.

Symphony owns orchestration and coding-agent dispatch today. The orchestration layer is expected to
be refactored into Jazzband, an open JavaScript implementation. VerifyFlow should work both with
Symphony/Jazzband and without them by relying on explicit public contracts:

- GitHub PR body links to Linear issue/project metadata
- Crosscheck posts a SHA-bound review annotation
- VerifyFlow posts a SHA-bound delivery annotation
- each tool exposes a small JSON CLI status contract

Each tool keeps independent config, state, logs, and lifecycle.

## What remains deliberately out of scope

- reviewing code style, maintainability, or security posture as a reviewer
- deciding which tickets should be built next
- dispatching coding agents
- applying production side effects such as real payments, real emails, or irreversible data changes
- replacing CI
- storing all artifacts forever in object storage
- native mobile app verification

These may integrate around VerifyFlow, but they are not part of the core delivery-verification
contract.

