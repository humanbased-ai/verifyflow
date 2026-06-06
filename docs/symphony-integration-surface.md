# Symphony integration surface (IN-562 discovery)

How Symphony invokes a post-Crosscheck step, and where VerifyFlow plugs in.
Investigated against `humanbased-ai/symphony` and `humanbased-ai/crosscheck` (2026-06-03).

## TL;DR

- **Crosscheck is not a Symphony step.** It is an external, webhook-driven reviewer. Symphony
  only *observes* its result by parsing PR comments for the machine annotation
  `<!-- crosscheck: ... verdict=APPROVE|NEEDS_WORK|BLOCK ... -->`
  (`symphony/acceptance.py` → `parse_crosscheck_verdict`).
- **The acceptance subsystem is off.** `AcceptanceConfig.enabled` defaults to `False`,
  `auto_merge=False` is hardcoded for phase 1, `bounce_back_on_fail` defaults to `False`
  (`symphony/config.py`). VerifyFlow must NOT depend on it.
- **Recommended insertion point:** a new, independent `verifyflow` hook in Symphony's PR-poll
  tick — a `_maybe_run_verifyflow()` parallel to `_maybe_run_acceptance()` in
  `symphony/runtime.py`, gated on a Crosscheck APPROVE for the current head SHA and de-duped
  per head SHA (same pattern as `_acceptance_judged_sha`).

## The invocation contract (what Symphony calls)

```
vf step --pr <pr-url> [--crosscheck-verdict <APPROVE|NEEDS WORK|BLOCK>]
```

- VerifyFlow resolves the linked Linear issue itself, from the PR body's `## Linear` link or
  the Linear branch-name format (`<user>/<team>-<number>-<slug>`). `--linear` overrides.
- It checks out the PR head, executes probes, writes report + evidence under
  `.verifyflow/runs/<runId>/`, and posts/updates the idempotent PR comment
  (`<!-- verifyflow:delivery-report -->`).
- **Advisory-only**: exit `0` whenever verification completed, regardless of verdict.
  Non-zero means operational failure (exit `2` usage, `1` fatal) — Symphony should log and
  move on, never block.
- stdout is exactly one JSON line (`StepSummary`, `src/cli/step.ts`):

```json
{"schemaVersion":1,"issue":"IN-569","repo":"owner/repo","prNumber":42,"commitSha":"…",
 "verdict":"accept","gateBlocked":false,
 "criteria":{"pass":2,"fail":0,"partial":0,"blocked":0,"not_evaluable":1},
 "runId":"IN-569_pr42_20260603070000","reportJson":"…","reportMarkdown":"…",
 "improvementSignal":"…(only when not fully delivered)","prCommentPosted":true}
```

- `--crosscheck-verdict` is recorded into `report.environment.crosscheckVerdict` for
  traceability. VerifyFlow does not gate on it — **timing is owned by the caller**.

## What the Symphony side needs (phase 1, PR 2 of IN-569)

1. Optional `verifyflow` config block in WORKFLOW.md front matter, default disabled —
   parallel to (not inside) `acceptance`:
   ```yaml
   verifyflow:
     enabled: true
     command: vf        # binary on PATH
     level: functional
     timeout_seconds: 900
   ```
2. `_maybe_run_verifyflow()` called from the PR-poll tick:
   - condition: Crosscheck APPROVE for the **current** head SHA (`parse_crosscheck_verdict`,
     staleness check on `sha == head_sha`);
   - dedup: run at most once per head SHA;
   - action: spawn `vf step --pr <url> --crosscheck-verdict <v>`, parse the JSON line, log it;
   - **no merge, no Linear state transition, no bounce-back dispatch** in phase 1.

## Why not the acceptance judge path

The judge (`acceptance_runtime.py`, `ClaudeCodeJudgeRunner`) reads the diff and *reasons* about
delivery; VerifyFlow *executes* and produces evidence. Wiring VerifyFlow as a judge
replacement would couple it to a disabled subsystem and to merge/bounce-back semantics that
are explicitly out of scope for phase 1. A parallel advisory hook keeps the responsibilities
separate: Crosscheck = code review, VerifyFlow = delivery verification, acceptance = (off).

## Exit-code & failure semantics for the caller

| Outcome | vf step exit | Symphony reaction |
|---|---|---|
| verification completed (any verdict) | 0 | log JSON, done — comment is already on the PR |
| usage / config error | 2 | log warning, do not retry until config changes |
| operational failure (crash, network) | 1 | log warning, retry on next poll tick (head-SHA dedup permits retry on failure) |

## Phase boundaries

- Phase 1 (this): execute → evidence → report → PR comment. Advisory only.
- Phase 2 (IN-564): Symphony consumes `improvement-signal.json` → dispatch fix agent → re-verify.
- Later: merge gating (`merge_gate`/`strict` stay CLI-only for now), Linear status transition
  (IN-565, behind flags, default off).
