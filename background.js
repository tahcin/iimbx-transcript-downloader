// ============================================
// IIMBx Transcript Downloader — background.js
// Service worker (MV3)
// Manages: durable state, download lifecycle,
//   iframe message relay, retry, progress
// ============================================

'use strict';

// ---- Default State ----

function createDefaultState() {
    return {
        queuedUrls: [],
        completedUrls: [],
        stats: { total: 0, completed: 0, errors: 0 },
        cursor: {
            correlationId: '',
            scanId: '',
            expectedBlockId: '',
            courseName: '',
            sectionName: '',
            unitTitle: ''
        },
        scanContexts: {},
        activeDownloads: {},
        pendingRetryCount: 0,
        stopRequested: false,
        isCrawling: false,
        isRunning: false
    };
}

function hydrateState(savedState) {
    const defaults = createDefaultState();
    const stats = savedState?.stats || {};
    const cursor = savedState?.cursor || {};

    return {
        ...defaults,
        ...savedState,
        queuedUrls: Array.isArray(savedState?.queuedUrls) ? [...savedState.queuedUrls] : [],
        completedUrls: Array.isArray(savedState?.completedUrls) ? [...savedState.completedUrls] : [],
        stats: {
            ...defaults.stats,
            ...stats
        },
        cursor: {
            ...defaults.cursor,
            ...cursor
        },
        scanContexts: savedState?.scanContexts ? { ...savedState.scanContexts } : {},
        activeDownloads: savedState?.activeDownloads ? { ...savedState.activeDownloads } : {}
    };
}

// ---- State Management ----

let state = null;
let stateReady = null; // Promise that resolves when state is loaded

async function loadState() {
    const data = await chrome.storage.local.get('downloadState');
    state = hydrateState(data.downloadState);
}

// Guard: ensures state is loaded before any handler uses it
async function ensureStateLoaded() {
    if (state === null) {
        await stateReady;
    }
}

// Mutation queue: serializes all state writes to prevent interleaving
let writeQueue = Promise.resolve();

function saveState() {
    writeQueue = writeQueue.then(async () => {
        await chrome.storage.local.set({ downloadState: state });
    });
    return writeQueue;
}

// Load on startup, store the promise for ensureStateLoaded
stateReady = loadState();

// ---- Filename Sanitization ----

