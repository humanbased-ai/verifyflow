# Pipeline smoke test

This document exists to validate the live delivery pipeline:

```
Symphony -> Crosscheck -> VerifyFlow
```

VerifyFlow runs in advisory mode after Crosscheck approves a PR: it checks out
the PR head, executes probes against the linked Linear issue's acceptance
criteria, keeps the evidence, and posts its delivery report back on the PR.
The advisory policy never blocks a merge.
