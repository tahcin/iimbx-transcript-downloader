# Implementation Review

## Findings (ordered by severity)

### Critical

1. `RESET_STATE` does not reliably reset nested state (shallow clone bug)  
   - File: `background.js:12`, `background.js:36`, `background.js:277`  
   - Problem: `DEFAULT_STATE` contains nested arrays/objects, but state is reset with `{ ...DEFAULT_STATE }` (shallow copy). Mutations to nested fields can leak across runs and make reset incomplete.  
   - Impact: stale `queuedUrls/completedUrls/stats/cursor` can persist unexpectedly between runs, causing bad dedup/progress behavior.  
   - Fix: replace with a factory, e.g. `createDefaultState()` returning fresh nested arrays/objects each time, and use it for initial load + reset.

### High

2. Relay acceptance allows empty correlation IDs, which can admit stale transcript batches  
   - File: `background.js:241`, `content.js:118`  
   - Problem: background relays `correlationId: ''` when unset; content only rejects when `message.correlationId` is truthy and mismatched. Empty correlation can pass through.  
   - Impact: stale transcript messages may be accepted and attributed to the current unit metadata.  
   - Fix: require non-empty strict correlation match in `content.js` before accepting relay payloads.

3. Retry scheduling is not durable under MV3 service-worker suspension  
   - File: `background.js:172`, `background.js:191`  
   - Problem: retries use `setTimeout` in service worker. If the worker is suspended before timer execution, retry timer is lost.  
   - Impact: retries may be skipped; completion can stall or silently finish with missing downloads.  
   - Fix: use persisted retry jobs with `chrome.alarms` (or startup reconciliation that re-queues pending retries).

### Medium

4. Fallback transcript selector is too broad and can capture unrelated PDFs  
   - File: `iframe_content.js:22`  
   - Problem: fallback selector `a[href$=".pdf"]` is used when transcript selector misses, which can include non-transcript documents.  
   - Impact: wrong files can be downloaded into transcript folders.  
   - Fix: constrain fallback by transcript context (label text/nearby heading/container) instead of all PDF anchors.

5. Unit iteration uses a static `NodeList` across SPA changes  
   - File: `content.js:355`, `content.js:358`  
   - Problem: unit links are queried once, then reused while clicking units can re-render sidebar DOM.  
   - Impact: stale element references can skip units or click detached nodes on some course pages.  
   - Fix: re-query unit links per iteration (or iterate by stable unit href list captured before clicks).

## Residual Risk / Testing Gaps

- No automated test coverage is present for cross-frame message ordering, retry lifecycle, and state-resume behavior after service-worker suspension.
- Highest-value validation: one end-to-end run that forces (1) stale iframe relay, (2) interrupted download retry, and (3) popup reopen during crawl.
