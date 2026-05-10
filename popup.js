'use strict';

const notOnDashboard = document.getElementById('not-on-dashboard');
const loadingState = document.getElementById('loading-state');
const courseSelection = document.getElementById('course-selection');
const progressSection = document.getElementById('progress-section');
const completeSection = document.getElementById('complete-section');

const goToDashboard = document.getElementById('go-to-dashboard');
const selectAllCb = document.getElementById('select-all');
const courseListDiv = document.getElementById('course-list');
const courseSearch = document.getElementById('course-search');
const courseEmpty = document.getElementById('course-empty');
const startBtn = document.getElementById('start-download');
const restartBtn = document.getElementById('restart-btn');
const retryFailedBtn = document.getElementById('retry-failed-btn');
const retryFailedLabel = document.getElementById('retry-failed-label');
const stopBtn = document.getElementById('stop-download');

const statusText = document.getElementById('status-text');
const progressFill = document.getElementById('progress-fill');
const currentCourse = document.getElementById('current-course');
const currentSection = document.getElementById('current-section');
const currentUnit = document.getElementById('current-unit');
const countCurrent = document.getElementById('count-current');
const countTotal = document.getElementById('count-total');
const completeSummary = document.getElementById('complete-summary');
const completeIconBox = document.getElementById('complete-icon-box');
const messageText = document.getElementById('message-text');

const DASHBOARD_URL = 'https://apps.iimbx.edu.in/learner-dashboard/';
const CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none"><path d="M3 8l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const COMPLETE_ICON = `<svg viewBox="0 0 24 24" fill="none">
  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.4"/>
  <path d="M7.5 12l3 3 6-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const STOPPED_ICON = `<svg viewBox="0 0 24 24" fill="none">
  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.4"/>
  <rect x="9" y="9" width="6" height="6" stroke="currentColor" stroke-width="1.4"/>
</svg>`;

const ERROR_ICON = `<svg viewBox="0 0 24 24" fill="none">
  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.4"/>
  <path d="M12 7v6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  <circle cx="12" cy="16.5" r="0.7" fill="currentColor"/>
</svg>`;

let courses = [];

function showOnly(section) {
  [notOnDashboard, loadingState, courseSelection, progressSection, completeSection]
    .forEach(el => el.classList.add('hidden'));
  if (section) section.classList.remove('hidden');
}

function pad3(n) {
  return String(Math.max(0, n | 0)).padStart(3, '0');
}

function setMeta(el, value) {
  el.textContent = value && String(value).trim() ? value : '—';
}

function updateStartButton() {
  const checked = courseListDiv.querySelectorAll('input[type="checkbox"]:checked');
  startBtn.disabled = checked.length === 0;
}

function renderCourseList(courseData) {
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

      label.appendChild(cb);
      label.appendChild(checkmark);
      label.appendChild(name);
      courseListDiv.appendChild(label);
    });

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

function renderProgress(data) {
  countCurrent.textContent = pad3(data.downloaded || 0);
  countTotal.textContent = pad3(data.total || 0);
  progressFill.style.width = `${data.percent || 0}%`;
  setMeta(currentCourse, data.courseName);
  setMeta(currentSection, data.sectionName);
  setMeta(currentUnit, data.unitTitle);

  const baseStatus = {
    downloading: 'Downloading',
    crawl_complete: 'Finishing downloads',
    stopped: 'Stopped',
    idle: 'Idle'
  }[data.status] || (data.status ? String(data.status).replace(/_/g, ' ') : 'Working');

  const bits = [baseStatus];
  if (data.activeDownloads > 0) bits.push(`${data.activeDownloads} in flight`);
  if (data.errors > 0) bits.push(`${data.errors} ${data.errors === 1 ? 'error' : 'errors'}`);
  statusText.textContent = bits.join(' · ');
}

async function showFinalState(data, kind) {
  showOnly(completeSection);

  const iconHtml = kind === 'error' ? ERROR_ICON : (kind === 'stopped' ? STOPPED_ICON : COMPLETE_ICON);
  completeIconBox.innerHTML = iconHtml;
  completeIconBox.className = `complete-mark complete-mark-${kind === 'error' ? 'error' : 'success'}`;

  const downloaded = data.downloaded || 0;
  const errors = data.errors || 0;
  const errorWord = errors === 1 ? 'error' : 'errors';

  let html;
  if (kind === 'complete') {
    html = `<strong>${pad3(downloaded)}</strong> transcripts saved`
      + (errors > 0 ? `<br>${errors} ${errorWord}` : '')
      + `<br>Download complete`;
  } else if (kind === 'stopped') {
    html = `<strong>${pad3(downloaded)}</strong> transcripts saved`
      + (errors > 0 ? `<br>${errors} ${errorWord}` : '')
      + `<br>Stopped`;
  } else {
    html = (downloaded > 0 ? `<strong>${pad3(downloaded)}</strong> transcripts saved before error<br>` : '')
      + (data.errorMessage || 'Unknown error');
  }
  completeSummary.innerHTML = html;

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
  chrome.tabs.create({ url: DASHBOARD_URL });
  window.close();
});

selectAllCb.addEventListener('change', () => {
  const visibleBoxes = visibleCourseRows().map(row => row.querySelector('input[type="checkbox"]'));
  visibleBoxes.forEach(cb => { if (cb) cb.checked = selectAllCb.checked; });
  updateStartButton();
  saveSelectedCourses();
});

courseSearch.addEventListener('input', applyCourseFilter);

startBtn.addEventListener('click', async () => {
  const selected = Array.from(courseListDiv.querySelectorAll('input[type="checkbox"]:checked'))
    .map(cb => ({ courseId: cb.value, name: cb.dataset.name }));

  if (selected.length === 0) return;

  showOnly(progressSection);
  renderProgress({ status: 'downloading', downloaded: 0, total: 0, errors: 0, activeDownloads: 0, percent: 0 });
  statusText.textContent = 'Starting';

  try {
    await chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', courses: selected });
  } catch (e) {
    console.error('Failed to start download:', e);
    messageText.textContent = 'Could not start the run. Check your IIMBx login and try again.';
    showOnly(notOnDashboard);
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
      if (progress.status === 'complete' && progress.downloaded > 0) {
        updateProgress(progress);
        return;
      }
    }
  } catch (e) {
    // Background not ready; fall through
  }

  showOnly(loadingState);

  try {
    const response = await chrome.runtime.sendMessage({ type: 'FETCH_DASHBOARD_COURSES' });
    if (response?.status === 'fetched' && Array.isArray(response.courses) && response.courses.length > 0) {
      renderCourseList(response.courses);
      showOnly(courseSelection);
      return;
    }
  } catch (e) {
    console.error('Failed to fetch courses:', e);
  }

  showOnly(notOnDashboard);
  messageText.textContent = 'Could not load your IIMBx courses. Open the dashboard and log in.';
}

init();
