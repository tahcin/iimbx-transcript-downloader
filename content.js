'use strict';

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(selector);
        if (existing) return resolve(existing);

        const observer = new MutationObserver(() => {
            const found = document.querySelector(selector);
            if (found) {
                observer.disconnect();
                resolve(found);
            }
        });

        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        }

        setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Timeout: ${selector}`));
        }, timeout);
    });
}

function normalizeWhitespace(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

function cleanSectionLabel(text) {
    return normalizeWhitespace(text).replace(/,\s*(Incomplete|Complete)\s*section$/i, '').trim();
}

function cleanUnitLabel(text) {
    return normalizeWhitespace(text).replace(/,\s*(Incomplete|Complete)\s*unit$/i, '').trim();
}

function toAbsoluteUrl(href) {
    try {
        return new URL(href, window.location.href);
    } catch (e) {
        return null;
    }
}

function extractCourseId(value) {
    return value?.match(/course-v1:[^/?#]+/)?.[0] || '';
}

function extractSequentialBlockId(value) {
    return value?.match(/block-v1:[^/?#]+type@sequential\+block@[A-Za-z0-9]+/)?.[0] || '';
}

function extractVerticalBlockId(value) {
    return value?.match(/type@vertical\+block@([A-Za-z0-9]+)/)?.[1] || '';
}

function normalizeSequentialUrl(href, courseId) {
    const parsed = toAbsoluteUrl(href);
    if (!parsed) return '';

    if (parsed.hostname === 'apps.iimbx.edu.in') {
        return parsed.toString();
    }

    const blockId = extractSequentialBlockId(parsed.toString());
    const resolvedCourseId = courseId || extractCourseId(parsed.toString());
    if (blockId && resolvedCourseId) {
        return `https://apps.iimbx.edu.in/learning/course/${resolvedCourseId}/${blockId}`;
    }

    return '';
}

function normalizeVerticalUrl(href) {
    const parsed = toAbsoluteUrl(href);
    return parsed ? parsed.toString() : '';
}

function isVisible(element) {
    return !!element && element.getClientRects().length > 0;
}

function hasVideoUnitIcon(link) {
    return !!link.querySelector('svg path[d*="V13.75L22 18.417V5.583"], svg path[d*="L22 18.417V5.583"]');
}

function uniqueBy(items, keyFn) {
    const seen = new Set();
    return items.filter(item => {
        const key = keyFn(item);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function parseOutlineNumbers(text) {
    const normalized = normalizeWhitespace(text);
    const match = normalized.match(/^(\d+(?:\.\d+)*)/);
    if (match) {
        return match[1].split('.').map(value => Number.parseInt(value, 10));
    }

    const moduleMatch = normalized.match(/^Module\s+(\d+)/i);
    if (moduleMatch) {
        return [Number.parseInt(moduleMatch[1], 10)];
    }

    return [];
}

function compareOutlineEntries(left, right) {
    const leftNumbers = parseOutlineNumbers(left.title);
    const rightNumbers = parseOutlineNumbers(right.title);
    const length = Math.max(leftNumbers.length, rightNumbers.length);

    for (let index = 0; index < length; index++) {
        const leftValue = leftNumbers[index] ?? -1;
        const rightValue = rightNumbers[index] ?? -1;
        if (leftValue !== rightValue) {
            return leftValue - rightValue;
        }
    }

    return left.title.localeCompare(right.title);
}

function extractSectionNumber(sectionName) {
    const match = normalizeWhitespace(sectionName).match(/^Section\s+(\d+):/i);
    return match ? Number.parseInt(match[1], 10) : null;
}

function extractModuleNumber(sectionName) {
    const match = normalizeWhitespace(sectionName).match(/^Module\s+(\d+):/i);
    return match ? Number.parseInt(match[1], 10) : null;
}

function isSequentialTitle(text) {
    return /^\d+\.\d+\s+\S+/.test(normalizeWhitespace(text));
}

function isModuleTitle(text) {
    return /^Module\s+\d+:/i.test(normalizeWhitespace(text));
}

function isOutlineEntryTitle(text) {
    return isSequentialTitle(text) || isModuleTitle(text);
}

function isHomeContainerTitle(text) {
    const normalized = normalizeWhitespace(text);
    return /^Section\s+\d+:/i.test(normalized) || /^Module\s+\d+:/i.test(normalized);
}

function isSkippableNonLectureSequential() {
    const pageText = normalizeWhitespace(document.body?.innerText || '');
    if (/timed exam/i.test(pageText)) return true;
    if (/i am ready to start this timed exam/i.test(pageText)) return true;
    if (/discussion forum/i.test(pageText)) return true;
    if (/continuous learning assessment/i.test(pageText) && !document.querySelector('.outline-sidebar a[href*="type@vertical"]')) {
        return true;
    }
    return false;
}

let currentCorrelationId = null;
let transcriptResolve = null;
let pendingTranscripts = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_COURSE_LIST') {
        handleGetCourseList(sendResponse);
        return true;
    }

    if (message.type === 'START_DOWNLOAD') {
        handleStartDownload(message.courses);
        sendResponse({ status: 'started' });
    }

    if (message.type === 'TRANSCRIPTS_FOUND_RELAY') {
        handleTranscriptsFoundRelay(message);
    }
});

