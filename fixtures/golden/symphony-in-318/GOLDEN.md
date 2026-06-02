# Golden case: Symphony PR #69 ↔ Linear IN-318

Known-answer calibration case ("Add `--version` flag to the `sy` CLI"). Golden cases are how
VerifyFlow proves it is getting **more accurate, not less** over time (prd.md success metrics;
`docs/improvement-directions.md` §5.1.4).

## Ground truth

PR #69 **genuinely delivers** IN-318 — on the checked-out head (`7d7169704629`), `sy --version`
prints `Symphony 0.1.0` and exits 0. AC-2 ("version read from metadata, not hardcoded") is true in
reality, but it is an *implementation constraint* that black-box execution cannot prove.

## Expected verdict

| Criterion | Expected | Why |
| --- | --- | --- |
| AC-1 | `pass` | ticket-quoted probe `sy --version` runs: exit 0, output contains "Symphony" |
| AC-2 | `not_evaluable` | no ticket-quoted probe; an agent-invented check is not authoritative, and "not hardcoded" is not observable by execution → escalate to a human |
| **Run** | **`manual_review_required`** | verify what execution proves (AC-1), escalate what it can't (AC-2) |

**Must NOT be `needs_fix`** — that was a real false-negative bug (an agent-invented probe failing on
a fragile `python` invocation marked a good PR as broken). Now regression-locked.

## Files

- `expected-verdict.json` — machine-readable expected answer.
- `expected-report.{md,json}` — snapshot of the real report produced by the live run.
- Regression test: `src/golden/symphony-in-318.golden.test.ts` replays the captured harness results
  through the verdict engine (hermetic, deterministic, runs in `npm test`).

## Reproduce live

```bash
git clone https://github.com/humanbased-ai/symphony /tmp/sym && cd /tmp/sym
git fetch origin pull/69/head && git checkout FETCH_HEAD && uv sync
cd <verifyflow> && npm run vf -- run \
  --fixtures fixtures/symphony-in-318 \
  --pr https://github.com/humanbased-ai/symphony/pull/69 --linear IN-318 \
  --level functional --policy merge_gate --workdir /tmp/sym
```
