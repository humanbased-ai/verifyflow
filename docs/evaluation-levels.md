# Evaluation Levels

VerifyFlow intentionally exposes only three levels.

The goal is to keep the product easy to invoke while still allowing meaningful depth.

## functional

`functional` validates API, service, data, and backend behavior.

Question:

```text
Does the capability work below the UI?
```

Typical checks:

- run relevant unit and integration tests
- call API endpoints directly
- verify database writes and reads
- validate authorization and permissions
- verify input validation and error handling
- check migrations where relevant
- inspect command output and logs

Best for:

- backend-only tickets
- API work
- service logic changes
- data model changes
- integrations that can be validated without UI

## ui

`ui` validates issue-scoped user-facing behavior.

Question:

```text
Can a user use the delivered capability?
```

Typical checks:

- open the app or preview deployment
- navigate to the relevant feature
- complete the ticket-scoped user action
- assert visible success, error, loading, and empty states where relevant
- inspect network and console logs
- capture screenshots, traces, and videos
- verify persistence after reload or reopen when relevant

Best for:

- frontend tickets
- settings pages
- forms
- dashboards
- user-visible workflows contained to one feature area

## journey

`journey` validates upstream, current, and downstream product outcomes.

Question:

```text
Does the complete product outcome work?
```

Typical checks:

- set up required upstream state
- execute the feature under evaluation
- verify downstream results
- check notifications, webhooks, events, derived records, or status transitions
- validate multiple roles or account states
- run targeted regression checks around neighboring flows

Best for:

- billing
- onboarding
- permissions
- checkout
- integrations
- migrations
- release-critical workflows

## Auto-Escalation

VerifyFlow may recommend escalation when risk exceeds the requested level.

Examples:

- requested `functional`, but the ticket acceptance criteria mention user-visible behavior
- requested `ui`, but the PR touches billing, auth, permissions, migrations, or external integrations
- requested `ui`, but downstream effects are the actual ticket outcome

Escalation should be explicit in the report and should not silently change merge-gate policy unless configured.
