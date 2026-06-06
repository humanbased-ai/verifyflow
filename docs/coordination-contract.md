# Coordination Contract

VerifyFlow, Crosscheck, and Symphony/Jazzband should cooperate through public artifacts, not
private state.

## Responsibilities

| Tool | Owns | Does not own |
| --- | --- | --- |
| Symphony / Jazzband | ticket orchestration, coding-agent dispatch, workflow retries | code review verdicts, delivery verification evidence |
| Crosscheck | PR review, merge-readiness, fix/recheck review loop | acceptance-criteria execution |
| VerifyFlow | delivery verification, evidence, criterion-level verdicts | coding-agent dispatch, code review |

## Independent state

Each tool keeps its own config and logs:

- Symphony: `~/.symphony/` or the future Jazzband config directory
- Crosscheck: `~/.crosscheck/`
- VerifyFlow: `~/.verifyflow/` for global settings and `--out` for run artifacts

No tool should parse another tool's private logs or config.

## Public handoff

Use GitHub PR artifacts and JSON CLI output:

```text
Symphony/Jazzband creates or updates PR
  -> PR links Linear issue/project metadata
Crosscheck reviews current head SHA
  -> PR comment/status says APPROVE or NEEDS_WORK for that SHA
VerifyFlow verifies current head SHA
  -> PR comment/status says accept, accept_with_risks, needs_fix, or manual_review_required
Symphony/Jazzband observes public result
  -> merge, retry, or dispatch fix according to workflow policy
```

Recommended hidden markers:

```html
<!-- crosscheck: type=review verdict=APPROVE sha=<head_sha> reviewer=<agent> origin=<agent> -->
<!-- verifyflow:delivery-report issue=<issue_id> sha=<head_sha> verdict=<verdict> run=<run_id> -->
```

## CLI contracts

The long-term contracts should be:

```bash
crosscheck status <pr-url> --json
vf step --pr <pr-url> --json
symphony pr-status <issue-id|pr-url> --json
```

`vf step` already prints one JSON line for orchestrators. The contract should remain stable as
Symphony is refactored into Jazzband.

## Failure semantics

- SHA mismatch means stale result; do not advance.
- Crosscheck non-APPROVE does not trigger VerifyFlow.
- VerifyFlow advisory verdict posts evidence but does not merge or mutate Linear by default.
- Operational failures are owned by the tool that failed and should be retried according to that
  tool's policy.
- Delivery failures should produce `improvement-signal.json`; Symphony/Jazzband may use it to
  dispatch a fix agent.

