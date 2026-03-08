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
            expectedBlockId: '',
            courseName: '',
            sectionName: '',
            unitTitle: ''
        },
        activeDownloads: {},
        pendingRetryCount: 0,
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
    const isComplete = !state.isRunning
        && !state.isCrawling
        && Object.keys(state.activeDownloads).length === 0
        && (state.pendingRetryCount || 0) === 0
        && state.stats.total > 0
        && (state.stats.completed + state.stats.errors) >= state.stats.total;

    return {
        type: 'PROGRESS_UPDATE',
        status: status || (isComplete ? 'complete' : (state.isRunning ? 'downloading' : 'idle')),
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
            console.log(`[BG] TRANSCRIPTS_FOUND received:`, {
                iframeSrc: (message.iframeSrc || '').substring(0, 100),
                count: message.transcripts?.length,
                expectedBlockId: state.cursor.expectedBlockId,
                correlationId: state.cursor.correlationId,
                senderTab: sender.tab?.id
            });

            const iframeSrc = message.iframeSrc || '';
            const expectedBlockId = state.cursor.expectedBlockId || '';
            const correlationId = state.cursor.correlationId || '';

            // Only drop if we have a block ID AND it doesn't match
            if (expectedBlockId && !iframeSrc.includes(expectedBlockId)) {
                console.warn(`[BG] Dropping stale TRANSCRIPTS_FOUND: expected ${expectedBlockId}, src=${iframeSrc.substring(0, 80)}`);
                sendResponse({ status: 'ignored', reason: 'stale_iframe' });
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
                            courseName: state.cursor.courseName,
                            sectionName: state.cursor.sectionName,
                            unitTitle: transcript.videoTitle || state.cursor.unitTitle,
                            filename: transcript.filename
                        });
                    }
                }

                console.log(`[BG] Relaying TRANSCRIPTS_FOUND_RELAY to tab ${sender.tab.id} with correlationId=${correlationId}`);
                await chrome.tabs.sendMessage(sender.tab.id, {
                    type: 'TRANSCRIPTS_FOUND_RELAY',
                    correlationId,
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

        if (message.type === 'DOWNLOAD_PDF') {
            await handleDownloadPDF(message);
            sendResponse({ status: 'queued' });
        }

        if (message.type === 'CURSOR_UPDATE') {
            state.isCrawling = true;
            state.isRunning = true;
            state.cursor = {
                correlationId: message.correlationId,
                expectedBlockId: message.expectedBlockId,
                courseName: message.courseName,
                sectionName: message.sectionName,
                unitTitle: message.unitTitle
            };
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
