'use strict';

// Folder setup page. Opened by the popup in its own window (the directory
// picker can't run inside the popup) and also used as the options page.

const panels = {
  loading: document.getElementById('panel-loading'),
  intro: document.getElementById('panel-intro'),
  reconnect: document.getElementById('panel-reconnect'),
  connected: document.getElementById('panel-connected'),
  brave: document.getElementById('panel-brave'),
  unsupported: document.getElementById('panel-unsupported')
};

const BRAVE_FLAG_URL = 'chrome://flags/#file-system-access-api';

const setupError = document.getElementById('setup-error');
const loadingLabel = document.getElementById('loading-label');
const introMissing = document.getElementById('intro-missing');
const reconnectName = document.getElementById('reconnect-name');
const connectedName = document.getElementById('connected-name');
const foundCount = document.getElementById('found-count');
const foundLabel = document.getElementById('found-label');
const foundDetail = document.getElementById('found-detail');
const foundLedger = document.getElementById('found-ledger');
const connectedNote = document.getElementById('connected-note');
const connectedWarning = document.getElementById('connected-warning');

const originWindowId = Number(new URLSearchParams(location.search).get('from')) || null;

let currentHandle = null;

function showPanel(name) {
  Object.entries(panels).forEach(([key, el]) => el.classList.toggle('hidden', key !== name));
}

function showLoading(label) {
  loadingLabel.textContent = label;
  showPanel('loading');
}

function setError(message) {
  setupError.textContent = message || '';
  setupError.classList.toggle('hidden', !message);
}

function showIntro({ missing = false } = {}) {
  introMissing.classList.toggle('hidden', !missing);
  showPanel('intro');
}

function showConnected(handle, scan, note) {
  connectedName.textContent = handle.name;
  foundCount.textContent = scan.total;
  foundLabel.textContent = scan.total === 1 ? 'transcript found' : 'transcripts found';
  foundDetail.textContent = scan.total > 0
    ? `Across ${scan.courseFolders} ${scan.courseFolders === 1 ? 'course' : 'courses'}. These are skipped on every run from now on.`
    : 'Nothing saved here yet. Transcripts you download are skipped next time.';
  renderLedger(foundLedger, { saved: scan.total });
  foundLedger.classList.toggle('hidden', scan.total === 0);

  connectedNote.textContent = note || '';
  connectedNote.classList.toggle('hidden', !note);
  connectedWarning.classList.toggle('hidden', scan.total > 0 || handle.name.toLowerCase() === 'transcripts');
  showPanel('connected');
}

// Scans before saving, so a folder that can't be read is never stored.
async function connect(handle, note) {
  showLoading('Reading folder');
  let scan;
  try {
    scan = await scanTranscriptsFolder(handle);
  } catch (e) {
    if (e?.name === 'NotFoundError') {
      await forgetFolder().catch(() => { });
      currentHandle = null;
      showIntro({ missing: true });
      return;
    }
    console.error('Folder scan failed:', e);
    setError("Couldn't read that folder. Try choosing it again.");
    showIntro();
    return;
  }
  await saveFolderHandle(handle);
  await saveFolderSnapshot(handle.name, scan);
  currentHandle = handle;
  showConnected(handle, scan, note);
}

async function chooseFolder() {
  setError('');
  let picked;
  try {
    picked = await window.showDirectoryPicker({ id: 'iimbx-transcripts', mode: 'read', startIn: 'downloads' });
  } catch (e) {
    if (e?.name === 'AbortError') return; // Picker dismissed
    console.error('Directory picker failed:', e);
    setError("Couldn't open that folder. Choose the Transcripts folder itself.");
    return;
  }

  // Picked the parent (e.g. a custom downloads folder)? Use the Transcripts folder inside it.
  let handle = picked;
  let note = '';
  if (picked.name.toLowerCase() !== 'transcripts') {
    try {
      handle = await picked.getDirectoryHandle('Transcripts');
      note = `Using the Transcripts folder inside ${picked.name}.`;
    } catch (e) {
      handle = picked;
    }
  }
  await connect(handle, note);
}

async function allowAccess() {
  setError('');
  if (!currentHandle) {
    showIntro();
    return;
  }
  let permission = 'denied';
  try {
    permission = await currentHandle.requestPermission({ mode: 'read' });
  } catch (e) {
    console.error('Permission request failed:', e);
  }
  if (permission !== 'granted') {
    setError('Access was not allowed. Try again, or choose the folder again.');
    return;
  }
  await connect(currentHandle, '');
}

async function disconnect() {
  setError('');
  await forgetFolder().catch(() => { });
  currentHandle = null;
  showIntro();
}

// Close this window and, where Chrome allows it, reopen the extension popup
// in the window the user came from so they land back on their course list.
async function finish() {
  if (originWindowId) {
    try {
      await chrome.windows.update(originWindowId, { focused: true });
      await chrome.action.openPopup({ windowId: originWindowId });
    } catch (e) {
      // Older Chrome or window gone; the user reopens the popup themselves
    }
  }
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id) chrome.tabs.remove(tab.id);
  else window.close();
}

// Brave serves its flags page at chrome:// too. If opening it is blocked,
// copy the address so it can be pasted instead.
async function openBraveFlags() {
  try {
    await chrome.tabs.create({ url: BRAVE_FLAG_URL });
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) chrome.tabs.remove(tab.id);
  } catch (e) {
    console.warn('Could not open flags page:', e);
    navigator.clipboard.writeText('brave://flags/#file-system-access-api').catch(() => { });
    document.getElementById('flags-fallback').classList.remove('hidden');
  }
}

async function init() {
  const result = await checkFolder();
  currentHandle = result.handle || null;

  if (result.status === 'unsupported') return showPanel(navigator.brave ? 'brave' : 'unsupported');
  if (result.status === 'none') return showIntro();
  if (result.status === 'missing') {
    await forgetFolder().catch(() => { });
    currentHandle = null;
    return showIntro({ missing: true });
  }
  // Not readable right now (access ends when an extension window closes): ask for a rescan.
  if (result.status === 'prompt' || !result.live) {
    reconnectName.textContent = currentHandle.name;
    return showPanel('reconnect');
  }
  showConnected(result.handle, result, '');
}

document.getElementById('choose-folder').addEventListener('click', chooseFolder);
document.getElementById('reconnect-choose').addEventListener('click', chooseFolder);
document.getElementById('connected-choose').addEventListener('click', chooseFolder);
document.getElementById('allow-access').addEventListener('click', allowAccess);
document.getElementById('reconnect-disconnect').addEventListener('click', disconnect);
document.getElementById('connected-disconnect').addEventListener('click', disconnect);
document.getElementById('done').addEventListener('click', finish);
document.getElementById('unsupported-close').addEventListener('click', finish);
document.getElementById('brave-close').addEventListener('click', finish);
document.getElementById('open-flags').addEventListener('click', openBraveFlags);

init().catch(e => {
  console.error('Folder setup failed to load:', e);
  setError('Something went wrong loading the folder settings.');
  showIntro();
});
