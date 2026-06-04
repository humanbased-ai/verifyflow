# UI-level verification (AI-driven browser)

VerifyFlow's `ui` level verifies **user-visible behavior** by driving a real browser with an AI
agent, then judges the result conservatively. Design principle: **the AI is the eyes and hands;
VerifyFlow is the judge.**

## How it works

```
acceptance criterion (natural language)
  → resolve a live app URL (explicit → preview → local)
  → AI agent loop: observe page (screenshot + DOM) → decide an action → act → repeat → conclude
  → conservative verdict mapping
```

### App-source resolution (where the running app comes from)

Tried in order; the first that yields a URL wins:

1. **explicit** — `--base-url https://...` (operator/orchestrator supplied).
2. **preview** — a deployment preview URL auto-discovered from the PR's GitHub commit statuses
   (Vercel/Netlify/Render/Cloudflare/…).
3. **local-serve** — build & serve the checked-out PR (inferred from the repo config). The plan
   inference ships now; auto-starting the server is a follow-up — pass `--base-url` meanwhile.

If no source yields a URL, the ui criteria are **environment-blocked** (never false-passed).

### Verdict guardrails (never false-fail)

The agent may only conclude `pass`, `fail`, or `cannot_verify`. VerifyFlow maps them so a confused
agent can't sink a good PR:

| Agent outcome | Criterion verdict |
| --- | --- |
| confident `pass` (behavior observed) | **pass** |
| confident, **re-confirmed** `fail` (behavior clearly absent) | **fail** |
| `cannot_verify` — element not found, timeout, login wall, ambiguous | **blocked** (never fail) |
| launch/navigation error, console-error storm, step budget exhausted, malformed reply | **blocked** |

A `fail` is re-run independently (`failConfirmations`, default 2). It survives only if every run
agrees `fail`; one disagreement downgrades it to `blocked`. This mirrors the functional layer's
authoritative-vs-corroborating rule for AI-invented probes.

## Running it

Prerequisites: the `claude` CLI (LLM backend), `gh` (GitHub), `LINEAR_API_KEY` (criteria source),
and Playwright:

```bash
npm i -D playwright && npx playwright install chromium
```

Then:

```bash
# Against an explicit running app:
vf run --linear IN-123 --pr https://github.com/acme/app/pull/45 --level ui \
       --base-url http://localhost:3000

# Let VerifyFlow discover the PR's deployment preview:
vf run --linear IN-123 --pr https://github.com/acme/app/pull/45 --level ui

# Authenticated app (log in once, save the session, reuse it):
playwright codegen --save-storage=auth.json https://app.example.com   # log in, then close
vf run --linear IN-123 --pr <pr> --level ui --base-url https://app.example.com --ui-auth auth.json
```

Evidence (per-step screenshots + the agent's observations) is written under the run's artifact
directory and referenced from the report — same evidence contract as the functional level.

Without Playwright installed, the ui level runs but every criterion is environment-blocked (the
harness reports "not executed" rather than guessing) — by design, never a false pass.
