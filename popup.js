'use strict';

const notOnDashboard = document.getElementById('not-on-dashboard');
const loadingState = document.getElementById('loading-state');
const waitingForLogin = document.getElementById('waiting-for-login');
const courseSelection = document.getElementById('course-selection');
const progressSection = document.getElementById('progress-section');
const completeSection = document.getElementById('complete-section');

const goToDashboard = document.getElementById('go-to-dashboard');
const goToDashboardLabel = document.getElementById('go-to-dashboard-label');
const goToDashboardIconExternal = document.getElementById('go-to-dashboard-icon-external');
const goToDashboardIconRetry = document.getElementById('go-to-dashboard-icon-retry');
const waitingRetry = document.getElementById('waiting-retry');
const selectAllCb = document.getElementById('select-all');
const courseListDiv = document.getElementById('course-list');
const courseSearch = document.getElementById('course-search');
const courseEmpty = document.getElementById('course-empty');
const startBtn = document.getElementById('start-download');
const restartBtn = document.getElementById('restart-btn');
const retryFailedBtn = document.getElementById('retry-failed-btn');
const retryFailedLabel = document.getElementById('retry-failed-label');
const stopBtn = document.getElementById('stop-download');

const step = document.getElementById('step');
const startLabel = document.getElementById('start-label');
const courseMeta = document.getElementById('course-meta');
const statusText = document.getElementById('status-text');
const ledger = document.getElementById('ledger');
const legend = document.getElementById('legend');
const counterCaption = document.getElementById('counter-caption');
const currentCourse = document.getElementById('current-course');
const currentSection = document.getElementById('current-section');
const currentUnit = document.getElementById('current-unit');
const countCurrent = document.getElementById('count-current');
const countTotal = document.getElementById('count-total');
const completeSummary = document.getElementById('complete-summary');
const completeTitle = document.getElementById('complete-title');
const completeIconBox = document.getElementById('complete-icon-box');
const completeLedger = document.getElementById('complete-ledger');
const statSaved = document.getElementById('stat-saved');
const statSkipped = document.getElementById('stat-skipped');
const statFailed = document.getElementById('stat-failed');
const messageText = document.getElementById('message-text');
const messageTitle = document.querySelector('#not-on-dashboard .message-title');
const completeHint = document.getElementById('complete-hint');
const completeConnect = document.getElementById('complete-connect');

const folderStrip = document.getElementById('folder-strip');
const folderStripIcon = document.getElementById('folder-strip-icon');
const folderStripTitle = document.getElementById('folder-strip-title');
const folderStripSub = document.getElementById('folder-strip-sub');
const folderStripAction = document.getElementById('folder-strip-action');

const DASHBOARD_URL = 'https://apps.iimbx.edu.in/learner-dashboard/';
const CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none"><path d="M3 8l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const COMPLETE_ICON = `<svg viewBox="0 0 16 16" fill="none">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
  <path d="M5.2 8.1l1.9 1.9 3.7-3.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const STOPPED_ICON = `<svg viewBox="0 0 16 16" fill="none">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
  <rect x="6" y="6" width="4" height="4" rx="0.8" fill="currentColor"/>
</svg>`;

const ERROR_ICON = `<svg viewBox="0 0 16 16" fill="none">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
  <path d="M8 4.8v3.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <circle cx="8" cy="11" r="0.8" fill="currentColor"/>
</svg>`;

const STEPS = new Map([
  ['course-selection', '<b>01</b> Choose'],
  ['progress-section', '<b>02</b> Download'],
  ['complete-section', '<b>03</b> Done']
]);

const FOLDER_ICON = `<svg viewBox="0 0 24 24" fill="none">
  <path d="M3.5 6.5h6l2 2h9v10h-17z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
</svg>`;

const FOLDER_READY_ICON = `<svg viewBox="0 0 24 24" fill="none">
  <path d="M3.5 6.5h6l2 2h9v10h-17z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M9 13.5l2 2 4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const FOLDER_ALERT_ICON = `<svg viewBox="0 0 24 24" fill="none">
  <path d="M3.5 6.5h6l2 2h9v10h-17z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M12 11v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  <circle cx="12" cy="16.2" r="0.6" fill="currentColor"/>
