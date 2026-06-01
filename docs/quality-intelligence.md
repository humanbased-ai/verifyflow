# Quality Intelligence

VerifyFlow should become more valuable as it runs.

Each evaluation creates structured logs that can reveal repeated quality patterns across repositories, teams, services, and workflows.

## Event Logging

Every run should append structured events.

Example:

```json
{
  "event_type": "acceptance_criterion_result",
  "repo": "acme/app",
  "linear_issue": "ENG-123",
  "pr": 456,
  "commit_sha": "abc123",
  "level": "ui",
  "criterion_id": "AC-2",
  "result": "fail",
  "failure_category": "ui_backend_integration",
  "component": "billing/settings",
  "duration_ms": 48122,
  "is_flaky_suspected": false
}
```

## Failure Categories

Initial categories:

- `missing_implementation`
- `backend_functionality`
- `ui_behavior`
- `ui_backend_integration`
- `downstream_integration`
- `auth_or_permission`
- `migration_or_data`
- `test_flake`
- `environment_failure`
- `ambiguous_ticket`
- `insufficient_evidence`

## Metrics

Track:

- acceptance-criterion pass rate
- approved-but-eval-failed rate
- average recheck count
- time from Crosscheck approval to VerifyFlow verdict
- flake suspicion rate
- not-evaluable criterion rate
- failure rate by component
- failure rate by evaluation level
- slowest harnesses
- most fragile UI journeys

## Recommendations

VerifyFlow should convert recurring patterns into concrete engineering recommendations.

Examples:

| Pattern | Recommendation |
| --- | --- |
| UI flows fail because selectors are unstable | Add stable accessibility labels or test IDs for critical paths |
| Backend passes but UI fails | Add API-contract or frontend integration tests |
| Many tickets are not evaluable | Improve Linear ticket template and acceptance criteria quality |
| CI is slow and repeatedly fails during dependency install | Profile dependency caching and cache-key strategy |
| Same integration fails after approval | Add regression coverage around that integration boundary |
| Preview environments are often unavailable | Improve preview environment provisioning and health checks |

## Quality Reports

Future scheduled reports should summarize:

- top failure categories
- recurring affected components
- slowest and least reliable checks
- flaky journeys
- acceptance-criteria quality issues
- recommended repo-wide improvements
- suggested Linear tickets for systemic fixes
