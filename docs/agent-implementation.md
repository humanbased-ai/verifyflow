# VerifyFlow agent — implementation (functional MVP)

This is the first runnable implementation of the agent defined in `prd.md` / `architecture.md`.
It is a **delivery verification agent**: it judges whether a PR delivers the intent + acceptance
criteria of its linked **Linear issue**. It does **not** review code quality / hunt for bugs.

## What it does today

- **Standalone**: runs from a Linear issue + GitHub PR (`vf run --linear … --pr …`).
- **Linear is the source of truth** for acceptance criteria; the PR is reference context only.
- **Real execution**: checks out the PR and runs real commands (probes + the PR's changed tests),
  capturing stdout/stderr/exit code as addressable evidence. No verdict without evidence.
- **Memory / feed-back**: every executed probe is persisted as a reusable *test point* and reused
  on later runs; failure modes accumulate. This is the difference from a stateless judge
  (Karpathy: keep memory, not just a score).
- **Records everything**: per-run `report.md` + `report.json`, `artifacts/*.log` evidence, and an
  append-only `events.jsonl` quality-intelligence log.

Levels: `functional` only for now (`ui`/`journey` are rejected with a clear message).

## Pipeline (maps 1:1 to architecture.md)

```
trigger (CLI)
  → Context: GitHub PR (gh, reference)  +  Linear issue (primary, source of truth)
  → Acceptance-criteria parser  (deterministic extraction of the issue's "Acceptance Criteria",
       quoted verbatim; LLM enrich classifies method / flags vague / proposes probes)
  → Planner  (env setup + per-criterion probe + scoped tests for CHANGED test files only)
  → Harness  (real subprocess execution; evidence capture)
  → Verdict engine  (evidence-grounded; skeptical LLM may only downgrade, never upgrade)
  → Reporter (md + json + optional PR comment)  +  Quality logger (events.jsonl + memory)
```

## Auth model (no stored secrets)

VerifyFlow shells out to CLI tools you have already installed and authorized:

| Concern | Tool | Notes |
| --- | --- | --- |
| GitHub PR + diff + comment | `gh` | uses your existing `gh auth` |
| LLM reasoning | `claude` | authorized Claude Code CLI, headless; falls back to deterministic rules if absent |
| Execution | `git`, `uv`/`node`/… | per the target repo's `verifyflow.config.json` or inferred |
| Linear issue | `LINEAR_API_KEY` **or** `--fixtures` | Linear has no first-class CLI; offline runs read a captured fixture |

## Usage

```bash
# offline / hermetic (recorded issue + PR, real execution against a local checkout)
vf run --fixtures fixtures/example-cli \
       --pr https://github.com/example/greet/pull/7 --linear EX-1 \
       --level functional --workdir examples/example-target --policy merge_gate

# live: derive the Linear issue from the PR body, clone + check out the PR, execute, comment
LINEAR_API_KEY=… vf run --pr https://github.com/humanbased-ai/symphony/pull/69 \
       --level functional --checkout --policy advisory --comment
```

## Dogfood target: Symphony PR #69 ↔ Linear IN-318

The chosen minimal real case ("Add `--version` flag to the `sy` CLI"):
- AC-1 `sy --version` prints `Symphony <version>` and exits 0 → runnable probe → **pass** by execution.
- AC-2 "version read from metadata, not hardcoded" → execution cannot prove this →
  **not_evaluable** → `manual_review_required` (escalated honestly, not failed, not rubber-stamped).

Captured fixture: `fixtures/symphony-in-318/` (issue.json via the Linear connector, pr.json from `gh`).
Live run: `vf run --fixtures fixtures/symphony-in-318 --pr …/pull/69 --workdir <symphony checkout>`
(after `git checkout <head>` + `uv sync`), or fully live with `--checkout` + `LINEAR_API_KEY`.

## Verdict integrity (learned from the live Symphony dogfood)

Real runs against Symphony surfaced three failure modes the engine now handles, so a
genuinely-good PR is never falsely failed:

- **Authoritative vs corroborating probes.** A probe whose command is *quoted in the ticket*
  (e.g. the issue literally says run `sy --version`) is authoritative — its failure is a real
  `fail`. An *agent-invented* probe only corroborates: it can confirm a `pass`, but its failure
  yields `not_evaluable` (the probe may be wrong, not the product). This prevented a false
  `needs_fix` when a model-built check used the wrong Python env.
- **Timeout ≠ failure.** A hung/killed command (per-step time budgets: probe 60s, tests 240s,
  setup 600s) is `blocked`/flake, never a product `fail`.
- **Selective execution.** Scoped tests are narrowed to the changed test files *and* to
  keyword-matched tests (`pytest -k`). On Symphony the version test runs in 0.07s instead of
  hanging on 59 unrelated daemon tests.

## Golden cases

`fixtures/golden/` holds known-answer cases that calibrate accuracy over time
(`docs/improvement-directions.md` §5.1.4). The first is **Symphony PR #69 ↔ IN-318**: expected
verdict `manual_review_required` (AC-1 proven, AC-2 escalated). A hermetic regression test replays
the real captured execution through the verdict engine — locking in that this good PR is never
marked `needs_fix`.

## Layout

```
src/
  cli/                 CLI trigger adapter
  core/
    context/           Linear (primary) + GitHub (reference) loaders
    criteria/          acceptance-criteria parser (deterministic + LLM enrich)
    planner/           evaluation planner + repo run-config
    verdict/           evidence-grounded verdict engine
    reporting/         markdown + json + PR comment
    pipeline.ts        orchestration
  harness/             real command execution + PR checkout
  backends/            LLM backend boundary (claude CLI + deterministic fallback)
  memory/              reusable test points + failure modes + JSONL events
fixtures/              recorded issue/PR for offline runs
examples/example-target  tiny real target used by the hermetic e2e test
```

## Tests

`npm test` — unit (JSON extraction, criteria parsing) + a **hermetic end-to-end** test that really
executes against `examples/example-target` (no network, no Python, no claude) and asserts the
verdict, evidence, event log, and the memory reuse (feed-back) loop.

## Not yet (next PRs)

`ui` (Playwright) and `journey` levels; native Crosscheck/Jazzband adapters; object storage for
artifacts; trend dashboards; auto-filing Linear tickets for recurring failure patterns.