function handleGetCourseList(sendResponse) {
    const links = document.querySelectorAll('a[href*="/learning/course/course-v1:"]');
    const courseMap = new Map();

    links.forEach(link => {
        const name = normalizeWhitespace(link.querySelector('h2')?.textContent || link.textContent);
        const courseId = extractCourseId(link.href);
        if (courseId && name && !courseMap.has(courseId)) {
            courseMap.set(courseId, { name, courseId });
        }
    });

    sendResponse({ courses: Array.from(courseMap.values()) });
}

function handleTranscriptsFoundRelay(message) {
    console.log('[IIMBx] TRANSCRIPTS_FOUND_RELAY received:', message.transcripts?.length, 'items, correlationId match:', message.correlationId === currentCorrelationId);

    if (!message.correlationId || message.correlationId !== currentCorrelationId) {
        console.log('[IIMBx] Ignoring stale relay');
        return;
    }

    const transcripts = message.transcripts || [];
    if (transcriptResolve) {
        transcriptResolve(transcripts);
        transcriptResolve = null;
    } else {
        pendingTranscripts = transcripts;
    }
}

function waitForTranscripts(timeout = 8000) {
    return new Promise(resolve => {
        if (pendingTranscripts.length > 0) {
            const buffered = pendingTranscripts;
            pendingTranscripts = [];
            resolve(buffered);
            return;
        }

        const timer = setTimeout(() => {
            transcriptResolve = null;
            pendingTranscripts = [];
            resolve([]);
        }, timeout);

        transcriptResolve = transcripts => {
            clearTimeout(timer);
            pendingTranscripts = [];
            resolve(transcripts);
        };
    });
}

