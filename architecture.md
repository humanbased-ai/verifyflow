# VerifyFlow Architecture

## Design Principle

VerifyFlow owns the evaluation contract. Coding agents and automation tools are interchangeable execution backends.

The core primitive is:

```text
Linear ticket + GitHub PR + evaluation level -> evidence-backed delivery verdict
```

## High-Level System

```text
Trigger Adapter
  -> Context Loader
  -> Acceptance Criteria Parser
  -> Evaluation Planner
  -> Harness Runner
  -> Evidence Collector
  -> Verdict Engine
  -> Reporter
  -> Quality Intelligence Logger
```

## Components

### Trigger Adapters

Trigger adapters normalize how VerifyFlow is invoked.

Supported directions:

- CLI: `verifyflow run` and `vf run`
- Crosscheck workflow step
- Jazzband orchestration step
- GitHub check
- Linear command or status transition

All adapters should produce the same internal run request.

### Context Loader

Loads source context:

- Linear issue title, description, scope, acceptance criteria, labels, comments, linked PRs
- GitHub PR title, body, commits, diff, changed files, checks, review state
- repository metadata
- local checkout or preview deployment metadata

### Acceptance Criteria Parser

Turns ticket requirements into testable claims.

Responsibilities:

- extract explicit acceptance criteria
- identify implicit product expectations
- preserve criterion IDs
- flag missing, vague, contradictory, or unobservable criteria
- classify criteria by likely method: backend, UI, integration, journey

### Evaluation Planner

Builds a run plan from:

- ticket criteria
- PR diff
- selected level
- repo conventions
- available tools
- environment readiness

The planner decides which harnesses to invoke and what evidence is required.

### Harness Runner

Executes checks through deterministic tools and optional agent backends.

Harness families:

- command runner for tests, typecheck, lint, build
- API runner for backend behavior
- database assertion runner
- Playwright runner for web UI
- Maestro, Appium, or Detox runner for mobile
- coding-agent runner for Codex, Claude Code, or Antigravity

### Evidence Collector

Collects and normalizes artifacts:

- screenshots
- videos
- browser traces
- console logs
- network logs
- test reports
- command output
- API responses
- device logs
- environment metadata

Evidence must be addressable from the final report.

### Verdict Engine

Assigns criterion-level and run-level verdicts.

It must separate:

- product failure
- test or harness failure
- environment failure
- ambiguity in the ticket
- insufficient evidence

### Reporter

Produces:

- Markdown report
- JSON report
- PR comment
- Linear update
- Jazzband callback payload
- Crosscheck step result

### Quality Intelligence Logger

Appends structured events for long-term analysis.

Used to detect:

- recurring failure categories
- flaky tests and unstable journeys
- weak acceptance criteria
- slow CI or unreliable preview environments
- fragile integrations
- modules that repeatedly fail delivery eval

## Execution Backend Boundary

VerifyFlow should not be tied to any single coding agent.

Backends may include:

- Codex
- Claude Code
- Antigravity
- local deterministic runner
- CI runner

Backends return structured observations to VerifyFlow. VerifyFlow remains responsible for final verdicts.

## Data Flow

```text
Run Request
  -> ticket context
  -> PR context
  -> criteria model
  -> evaluation plan
  -> harness results
  -> evidence bundle
  -> verdict
  -> report
  -> quality events
```

## Suggested Repository Layout

```text
verifyflow/
  cli/
  core/
    context/
    criteria/
    planner/
    verdict/
    reporting/
  harness/
    command/
    api/
    playwright/
    mobile/
  backends/
    codex/
    claude-code/
    antigravity/
    local/
  docs/
  examples/
```

## First Implementation Target

Start with:

- CLI adapter
- GitHub PR context through `gh`
- Linear context through API or connector
- Markdown acceptance-criteria parsing
- Playwright harness for web UI
- local artifact directory
- JSON report
- Markdown report
- PR comment publishing
