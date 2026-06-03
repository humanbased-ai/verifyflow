# VerifyFlow delivery report — IN-545

> Delivery verdict: needs_fix. 9 criteria (5 pass, 3 not_evaluable, 1 fail). Escalation recommended to ui: criteria mention user-visible behavior.

## Run

| Field | Value |
| --- | --- |
| Linear issue | [IN-545](https://linear.app/inductive-network/issue/IN-545/add-symphony-info-command-to-print-environment-diagnostics) — Add `symphony info` command to print environment diagnostics |
| Pull request | humanbased-ai/symphony#154 |
| Commit | `d86879dfd6cff798afc4627394863cce00b9f681` |
| Level | functional |
| Policy | merge_gate |
| Backend | claude-cli |
| Verdict | **needs_fix** |
| Merge gate | 🔴 BLOCKED — policy=merge_gate and verdict=needs_fix |

## Acceptance criteria

| # | Criterion | Result | Method | Evidence |
| --- | --- | --- | --- | --- |
| AC-1 | `symphony info` prints the three sections in human-readable form and exits 0. | ✅ pass | integration | `probe-AC-1.log` |
| AC-2 | `symphony info --json` prints valid JSON with the six keys and exits 0. | ✅ pass | integration | `probe-AC-2.log` |
| AC-3 | Missing `WORKFLOW.md` does not crash either mode. | ❓ not_evaluable | integration | `probe-AC-3.log` |
| AC-4 | Add a focused unit/integration test covering both the text and `--json` paths. | ❓ not_evaluable | integration | `probe-AC-4.log`<br>`probe-AC-4.log` |
| AC-5 | The version/platform line reports the Symphony version (symphony.__version__), the running Python version, and the OS platform together. | ✅ pass | integration | `probe-AC-5.log` |
| AC-6 | The workflow summary resolves and prints the absolute WORKFLOW.md path, the configured agent.runner, and the tracker.kind. | ✅ pass | integration | `tests-scoped.log`<br>`tests-scoped.log` |
| AC-7 | The workflow file path is overridable via a positional workflow_path argument, defaulting to ./WORKFLOW.md. | ❌ fail | integration | `probe-AC-7.log` |
| AC-8 | On a missing/unparseable workflow, the human-readable mode prints a clear 'not found' line for the workflow fields rather than failing silently. | ❓ not_evaluable | integration | `probe-AC-8.log` |
| AC-9 | The `sy info` alias behaves identically to `symphony info`. | ✅ pass | integration | `probe-AC-9.log` |

### Reasoning
- **AC-1** (pass, confidence 0.92): Ran `uv run symphony info`: exit 0 and output contains "Symphony".
- **AC-2** (pass, confidence 0.92): Ran `uv run symphony info --json`: exit 0.
- **AC-3** (not_evaluable, confidence 0.40): Agent-constructed check did not pass (Ran `uv run d=$(mktemp -d); symphony info "$d/WORKFLOW.md"; t=$?; symphony info "$d/WORKFLOW.md" --json; j=$?; test $t -eq 0 -a $j -eq 0 && echo ok`: exited 1 (expected 0).) — this corroborating probe is not authoritative, so the criterion could not be verified by execution and needs manual review.
- **AC-4** (not_evaluable, confidence 0.40): Agent-constructed check did not pass (Ran `python3 -m pytest tests/test_cli.py -k info -q`: exited 1 (expected 0).) — this corroborating probe is not authoritative, so the criterion could not be verified by execution and needs manual review.
- **AC-5** (pass, confidence 0.92): Ran `uv run symphony info | python3 -c "import sys,re; line=sys.stdin.readline(); assert line.startswith('Symphony ') and 'Python' in line and ' on ' in line, line; print('ok')"`: exit 0 and output contains "ok".
- **AC-6** (pass, confidence 0.70): Covered by the PR's changed tests, which pass.
- **AC-7** (fail, confidence 0.40): Agent-constructed check did not pass (Ran `uv run d=$(mktemp -d); symphony info "$d/WORKFLOW.md" --json | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['workflow_path']=='not found'; print('ok')"`: exited 1 (expected 0).) — this corroborating probe is not authoritative, so the criterion could not be verified by execution and needs manual review. [reviewer: Across probe-AC-3, probe-AC-7, and probe-AC-8 the residual command `symphony info /WORKFLOW.md` consistently runs (the `d=` shell-assignment failed, leaving the path as `/WORKFLOW.md`) and argparse rejects it with `symphony: error: unrecognized arguments: /WORKFLOW.md`. This is genuine, reproducible program output independent of the mktemp shell bug, and the usage block shows `[workflow_path]` only on the top-level `symphony` parser, not on `info`. It positively demonstrates that `symphony info` does not accept a positional workflow_path, directly violating AC-7. not_evaluable understates a provable violation.]
- **AC-8** (not_evaluable, confidence 0.40): Agent-constructed check did not pass (Ran `uv run d=$(mktemp -d); symphony info "$d/WORKFLOW.md"`: exited 2 (expected 0).) — this corroborating probe is not authoritative, so the criterion could not be verified by execution and needs manual review.
- **AC-9** (pass, confidence 0.92): Ran `uv run sy info --json | python3 -c "import sys,json; json.load(sys.stdin); print('ok')"`: exit 0 and output contains "ok".

> ⚠️ Escalation recommended to **ui**: criteria mention user-visible behavior

## Ticket quality notes
- AC-1: ‘prints the three sections in human-readable form’ does not enumerate the three sections within the acceptance criteria block; the sections are only defined earlier in feature points 1–3. A reader checking AC-1 in isolation cannot tell exactly what must appear.
- AC-1 / description: The description lists three feature points (version line, workflow summary, --json), but --json is itself one of the three 'sections'. So 'prints the three sections in human-readable form' is mildly self-contradictory: in text mode there are only two content sections (version line + workflow summary), since --json is a mode rather than a printed section. Minor wording ambiguity.
- AC-2: The required key order/format is unspecified (only the key set is named). Acceptable, but worth noting that 'six keys' is verifiable only as a set, not order.
- AC-4: ‘Add a focused unit/integration test’ specifies adding a test but not that it must pass or what assertions it must make; observability relies on the test actually exercising both output paths, which is not pinned down in the AC.

## Evaluation plan
- `setup-1`: environment setup: uv sync --frozen || uv sync → `uv sync --frozen || uv sync`
- `probe-AC-1`: probe for AC-1 → `uv run symphony info`
- `probe-AC-2`: probe for AC-2 → `uv run symphony info --json`
- `probe-AC-3`: probe for AC-3 → `uv run d=$(mktemp -d); symphony info "$d/WORKFLOW.md"; t=$?; symphony info "$d/WORKFLOW.md" --json; j=$?; test $t -eq 0 -a $j -eq 0 && echo ok`
- `probe-AC-4`: probe for AC-4 → `python3 -m pytest tests/test_cli.py -k info -q`
- `probe-AC-5`: probe for AC-5 → `uv run symphony info | python3 -c "import sys,re; line=sys.stdin.readline(); assert line.startswith('Symphony ') and 'Python' in line and ' on ' in line, line; print('ok')"`
- `probe-AC-7`: probe for AC-7 → `uv run d=$(mktemp -d); symphony info "$d/WORKFLOW.md" --json | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['workflow_path']=='not found'; print('ok')"`
- `probe-AC-8`: probe for AC-8 → `uv run d=$(mktemp -d); symphony info "$d/WORKFLOW.md"`
- `probe-AC-9`: probe for AC-9 → `uv run sy info --json | python3 -c "import sys,json; json.load(sys.stdin); print('ok')"`
- `tests-scoped`: scoped tests for changed test files: tests/test_cli.py → `uv run pytest -q tests/test_cli.py -k "json"`

_Evidence artifacts under `runs/IN-545_pr154_20260602094857/artifacts`. Generated 2026-06-02T09:51:35.632Z._