async function handleStartDownload(courses) {
    console.log('[IIMBx] Starting download for:', courses.map(course => course.name));
    await chrome.runtime.sendMessage({ type: 'RESET_STATE' });
    await saveProcessingState({
        state: 'NAVIGATING_TO_COURSE',
        selectedCourses: courses,
        currentCourseIndex: 0,
        sequentials: [],
        currentSequentialIndex: 0
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
        await crawlCourseHome(course, selectedCourses, currentCourseIndex);
        return;
    }

    if (currentUrl.includes('/block-v1:')) {
        await processSequentialPage(course, selectedCourses, currentCourseIndex, savedState);
        return;
    }

    await saveProcessingState({
        ...savedState,
        state: 'NAVIGATING_TO_COURSE',
        currentCourseIndex
    });
    window.location.href = buildCourseHomeUrl(course.courseId);
}

async function crawlCourseHome(course, allCourses, courseIdx) {
    console.log(`[IIMBx] Collecting sequentials from course home: ${course.name}`);
    await saveProcessingState({
        state: 'CRAWLING_COURSE_HOME',
        selectedCourses: allCourses,
        currentCourseIndex: courseIdx,
        sequentials: [],
        currentSequentialIndex: 0
    });

    await waitForCourseHomeReady();
    let sequentials = await collectAllSequentialsFromHome(course.courseId);

    console.log(`[IIMBx] Found ${sequentials.length} sequential links on course home`);

    if (sequentials.length === 0) {
        console.error('[IIMBx] No sequential links found on course home');
        await delay(2000);
        sequentials = await collectAllSequentialsFromHome(course.courseId, 10);
        console.log(`[IIMBx] Retry found ${sequentials.length} sequential links on course home`);
        if (sequentials.length === 0) {
            await moveToNextCourse(allCourses, courseIdx);
            return;
        }
    }

    if (sequentials.length === 0) {
        return;
    }

    await saveProcessingState({
        state: 'NAVIGATING_TO_SEQUENTIAL',
        selectedCourses: allCourses,
        currentCourseIndex: courseIdx,
        sequentials,
        currentSequentialIndex: 0
    });

    window.location.href = sequentials[0].url;
}

async function expandAllHomeSections() {
    const expandAll = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .find(element => /expand all/i.test(normalizeWhitespace(element.textContent)));

    if (expandAll) {
        expandAll.click();
        await delay(1500);
    }
}

async function clickVisiblePlusControls() {
    const plusControls = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
        .filter(element => isVisible(element) && normalizeWhitespace(element.textContent) === '+');

    for (const control of plusControls) {
        control.click();
        await delay(250);
    }
}

async function collectAllSequentialsFromHome(courseId, maxPasses = 6) {
    await expandAllHomeSections();
    await delay(1000);

    let sequentials = [];
    let previousCount = -1;

    for (let pass = 0; pass < maxPasses; pass++) {
        sequentials = uniqueBy(
            [...sequentials, ...collectSequentialsFromHome(courseId)],
            entry => entry.url
        ).sort(compareOutlineEntries);

        const missingSections = getHomeSectionHeadings()
            .filter(section => {
                const sectionNumber = extractSectionNumber(section.title);
                return sectionNumber != null && !sequentials.some(entry => parseOutlineNumbers(entry.title)[0] === sectionNumber);
            });

        if (missingSections.length > 0) {
            for (const section of missingSections) {
                const expanded = await expandHomeSection(section);
                if (expanded) {
                    await delay(800);
                    sequentials = uniqueBy(
                        [...sequentials, ...collectSequentialsFromHome(courseId)],
                        entry => entry.url
                    ).sort(compareOutlineEntries);
                }
            }
        }

        if (sequentials.length === previousCount) {
            const expanded = await expandCollapsedHomeSections();
            if (!expanded) break;
        } else {
            previousCount = sequentials.length;
            await clickVisiblePlusControls();
            await delay(800);
        }
    }

    return sequentials;
}

function getHomeSectionHeadings() {
    return Array.from(document.querySelectorAll('div, span'))
        .map(element => ({
            element,
            title: cleanSectionLabel(element.textContent)
        }))
        .filter(entry => isHomeContainerTitle(entry.title))
        .filter(entry => isVisible(entry.element))
        .sort((left, right) => {
            const leftNumber = extractSectionNumber(left.title) ?? extractModuleNumber(left.title) ?? 0;
            const rightNumber = extractSectionNumber(right.title) ?? extractModuleNumber(right.title) ?? 0;
            return leftNumber - rightNumber;
        });
}

async function expandHomeSection(sectionEntry) {
    const row = findSectionRow(sectionEntry.element);
    if (!row) return false;

    const rowText = normalizeWhitespace(row.textContent);
    if (/-$/.test(rowText)) {
        return false;
    }

    const toggle = Array.from(row.querySelectorAll('button, a, [role="button"], div, span'))
        .find(element => isVisible(element) && /^[+]$/.test(normalizeWhitespace(element.textContent)));

    if (toggle) {
        toggle.click();
        return true;
    }

    row.click();
    return true;
}

function findSectionRow(element) {
    let current = element;
    while (current && current !== document.body) {
        const text = normalizeWhitespace(current.textContent);
        if (isHomeContainerTitle(text)) {
            return current;
        }
        current = current.parentElement;
    }
    return element.parentElement;
}

async function waitForCourseHomeReady(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const hasSectionHeading = Array.from(document.querySelectorAll('div, span'))
            .some(element => /^Section\s+\d+:/i.test(normalizeWhitespace(element.textContent)));
        const hasSequentialLink = document.querySelector('a[href*="type@sequential"], a[href*="/jump_to/"]');

        if (hasSectionHeading || hasSequentialLink) {
            await delay(800);
            return;
        }

        await delay(500);
    }
}

async function expandCollapsedHomeSections() {
    const rows = Array.from(document.querySelectorAll('div, section, article'));
    let expandedAny = false;

    for (const row of rows) {
        const text = normalizeWhitespace(row.textContent);
        if (!isHomeContainerTitle(text)) continue;

        const clickable = Array.from(row.querySelectorAll('button, a, [role="button"], div, span'))
            .find(element => isVisible(element) && /^[+]$/.test(normalizeWhitespace(element.textContent)));

        if (clickable) {
            clickable.click();
            expandedAny = true;
            await delay(500);
            continue;
        }

        const container = findSectionContainer(row);
        if (container) {
            container.click();
            expandedAny = true;
            await delay(500);
        }
    }

    return expandedAny;
}

