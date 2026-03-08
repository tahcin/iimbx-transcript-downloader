// ============================================
// IIMBx Transcript Downloader — popup.js
// Handles: course list display, selection,
// start download, progress display
// ============================================

'use strict';

// DOM References
const notOnDashboard  = document.getElementById('not-on-dashboard');
const loadingState    = document.getElementById('loading-state');
const courseSelection = document.getElementById('course-selection');
const progressSection = document.getElementById('progress-section');
const completeSection = document.getElementById('complete-section');

const goToDashboard  = document.getElementById('go-to-dashboard');
const selectAllCb    = document.getElementById('select-all');
const courseListDiv   = document.getElementById('course-list');
const startBtn       = document.getElementById('start-download');
const restartBtn     = document.getElementById('restart-btn');

const statusText     = document.getElementById('status-text');
const progressFill   = document.getElementById('progress-fill');
const currentCourse  = document.getElementById('current-course');
const currentSection = document.getElementById('current-section');
const currentUnit    = document.getElementById('current-unit');
const downloadCount  = document.getElementById('download-count');
const logArea        = document.getElementById('log');
const completeSummary = document.getElementById('complete-summary');

const DASHBOARD_URL = 'https://apps.iimbx.edu.in/learner-dashboard/';

// ---- State ----
let courses = [];
let tabId = null;
let progressPollTimer = null;

// ---- Helpers ----

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function showOnly(section) {
  [notOnDashboard, loadingState, courseSelection, progressSection, completeSection]
    .forEach(el => el.classList.add('hidden'));
  if (section) section.classList.remove('hidden');
}

function addLog(text, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = text;
  logArea.appendChild(entry);
  logArea.scrollTop = logArea.scrollHeight;
}

function stopProgressPolling() {
  if (progressPollTimer) {
    clearInterval(progressPollTimer);
    progressPollTimer = null;
  }
}

function startProgressPolling() {
  if (progressPollTimer) return;

  progressPollTimer = setInterval(async () => {
    try {
      const progress = await chrome.runtime.sendMessage({ type: 'GET_PROGRESS' });
      if (progress) updateProgress(progress);
    } catch (e) {
      // Background may be temporarily unavailable; next tick will retry.
    }
  }, 1000);
}

function waitForTabUrl(tabIdToWatch, matcher, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      reject(new Error('Timed out waiting for tab update'));
    }, timeout);

    function handleUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabIdToWatch) return;
      if (changeInfo.status !== 'complete') return;

      if (matcher(tab.url || '')) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(handleUpdated);
        resolve(tab);
      }
    }

    chrome.tabs.onUpdated.addListener(handleUpdated);
  });
}

function updateStartButton() {
  const checked = courseListDiv.querySelectorAll('input[type="checkbox"]:checked');
  startBtn.disabled = checked.length === 0;
}

// ---- Course List Rendering ----

function renderCourseList(courseData) {
  courses = courseData;
  courseListDiv.innerHTML = '';

  // Restore previously selected courses
  chrome.storage.local.get('selectedCourseIds', (data) => {
    const savedIds = new Set(data.selectedCourseIds || []);

    courses.forEach(course => {
      const item = document.createElement('div');
      item.className = 'course-item';

      const label = document.createElement('label');
      label.className = 'checkbox-label';

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

      const span = document.createElement('span');
      span.textContent = course.name;
      span.title = course.name;

      label.appendChild(cb);
      label.appendChild(span);
      item.appendChild(label);
      courseListDiv.appendChild(item);
    });

    updateStartButton();
    updateSelectAllState();
  });
}

function updateSelectAllState() {
  const boxes = courseListDiv.querySelectorAll('input[type="checkbox"]');
  const allChecked = boxes.length > 0 && Array.from(boxes).every(cb => cb.checked);
  selectAllCb.checked = allChecked;
}

function saveSelectedCourses() {
  const selected = Array.from(courseListDiv.querySelectorAll('input[type="checkbox"]:checked'))
    .map(cb => cb.value);
  chrome.storage.local.set({ selectedCourseIds: selected });
}

// ---- Progress UI Update ----

