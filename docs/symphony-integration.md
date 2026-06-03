# Running VerifyFlow in the Symphony → Crosscheck → VerifyFlow pipeline

Phase-1 setup (IN-569): VerifyFlow runs as an **advisory** step after Crosscheck approves a
PR. It really executes the PR (checkout → probes → evidence), keeps the report + artifacts,
and comments the report back on the PR. It never merges, never blocks, never transitions
Linear state.

```
Symphony (orchestrator) ──dispatch──▶ coding agent ──▶ PR
        │                                              │
        │                    Crosscheck (webhook) reviews ──▶ verdict comment
        │                                              │
        └─ PR poll tick: crosscheck APPROVE? ──▶ vf step --pr <url> ──▶ delivery report comment
                                                       └─ evidence kept in .verifyflow/runs/<runId>/
```

## Prerequisites

On the machine running Symphony:

- `vf` on PATH (`npm install && npm run build`, then link `dist/cli/main.js`, or `npm i -g`).
- `gh` authenticated for the target repos (checkout, comments).
- `LINEAR_API_KEY` exported (criteria source; also enables `--linear-writeback` later).
- `claude` CLI authenticated (probe generation; falls back to rules-only without it).
- Crosscheck `watch`/`serve` running for the repo (its PR comment carries the verdict
  annotation Symphony keys on).

## Enable the step

In the project's WORKFLOW.md front matter (Symphony side, phase-1 wiring — see
`docs/symphony-integration-surface.md` for the contract):

```yaml
verifyflow:
  enabled: true
  command: vf
  level: functional
  timeout_seconds: 900
```

## Manual / standalone invocation

The same step Symphony runs can be invoked by hand on any PR whose branch or body links a
Linear issue:

```sh
vf step --pr https://github.com/owner/repo/pull/42
# with the crosscheck verdict recorded for traceability:
vf step --pr https://github.com/owner/repo/pull/42 --crosscheck-verdict APPROVE
# skip the PR comment (e.g. trial runs):
vf step --pr https://github.com/owner/repo/pull/42 --no-comment
```

stdout is a single JSON line (see `StepSummary` in `src/cli/step.ts`); human-readable
progress goes to stderr; the full markdown/JSON reports and all evidence land under
`.verifyflow/runs/<runId>/`.

`vf step` is advisory by design — it exits 0 for every completed verification, whatever the
verdict. For local gating (CI etc.) use `vf run --policy merge_gate|strict` instead.

## What lands where

| Artifact | Location |
|---|---|
| delivery report (md + json) | `.verifyflow/runs/<runId>/report.{md,json}` |
| probe/test evidence | `.verifyflow/runs/<runId>/artifacts/` |
| bounce-back signal (phase 2 input) | `.verifyflow/runs/<runId>/improvement-signal.json` |
| PR comment (idempotent, updated in place) | the PR, marker `<!-- verifyflow:delivery-report -->` |
| quality-intelligence events | `.verifyflow/events.jsonl` (`vf report` aggregates) |
| reusable test points / failure modes | `.verifyflow/memory/<repo-slug>/` |