function findSectionContainer(element) {
    let current = element;
    while (current && current !== document.body) {
        const text = normalizeWhitespace(current.textContent);
        if (isHomeContainerTitle(text)) {
            return current;
        }
        current = current.parentElement;
    }
    return element.parentElement || null;
}

function collectSequentialsFromHome(courseId) {
    const items = Array.from(document.querySelectorAll('div.font-weight-bold.text-dark-500, a[href]'));

    let currentSectionName = '';
    const sequentials = [];

    for (const item of items) {
        const text = normalizeWhitespace(item.textContent);

        if (!item.matches('a') && isHomeContainerTitle(text)) {
            currentSectionName = cleanSectionLabel(text);
            continue;
        }

        if (!item.matches('a')) continue;

        const title = cleanUnitLabel(text);
        if (!isOutlineEntryTitle(title)) continue;

        const url = normalizeSequentialUrl(item.href, courseId);
        if (!url || !title) continue;

        sequentials.push({
            url,
            title,
            sectionName: currentSectionName || title
        });
    }

    return uniqueBy(sequentials, entry => entry.url).sort(compareOutlineEntries);
}

function collectChildSequentialsFromCurrentPage(parentSequential) {
    const currentSequentialBlockId = extractSequentialBlockId(window.location.href);
    const links = Array.from(document.querySelectorAll('.outline-sidebar a[href*="type@sequential"]'))
        .filter(link => isVisible(link));

    const children = links.map(link => {
        const title = cleanUnitLabel(link.textContent);
        const url = normalizeSequentialUrl(link.href);

        if (!title || !url) return null;
        if (!isSequentialTitle(title)) return null;
        if (extractSequentialBlockId(url) === currentSequentialBlockId) return null;

        return {
            url,
            title,
            sectionName: parentSequential.title
        };
    }).filter(Boolean);

    return uniqueBy(children, entry => entry.url).sort(compareOutlineEntries);
}

