// ============================================
// IIMBx Transcript Downloader — iframe_content.js
// Runs on: iimbx.edu.in (all frames)
// Purpose: Detect transcript PDF links inside
//   cross-origin iframes and report them to
//   the background service worker.
// ============================================

'use strict';

// Only act inside iframes, not top-level navigation to iimbx.edu.in
if (window.self !== window.top) {
    console.log('[IIMBx iframe] Script loaded in iframe:', window.location.href.substring(0, 100));

    let lastReportedKey = '';
    let autoScrollStarted = false;

    function isTranscriptLink(link) {
        const href = link.href || '';
        const text = (link.textContent || '').trim();
        return /download transcript/i.test(text)
            || /\.pdf([?#]|$)/i.test(href)
            || (/asset-v1:/i.test(href) && /\.pdf/i.test(href));
    }

    function findAndReportTranscripts() {
        const fallbackLinks = Array.from(document.querySelectorAll('a[href]')).filter(isTranscriptLink);

        if (fallbackLinks.length === 0) return;

        // Dedup: only report if set changed
        const urlKey = Array.from(fallbackLinks).map(l => l.href).sort().join('|');
        if (urlKey === lastReportedKey) return;
        lastReportedKey = urlKey;

        const transcripts = Array.from(fallbackLinks).map(link => {
            const urlPath = new URL(link.href).pathname;
            const rawFilename = urlPath.split('/').pop();
            const filename = decodeURIComponent(rawFilename);

            const videoTitle =
                link.closest('.xblock')?.querySelector('h3, h2')?.textContent?.trim() ||
                link.closest('.xblock')?.querySelector('.video-title')?.textContent?.trim() ||
                '';

            return { url: link.href, filename, videoTitle };
        });

        console.log(`[IIMBx iframe] Found ${transcripts.length} transcript(s), reporting...`);

        chrome.runtime.sendMessage({
            type: 'TRANSCRIPTS_FOUND',
            iframeSrc: window.location.href,
            transcripts: transcripts
        }).then(() => {
            console.log('[IIMBx iframe] TRANSCRIPTS_FOUND sent successfully');
        }).catch(e => {
            console.error('[IIMBx iframe] Failed to send TRANSCRIPTS_FOUND:', e);
        });
    }

    function startAutoScrollScan() {
        if (autoScrollStarted) return;
        autoScrollStarted = true;

        let attempts = 0;
        const maxAttempts = 20;

        const tick = () => {
            findAndReportTranscripts();

            const scroller = document.scrollingElement || document.documentElement || document.body;
            if (!scroller) return;

            const maxScrollTop = Math.max(0, scroller.scrollHeight - window.innerHeight);
            const step = Math.max(window.innerHeight * 0.8, 500);
            const nextTop = Math.min(scroller.scrollTop + step, maxScrollTop);
            scroller.scrollTop = nextTop;

            attempts += 1;
            if (attempts >= maxAttempts || nextTop >= maxScrollTop) {
                // One final pass at the bottom catches transcript links that render late.
                setTimeout(findAndReportTranscripts, 800);
                return;
            }

            setTimeout(tick, 700);
        };

        setTimeout(tick, 1200);
    }

    // Run immediately
    findAndReportTranscripts();
    startAutoScrollScan();

    // Run again after a delay (content may still be loading)
    setTimeout(findAndReportTranscripts, 1000);
    setTimeout(findAndReportTranscripts, 2000);
    setTimeout(findAndReportTranscripts, 3000);

    // Also observe for dynamic content loading
    const observer = new MutationObserver(() => {
        findAndReportTranscripts();
    });

    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    } else {
        // Body not ready — wait for it
        document.addEventListener('DOMContentLoaded', () => {
            findAndReportTranscripts();
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

    // Cleanup observer after 30 seconds
    setTimeout(() => observer.disconnect(), 30000);
} else {
    console.log('[IIMBx iframe] Skipping — top-level page');
}
