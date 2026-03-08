# Review of Latest `spec.md`

## Findings (ordered by severity)

### High

1. Retry scheduling is not durable across MV3 service worker suspension  
Reference: `spec.md:1005`, `spec.md:1008`, `spec.md:1014`, `spec.md:1280`, `spec.md:1282`  
Issue: retry uses `setTimeout` in the service worker (`pendingRetryCount++` then delayed requeue). If the worker is suspended before timer execution, the timer is lost; no resume/replay mechanism for pending retries is specified after restart.  
Impact: retries can be silently skipped and runs can stall in non-terminal state (`pendingRetryCount > 0`).  
Fix: persist a retry queue with due timestamps and recover/re-enqueue on startup (or use `chrome.alarms` instead of plain `setTimeout`).

### Medium

2. Sequence diagram still omits `expectedBlockId` in `CURSOR_UPDATE`  
Reference: `spec.md:384`, `spec.md:1124`  
Issue: canonical schema defines `CURSOR_UPDATE` as `{ correlationId, expectedBlockId, courseName, sectionName, unitTitle }`, but sequence diagram still shows it without `expectedBlockId`.  
Impact: implementers using the diagram as source-of-truth may miss iframe-block binding required for stale-message gating.  
Fix: update sequence diagram `CURSOR_UPDATE` payload to include `expectedBlockId`.

## Summary

- The major prior correctness issues are addressed.
- Remaining gaps are a retry durability concern under MV3 lifecycle behavior and one documentation mismatch.