async function processSequentialPage(course, allCourses, courseIdx, savedState) {
    const sequentials = Array.isArray(savedState.sequentials) ? savedState.sequentials : [];
    if (sequentials.length === 0) {
        console.warn('[IIMBx] Missing sequential list in state, returning to course home');
        await saveProcessingState({
            ...savedState,
            state: 'NAVIGATING_TO_COURSE',
            currentCourseIndex: courseIdx,
            sequentials: [],
            currentSequentialIndex: 0
        });
        window.location.href = buildCourseHomeUrl(course.courseId);
        return;
    }

    const currentSequentialIndex = resolveCurrentSequentialIndex(sequentials, savedState.currentSequentialIndex);
    const currentSequential = sequentials[currentSequentialIndex];

    console.log(`[IIMBx] Processing sequential ${currentSequentialIndex + 1}/${sequentials.length}: ${currentSequential.title}`);

    await saveProcessingState({
        state: 'PROCESSING_SEQUENTIAL',
        selectedCourses: allCourses,
        currentCourseIndex: courseIdx,
        sequentials,
        currentSequentialIndex
    });

    const childSequentials = collectChildSequentialsFromCurrentPage(currentSequential);
    if (childSequentials.length > 0 && isModuleTitle(currentSequential.title)) {
        console.log(`[IIMBx] Expanding module ${currentSequential.title} into ${childSequentials.length} child sequentials`);

        const expandedSequentials = [
            ...sequentials.slice(0, currentSequentialIndex),
            ...childSequentials,
            ...sequentials.slice(currentSequentialIndex + 1)
        ];

        await saveProcessingState({
            state: 'NAVIGATING_TO_SEQUENTIAL',
            selectedCourses: allCourses,
            currentCourseIndex: courseIdx,
            sequentials: expandedSequentials,
            currentSequentialIndex
        });

        window.location.assign(childSequentials[0].url);
        return;
    }

    let unitEntries = [];
    if (isSkippableNonLectureSequential()) {
        console.log(`[IIMBx] Skipping non-lecture sequential: ${currentSequential.title}`);
    } else {
    try {
        await waitForElement('.outline-sidebar a[href*="type@vertical"]', 15000);
        await delay(1000);
        unitEntries = collectVisibleUnitsFromSidebar();
    } catch (e) {
        console.log(`[IIMBx] No unit links found for sequential: ${currentSequential.title}`);
    }
    }

    console.log(`[IIMBx] Found ${unitEntries.length} units in sidebar`);

    for (let unitIdx = 0; unitIdx < unitEntries.length; unitIdx++) {
        const unit = unitEntries[unitIdx];
        const correlationId = `${course.courseId}::${currentSequentialIndex}::${unitIdx}::${Date.now()}`;
        const expectedBlockId = extractVerticalBlockId(unit.url);

        console.log(`[IIMBx] Unit ${unitIdx + 1}/${unitEntries.length}: ${unit.title}`);

        const liveLink = findVisibleUnitLink(unit.url);
        const alreadyOnUnit = !!expectedBlockId && window.location.href.includes(expectedBlockId);
        let activated = alreadyOnUnit;

        if (!liveLink) {
            console.log(`[IIMBx] Missing live sidebar link for unit: ${unit.title}`);
            continue;
        }

        if (!alreadyOnUnit) {
            liveLink.click();
            activated = await waitForUnitActivation(expectedBlockId, 5000);
        }

        if (!activated) {
            console.log(`[IIMBx] Sidebar click did not activate target unit: ${unit.title}`);
            continue;
        }

        currentCorrelationId = correlationId;
        pendingTranscripts = [];
        transcriptResolve = null;

        await chrome.runtime.sendMessage({
            type: 'CURSOR_UPDATE',
            correlationId,
            expectedBlockId,
            courseName: course.name,
            sectionName: currentSequential.sectionName,
            unitTitle: unit.title
        });

        try {
            await waitForElement('#unit-iframe', 4000);
            await reloadUnitIframe(expectedBlockId);
            await waitForIframeReady(expectedBlockId, 5000);
            await delay(1200);
        } catch (e) {
            console.log(`[IIMBx] Iframe timeout for unit: ${unit.title}`);
            await delay(1000);
            continue;
        }

        let transcripts = await waitForTranscripts(5000);
        if (transcripts.length === 0) {
            console.log(`[IIMBx] No transcripts received on first pass for ${unit.title}, retrying iframe reload`);
            try {
                await reloadUnitIframe(expectedBlockId);
                await waitForIframeReady(expectedBlockId, 5000);
                await delay(1200);
            } catch (e) {
                // Ignore retry setup failures; the final empty state below will handle it.
            }
            transcripts = await waitForTranscripts(5000);
        }

        if (transcripts.length > 0) {
            console.log(`[IIMBx] Found ${transcripts.length} transcript(s) for ${unit.title}`);
        } else {
            console.log(`[IIMBx] No transcript found for ${unit.title}, advancing`);
        }

        await delay(1500);
    }

    await navigateToNextSequentialOrCourse(allCourses, courseIdx, sequentials, currentSequentialIndex);
}

function resolveCurrentSequentialIndex(sequentials, fallbackIndex) {
    const currentUrl = window.location.href;
    const currentBlockId = extractSequentialBlockId(currentUrl);
    const foundIndex = sequentials.findIndex(entry => extractSequentialBlockId(entry.url) === currentBlockId);
    if (foundIndex >= 0) return foundIndex;
    return Number.isInteger(fallbackIndex) ? fallbackIndex : 0;
}

function collectVisibleUnitsFromSidebar() {
    const links = Array.from(document.querySelectorAll('.outline-sidebar a[href*="type@vertical"]'))
        .filter(link => isVisible(link) && hasVideoUnitIcon(link));

    const units = links.map((link, index) => ({
        url: normalizeVerticalUrl(link.href),
        title: cleanUnitLabel(link.textContent) || `Unit ${index + 1}`
    }));

    return uniqueBy(units, entry => entry.url);
}

function findVisibleUnitLink(url) {
    return Array.from(document.querySelectorAll('.outline-sidebar a[href*="type@vertical"]'))
        .find(link => isVisible(link) && hasVideoUnitIcon(link) && normalizeVerticalUrl(link.href) === url) || null;
}

function findVisibleSequentialLink(url) {
    return Array.from(document.querySelectorAll('a[href*="type@sequential"]'))
        .find(link => isVisible(link) && normalizeSequentialUrl(link.href) === url) || null;
}

function waitForUnitActivation(expectedBlockId, timeout = 5000) {
    return new Promise(resolve => {
        if (!expectedBlockId) {
            resolve(false);
            return;
        }

        const start = Date.now();
        const timer = setInterval(() => {
            if (window.location.href.includes(expectedBlockId)) {
                clearInterval(timer);
                resolve(true);
                return;
            }

            if (Date.now() - start >= timeout) {
                clearInterval(timer);
                resolve(false);
            }
        }, 250);
    });
}

