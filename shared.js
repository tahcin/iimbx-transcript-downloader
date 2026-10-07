// ============================================
// IIMBx Transcript Downloader: shared.js
// Loaded by background.js (importScripts) and by
// the extension pages. Owns: filename rules,
// the connected Transcripts folder, folder scans.
// ============================================

'use strict';

// ---- Filename Sanitization ----

// Output is one path segment Chrome will accept: trimming runs after the length cap
// (a cut can leave a trailing space or dot, which Chrome rejects as an invalid filename),
// and Windows reserved names get a prefix.
function sanitizeFilename(name) {
    const safe = String(name || '')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 100)
        .replace(/^[\s.]+|[\s.]+$/g, '');
    if (!safe) return '_';
    return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(safe) ? `_${safe}` : safe;
}

// Chrome can tweak characters when it writes a file, so saved files are matched
// on letters and digits only. Asset filenames are unique within a course, which
// makes course folder + filename enough to identify a transcript, wherever it
// sits inside that course folder.
function looseName(name) {
    return String(name || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function transcriptKey(courseFolder, fileName) {
    return `${looseName(courseFolder)}/${looseName(fileName)}`;
}

// ---- Connected folder handle (IndexedDB) ----

const FOLDER_DB = 'transcripts-folder';
const FOLDER_STORE = 'handles';
const FOLDER_KEY = 'root';

function openFolderDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(FOLDER_DB, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(FOLDER_STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function folderDbRequest(mode, run) {
    const db = await openFolderDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(FOLDER_STORE, mode);
            const request = run(tx.objectStore(FOLDER_STORE));
            tx.oncomplete = () => resolve(request.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

function loadFolderHandle() {
    return folderDbRequest('readonly', store => store.get(FOLDER_KEY));
}

function saveFolderHandle(handle) {
    return folderDbRequest('readwrite', store => store.put(handle, FOLDER_KEY));
}

function clearFolderHandle() {
    return folderDbRequest('readwrite', store => store.delete(FOLDER_KEY));
}

// ---- Folder scan ----

function folderAccessSupported() {
    return typeof self.showDirectoryPicker === 'function';
}

async function collectPdfKeys(dir, courseKey, keys, depth) {
    for await (const entry of dir.values()) {
        if (entry.kind === 'file') {
            if (!/\.pdf$/i.test(entry.name)) continue;
            // "Notes (1).pdf" is a copy Chrome made of "Notes.pdf"; it still means the transcript is saved.
            const baseName = entry.name.replace(/\s\(\d+\)(\.pdf)$/i, '$1');
            keys.add(`${courseKey}/${looseName(baseName)}`);
        } else if (depth < 3) {
            await collectPdfKeys(entry, courseKey, keys, depth + 1);
        }
    }
}

function summarizeKeys(keys) {
    const courseCounts = {};
    for (const key of keys) {
        const courseKey = key.split('/')[0];
        courseCounts[courseKey] = (courseCounts[courseKey] || 0) + 1;
    }
    return { keys, courseCounts, total: keys.length, courseFolders: Object.keys(courseCounts).length };
}

// Walks <root>/<course folder>/**.pdf. Anything else in the folder is ignored.
async function scanTranscriptsFolder(root) {
    const keys = new Set();
    for await (const entry of root.values()) {
        if (entry.kind !== 'directory') continue;
        await collectPdfKeys(entry, looseName(entry.name), keys, 0);
    }
    return summarizeKeys([...keys]);
}

// ---- Folder snapshot ----
// The browser drops folder access once the page that was granted it closes
// (Brave has no "allow on every visit"), so the popup usually can't read the
// folder itself. The last scan is kept here and the service worker appends
// each transcript it finishes downloading.

async function saveFolderSnapshot(name, scan) {
    await chrome.storage.local.set({ folderSnapshot: { name, keys: scan.keys, scannedAt: Date.now() } });
}

async function loadFolderSnapshot() {
    const { folderSnapshot } = await chrome.storage.local.get('folderSnapshot');
    return Array.isArray(folderSnapshot?.keys) ? folderSnapshot : null;
}

async function forgetFolder() {
    await clearFolderHandle();
    await chrome.storage.local.remove('folderSnapshot');
}

// status: unsupported | none | prompt | missing | ready
// A ready result is live when the folder was just read, otherwise it comes
// from the snapshot and carries scannedAt.
async function checkFolder() {
    if (!folderAccessSupported()) return { status: 'unsupported' };

    let handle = null;
    try {
        handle = await loadFolderHandle();
    } catch (e) {
        handle = null;
    }
    if (!handle) return { status: 'none' };

    let permission = 'prompt';
    try {
        permission = await handle.queryPermission({ mode: 'read' });
    } catch (e) {
        // Treat as needing a fresh grant
    }
    if (permission === 'granted') {
        try {
            const scan = await scanTranscriptsFolder(handle);
            await saveFolderSnapshot(handle.name, scan);
            return { status: 'ready', live: true, handle, scannedAt: Date.now(), ...scan };
        } catch (e) {
            if (e?.name === 'NotFoundError') return { status: 'missing', handle };
        }
    }

    const snapshot = await loadFolderSnapshot().catch(() => null);
    if (!snapshot) return { status: 'prompt', handle };
    return { status: 'ready', live: false, handle, scannedAt: snapshot.scannedAt, ...summarizeKeys(snapshot.keys) };
}

// ---- Ledger (extension pages only) ----
// One cell per transcript, ordered skipped, saved, in flight, queued, failed.
// Big runs fold several transcripts into one cell so the grid stays a few rows tall.

const LEDGER_MAX_CELLS = 360;

function renderLedger(container, { saved = 0, skipped = 0, active = 0, failed = 0, queued = 0 }) {
    const parts = [['skipped', skipped], ['saved', saved], ['active', active], ['queued', queued], ['failed', failed]];
    const count = parts.reduce((sum, [, n]) => sum + n, 0);
    const perCell = Math.max(1, Math.ceil(count / LEDGER_MAX_CELLS));
    const states = [];
    for (const [state, n] of parts) {
        for (let i = 0; i < Math.ceil(n / perCell); i++) states.push(state);
    }

    container.dataset.density = states.length > 200 ? 'dense' : states.length > 84 ? 'mid' : 'loose';
    while (container.children.length > states.length) container.lastChild.remove();
    while (container.children.length < states.length) container.appendChild(document.createElement('i'));
    states.forEach((state, i) => {
        const cell = container.children[i];
        if (cell.dataset.s !== state) cell.dataset.s = state;
    });
    container.title = perCell > 1 ? `Each square is about ${perCell} transcripts` : '';
}
