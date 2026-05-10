// ============================================
// IIMBx Transcript Downloader - iframe_content.js
// Runs on: iimbx.edu.in (all frames)
// Purpose: Detect transcript PDF links inside
//   cross-origin iframes and report them to
//   the background service worker.
// ============================================

'use strict';

function extractVerticalBlockId(value) {
    return value?.match(/type@vertical\+block@([A-Za-z0-9]+)/)?.[1] || '';
}

function isScannableXblockFrame() {
    return /\/xblock\/block-v1:/i.test(window.location.href)
        && /type@vertical\+block@[A-Za-z0-9]+/i.test(window.location.href);
}

// Only act inside iframes, not top-level navigation to iimbx.edu.in
if (window.self !== window.top && isScannableXblockFrame()) {
    console.log('[IIMBx iframe] Script loaded in iframe:', window.location.href.substring(0, 100));

    let lastReportedKey = '';
    let autoScrollStarted = false;
    let scanCompleteSent = false;
    let completionTimer = null;
    let maxScanTimer = null;
    let reachedBottom = false;
    let lastActivityAt = Date.now();

    const scanId = new URL(window.location.href).searchParams.get('codex_scan_id') || '';
    const expectedBlockId = extractVerticalBlockId(window.location.href);
    const SCAN_IDLE_MS = 1500;
    const SCAN_MAX_MS = 15000;

    function isTranscriptLink(link) {
        const href = link.href || '';
        const text = (link.textContent || '').trim();
        return /download transcript/i.test(text)
            || /\.pdf([?#]|$)/i.test(href)
            || (/asset-v1:/i.test(href) && /\.pdf/i.test(href));
    }

    function collectTranscripts() {
        const transcriptLinks = Array.from(document.querySelectorAll('a[href]')).filter(isTranscriptLink);
        return transcriptLinks.map(link => {
            const urlPath = new URL(link.href).pathname;
            const rawFilename = urlPath.split('/').pop();
            const filename = decodeURIComponent(rawFilename);

            const videoTitle =
                link.closest('.xblock')?.querySelector('h3, h2')?.textContent?.trim() ||
                link.closest('.xblock')?.querySelector('.video-title')?.textContent?.trim() ||
                '';

            return { url: link.href, filename, videoTitle };
        });
    }

    function findAndReportTranscripts() {
        const transcripts = collectTranscripts();
        const urlKey = transcripts.map(item => item.url).sort().join('|');

        if (urlKey === lastReportedKey) return transcripts;
        lastReportedKey = urlKey;

        if (transcripts.length === 0) return transcripts;

        console.log(`[IIMBx iframe] Found ${transcripts.length} transcript(s), reporting...`);

        chrome.runtime.sendMessage({
            type: 'TRANSCRIPTS_FOUND',
            iframeSrc: window.location.href,
            scanId,
            expectedBlockId,
            transcripts
        }).then(() => {
            console.log('[IIMBx iframe] TRANSCRIPTS_FOUND sent successfully');
        }).catch(e => {
            console.error('[IIMBx iframe] Failed to send TRANSCRIPTS_FOUND:', e);
        });

        return transcripts;
    }

    function scheduleCompletionCheck() {
        if (scanCompleteSent) return;

        clearTimeout(completionTimer);
        completionTimer = setTimeout(() => {
            maybeCompleteScan();
        }, SCAN_IDLE_MS);
    }

    function maybeCompleteScan(force = false) {
        if (scanCompleteSent) return;

        const transcripts = collectTranscripts();
        findAndReportTranscripts();

        if (!force && !reachedBottom) {
            scheduleCompletionCheck();
            return;
        }

        if (!force && Date.now() - lastActivityAt < SCAN_IDLE_MS) {
            scheduleCompletionCheck();
            return;
        }

        scanCompleteSent = true;
        clearTimeout(completionTimer);
        clearTimeout(maxScanTimer);

        chrome.runtime.sendMessage({
            type: 'TRANSCRIPT_SCAN_COMPLETE',
            iframeSrc: window.location.href,
            scanId,
            expectedBlockId,
            transcripts
        }).then(() => {
            console.log('[IIMBx iframe] TRANSCRIPT_SCAN_COMPLETE sent successfully');
        }).catch(e => {
            console.error('[IIMBx iframe] Failed to send TRANSCRIPT_SCAN_COMPLETE:', e);
        });
    }

    function startAutoScrollScan() {
        if (autoScrollStarted) return;
        autoScrollStarted = true;

        let attempts = 0;
        const maxAttempts = 20;

        const tick = () => {
            lastActivityAt = Date.now();
            findAndReportTranscripts();

            const scroller = document.scrollingElement || document.documentElement || document.body;
            if (!scroller) return;

            const maxScrollTop = Math.max(0, scroller.scrollHeight - window.innerHeight);
            const step = Math.max(window.innerHeight * 0.8, 500);
            const nextTop = Math.min(scroller.scrollTop + step, maxScrollTop);
            scroller.scrollTop = nextTop;

            attempts += 1;
            if (attempts >= maxAttempts || nextTop >= maxScrollTop) {
                reachedBottom = true;
                setTimeout(() => {
                    lastActivityAt = Date.now();
                    findAndReportTranscripts();
                    scheduleCompletionCheck();
                }, 800);
                return;
            }

            setTimeout(tick, 700);
        };

        setTimeout(tick, 1200);
    }

    // Run immediately
    findAndReportTranscripts();
    startAutoScrollScan();
    scheduleCompletionCheck();
    maxScanTimer = setTimeout(() => {
        maybeCompleteScan(true);
    }, SCAN_MAX_MS);

    // Run again after a delay (content may still be loading)
    setTimeout(() => {
        lastActivityAt = Date.now();
        findAndReportTranscripts();
        scheduleCompletionCheck();
    }, 1000);
    setTimeout(() => {
        lastActivityAt = Date.now();
        findAndReportTranscripts();
        scheduleCompletionCheck();
    }, 2000);
    setTimeout(() => {
        lastActivityAt = Date.now();
        findAndReportTranscripts();
        scheduleCompletionCheck();
    }, 3000);

    // Also observe for dynamic content loading
    const observer = new MutationObserver(() => {
        lastActivityAt = Date.now();
        findAndReportTranscripts();
        scheduleCompletionCheck();
    });

    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    } else {
        // Body not ready - wait for it
        document.addEventListener('DOMContentLoaded', () => {
            lastActivityAt = Date.now();
            findAndReportTranscripts();
            observer.observe(document.body, { childList: true, subtree: true });
            scheduleCompletionCheck();
        });
    }

    // Cleanup observer after 30 seconds
    setTimeout(() => {
        observer.disconnect();
        maybeCompleteScan(true);
    }, 30000);
} else {
    console.log('[IIMBx iframe] Skipping non-xblock frame:', window.location.href.substring(0, 100));
}
