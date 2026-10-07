// ============================================
// IIMBx Transcript Downloader — background.js
// Service worker (MV3)
// Owns: API orchestration, parallel fetch pool,
//       download lifecycle, retry, state, progress.
// ============================================

'use strict';

importScripts('shared.js');

const FETCH_CONCURRENCY = 5;
const OUTLINE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---- Default State ----

function createDefaultState() {
    return {
        queuedUrls: [],
        completedUrls: [],
        claimedPaths: [],
        stats: { total: 0, completed: 0, errors: 0, skipped: 0 },
        cursor: {
            courseName: '',
            sectionName: '',
            unitTitle: ''
        },
        activeDownloads: {},
        pendingRetryCount: 0,
        stopRequested: false,
        isCrawling: false,
        isRunning: false,
        lastError: '',
        queueInProgress: false,
        pendingCourses: [],
        currentCourseIndex: 0,
        folderChecked: false
    };
}

function hydrateState(savedState) {
    const defaults = createDefaultState();
    return {
        ...defaults,
        ...savedState,
        queuedUrls: Array.isArray(savedState?.queuedUrls) ? [...savedState.queuedUrls] : [],
        completedUrls: Array.isArray(savedState?.completedUrls) ? [...savedState.completedUrls] : [],
        claimedPaths: Array.isArray(savedState?.claimedPaths) ? [...savedState.claimedPaths] : [],
        stats: { ...defaults.stats, ...(savedState?.stats || {}) },
        cursor: { ...defaults.cursor, ...(savedState?.cursor || {}) },
        activeDownloads: savedState?.activeDownloads ? { ...savedState.activeDownloads } : {},
        pendingCourses: Array.isArray(savedState?.pendingCourses) ? [...savedState.pendingCourses] : []
    };
}

let state = null;
let stateReady = null;
// { state, promise } for the crawl in progress. Each run is tied to the state object it
// started with; a reset or new run swaps `state`, which cancels the old run (see isCancelled).
let activeRun = null;
// Transcripts already in the connected folder when the run started (transcriptKey values).
// Stored apart from downloadState so the per-download state writes stay small.
let existingKeys = new Set();

async function loadState() {
    const data = await chrome.storage.local.get(['downloadState', 'existingFiles']);
    state = hydrateState(data.downloadState);
    existingKeys = new Set(Array.isArray(data.existingFiles) ? data.existingFiles : []);

    // Retry timers don't survive a service worker restart; count those downloads as failed
    // so the run can still finish.
    if (state.pendingRetryCount > 0) {
        state.stats.errors += state.pendingRetryCount;
        state.pendingRetryCount = 0;
    }

    if (state.queueInProgress && state.pendingCourses.length > 0) {
        console.log('[BG] Resuming download after service worker restart');
        state.stopRequested = false;
        startRun(state.pendingCourses, state.currentCourseIndex);
    }
}

async function ensureStateLoaded() {
    if (state === null) await stateReady;
}

// Writes are serialized and coalesced: while one is queued, later calls share it, and it
// writes whatever `state` holds when it runs.
let writeQueue = Promise.resolve();
let writePending = false;
function saveState() {
    if (!writePending) {
        writePending = true;
        writeQueue = writeQueue.then(async () => {
            writePending = false;
            await chrome.storage.local.set({ downloadState: state });
        }).catch(e => console.warn('[BG] Saving state failed:', e));
    }
    return writeQueue;
}

function isCancelled(runState) {
    return runState !== state || runState.stopRequested;
}

// Stops whatever the current state is doing before it is replaced.
function abandonCurrentRun() {
    if (!state) return;
    state.stopRequested = true;
    for (const id of Object.keys(state.activeDownloads)) {
        chrome.downloads.cancel(Number(id), () => { chrome.runtime.lastError; });
    }
    state.activeDownloads = {};
}

stateReady = loadState();

// ---- Progress Broadcasting ----