function sanitizeFilename(name) {
    return name
        .replace(/[<>:"/\\|?*]/g, '_')  // Windows illegal chars
        .replace(/\s+/g, ' ')           // Collapse whitespace
        .replace(/\.+$/g, '')           // Remove trailing dots
        .trim()
        .substring(0, 100);             // Max length
}

// ---- Progress Broadcasting ----

function buildProgressSnapshot(status) {
    const effectiveStatus = status || (
        state.stopRequested && !state.isRunning && !state.isCrawling
            ? 'stopped'
            : null
    );
    const isComplete = !state.isRunning
        && !state.isCrawling
        && Object.keys(state.activeDownloads).length === 0
        && (state.pendingRetryCount || 0) === 0
        && state.stats.total > 0
        && (state.stats.completed + state.stats.errors) >= state.stats.total;

    return {
        type: 'PROGRESS_UPDATE',
        status: effectiveStatus || (isComplete ? 'complete' : (state.isRunning ? 'downloading' : 'idle')),
        isRunning: state.isRunning,
        courseName: state.cursor.courseName || '',
        sectionName: state.cursor.sectionName || '',
        unitTitle: state.cursor.unitTitle || '',
        downloaded: state.stats.completed,
        total: state.stats.total,
        errors: state.stats.errors,
        activeDownloads: Object.keys(state.activeDownloads).length,
        percent: state.stats.total > 0
            ? Math.round((state.stats.completed / state.stats.total) * 100) : 0
    };
}

async function broadcastProgress(status) {
    chrome.runtime.sendMessage(buildProgressSnapshot(status)).catch(() => { });
}

function isScannableIframeUrl(iframeSrc) {
    return /\/xblock\/block-v1:/i.test(iframeSrc)
        && /type@vertical\+block@[A-Za-z0-9]+/i.test(iframeSrc);
}

function extractVerticalBlockPath(value) {
    return value?.match(/block-v1:[^/?#]+type@vertical\+block@[A-Za-z0-9]+/)?.[0] || '';
}

function extractSequentialBlockPath(value) {
    return value?.match(/block-v1:[^/?#]+type@sequential\+block@[A-Za-z0-9]+/)?.[0] || '';
}

function buildXblockUrl(unitUrl, scanId) {
    const verticalBlockPath = extractVerticalBlockPath(unitUrl);
    if (!verticalBlockPath) return '';

    const url = new URL(`https://iimbx.edu.in/xblock/${verticalBlockPath}`);
    url.searchParams.set('exam_access', '');
    url.searchParams.set('jumpToId', '');
    url.searchParams.set('recheck_access', '1');
    url.searchParams.set('show_bookmark', '0');
    url.searchParams.set('show_title', '0');
    url.searchParams.set('view', 'student_view');
    if (scanId) {
        url.searchParams.set('codex_scan_id', scanId);
    }
    return url.toString();
}

function buildSequentialXblockUrl(sequentialUrl) {
    const sequentialBlockPath = extractSequentialBlockPath(sequentialUrl);
    if (!sequentialBlockPath) return '';

    const url = new URL(`https://iimbx.edu.in/xblock/${sequentialBlockPath}`);
    url.searchParams.set('exam_access', '');
    url.searchParams.set('jumpToId', '');
    url.searchParams.set('recheck_access', '1');
    url.searchParams.set('show_bookmark', '0');
    url.searchParams.set('show_title', '0');
    url.searchParams.set('view', 'student_view');
    return url.toString();
}

function collectChildBlocksFromHtml(html, parentBlockPath) {
    const verticals = new Map();
    const sequentials = new Map();
    const source = html || '';

    const verticalRegex = /block-v1:[A-Za-z0-9_+:.-]+type@vertical\+block@[A-Za-z0-9]+/g;
    let match;
    while ((match = verticalRegex.exec(source))) {
        const path = match[0];
        if (!verticals.has(path)) {
            verticals.set(path, {
                url: `https://iimbx.edu.in/xblock/${path}?view=student_view`,
                blockPath: path
            });
        }
    }

    const sequentialRegex = /block-v1:[A-Za-z0-9_+:.-]+type@sequential\+block@[A-Za-z0-9]+/g;
    while ((match = sequentialRegex.exec(source))) {
        const path = match[0];
        if (parentBlockPath && path === parentBlockPath) continue;
        if (!sequentials.has(path)) {
            sequentials.set(path, {
                url: `https://iimbx.edu.in/xblock/${path}?view=student_view`,
                blockPath: path
            });
        }
    }

    return {
        verticals: [...verticals.values()],
        sequentials: [...sequentials.values()]
    };
}

function decodeHtmlEntities(value) {
    return (value || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function stripTags(value) {
    return decodeHtmlEntities((value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function isTranscriptHref(href, text) {
    return /download transcript/i.test(text)
        || /\.pdf([?#]|$)/i.test(href)
        || (/asset-v1:/i.test(href) && /\.pdf/i.test(href));
}

function collectTranscriptsFromHtml(html, baseUrl) {
    const transcripts = [];
    const seen = new Set();
    const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = anchorPattern.exec(html || ''))) {
        const attrs = match[1] || '';
        const hrefMatch = attrs.match(/\bhref\s*=\s*(["'])(.*?)\1/i) || attrs.match(/\bhref\s*=\s*([^\s>]+)/i);
        const rawHref = hrefMatch?.[2] || hrefMatch?.[1] || '';
        const href = decodeHtmlEntities(rawHref);
        const text = stripTags(match[2]);

        if (!href || !isTranscriptHref(href, text)) continue;

        let url;
        try {
            url = new URL(href, baseUrl).toString();
        } catch (e) {
            continue;
        }

        if (seen.has(url)) continue;
        seen.add(url);

        let filename = '';
        try {
            const rawFilename = new URL(url).pathname.split('/').pop() || '';
            filename = decodeURIComponent(rawFilename);
        } catch (e) {
            filename = '';
        }

        transcripts.push({ url, filename, videoTitle: '' });
    }

    return transcripts;
}

function resolveScanContext(message) {
    const messageScanId = message.scanId || '';
    if (messageScanId && state.scanContexts?.[messageScanId]) {
        return state.scanContexts[messageScanId];
    }

    return state.cursor;
}

function rememberScanContext(context) {
    if (!context.scanId) return;

    state.scanContexts = {
        ...(state.scanContexts || {}),
        [context.scanId]: {
            correlationId: context.correlationId,
            scanId: context.scanId,
            expectedBlockId: context.expectedBlockId,
            courseName: context.courseName,
            sectionName: context.sectionName,
            unitTitle: context.unitTitle,
            createdAt: Date.now()
        }
    };

    const entries = Object.entries(state.scanContexts)
        .sort((left, right) => (right[1].createdAt || 0) - (left[1].createdAt || 0));

    state.scanContexts = Object.fromEntries(entries.slice(0, 30));
}

// ---- Completion Check ----

function checkAllComplete() {
    if (!state.isCrawling
        && Object.keys(state.activeDownloads).length === 0
        && (state.pendingRetryCount || 0) === 0) {
        state.isRunning = false;
        saveState();
        broadcastProgress('complete');
    }
}

// ---- Download Handler ----

async function handleDownloadPDF({ url, courseName, sectionName, unitTitle, filename }) {
    if (state.stopRequested) return;
    // Dedup: skip if already queued or completed
    if (state.queuedUrls.includes(url) || state.completedUrls.includes(url)) return;
    state.queuedUrls.push(url);

    // Sanitize all path components
    const safeCourse = sanitizeFilename(courseName);
    const safeSection = sanitizeFilename(sectionName);

    // Multi-video naming: prefer PDF basename from URL, fallback to unitTitle
    const pdfBasename = filename ? filename.replace('.pdf', '') : unitTitle;
    const safeTitle = sanitizeFilename(pdfBasename);
    const savePath = `Transcripts/${safeCourse}/${safeSection}/${safeTitle}.pdf`;

    state.stats.total++;
    state.isRunning = true;
    await saveState();
    await broadcastProgress('downloading');

    chrome.downloads.download({
        url: url,
        filename: savePath,
        conflictAction: 'uniquify',
        saveAs: false
    }, (downloadId) => {
        if (chrome.runtime.lastError) {
            state.stats.errors++;
            // Remove from queuedUrls so retry is possible
            state.queuedUrls = state.queuedUrls.filter(u => u !== url);
            console.error('Download error:', chrome.runtime.lastError.message);
            saveState();
            broadcastProgress('error');
        } else if (downloadId) {
            // Track this download for lifecycle monitoring
            state.activeDownloads[downloadId] = { url, savePath, retryCount: 0 };
            saveState();
            broadcastProgress('downloading');
        }
    });
}

// ---- Download Lifecycle Tracking ----

chrome.downloads.onChanged.addListener(async (delta) => {
    await ensureStateLoaded();
    const entry = state.activeDownloads[delta.id];
    if (!entry) return;

    if (state.stopRequested) {
        delete state.activeDownloads[delta.id];
        await saveState();
        if (Object.keys(state.activeDownloads).length === 0) {
            broadcastProgress('stopped');
        }
        return;
    }

    if (delta.state) {
        if (delta.state.current === 'complete') {
            // Move URL from queued to completed (confirmed on disk)
            state.completedUrls.push(entry.url);
            state.stats.completed++;
            delete state.activeDownloads[delta.id];
            await saveState();
            broadcastProgress('downloading');
            checkAllComplete();

        } else if (delta.state.current === 'interrupted') {
            if (entry.retryCount < 1) {
                // RETRY: remove from queued (allows re-queue), re-download after 3s
                state.queuedUrls = state.queuedUrls.filter(u => u !== entry.url);
                delete state.activeDownloads[delta.id];
                state.pendingRetryCount++;
                await saveState();
                console.log(`Retrying download: ${entry.url}`);

                setTimeout(() => {
                    // Re-queue with incremented retry count
                    state.queuedUrls.push(entry.url);
                    chrome.downloads.download({
                        url: entry.url,
                        filename: entry.savePath,
                        conflictAction: 'uniquify',
                        saveAs: false
                    }, (newDownloadId) => {
                        if (newDownloadId) {
                            state.activeDownloads[newDownloadId] = { ...entry, retryCount: entry.retryCount + 1 };
                        } else {
                            state.stats.errors++;
                        }
                        // Decrement AFTER registration/failure — prevents premature completion
                        state.pendingRetryCount--;
                        saveState();
                        if (!newDownloadId) checkAllComplete();
                    });
                }, 3000);

            } else {
                // Max retries exhausted
                state.stats.errors++;
                delete state.activeDownloads[delta.id];
                // Log failed URL for user review
                chrome.storage.local.get('failedDownloads').then(data => {
                    const failedDownloads = data.failedDownloads || [];
                    failedDownloads.push({ url: entry.url, path: entry.savePath });
                    chrome.storage.local.set({ failedDownloads });
                });
                await saveState();
                broadcastProgress('error');
                checkAllComplete();
            }
        }
    }
});

// ---- Message Handler ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Wrap in async IIFE to use await; return true for async sendResponse
    (async () => {
        await ensureStateLoaded();

        if (message.type === 'TRANSCRIPTS_FOUND') {
            const scanContext = resolveScanContext(message);
            console.log(`[BG] TRANSCRIPTS_FOUND received:`, {
                iframeSrc: (message.iframeSrc || '').substring(0, 200),
                count: message.transcripts?.length,
                scanId: message.scanId,
                expectedBlockId: scanContext.expectedBlockId,
                correlationId: scanContext.correlationId,
                senderTab: sender.tab?.id
            });

            const iframeSrc = message.iframeSrc || '';
            const expectedBlockId = scanContext.expectedBlockId || '';
            const correlationId = scanContext.correlationId || '';
            const activeScanId = scanContext.scanId || '';
            const messageScanId = message.scanId || '';

            if (!isScannableIframeUrl(iframeSrc)) {
                console.warn(`[BG] Dropping TRANSCRIPTS_FOUND from non-xblock iframe: ${iframeSrc.substring(0, 200)}`);
                sendResponse({ status: 'ignored', reason: 'non_xblock_iframe' });
                return;
            }

            // Only drop if we have a block ID AND it doesn't match
            if (expectedBlockId && !iframeSrc.includes(expectedBlockId)) {
                console.warn(`[BG] Dropping stale TRANSCRIPTS_FOUND: expected ${expectedBlockId}, src=${iframeSrc.substring(0, 200)}`);
                sendResponse({ status: 'ignored', reason: 'stale_iframe' });
                return;
            }

            if (activeScanId && (!messageScanId || messageScanId !== activeScanId)) {
                console.warn(`[BG] Dropping stale TRANSCRIPTS_FOUND: expected scanId ${activeScanId}, got ${messageScanId || 'missing'}`);
                sendResponse({ status: 'ignored', reason: 'stale_scan' });
                return;
            }

            // Relay to the tab that contains the iframe
            if (sender.tab) {
                if (!correlationId) {
                    console.warn('[BG] Dropping TRANSCRIPTS_FOUND because no active correlation is set');
                    sendResponse({ status: 'ignored', reason: 'missing_correlation' });
                    return;
                }

                const transcripts = Array.isArray(message.transcripts) ? message.transcripts : [];
                if (transcripts.length > 0) {
                    console.log(`[BG] Queueing ${transcripts.length} transcript download(s) from iframe relay`);
                    for (const transcript of transcripts) {
                        await handleDownloadPDF({
                            url: transcript.url,
                            courseName: scanContext.courseName,
                            sectionName: scanContext.sectionName,
                            unitTitle: transcript.videoTitle || scanContext.unitTitle,
                            filename: transcript.filename
                        });
                    }
                }

                console.log(`[BG] Relaying TRANSCRIPTS_FOUND_RELAY to tab ${sender.tab.id} with correlationId=${correlationId}`);
                await chrome.tabs.sendMessage(sender.tab.id, {
                    type: 'TRANSCRIPTS_FOUND_RELAY',
                    correlationId,
                    scanId: activeScanId,
                    iframeSrc: message.iframeSrc,
                    transcripts: message.transcripts
                }).catch(e => {
                    console.error('[BG] Failed to relay TRANSCRIPTS_FOUND:', e);
                    return null;
                });
                sendResponse({ status: 'relayed' });
            } else {
                console.error('[BG] No sender.tab — cannot relay TRANSCRIPTS_FOUND');
                sendResponse({ status: 'ignored', reason: 'missing_sender_tab' });
            }
        }

        if (message.type === 'TRANSCRIPT_SCAN_COMPLETE') {
            const scanContext = resolveScanContext(message);
            const iframeSrc = message.iframeSrc || '';
            const expectedBlockId = scanContext.expectedBlockId || '';
            const correlationId = scanContext.correlationId || '';
            const activeScanId = scanContext.scanId || '';
            const messageScanId = message.scanId || '';

            if (!isScannableIframeUrl(iframeSrc)) {
                console.warn(`[BG] Dropping TRANSCRIPT_SCAN_COMPLETE from non-xblock iframe: ${iframeSrc.substring(0, 200)}`);
                sendResponse({ status: 'ignored', reason: 'non_xblock_iframe' });
                return;
            }

            if (expectedBlockId && !iframeSrc.includes(expectedBlockId)) {
                console.warn(`[BG] Dropping stale TRANSCRIPT_SCAN_COMPLETE: expected ${expectedBlockId}, src=${iframeSrc.substring(0, 200)}`);
                sendResponse({ status: 'ignored', reason: 'stale_iframe' });
                return;
            }

            if (activeScanId && (!messageScanId || messageScanId !== activeScanId)) {
                console.warn(`[BG] Dropping stale TRANSCRIPT_SCAN_COMPLETE: expected scanId ${activeScanId}, got ${messageScanId || 'missing'}`);
                sendResponse({ status: 'ignored', reason: 'stale_scan' });
                return;
            }

            if (!sender.tab || !correlationId) {
                sendResponse({ status: 'ignored', reason: 'missing_context' });
                return;
            }

            await chrome.tabs.sendMessage(sender.tab.id, {
                type: 'TRANSCRIPT_SCAN_COMPLETE_RELAY',
                correlationId,
                scanId: activeScanId,
                iframeSrc,
                transcripts: Array.isArray(message.transcripts) ? message.transcripts : []
            }).catch(e => {
                console.error('[BG] Failed to relay TRANSCRIPT_SCAN_COMPLETE:', e);
                return null;
            });

            sendResponse({ status: 'relayed' });
        }

        if (message.type === 'DOWNLOAD_PDF') {
            await handleDownloadPDF(message);
            sendResponse({ status: 'queued' });
        }

        if (message.type === 'REGISTER_SCAN_CONTEXT') {
            rememberScanContext({
                correlationId: message.correlationId,
                scanId: message.scanId,
                expectedBlockId: message.expectedBlockId,
                courseName: message.courseName,
                sectionName: message.sectionName,
                unitTitle: message.unitTitle
            });
            state.isCrawling = true;
            state.isRunning = true;
            await saveState();
            sendResponse({ status: 'scan_context_registered' });
        }

        if (message.type === 'FETCH_SEQUENTIAL_UNITS') {
            const sequentialXblockUrl = buildSequentialXblockUrl(message.sequentialUrl);
            if (!sequentialXblockUrl) {
                sendResponse({
                    status: 'error',
                    reason: 'invalid_sequential_url',
                    verticals: [],
                    sequentials: []
                });
                return;
            }

            try {
                const response = await fetch(sequentialXblockUrl, {
                    credentials: 'include',
                    cache: 'no-store'
                });
                if (!response.ok) {
                    sendResponse({
                        status: 'error',
                        reason: `http_${response.status}`,
                        verticals: [],
                        sequentials: []
                    });
                    return;
                }
                const html = await response.text();
                const parentBlockPath = extractSequentialBlockPath(message.sequentialUrl);
                const { verticals, sequentials } = collectChildBlocksFromHtml(html, parentBlockPath);
                console.log(`[BG] Sequential outline for ${message.sequentialTitle || parentBlockPath}: ${verticals.length} verticals, ${sequentials.length} child sequentials`);
                sendResponse({ status: 'fetched', verticals, sequentials });
            } catch (e) {
                console.warn(`[BG] FETCH_SEQUENTIAL_UNITS failed:`, e);
                sendResponse({
                    status: 'error',
                    reason: e?.message || 'fetch_failed',
                    verticals: [],
                    sequentials: []
                });
            }
            return;
        }

        if (message.type === 'FETCH_UNIT_TRANSCRIPTS') {
            const scanContext = {
                correlationId: message.correlationId,
                scanId: message.scanId,
                expectedBlockId: message.expectedBlockId,
                courseName: message.courseName,
                sectionName: message.sectionName,
                unitTitle: message.unitTitle
            };
            rememberScanContext(scanContext);

            const xblockUrl = buildXblockUrl(message.unitUrl, message.scanId);
            if (!xblockUrl) {
                sendResponse({ status: 'error', reason: 'missing_xblock_url', transcripts: [] });
                return;
            }

            try {
                const response = await fetch(xblockUrl, {
                    credentials: 'include',
                    cache: 'no-store'
                });

                if (!response.ok) {
                    sendResponse({
                        status: 'error',
                        reason: `http_${response.status}`,
                        transcripts: [],
                        xblockUrl
                    });
                    return;
                }

                const html = await response.text();
                const transcripts = collectTranscriptsFromHtml(html, xblockUrl);
                console.log(`[BG] Fetch scan found ${transcripts.length} transcript(s) for ${message.unitTitle || message.expectedBlockId}`);

                for (const transcript of transcripts) {
                    await handleDownloadPDF({
                        url: transcript.url,
                        courseName: scanContext.courseName,
                        sectionName: scanContext.sectionName,
                        unitTitle: transcript.videoTitle || scanContext.unitTitle,
                        filename: transcript.filename
                    });
                }

                sendResponse({ status: 'fetched', transcripts, xblockUrl });
            } catch (e) {
                console.warn(`[BG] Fetch scan failed for ${xblockUrl}:`, e);
                sendResponse({
                    status: 'error',
                    reason: e?.message || 'fetch_failed',
                    transcripts: [],
                    xblockUrl
                });
            }
        }

        if (message.type === 'CURSOR_UPDATE') {
            state.isCrawling = true;
            state.isRunning = true;
            state.cursor = {
                correlationId: message.correlationId,
                scanId: message.scanId,
                expectedBlockId: message.expectedBlockId,
                courseName: message.courseName,
                sectionName: message.sectionName,
                unitTitle: message.unitTitle
            };
            rememberScanContext(state.cursor);
            await saveState();
            broadcastProgress('downloading');
            sendResponse({ status: 'cursor_updated' });
        }

        if (message.type === 'GET_PROGRESS') {
            // Return full ProgressSnapshot
            sendResponse(buildProgressSnapshot());
        }

        if (message.type === 'RESET_STATE') {
            state = createDefaultState();
            await saveState();
            sendResponse({ status: 'reset' });
        }

        if (message.type === 'STOP_DOWNLOAD') {
            state.stopRequested = true;
            state.isCrawling = false;
            state.isRunning = false;
            state.pendingRetryCount = 0;
            state.cursor = {
                correlationId: '',
                scanId: '',
                expectedBlockId: '',
                courseName: state.cursor.courseName || '',
                sectionName: '',
                unitTitle: ''
            };
            state.scanContexts = {};

            const activeDownloadIds = Object.keys(state.activeDownloads).map(id => Number(id));
            state.activeDownloads = {};
            await saveState();

            for (const downloadId of activeDownloadIds) {
                chrome.downloads.cancel(downloadId, () => {
                    chrome.runtime.lastError;
                });
            }

            broadcastProgress('stopped');
            sendResponse({ status: 'stopped' });
        }

        if (message.type === 'CRAWL_COMPLETE') {
            state.isCrawling = false;
            await saveState();
            if (Object.keys(state.activeDownloads).length > 0 || (state.pendingRetryCount || 0) > 0) {
                // Crawl done but downloads still draining
                broadcastProgress('crawl_complete');
            } else {
                // Everything done
                checkAllComplete();
            }
            sendResponse({ status: 'crawl_complete_ack' });
        }
    })();

    return true; // keep sendResponse channel open for async
});