function waitForIframeReady(expectedBlockId, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
            const iframe = document.querySelector('#unit-iframe');
            const src = iframe?.src || '';
            const matches = expectedBlockId ? src.includes(expectedBlockId) : /xblock|block-v1/.test(src);

            if (matches) {
                clearInterval(timer);
                resolve();
                return;
            }

            if (Date.now() - start >= timeout) {
                clearInterval(timer);
                reject(new Error('Iframe did not reach expected unit'));
            }
        }, 400);
    });
}

async function reloadUnitIframe(expectedBlockId) {
    const iframe = document.querySelector('#unit-iframe');
    const currentSrc = iframe?.src || '';
    const matches = expectedBlockId ? currentSrc.includes(expectedBlockId) : /xblock|block-v1/.test(currentSrc);

    if (!iframe || !currentSrc || !matches) {
        return false;
    }

    iframe.src = 'about:blank';
    await delay(250);
    iframe.src = currentSrc;
    return true;
}

function waitForSequentialActivation(expectedBlockId, timeout = 7000) {
    return new Promise(resolve => {
        if (!expectedBlockId) {
            resolve(false);
            return;
        }

        const start = Date.now();
        const timer = setInterval(() => {
            if (window.location.href.includes(expectedBlockId)) {
                clearInterval(timer);
                resolve(true);
                return;
            }

            if (Date.now() - start >= timeout) {
                clearInterval(timer);
                resolve(false);
            }
        }, 250);
    });
}

async function navigateToNextSequentialOrCourse(allCourses, courseIdx, sequentials, currentSequentialIndex) {
    const nextSequentialIndex = currentSequentialIndex + 1;
    if (nextSequentialIndex < sequentials.length) {
        const nextSequential = sequentials[nextSequentialIndex];
        const nextSequentialBlockId = extractSequentialBlockId(nextSequential.url);

        console.log(`[IIMBx] Navigating to next sequential ${nextSequentialIndex + 1}/${sequentials.length}: ${nextSequential.title}`);
        await saveProcessingState({
            state: 'NAVIGATING_TO_SEQUENTIAL',
            selectedCourses: allCourses,
            currentCourseIndex: courseIdx,
            sequentials,
            currentSequentialIndex: nextSequentialIndex
        });

        const liveSequentialLink = findVisibleSequentialLink(nextSequential.url);
        if (liveSequentialLink) {
            console.log(`[IIMBx] Clicking live sequential link: ${nextSequential.title}`);
            liveSequentialLink.click();
            const activated = await waitForSequentialActivation(nextSequentialBlockId, 5000);
            if (activated) {
                return;
            }
            console.log(`[IIMBx] Live sequential click did not activate target, falling back to location.assign`);
        }

        window.location.assign(nextSequential.url);
        const activatedByAssign = await waitForSequentialActivation(nextSequentialBlockId, 5000);
        if (!activatedByAssign) {
            console.log(`[IIMBx] location.assign did not activate target, forcing location.replace`);
            window.location.replace(nextSequential.url);
        }
        return;
    }

    await moveToNextCourse(allCourses, courseIdx);
}

async function moveToNextCourse(allCourses, currentIdx) {
    const nextIdx = currentIdx + 1;
    if (nextIdx < allCourses.length) {
        const nextCourse = allCourses[nextIdx];
        console.log(`[IIMBx] Next course: ${nextCourse.name}`);
        await saveProcessingState({
            state: 'NAVIGATING_TO_COURSE',
            selectedCourses: allCourses,
            currentCourseIndex: nextIdx,
            sequentials: [],
            currentSequentialIndex: 0
        });
        window.location.href = buildCourseHomeUrl(nextCourse.courseId);
    } else {
        await finishCrawling();
    }
}

async function saveProcessingState(nextState) {
    console.log(`[IIMBx] State: ${nextState.state}, course ${nextState.currentCourseIndex}, sequential ${nextState.currentSequentialIndex ?? 0}`);
    await chrome.storage.local.set({ processingState: nextState });
}

async function clearProcessingState() {
    await chrome.storage.local.remove('processingState');
}

async function finishCrawling() {
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
    const { processingState } = await chrome.storage.local.get('processingState');
    if (processingState) {
        await resumeProcessing(processingState);
    } else {
        console.log('[IIMBx] Ready.');
    }
}

init();