function buildProgressSnapshot(status) {
    const idle = !state.isRunning && !state.isCrawling;
    const effectiveStatus = status
        || (state.stopRequested && idle ? 'stopped' : null)
        || (state.lastError && idle ? 'error' : null);
    const isComplete = !state.isRunning
        && !state.isCrawling
        && Object.keys(state.activeDownloads).length === 0
        && (state.pendingRetryCount || 0) === 0
        && (state.stats.total > 0 || state.stats.skipped > 0)
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
        skipped: state.stats.skipped,
        folderChecked: state.folderChecked,
        activeDownloads: Object.keys(state.activeDownloads).length,
        percent: state.stats.total > 0
            ? Math.round((state.stats.completed / state.stats.total) * 100) : 0,
        errorMessage: state.lastError || ''
    };
}

function broadcastProgress(status) {
    chrome.runtime.sendMessage(buildProgressSnapshot(status)).catch(() => { });
}

// ---- URL Helpers ----

function extractVerticalBlockPath(value) {
    return value?.match(/block-v1:[^/?#]+type@vertical\+block@[A-Za-z0-9]+/)?.[0] || '';
}

function buildXblockUrl(unitUrl) {
    const verticalBlockPath = extractVerticalBlockPath(unitUrl);
    if (!verticalBlockPath) return '';
    const url = new URL(`https://iimbx.edu.in/xblock/${verticalBlockPath}`);
    url.searchParams.set('exam_access', '');
    url.searchParams.set('jumpToId', '');
    url.searchParams.set('recheck_access', '1');
    url.searchParams.set('show_bookmark', '0');
    url.searchParams.set('show_title', '0');
    url.searchParams.set('view', 'student_view');
    return url.toString();
}

// ---- API Layer ----

let cachedUsername = null;

async function fetchUsername(courseId) {
    if (cachedUsername) return cachedUsername;
    try {
        const url = `https://iimbx.edu.in/api/learning_sequences/v1/course_outline/${courseId}`;
        const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
        if (!response.ok) return null;
        const data = await response.json();
        if (data.username) {
            cachedUsername = data.username;
            console.log(`[BG] Cached username: ${cachedUsername}`);
        }
        return cachedUsername;
    } catch (e) {
        console.warn('[BG] fetchUsername failed:', e);
        return null;
    }
}

async function fetchCourseBlocks(courseId, username) {
    const params = new URLSearchParams({
        course_id: courseId,
        username,
        depth: 'all',
        requested_fields: 'display_name,children,type,student_view_url'
    });
    try {
        const response = await fetch(`https://iimbx.edu.in/api/courses/v2/blocks/?${params}`, {
            credentials: 'include',
            cache: 'no-store'
        });
        if (!response.ok) {
            console.warn(`[BG] Blocks API HTTP ${response.status}`);
            return null;
        }
        return await response.json();
    } catch (e) {
        console.warn('[BG] fetchCourseBlocks failed:', e);
        return null;
    }
}

function flattenBlocksToUnits(blocksResponse) {
    if (!blocksResponse?.blocks || !blocksResponse?.root) return [];
    const blocks = blocksResponse.blocks;
    const root = blocks[blocksResponse.root];
    if (!root) return [];

    const units = [];
    for (const chapterId of (root.children || [])) {
        const chapter = blocks[chapterId];
        if (!chapter || chapter.type !== 'chapter') continue;
        const chapterTitle = chapter.display_name || '';

        for (const sequentialId of (chapter.children || [])) {
            const sequential = blocks[sequentialId];
            if (!sequential || sequential.type !== 'sequential') continue;
            const sequentialTitle = sequential.display_name || '';

            for (const verticalId of (sequential.children || [])) {
                const vertical = blocks[verticalId];
                if (!vertical || vertical.type !== 'vertical') continue;
                units.push({
                    chapterTitle,
                    sequentialTitle,
                    unitTitle: vertical.display_name || '',
                    unitUrl: vertical.student_view_url || vertical.lms_web_url || vertical.id || ''
                });
            }
        }
    }
    return units;
}

async function fetchDashboardCourses() {
    try {
        const response = await fetch('https://iimbx.edu.in/api/learner_home/init/', {
            credentials: 'include',
            cache: 'no-store'
        });
        if (response.status === 401 || response.status === 403) {
            return { ok: false, reason: 'not_logged_in' };
        }
        if (response.status >= 500) {
            return { ok: false, reason: 'network_error' };
        }
        if (!response.ok) {
            console.warn(`[BG] learner_home/init/ HTTP ${response.status}`);
            return { ok: false, reason: 'unknown' };
        }
        const data = await response.json();
        const entries = Array.isArray(data?.courses) ? data.courses : null;
        if (!entries) return { ok: false, reason: 'not_logged_in' };
        const courses = entries
            .map(entry => ({
                courseId: entry?.courseRun?.courseId || '',
                name: entry?.course?.courseName || '',
                isArchived: !!entry?.courseRun?.isArchived
            }))
            .filter(c => c.courseId && c.name);
        if (courses.length === 0) return { ok: false, reason: 'not_logged_in' };
        return { ok: true, courses };
    } catch (e) {
        console.warn('[BG] fetchDashboardCourses failed:', e);
        return { ok: false, reason: 'network_error' };
    }
}

// ---- Outline cache ----

async function getCachedOutline(courseId) {
    const data = await chrome.storage.local.get('outlineCache');
    const cache = data.outlineCache || {};
    const entry = cache[courseId];
    if (!entry) return null;
    if (Date.now() - (entry.cachedAt || 0) > OUTLINE_CACHE_TTL_MS) return null;
    return entry.units;
}

async function setCachedOutline(courseId, units) {
    const data = await chrome.storage.local.get('outlineCache');
    const cache = data.outlineCache || {};
    cache[courseId] = { units, cachedAt: Date.now() };
    await chrome.storage.local.set({ outlineCache: cache });
}

async function clearOutlineCache() {
    await chrome.storage.local.remove('outlineCache');
}

async function getCourseOutline(courseId) {
    const cached = await getCachedOutline(courseId);
    if (cached) {
        console.log(`[BG] Using cached outline for ${courseId}: ${cached.length} verticals`);
        return cached;
    }
    const username = await fetchUsername(courseId);
    if (!username) return null;
    const blocks = await fetchCourseBlocks(courseId, username);
    if (!blocks) return null;
    const units = flattenBlocksToUnits(blocks);
    if (units.length > 0) await setCachedOutline(courseId, units);
    return units;
}

// ---- Transcript HTML parsing ----

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
    if (state.queuedUrls.includes(url) || state.completedUrls.includes(url)) return;

    const safeCourse = sanitizeFilename(courseName);
    const safeSection = sanitizeFilename(sectionName);
    const pdfBasename = filename ? filename.replace(/\.pdf$/i, '') : unitTitle;
    const safeTitle = sanitizeFilename(pdfBasename);
    const savePath = `Transcripts/${safeCourse}/${safeSection}/${safeTitle}.pdf`;

    const key = transcriptKey(safeCourse, `${safeTitle}.pdf`);
    if (existingKeys.has(key)) {
        state.completedUrls.push(url);
        state.stats.skipped++;
        saveState();
        broadcastProgress('downloading');
        return;
    }

    state.queuedUrls.push(url);
    // Replace a same-named file left by an earlier run instead of saving "name (1).pdf",
    // unless another transcript in this run already claimed that path.
    const conflictAction = state.claimedPaths.includes(savePath) ? 'uniquify' : 'overwrite';
    state.claimedPaths.push(savePath);

    state.stats.total++;
    state.isRunning = true;
    saveState();
    broadcastProgress('downloading');

    // Awaited so the crawl only finishes once every download is registered;
    // otherwise the run could be reported complete while downloads are still starting.
    const runState = state;
    let downloadId;
    try {
        downloadId = await chrome.downloads.download({ url, filename: savePath, conflictAction, saveAs: false });
    } catch (e) {
        console.error('Download error:', e?.message || e);
        if (runState !== state) return;
        state.stats.errors++;
        state.queuedUrls = state.queuedUrls.filter(u => u !== url);
        recordFailedDownload({ url, savePath, courseName, sectionName, unitTitle });
        saveState();
        broadcastProgress('downloading');
        checkAllComplete();
        return;
    }

    if (isCancelled(runState)) {
        chrome.downloads.cancel(downloadId, () => { chrome.runtime.lastError; });
        return;
    }
    state.activeDownloads[downloadId] = {
        url, savePath, key, conflictAction, courseName, sectionName, unitTitle, retryCount: 0
    };
    saveState();
}

// Keeps the connected folder's snapshot (see shared.js) in step with what this
// extension has saved into it since the last scan.
let snapshotQueue = Promise.resolve();
function recordSavedTranscript(key) {
    if (!key) return;
    snapshotQueue = snapshotQueue.then(async () => {
        const snapshot = await loadFolderSnapshot();
        if (!snapshot || snapshot.keys.includes(key)) return;
        snapshot.keys.push(key);
        await chrome.storage.local.set({ folderSnapshot: snapshot });
    }).catch(e => console.warn('[BG] Snapshot update failed:', e));
}

// Serialized so two downloads failing together can't overwrite each other's entry.
let failedQueue = Promise.resolve();
function recordFailedDownload(entry) {
    failedQueue = failedQueue.then(async () => {
        const data = await chrome.storage.local.get('failedDownloads');
        const failedDownloads = Array.isArray(data.failedDownloads) ? data.failedDownloads : [];
        failedDownloads.push({
            url: entry.url,
            path: entry.savePath,
            courseName: entry.courseName || '',
            sectionName: entry.sectionName || '',
            unitTitle: entry.unitTitle || ''
        });
        await chrome.storage.local.set({ failedDownloads });
    }).catch(e => console.warn('[BG] Recording failed download failed:', e));
    return failedQueue;
}

function retryDownload(entry, runState) {
    setTimeout(async () => {
        // Stopped or replaced by a new run while waiting: drop the retry
        if (isCancelled(runState)) return;
        state.pendingRetryCount--;
        state.queuedUrls.push(entry.url);
        try {
            const newDownloadId = await chrome.downloads.download({
                url: entry.url,
                filename: entry.savePath,
                conflictAction: entry.conflictAction || 'uniquify',
                saveAs: false
            });
            if (isCancelled(runState)) {
                chrome.downloads.cancel(newDownloadId, () => { chrome.runtime.lastError; });
                return;
            }
            state.activeDownloads[newDownloadId] = { ...entry, retryCount: entry.retryCount + 1 };
            saveState();
        } catch (e) {
            if (isCancelled(runState)) return;
            state.stats.errors++;
            state.queuedUrls = state.queuedUrls.filter(u => u !== entry.url);
            recordFailedDownload(entry);
            saveState();
            broadcastProgress('downloading');
            checkAllComplete();
        }
    }, 3000);
}

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

    if (!delta.state) return;

    if (delta.state.current === 'complete') {
        recordSavedTranscript(entry.key);
        state.completedUrls.push(entry.url);
        state.stats.completed++;
        delete state.activeDownloads[delta.id];
        await saveState();
        broadcastProgress('downloading');
        checkAllComplete();
        return;
    }

    if (delta.state.current === 'interrupted') {
        delete state.activeDownloads[delta.id];
        state.queuedUrls = state.queuedUrls.filter(u => u !== entry.url);

        // Cancelled from Chrome's download bar: respect it instead of retrying
        const userCancelled = delta.error?.current === 'USER_CANCELED';
        if (entry.retryCount < 1 && !userCancelled) {
            state.pendingRetryCount++;
            await saveState();
            console.log(`Retrying download: ${entry.url}`);
            retryDownload(entry, state);
            return;
        }

        state.stats.errors++;
        recordFailedDownload(entry);
        await saveState();
        broadcastProgress('downloading');
        checkAllComplete();
    }
});

