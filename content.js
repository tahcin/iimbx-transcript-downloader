'use strict';

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

function isVisible(element) {
    return !!element && element.getClientRects().length > 0;
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
    const match = normalizeWhitespace(sectionName).match(/^Module\s+(\d+)\s*(?:\||:)/i);
    return match ? Number.parseInt(match[1], 10) : null;
}

function isSequentialTitle(text) {
    return /^\d+\.\d+\s+\S+/.test(normalizeWhitespace(text));
}

function isModuleTitle(text) {
    return /^Module\s+\d+\s*(?:\||:)/i.test(normalizeWhitespace(text));
}

function isOutlineEntryTitle(text) {
    return isSequentialTitle(text) || isModuleTitle(text);
}

function isHomeContainerTitle(text) {
    const normalized = normalizeWhitespace(text);
    return /^Section\s+\d+:/i.test(normalized) || /^Module\s+\d+\s*(?:\||:)/i.test(normalized);
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
        if (savedState.state === 'PROCESSING_SEQUENTIALS'
            && Array.isArray(savedState.sequentials)
            && savedState.sequentials.length > 0) {
            const startIdx = Number.isInteger(savedState.currentSequentialIndex) ? savedState.currentSequentialIndex : 0;
            await processSequentialsList(course, selectedCourses, currentCourseIndex, savedState.sequentials, startIdx);
        } else {
            await crawlCourseHome(course, selectedCourses, currentCourseIndex);
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

async function crawlCourseHome(course, allCourses, courseIdx) {
    if (shouldStop()) return;
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
        state: 'PROCESSING_SEQUENTIALS',
        selectedCourses: allCourses,
        currentCourseIndex: courseIdx,
        sequentials,
        currentSequentialIndex: 0
    });

    await processSequentialsList(course, allCourses, courseIdx, sequentials, 0);
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
    if (shouldStop()) return [];
    await expandAllHomeSections();
    await delay(1000);

    let sequentials = [];
    let previousCount = -1;

    for (let pass = 0; pass < maxPasses; pass++) {
        if (shouldStop()) return sequentials;
        sequentials = uniqueBy(
            [...sequentials, ...collectSequentialsFromHome(courseId)],
            entry => entry.url
        ).sort(compareOutlineEntries);

        const missingSections = getHomeSectionHeadings()
            .filter(section => {
                const sectionNumber = extractSectionNumber(section.title);
                const moduleNumber = extractModuleNumber(section.title);
                const containerNumber = sectionNumber ?? moduleNumber;
                return containerNumber != null && !sequentials.some(entry => parseOutlineNumbers(entry.title)[0] === containerNumber);
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
            .some(element => isHomeContainerTitle(normalizeWhitespace(element.textContent)));
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

        if (!clickable) continue;

        clickable.click();
        expandedAny = true;
        await delay(500);
    }

    return expandedAny;
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

async function processSequentialsList(course, allCourses, courseIdx, initialSequentials, startIdx) {
    let workingSequentials = initialSequentials.map(entry => ({ ...entry }));
    let seqIdx = Number.isInteger(startIdx) ? startIdx : 0;

    while (seqIdx < workingSequentials.length) {
        if (shouldStop()) return;
        const sequential = workingSequentials[seqIdx];

        await saveProcessingState({
            state: 'PROCESSING_SEQUENTIALS',
            selectedCourses: allCourses,
            currentCourseIndex: courseIdx,
            sequentials: workingSequentials,
            currentSequentialIndex: seqIdx
        });

        console.log(`[IIMBx] Processing sequential ${seqIdx + 1}/${workingSequentials.length}: ${sequential.title}`);

        const fetchResult = await chrome.runtime.sendMessage({
            type: 'FETCH_SEQUENTIAL_UNITS',
            sequentialUrl: sequential.url,
            sequentialTitle: sequential.title
        });

        if (shouldStop()) return;

        const verticals = Array.isArray(fetchResult?.verticals) ? fetchResult.verticals : [];
        const childSequentials = Array.isArray(fetchResult?.sequentials) ? fetchResult.sequentials : [];

        if (verticals.length === 0 && childSequentials.length > 0) {
            console.log(`[IIMBx] Expanding ${sequential.title} into ${childSequentials.length} child sequentials`);
            const expanded = childSequentials.map((child, idx) => ({
                url: child.url,
                title: `${sequential.title} > ${idx + 1}`,
                sectionName: sequential.title
            }));
            workingSequentials = [
                ...workingSequentials.slice(0, seqIdx),
                ...expanded,
                ...workingSequentials.slice(seqIdx + 1)
            ];
            continue;
        }

        if (verticals.length === 0) {
            console.log(`[IIMBx] No units found in ${sequential.title}, advancing`);
            seqIdx += 1;
            continue;
        }

        const sectionName = sequential.sectionName || sequential.title;

        for (let unitIdx = 0; unitIdx < verticals.length; unitIdx++) {
            if (shouldStop()) return;
            const unit = verticals[unitIdx];
            const expectedBlockId = extractVerticalBlockId(unit.url);
            const correlationId = `${course.courseId}::${seqIdx}::${unitIdx}::attempt-1::${Date.now()}`;
            const scanId = buildScanId(course.courseId, seqIdx, unitIdx, 1);
            const unitTitle = unit.title || `${sequential.title} unit ${unitIdx + 1}`;

            console.log(`[IIMBx] Unit ${unitIdx + 1}/${verticals.length}: ${unitTitle}`);

            const fetched = await chrome.runtime.sendMessage({
                type: 'FETCH_UNIT_TRANSCRIPTS',
                correlationId,
                expectedBlockId,
                scanId,
                unitUrl: unit.url,
                courseName: course.name,
                sectionName,
                unitTitle
            });

            await chrome.runtime.sendMessage({
                type: 'CURSOR_UPDATE',
                correlationId,
                expectedBlockId,
                scanId,
                courseName: course.name,
                sectionName,
                unitTitle
            });

            if (!Array.isArray(fetched?.transcripts) || fetched.transcripts.length === 0) {
                console.log(`[IIMBx] No transcripts for ${unitTitle}`);
            }

            await delay(200);
        }

        seqIdx += 1;
    }

    if (shouldStop()) return;
    await moveToNextCourse(allCourses, courseIdx);
}

function buildScanId(courseId, sequentialIndex, unitIdx, attempt) {
    return `${courseId}::${sequentialIndex}::${unitIdx}::scan-${attempt}::${Date.now()}`;
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