</svg>`;

const NO_FOLDER_HINT = 'Without a connected folder every transcript downloads again, replacing the copy already on disk.';

const FOLDER_STRIP_COPY = {
  checking: { icon: FOLDER_ICON, title: 'Transcripts folder', sub: 'Looking for saved transcripts…', action: '' },
  none: { icon: FOLDER_ICON, title: 'Skip transcripts you already have', sub: 'Connect your Transcripts folder', action: 'Connect', hint: NO_FOLDER_HINT },
  prompt: { icon: FOLDER_ALERT_ICON, title: 'Check your Transcripts folder', sub: 'Allow access once to see what\'s saved', action: 'Allow', hint: NO_FOLDER_HINT },
  missing: { icon: FOLDER_ALERT_ICON, title: 'Transcripts folder not found', sub: 'It may have been moved or renamed', action: 'Reconnect', hint: NO_FOLDER_HINT },
  unsupported: navigator.brave
    ? { icon: FOLDER_ALERT_ICON, title: 'Folder access is off in Brave', sub: 'Turn on one setting to skip saved files', action: 'Enable', hint: NO_FOLDER_HINT }
    : { icon: FOLDER_ICON, title: 'Saved-file check unavailable', sub: 'This browser blocks folder access', action: '', hint: NO_FOLDER_HINT }
};

let courses = [];
let waitingPollTimer = null;
let lastErrorReason = 'unknown';
let folderPromise = null;
let folderState = null;

const ERROR_COPY = {
  not_logged_in: {
    title: 'Sign in to <em>begin.</em>',
    message: "You're not signed in to IIMBx. Sign in and your courses will show up here.",
    button: 'Open IIMBx',
    icon: 'external'
  },
  network_error: {
    title: "Can't reach <em>IIMBx.</em>",
    message: 'Check your connection and try again.',
    button: 'Try again',
    icon: 'retry'
  },
  unknown: {
    title: 'Something <em>went sideways.</em>',
    message: "Your courses didn't load. Give it another go.",
    button: 'Try again',
    icon: 'retry'
  }
};

function stopWaitingPoll() {
  if (waitingPollTimer !== null) {
    clearInterval(waitingPollTimer);
    waitingPollTimer = null;
  }
}

function showOnly(section) {
  [notOnDashboard, loadingState, waitingForLogin, courseSelection, progressSection, completeSection]
    .forEach(el => el.classList.add('hidden'));
  if (section !== waitingForLogin) stopWaitingPoll();
  if (section) section.classList.remove('hidden');
  step.innerHTML = STEPS.get(section?.id) || '';
}

function showErrorState(reason) {
  const copy = ERROR_COPY[reason] || ERROR_COPY.unknown;
  lastErrorReason = reason in ERROR_COPY ? reason : 'unknown';
  messageTitle.innerHTML = copy.title;
  messageText.textContent = copy.message;
  goToDashboardLabel.textContent = copy.button;
  goToDashboardIconExternal.classList.toggle('hidden', copy.icon !== 'external');
  goToDashboardIconRetry.classList.toggle('hidden', copy.icon !== 'retry');
  showOnly(notOnDashboard);
}

async function pollLoginOnce() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'FETCH_DASHBOARD_COURSES' });
    if (response?.status === 'fetched' && Array.isArray(response.courses) && response.courses.length > 0) {
      stopWaitingPoll();
      renderCourseList(response.courses);
      showOnly(courseSelection);
    }
  } catch (e) {
    // Background not ready or transient error; keep polling
  }
}

function enterWaitingState() {
  stopWaitingPoll();
  showOnly(waitingForLogin);
  waitingPollTimer = setInterval(pollLoginOnce, 3000);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Error text includes course names from the IIMBx API
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function setMeta(el, value) {
  el.textContent = value && String(value).trim() ? value : '…';
}

function updateStartButton() {
  const checked = courseListDiv.querySelectorAll('input[type="checkbox"]:checked').length;
  startBtn.disabled = checked === 0;
  startLabel.textContent = checked === 0 ? 'Select a course' : `Download ${plural(checked, 'course')}`;
  courseMeta.textContent = checked > 0
    ? `${checked} of ${courses.length} selected`
    : plural(courses.length, 'course');
}

// ---- Transcripts folder ----

function refreshFolderState() {
  folderState = null;
  renderFolderStrip({ status: 'checking' });
  applySavedCounts();
  folderPromise = checkFolder()
    .catch(() => ({ status: 'none' }))
    .then(result => {
      folderState = result;
      renderFolderStrip(result);
      applySavedCounts();
      return result;
    });
  return folderPromise;
}

function renderFolderStrip(result) {
  let copy = FOLDER_STRIP_COPY[result.status] || FOLDER_STRIP_COPY.none;
  if (result.status === 'ready') {
    const saved = result.total > 0 ? `${result.total} saved` : 'Nothing saved yet';
    copy = {
      icon: FOLDER_READY_ICON,
      title: result.handle?.name || 'Transcripts',
      sub: result.live ? `${saved} · these will be skipped` : `${saved} · checked ${timeAgo(result.scannedAt)}`,
      action: result.live ? 'Change' : 'Rescan',
      hint: result.live
        ? 'Transcripts already in this folder are skipped. Everything else downloads into it.'
        : 'Uses the list from your last folder check plus everything downloaded since. Rescan if you have deleted or moved transcripts.'
    };
  }
  folderStrip.dataset.state = result.status;
  folderStripIcon.innerHTML = copy.icon;
  folderStripTitle.textContent = copy.title;
  folderStripSub.textContent = copy.sub;
  folderStrip.title = copy.hint || '';
  folderStripAction.textContent = copy.action;
  folderStripAction.classList.toggle('hidden', !copy.action);
}

function timeAgo(timestamp) {
  const minutes = Math.floor((Date.now() - (timestamp || 0)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function applySavedCounts() {
  const counts = folderState?.status === 'ready' ? folderState.courseCounts : {};
  courseListDiv.querySelectorAll('.course-saved').forEach(el => {
    const count = counts[el.dataset.courseKey] || 0;
    el.textContent = count > 0 ? `${count} saved` : '';
    el.title = count > 0 ? `${count} ${count === 1 ? 'transcript' : 'transcripts'} already in your folder` : '';
    el.classList.toggle('hidden', count === 0);
  });
}

async function openFolderSetup() {
  // The directory picker can't run inside this popup (Chrome closes the popup when
  // the picker takes focus), so setup happens in its own small window.
  // Already open (e.g. Connect clicked twice): bring that window forward instead of stacking another
  try {
    const setupUrl = chrome.runtime.getURL('folder.html');
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const existing = contexts.find(c => c.documentUrl?.startsWith(setupUrl));
    if (existing) {
      await chrome.windows.update(existing.windowId, { focused: true });
      window.close();
      return;
    }
  } catch (e) {
    // getContexts unavailable (older browser); open a new window
  }

  const width = 460;
  const height = 680;
  const createData = { url: 'folder.html', type: 'popup', width, height, focused: true };
  try {
    const current = await chrome.windows.getCurrent();
    createData.url = `folder.html?from=${current.id}`;
    createData.left = Math.max(0, current.left + Math.round((current.width - width) / 2));
    createData.top = Math.max(0, current.top + Math.round((current.height - height) / 3));
  } catch (e) {
    // Let Chrome place the window
  }
  await chrome.windows.create(createData);
  window.close();
}

function renderCourseList(courseData) {
  if (!folderPromise) refreshFolderState();
  courses = courseData;
  courseListDiv.innerHTML = '';
  courseSearch.value = '';

  chrome.storage.local.get('selectedCourseIds', data => {
    const savedIds = new Set(data.selectedCourseIds || []);

    courses.forEach(course => {
      const label = document.createElement('label');
      label.className = 'course-row';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = course.courseId;
      cb.dataset.name = course.name;
      cb.checked = savedIds.has(course.courseId);
      cb.addEventListener('change', () => {
        updateStartButton();
        updateSelectAllState();
        saveSelectedCourses();
      });

      const checkmark = document.createElement('span');
      checkmark.className = 'checkbox';
      checkmark.setAttribute('aria-hidden', 'true');
      checkmark.innerHTML = CHECK_SVG;

      const name = document.createElement('span');
      name.className = 'course-name';
      name.textContent = course.name;
      name.title = course.name;

      const saved = document.createElement('span');
      saved.className = 'course-saved hidden';
      saved.dataset.courseKey = looseName(sanitizeFilename(course.name));

      label.appendChild(cb);
      label.appendChild(checkmark);
      label.appendChild(name);
      label.appendChild(saved);
      courseListDiv.appendChild(label);
    });

    applySavedCounts();
    applyCourseFilter();
    updateStartButton();
    updateSelectAllState();
  });
}

function visibleCourseRows() {
  return Array.from(courseListDiv.querySelectorAll('.course-row'))
    .filter(row => !row.classList.contains('hidden'));
}

function applyCourseFilter() {
  const query = courseSearch.value.trim().toLowerCase();
  const rows = courseListDiv.querySelectorAll('.course-row');
  let visible = 0;
  rows.forEach(row => {
    const name = row.querySelector('.course-name')?.textContent.toLowerCase() || '';
    const match = !query || name.includes(query);
    row.classList.toggle('hidden', !match);
    if (match) visible++;
  });
  courseEmpty.classList.toggle('hidden', visible > 0 || rows.length === 0);
  updateSelectAllState();
}

function updateSelectAllState() {
  const visibleBoxes = visibleCourseRows().map(row => row.querySelector('input[type="checkbox"]'));
  const allChecked = visibleBoxes.length > 0 && visibleBoxes.every(cb => cb && cb.checked);
  selectAllCb.checked = allChecked;
}

function saveSelectedCourses() {
  const selected = Array.from(courseListDiv.querySelectorAll('input[type="checkbox"]:checked'))
    .map(cb => cb.value);
  chrome.storage.local.set({ selectedCourseIds: selected });
}

// Splits the background's counters into ledger cells
function ledgerCounts(data) {
  const saved = data.downloaded || 0;
  const failed = data.errors || 0;
  const active = data.activeDownloads || 0;
  return {
    saved,
    failed,
    active,
    skipped: data.skipped || 0,
    queued: Math.max(0, (data.total || 0) - saved - failed - active)
  };
}

function renderLegend(counts, showSkipped) {
  const items = [
    ['saved', 'saved', counts.saved],
    ['skipped', 'skipped', counts.skipped],
    ['active', 'in flight', counts.active],
    ['queued', 'queued', counts.queued],
    ['failed', 'failed', counts.failed]
  ].filter(([state, , n]) => n > 0 || state === 'saved' || (state === 'skipped' && showSkipped));
  legend.innerHTML = items
    .map(([state, label, n]) => `<span><i data-s="${state}"></i><b>${n}</b> ${label}</span>`)
    .join('');
}

function setCounter(el, value) {
  const text = String(Math.max(0, value | 0));
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('tick');
  void el.offsetWidth; // restart the tick animation
  el.classList.add('tick');
}

function renderProgress(data) {
  const counts = ledgerCounts(data);
  setCounter(countCurrent, counts.saved);
  countTotal.textContent = String(data.total || 0);
  counterCaption.textContent = counts.skipped > 0
    ? `new transcripts downloaded, ${counts.skipped} already in your folder`
    : 'transcripts downloaded';
  renderLedger(ledger, counts);
  renderLegend(counts, !!data.folderChecked);
  setMeta(currentCourse, data.courseName);
  setMeta(currentSection, data.sectionName);
  setMeta(currentUnit, data.unitTitle);

  const baseStatus = {
    downloading: 'Downloading',
    crawl_complete: 'Finishing up',
    stopped: 'Stopped',
    idle: 'Idle'
  }[data.status] || (data.status ? String(data.status).replace(/_/g, ' ') : 'Working');

  const bits = [baseStatus];
  if (counts.active > 0) bits.push(`${counts.active} in flight`);
  if (counts.failed > 0) bits.push(plural(counts.failed, 'error'));
  statusText.textContent = bits.join(' · ');
}

async function showFinalState(data, kind) {
  showOnly(completeSection);

  const iconHtml = kind === 'error' ? ERROR_ICON : (kind === 'stopped' ? STOPPED_ICON : COMPLETE_ICON);
  const label = { complete: 'Complete', stopped: 'Stopped', error: 'Run failed' }[kind];
  completeIconBox.innerHTML = `${iconHtml}<span>${label}</span>`;
  completeIconBox.className = `complete-mark kicker complete-mark-${kind === 'error' ? 'error' : 'success'}`;

  const counts = ledgerCounts({ ...data, activeDownloads: 0 });
  const { saved, skipped, failed } = counts;

  let title;
  let summary;
  if (kind === 'error') {
    title = 'Something <em>went sideways.</em>';
    summary = escapeHtml(data.errorMessage || 'Unknown error');
  } else if (kind === 'stopped') {
    title = 'Stopped <em>midway.</em>';
    summary = saved > 0
      ? `${plural(saved, 'transcript')} saved before you stopped.`
        + (data.folderChecked ? ' Start again and saved ones are skipped.' : ' Start again anytime.')
      : 'Nothing was saved. Start again whenever you like.';
  } else if (saved === 0 && failed === 0 && skipped > 0) {
    title = 'All <em>caught up.</em>';
    summary = `Every one of your ${plural(skipped, 'transcript')} is already in your folder.`;
  } else if (saved === 0 && failed === 0) {
    title = 'Nothing <em>to fetch.</em>';
    summary = 'These courses have no transcripts yet.';
  } else {
    title = `${saved} <em>${saved === 1 ? 'transcript' : 'transcripts'}</em>`;
    summary = `Saved to <strong>Downloads/Transcripts</strong>`
      + (skipped > 0 ? `, with ${skipped} already there and skipped.` : '.')
      + (failed > 0 ? ` ${plural(failed, 'download')} failed.` : '');
  }
  completeTitle.innerHTML = title;
  completeSummary.innerHTML = summary;

  statSaved.textContent = saved;
  statSkipped.textContent = skipped;
  statFailed.textContent = failed;
  [statSaved, statSkipped, statFailed].forEach((el, i) => {
    el.parentElement.dataset.zero = String([saved, skipped, failed][i] === 0);
  });
  renderLedger(completeLedger, counts);

  completeHint.classList.toggle('hidden', !!data.folderChecked || kind === 'error' || saved === 0);

  await refreshFailedBadge();
}

async function refreshFailedBadge() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_FAILED_DOWNLOADS' });
    const failed = Array.isArray(result?.failedDownloads) ? result.failedDownloads : [];
    if (failed.length > 0) {
      retryFailedLabel.textContent = `Retry ${failed.length} failed`;
      retryFailedBtn.classList.remove('hidden');
    } else {
      retryFailedBtn.classList.add('hidden');
    }
  } catch (e) {
    retryFailedBtn.classList.add('hidden');
  }
}

function updateProgress(data) {
  if (data.status === 'complete') return showFinalState(data, 'complete');
  if (data.status === 'stopped') return showFinalState(data, 'stopped');
  if (data.status === 'error') return showFinalState(data, 'error');

  showOnly(progressSection);
  renderProgress(data);
}

goToDashboard.addEventListener('click', () => {
  if (lastErrorReason === 'not_logged_in') {
    chrome.tabs.create({ url: DASHBOARD_URL });
    enterWaitingState();
  } else {
    init();
  }
});

waitingRetry.addEventListener('click', () => {
  pollLoginOnce();
});

window.addEventListener('unload', stopWaitingPoll);

selectAllCb.addEventListener('change', () => {
  const visibleBoxes = visibleCourseRows().map(row => row.querySelector('input[type="checkbox"]'));
  visibleBoxes.forEach(cb => { if (cb) cb.checked = selectAllCb.checked; });
  updateStartButton();
  saveSelectedCourses();
});

courseSearch.addEventListener('input', applyCourseFilter);

// "/" jumps to search, Escape clears it
document.addEventListener('keydown', e => {
  if (courseSelection.classList.contains('hidden')) return;
  if (e.key === '/' && document.activeElement !== courseSearch) {
    e.preventDefault();
    courseSearch.focus();
  } else if (e.key === 'Escape' && document.activeElement === courseSearch && courseSearch.value) {
    e.preventDefault();
    courseSearch.value = '';
    applyCourseFilter();
  }
});

[folderStripAction, completeConnect].forEach(btn => btn.addEventListener('click', () => {
  openFolderSetup().catch(e => console.error('Failed to open folder setup:', e));
}));

startBtn.addEventListener('click', async () => {
  const selected = Array.from(courseListDiv.querySelectorAll('input[type="checkbox"]:checked'))
    .map(cb => ({ courseId: cb.value, name: cb.dataset.name }));

  if (selected.length === 0) return;

  showOnly(progressSection);
  renderProgress({ status: 'downloading', downloaded: 0, total: 0, errors: 0, activeDownloads: 0, percent: 0 });
  statusText.textContent = folderState ? 'Starting' : 'Checking your folder';

  // Hand the background the saved transcripts for the chosen courses only.
  const folder = folderPromise ? await folderPromise : null;
  const folderChecked = folder?.status === 'ready';
  let existingKeys = [];
  if (folderChecked) {
    const courseKeys = new Set(selected.map(c => looseName(sanitizeFilename(c.name))));
    existingKeys = folder.keys.filter(key => courseKeys.has(key.split('/')[0]));
  }
  statusText.textContent = 'Starting';

  try {
    await chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', courses: selected, existingKeys, folderChecked });
  } catch (e) {
    console.error('Failed to start download:', e);
    showErrorState('unknown');
    messageText.textContent = 'Could not start the run. Check your IIMBx login and try again.';
  }
});

restartBtn.addEventListener('click', () => {
  handleStartNewDownload();
});

retryFailedBtn.addEventListener('click', async () => {
  retryFailedBtn.disabled = true;
  showOnly(progressSection);
  renderProgress({ status: 'downloading', downloaded: 0, total: 0, errors: 0, activeDownloads: 0, percent: 0 });
  statusText.textContent = 'Retrying';
  try {
    await chrome.runtime.sendMessage({ type: 'RETRY_FAILED_DOWNLOADS' });
  } catch (e) {
    console.error('Retry failed:', e);
  } finally {
    retryFailedBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'STOP_DOWNLOAD' });
  } catch (e) {
    // Ignore failures
  } finally {
    stopBtn.disabled = false;
  }
});

chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'PROGRESS_UPDATE') {
    updateProgress(message);
  }
});

async function handleStartNewDownload() {
  showOnly(loadingState);
  try {
    await chrome.runtime.sendMessage({ type: 'RESET_STATE' });
  } catch (e) {
    // Ignore
  }
  await init();
}

async function init() {
  try {
    const progress = await chrome.runtime.sendMessage({ type: 'GET_PROGRESS' });
    if (progress) {
      if (progress.isRunning) {
        updateProgress(progress);
        return;
      }
      if (progress.status === 'stopped' || progress.status === 'error') {
        updateProgress(progress);
        return;
      }
      if (progress.status === 'complete' && (progress.downloaded > 0 || progress.skipped > 0 || progress.errors > 0)) {
        updateProgress(progress);
        return;
      }
    }
  } catch (e) {
    // Background not ready; fall through
  }

  showOnly(loadingState);
  refreshFolderState();

  try {
    const response = await chrome.runtime.sendMessage({ type: 'FETCH_DASHBOARD_COURSES' });
    if (response?.status === 'fetched' && Array.isArray(response.courses) && response.courses.length > 0) {
      renderCourseList(response.courses);
      showOnly(courseSelection);
      return;
    }
    showErrorState(response?.reason || 'unknown');
  } catch (e) {
    console.error('Failed to fetch courses:', e);
    showErrorState('unknown');
  }
}

init();