function updateProgress(data) {
  // data is a ProgressSnapshot
  if (data.status === 'complete') {
    stopProgressPolling();
    showOnly(completeSection);
    completeSummary.innerHTML =
      `<strong>${data.downloaded}</strong> transcripts downloaded` +
      (data.errors > 0 ? `<br>${data.errors} errors` : '') +
      `<br>Download complete! ✨`;
    return;
  }

  startProgressPolling();
  showOnly(progressSection);

  const statusMap = {
    'downloading':     '⏳ Downloading...',
    'crawl_complete':  '⏳ Finishing downloads...',
    'error':           '⚠️ Error occurred',
    'idle':            '⏸ Idle'
  };
  statusText.textContent = statusMap[data.status] || `⏳ ${data.status}...`;

  progressFill.style.width = `${data.percent || 0}%`;

  if (data.courseName)  currentCourse.innerHTML  = `<strong>Course:</strong> ${data.courseName}`;
  if (data.sectionName) currentSection.innerHTML = `<strong>Section:</strong> ${data.sectionName}`;
  if (data.unitTitle)   currentUnit.innerHTML    = `<strong>Unit:</strong> ${data.unitTitle}`;

  downloadCount.innerHTML = `<strong>Downloaded:</strong> ${data.downloaded || 0} / ${data.total || 0} PDFs` +
    (data.activeDownloads > 0 ? ` (${data.activeDownloads} in flight)` : '') +
    (data.errors > 0 ? ` | ${data.errors} errors` : '');
}

// ---- Event Listeners ----

// "Go to Dashboard" button
goToDashboard.addEventListener('click', () => {
  if (tabId) {
    chrome.tabs.update(tabId, { url: DASHBOARD_URL });
    window.close();
  }
});

// "Select All" checkbox
selectAllCb.addEventListener('change', () => {
  const boxes = courseListDiv.querySelectorAll('input[type="checkbox"]');
  boxes.forEach(cb => cb.checked = selectAllCb.checked);
  updateStartButton();
  saveSelectedCourses();
});

// "Download Transcripts" button
startBtn.addEventListener('click', async () => {
  const selected = Array.from(courseListDiv.querySelectorAll('input[type="checkbox"]:checked'))
    .map(cb => ({
      courseId: cb.value,
      name: cb.dataset.name
    }));

  if (selected.length === 0) return;

  showOnly(progressSection);
  statusText.textContent = '⏳ Starting...';
  logArea.innerHTML = '';

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'START_DOWNLOAD',
      courses: selected
    });
    startProgressPolling();
  } catch (e) {
    console.error('Failed to start download:', e);
    document.querySelector('#not-on-dashboard .info-text').textContent =
      'Could not start the crawler. Refresh the page and try again.';
    showOnly(notOnDashboard);
  }
});

// "Start New Download" button (from complete state)
restartBtn.addEventListener('click', () => {
  handleStartNewDownload();
});

async function handleStartNewDownload() {
  stopProgressPolling();
  showOnly(loadingState);
  logArea.innerHTML = '';

  try {
    await chrome.runtime.sendMessage({ type: 'RESET_STATE' });
  } catch (e) {
    // Ignore background reset failures and continue with local cleanup.
  }

  await chrome.storage.local.remove('processingState');

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) {
    showOnly(notOnDashboard);
    return;
  }

  tabId = activeTab.id;

  if ((activeTab.url || '').includes('apps.iimbx.edu.in/learner-dashboard')) {
    await init();
    return;
  }

  try {
    await chrome.tabs.update(tabId, { url: DASHBOARD_URL });
    await waitForTabUrl(tabId, url => url.includes('apps.iimbx.edu.in/learner-dashboard'));
    await delay(800);
    await init();
  } catch (e) {
    showOnly(notOnDashboard);
    document.querySelector('#not-on-dashboard .info-text').textContent =
      'Navigate back to the dashboard and reopen the popup to start another run.';
  }
}

// Listen for PROGRESS_UPDATE from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PROGRESS_UPDATE') {
    updateProgress(message);
  }
});

// ---- Initialization ----

async function init() {
  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    showOnly(notOnDashboard);
    return;
  }
  tabId = tab.id;

  // Check if we're already mid-process — ask background for status
  try {
    const progress = await chrome.runtime.sendMessage({ type: 'GET_PROGRESS' });
    if (progress && progress.isRunning) {
      updateProgress(progress);
      return;
    }
    if (progress && progress.status === 'complete' && progress.downloaded > 0) {
      updateProgress(progress);
      return;
    }
  } catch (e) {
    // Background not ready yet, continue with normal init
  }

  // Check if on dashboard
  if (!tab.url || !tab.url.includes('apps.iimbx.edu.in/learner-dashboard')) {
    showOnly(notOnDashboard);
    return;
  }

  // On dashboard — request course list from content script
  showOnly(loadingState);

  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_COURSE_LIST' });
    if (response && response.courses && response.courses.length > 0) {
      renderCourseList(response.courses);
      showOnly(courseSelection);
    } else {
      showOnly(notOnDashboard);
      document.querySelector('#not-on-dashboard .info-text').textContent =
        'No courses found. Make sure your dashboard has enrolled courses.';
    }
  } catch (e) {
    console.error('Failed to get course list:', e);
    showOnly(notOnDashboard);
    document.querySelector('#not-on-dashboard .info-text').textContent =
      'Could not communicate with the page. Try refreshing.';
  }
}

// Run on popup open
init();