// ---- Run Orchestration ----

async function processUnit(course, unit, runState) {
    if (isCancelled(runState)) return;

    const sectionName = unit.chapterTitle || unit.sequentialTitle || course.name;
    state.cursor = {
        courseName: course.name,
        sectionName,
        unitTitle: unit.unitTitle || ''
    };
    broadcastProgress('downloading');

    const xblockUrl = buildXblockUrl(unit.unitUrl);
    if (!xblockUrl) return;

    try {
        const response = await fetch(xblockUrl, { credentials: 'include', cache: 'no-store' });
        if (!response.ok) {
            console.warn(`[BG] Unit fetch HTTP ${response.status} for ${unit.unitTitle}`);
            return;
        }
        const html = await response.text();
        const transcripts = collectTranscriptsFromHtml(html, xblockUrl);
        for (const t of transcripts) {
            if (isCancelled(runState)) return;
            await handleDownloadPDF({
                url: t.url,
                courseName: course.name,
                sectionName,
                unitTitle: t.videoTitle || unit.unitTitle,
                filename: t.filename
            });
        }
    } catch (e) {
        console.warn(`[BG] Unit fetch failed for ${unit.unitTitle}:`, e);
    }
}

async function processOneCourse(course, runState) {
    if (isCancelled(runState)) return;

    state.isCrawling = true;
    state.isRunning = true;
    state.cursor = { courseName: course.name, sectionName: '', unitTitle: '' };
    await saveState();
    broadcastProgress('downloading');

    const units = await getCourseOutline(course.courseId);
    if (isCancelled(runState)) return;

    if (!units || units.length === 0) {
        state.lastError = `Could not load outline for "${course.name}". Refresh your IIMBx login and retry.`;
        await saveState();
        throw new Error('outline_failed');
    }

    console.log(`[BG] Processing ${course.name}: ${units.length} verticals`);

    let cursor = 0;
    const worker = async () => {
        while (cursor < units.length) {
            if (isCancelled(runState)) return;
            const idx = cursor++;
            await processUnit(course, units[idx], runState);
        }
    };

    const workers = [];
    for (let i = 0; i < Math.min(FETCH_CONCURRENCY, units.length); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
}

async function runDownload(courses, startIdx = 0) {
    const runState = state;
    state.queueInProgress = true;
    state.pendingCourses = courses;
    state.currentCourseIndex = startIdx;
    state.stopRequested = false;
    state.lastError = '';
    await saveState();

    try {
        for (let i = startIdx; i < courses.length; i++) {
            if (isCancelled(runState)) break;
            state.currentCourseIndex = i;
            await saveState();
            try {
                await processOneCourse(courses[i], runState);
            } catch (e) {
                console.warn(`[BG] Course ${courses[i].name} aborted:`, e.message);
                if (e.message === 'outline_failed') break;
            }
        }
    } finally {
        // A reset or a newer run replaced this run's state; leave the new one alone.
        if (runState === state) {
            state.queueInProgress = false;
            state.isCrawling = false;
            state.pendingCourses = [];
            if (state.lastError && !state.stopRequested) state.isRunning = false;
            await saveState();

            if (state.stopRequested) {
                broadcastProgress('stopped');
            } else if (state.lastError) {
                broadcastProgress('error');
            } else if (Object.keys(state.activeDownloads).length > 0 || (state.pendingRetryCount || 0) > 0) {
                broadcastProgress('crawl_complete');
            } else {
                checkAllComplete();
            }
        }
    }
}

function startRun(courses, startIdx = 0) {
    if (activeRun && activeRun.state === state) {
        console.log('[BG] Run already in progress; ignoring duplicate start');
        return activeRun.promise;
    }
    const run = { state };
    run.promise = runDownload(courses, startIdx).finally(() => {
        if (activeRun === run) activeRun = null;
    });
    activeRun = run;
    return run.promise;
}

// ---- Failed-download retry ----

async function retryFailedDownloads() {
    const data = await chrome.storage.local.get('failedDownloads');
    const failed = Array.isArray(data.failedDownloads) ? data.failedDownloads : [];
    if (failed.length === 0) return 0;

    state.stopRequested = false;
    state.lastError = '';

    for (const entry of failed) {
        state.queuedUrls = state.queuedUrls.filter(u => u !== entry.url);
        state.completedUrls = state.completedUrls.filter(u => u !== entry.url);
        if (state.stats.errors > 0) state.stats.errors--;
        if (state.stats.total > 0) state.stats.total--;
    }
    await saveState();
    await chrome.storage.local.remove('failedDownloads');

    for (const entry of failed) {
        // Entries recorded before names were stored only carry the path:
        // Transcripts/<course>/<section>/<file>.pdf
        const parts = (entry.path || '').split(/[\\/]/);
        await handleDownloadPDF({
            url: entry.url,
            courseName: entry.courseName || parts[1] || '',
            sectionName: entry.sectionName || parts[2] || '',
            unitTitle: entry.unitTitle || '',
            filename: parts[parts.length - 1] || ''
        });
    }
    checkAllComplete();
    return failed.length;
}

// ---- Message Handler ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        await ensureStateLoaded();

        if (message.type === 'FETCH_DASHBOARD_COURSES') {
            const result = await fetchDashboardCourses();
            if (result.ok) {
                console.log(`[BG] Dashboard: ${result.courses.length} courses`);
                sendResponse({ status: 'fetched', courses: result.courses });
            } else {
                sendResponse({ status: 'error', reason: result.reason });
            }
            return;
        }

        if (message.type === 'START_DOWNLOAD') {
            const courses = Array.isArray(message.courses) ? message.courses : [];
            if (courses.length === 0) {
                sendResponse({ status: 'error', reason: 'no_courses' });
                return;
            }
            const existingFiles = Array.isArray(message.existingKeys) ? message.existingKeys : [];
            abandonCurrentRun();
            state = createDefaultState();
            state.folderChecked = !!message.folderChecked;
            existingKeys = new Set(existingFiles);
            cachedUsername = null;
            await chrome.storage.local.remove('failedDownloads');
            await chrome.storage.local.set({ existingFiles });
            await saveState();
            startRun(courses, 0);
            sendResponse({ status: 'started' });
            return;
        }

        if (message.type === 'STOP_DOWNLOAD') {
            state.stopRequested = true;
            state.isCrawling = false;
            state.isRunning = false;
            state.pendingRetryCount = 0;
            state.queueInProgress = false;
            state.pendingCourses = [];
            state.cursor = {
                courseName: state.cursor.courseName || '',
                sectionName: '',
                unitTitle: ''
            };
            const activeDownloadIds = Object.keys(state.activeDownloads).map(id => Number(id));
            state.activeDownloads = {};
            await saveState();
            for (const downloadId of activeDownloadIds) {
                chrome.downloads.cancel(downloadId, () => { chrome.runtime.lastError; });
            }
            broadcastProgress('stopped');
            sendResponse({ status: 'stopped' });
            return;
        }

        if (message.type === 'GET_PROGRESS') {
            sendResponse(buildProgressSnapshot());
            return;
        }

        if (message.type === 'RESET_STATE') {
            abandonCurrentRun();
            state = createDefaultState();
            existingKeys = new Set();
            cachedUsername = null;
            await chrome.storage.local.remove(['failedDownloads', 'existingFiles']);
            await saveState();
            sendResponse({ status: 'reset' });
            return;
        }

        if (message.type === 'CLEAR_OUTLINE_CACHE') {
            await clearOutlineCache();
            sendResponse({ status: 'cleared' });
            return;
        }

        if (message.type === 'GET_FAILED_DOWNLOADS') {
            const data = await chrome.storage.local.get('failedDownloads');
            sendResponse({ failedDownloads: Array.isArray(data.failedDownloads) ? data.failedDownloads : [] });
            return;
        }

        if (message.type === 'RETRY_FAILED_DOWNLOADS') {
            const count = await retryFailedDownloads();
            sendResponse({ status: 'retrying', count });
            return;
        }

        sendResponse({ status: 'unknown_message' });
    })();

    return true;
});
