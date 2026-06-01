# Evidence And Verdict Schema

VerifyFlow must produce evidence that is both human-readable and machine-readable.

## Run Request

```json
{
  "linear_issue": "ENG-123",
  "pull_request": "https://github.com/acme/app/pull/456",
  "commit_sha": "abc123",
  "level": "ui",
  "backend": "codex",
  "policy": "advisory"
}
```

## Criterion Result

```json
{
  "criterion_id": "AC-2",
  "criterion": "User can create a billing rule and see it after reload.",
  "result": "fail",
  "method": "playwright_ui_flow",
  "reason": "The UI shows a success toast, but the rule disappears after reload.",
  "evidence": [
    {
      "type": "screenshot",
      "path": "artifacts/ENG-123/after-save.png"
    },
    {
      "type": "browser_trace",
      "path": "artifacts/ENG-123/trace.zip"
    },
    {
      "type": "network_log",
      "path": "artifacts/ENG-123/network.json"
    }
  ],
  "confidence": 0.92
}
```

## Result Values

Criterion result values:

- `pass`
- `fail`
- `partial`
- `blocked`
- `not_evaluable`

Run verdict values:

- `accept`
- `accept_with_risks`
- `needs_fix`
- `manual_review_required`

## Evidence Types

Supported evidence types:

- `command_output`
- `test_report`
- `api_response`
- `database_assertion`
- `screenshot`
- `video`
- `browser_trace`
- `console_log`
- `network_log`
- `device_log`
- `ci_artifact`
- `environment_metadata`

## Required Metadata

Each report should include:

- repo
- PR number
- commit SHA
- Linear issue
- selected level
- execution backend
- policy
- timestamp
- environment
- app URL or preview URL when applicable
- artifact root

## Report Rule

VerifyFlow should not mark a criterion as `pass` without evidence.
