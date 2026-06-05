# Effectiveness: ticket *with* acceptance criteria vs *without* (IN-679)

VerifyFlow's PRIMARY input is the linked Linear issue's **acceptance criteria**. This note shows,
with a real side-by-side run, how much the verdict's quality and authority depend on those criteria
existing — i.e. what you lose when the ticket has none (or you run `--allow-no-ticket`).

## Setup

The **same PR** (`example/greet#7`, "Add a `--version` flag") is verified twice against the same
running code (`examples/example-target`, functional level, advisory policy). Only the acceptance
source changes. Offline + deterministic (fixtures + the rules-only fallback backend); reproduce with
`scripts`-free fixtures via:

```bash
# A — ticket WITH acceptance criteria
vf run --fixtures fixtures/example-cli --linear EX-1 --pr example/greet#7 \
  --level functional --workdir examples/example-target

# B — no ticket; verify against the PR's own description (degraded)
#   (a PR with no Linear link; only its body carries self-claimed criteria)
vf run --fixtures <no-ticket-fixture> --pr example/greet#7 \
  --level functional --workdir examples/example-target --allow-no-ticket
```

## Result (actual VerifyFlow output)

| | **A — ticket has acceptance criteria** | **B — no ticket / degraded** |
| --- | --- | --- |
| Acceptance source | `fixture` (the Linear ticket — **independent**) | `pr-degraded` (the PR describing **itself**) |
| Criteria evaluated | **2** | **1** |
| Run verdict | **`accept`** | **`manual_review_required`** (capped) |
| AC-1 `node bin/greet.mjs --version` prints `ExampleCLI <version>`, exits 0 | ✅ pass (conf 0.92) | ✅ pass (conf 0.92) |
| AC-2 version is read from package.json — **not hardcoded** | ✅ pass (conf 0.70) | — *(criterion absent)* |

Run B also stamps the report:

> ⚠️ degraded run: no Linear ticket — acceptance criteria derived from the PR's own description
> (no independent acceptance source); verdict capped at `manual_review_required`.

## What you lose without acceptance criteria

1. **The verdict is capped.** Even though the executed criterion *passed*, run B can only reach
   `manual_review_required`, never `accept`. A PR asserting its own success is not an independent
   acceptance source, so VerifyFlow refuses to greenlight it on its own word. With the ticket, the
   same PR earns a real `accept`.
2. **Coverage shrinks to whatever the PR happens to mention.** The ticket asked for two things; the
   PR's self-description only restated one. **AC-2 — "version is read from package.json, not
   hardcoded" — simply vanishes** in degraded mode. A PR that hardcoded `"1.2.3"` would still pass
   run B while silently violating the real intent. The ticket is what catches that.
3. **The source is circular.** `fixture` (ticket) vs `pr-degraded` (the PR vouching for itself) —
   independent intent vs the author's own claim.

## Takeaway

Acceptance criteria in the ticket are not paperwork — they are the contract VerifyFlow verifies
against. **Write tickets with explicit, executable acceptance criteria.** Without them VerifyFlow
still runs and still gives a useful, evidence-backed report, but it deliberately downgrades its
verdict to `manual_review_required` and can only check the subset the PR chose to describe — so its
strongest guarantee (an independent `accept`) is off the table.
