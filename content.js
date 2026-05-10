'use strict';

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeWhitespace(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

function extractCourseId(value) {
    return value?.match(/course-v1:[^/?#]+/)?.[0] || '';
}

function extractVerticalBlockId(value) {
    return value?.match(/type@vertical\+block@([A-Za-z0-9]+)/)?.[1] || '';
}

let stopRequested = false;

function shouldStop() {
    return stopRequested;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_COURSE_LIST') {
        handleGetCourseList(sendResponse);
        return true;
    }

    if (message.type === 'START_DOWNLOAD') {
        stopRequested = false;
        handleStartDownload(message.courses);
        sendResponse({ status: 'started' });
        return true;
    }

    if (message.type === 'STOP_DOWNLOAD') {
        stopRequested = true;
        clearProcessingState().finally(() => {
            sendResponse({ status: 'stopping' });
        });
        return true;
    }
});

async function handleGetCourseList(sendResponse) {
    const courseLinkSelector = 'a[href*="/learning/course/course-v1:"]';

    const initialWaitStart = Date.now();
    while (Date.now() - initialWaitStart < 10000) {
        if (document.querySelectorAll(courseLinkSelector).length > 0) break;
        await delay(300);
    }

    const scroller = document.scrollingElement || document.documentElement;
    const previousScroll = scroller.scrollTop;
    let lastCount = -1;
    for (let i = 0; i < 40; i++) {
        scroller.scrollTop = scroller.scrollHeight;
        await delay(500);
        const count = document.querySelectorAll(courseLinkSelector).length;
        if (count === lastCount) break;
        lastCount = count;
    }
    scroller.scrollTop = previousScroll;

    const courseMap = new Map();
    document.querySelectorAll(courseLinkSelector).forEach(link => {
        const name = normalizeWhitespace(link.querySelector('h2')?.textContent || link.textContent);
        const courseId = extractCourseId(link.href);
        if (courseId && name && !courseMap.has(courseId)) {
            courseMap.set(courseId, { name, courseId });
        }
    });

    sendResponse({ courses: Array.from(courseMap.values()) });
}

async function handleStartDownload(courses) {
    console.log('[IIMBx] Starting download for:', courses.map(course => course.name));
    await chrome.runtime.sendMessage({ type: 'RESET_STATE' });
    await saveProcessingState({
        state: 'NAVIGATING_TO_COURSE',
        selectedCourses: courses,
        currentCourseIndex: 0,
        units: [],
        currentUnitIndex: 0
    });

    const firstCourse = courses[0];
    if (firstCourse) {
        window.location.href = buildCourseHomeUrl(firstCourse.courseId);
    }
}

function buildCourseHomeUrl(courseId) {
    return `https://apps.iimbx.edu.in/learning/course/${courseId}/home`;
}

async function resumeProcessing(savedState) {
    if (shouldStop()) return;
    const selectedCourses = Array.isArray(savedState.selectedCourses) ? savedState.selectedCourses : [];
    const currentCourseIndex = Number.isInteger(savedState.currentCourseIndex) ? savedState.currentCourseIndex : 0;
    const course = selectedCourses[currentCourseIndex];

    if (!course) {
        await finishCrawling();
        return;
    }

    const currentUrl = window.location.href;
    console.log(`[IIMBx] Resume: state=${savedState.state}, course=${course.name}, url=${currentUrl.substring(0, 120)}`);

    if (currentUrl.includes('/home')) {
        if (savedState.state === 'PROCESSING_UNITS'
            && Array.isArray(savedState.units)
            && savedState.units.length > 0) {
            await processCourseUnits(course, selectedCourses, currentCourseIndex, savedState.units);
        } else {
            await loadCourseOutline(course, selectedCourses, currentCourseIndex);
        }
        return;
    }

    await saveProcessingState({
        ...savedState,
        state: 'NAVIGATING_TO_COURSE',
        currentCourseIndex
    });
    window.location.href = buildCourseHomeUrl(course.courseId);
}

async function loadCourseOutline(course, allCourses, courseIdx) {
    if (shouldStop()) return;
    console.log(`[IIMBx] Loading outline for: ${course.name}`);
    await saveProcessingState({
        state: 'LOADING_OUTLINE',
        selectedCourses: allCourses,
        currentCourseIndex: courseIdx,
        units: [],
        currentUnitIndex: 0
    });

    const apiResult = await chrome.runtime.sendMessage({
        type: 'FETCH_COURSE_OUTLINE',
        courseId: course.courseId
    });

    if (apiResult?.status === 'fetched' && Array.isArray(apiResult.units) && apiResult.units.length > 0) {
        console.log(`[IIMBx] Outline: ${apiResult.units.length} verticals`);
        await saveProcessingState({
            state: 'PROCESSING_UNITS',
            selectedCourses: allCourses,
            currentCourseIndex: courseIdx,
            units: apiResult.units,
            currentUnitIndex: 0
        });
        await processCourseUnits(course, allCourses, courseIdx, apiResult.units);
        return;
    }

    console.error(`[IIMBx] Could not load outline for ${course.name} via blocks API`);
    await chrome.runtime.sendMessage({
        type: 'REPORT_ERROR',
        reason: `Could not load outline for "${course.name}". Refresh your IIMBx login and retry.`
    });
    await clearProcessingState();
}

const FETCH_CONCURRENCY = 5;

async function processCourseUnits(course, allCourses, courseIdx, units) {
    if (units.length === 0) {
        await moveToNextCourse(allCourses, courseIdx);
        return;
    }

    await saveProcessingState({
        state: 'PROCESSING_UNITS',
        selectedCourses: allCourses,
        currentCourseIndex: courseIdx,
        units,
        currentUnitIndex: 0
    });

    let cursor = 0;
    const fetchUnit = async (unit, idx) => {
        const sectionName = unit.chapterTitle || unit.sequentialTitle || course.name;
        const unitLabel = `${unit.chapterTitle} > ${unit.sequentialTitle} > ${unit.unitTitle}`.trim();
        console.log(`[IIMBx] Unit ${idx + 1}/${units.length}: ${unitLabel}`);

        const expectedBlockId = unit.unitBlockId || extractVerticalBlockId(unit.unitUrl);
        const correlationId = `${course.courseId}::${idx}::${Date.now()}`;
        const scanId = `${course.courseId}::${idx}::${Date.now()}`;

        try {
            await chrome.runtime.sendMessage({
                type: 'FETCH_UNIT_TRANSCRIPTS',
                correlationId,
                expectedBlockId,
                scanId,
                unitUrl: unit.unitUrl,
                courseName: course.name,
                sectionName,
                unitTitle: unit.unitTitle
            });
        } catch (e) {
            console.warn(`[IIMBx] Fetch failed for ${unitLabel}:`, e);
        }
    };

    const worker = async () => {
        while (cursor < units.length) {
            if (shouldStop()) return;
            const idx = cursor++;
            await fetchUnit(units[idx], idx);
        }
    };

    const workers = [];
    for (let i = 0; i < Math.min(FETCH_CONCURRENCY, units.length); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    if (shouldStop()) return;
    await moveToNextCourse(allCourses, courseIdx);
}

async function moveToNextCourse(allCourses, currentIdx) {
    if (shouldStop()) return;
    const nextIdx = currentIdx + 1;
    if (nextIdx < allCourses.length) {
        const nextCourse = allCourses[nextIdx];
        console.log(`[IIMBx] Next course: ${nextCourse.name}`);
        await saveProcessingState({
            state: 'NAVIGATING_TO_COURSE',
            selectedCourses: allCourses,
            currentCourseIndex: nextIdx,
            units: [],
            currentUnitIndex: 0
        });
        window.location.href = buildCourseHomeUrl(nextCourse.courseId);
    } else {
        await finishCrawling();
    }
}

async function saveProcessingState(nextState) {
    console.log(`[IIMBx] State: ${nextState.state}, course ${nextState.currentCourseIndex}, unit ${nextState.currentUnitIndex ?? 0}`);
    await chrome.storage.local.set({ processingState: nextState });
}

async function clearProcessingState() {
    await chrome.storage.local.remove('processingState');
}

async function finishCrawling() {
    if (shouldStop()) return;
    console.log('[IIMBx] All done - CRAWL_COMPLETE');
    try {
        await chrome.runtime.sendMessage({ type: 'CRAWL_COMPLETE' });
    } catch (e) {
        // ignore
    }
    await clearProcessingState();
}

async function init() {
    await delay(1000);
    if (shouldStop()) return;
    const { processingState } = await chrome.storage.local.get('processingState');
    if (processingState) {
        await resumeProcessing(processingState);
    } else {
        console.log('[IIMBx] Ready.');
    }
}

init();
