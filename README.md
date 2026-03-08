# IIMBx Transcript Downloader

Chrome/Brave extension for bulk-downloading transcript PDFs from IIMBx courses.

It is meant for the IIMBx learning flows hosted on:

- `https://apps.iimbx.edu.in/*`
- `https://iimbx.edu.in/*`

The extension crawls a selected course, opens its lecture pages, detects transcript PDF links inside the course content iframe, and downloads those PDFs into a course-organized folder structure under your Downloads folder.

## What It Is For

This extension is designed for IIMBx courses where:

- the learner starts from the IIMBx dashboard
- a course has modules/sections such as `Section 1`, `Module 2`, etc.
- those contain sequentials like `1.1`, `2.3`, `4.1`
- those then contain lecture/video units like `1.1.1`, `1.2.2`, etc.
- video pages expose transcript downloads inside the embedded IIMBx content frame

It skips obvious non-lecture pages such as:

- discussion forums
- timed exams / continuous learning assessments
- feedback/live-session style pages

## What It Downloads

The extension downloads transcript PDFs only.

It does not download:

- videos
- subtitles from YouTube directly
- handouts unless they are surfaced as transcript PDF assets

Downloads are grouped under a path like:

`Downloads/Transcripts/<Course Name>/<Section or Module Name>/...`

## Setup

There is no build step. Load it as an unpacked extension.

1. Open Chrome or Brave.
2. Go to `chrome://extensions` or `brave://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select this folder:

```text
C:\Users\tahci\desktop\t_d
```

6. Make sure the extension stays enabled.

## Required Browser Settings

For reliable bulk downloading:

1. Open browser download settings.
2. Disable:

```text
Ask where to save each file before downloading
```

If this setting stays enabled, the native `Save As` dialog will block the crawl.

## How To Use

1. Log in to IIMBx.
2. Open the learner dashboard:

```text
https://apps.iimbx.edu.in/learner-dashboard/
```

3. Open the extension popup.
4. Select one or more courses.
5. Click `Download Transcripts`.
6. Leave the course tab open until the run finishes.

The popup shows:

- current course
- current section/module
- current unit
- number of PDFs downloaded

You can also use `Stop Download` to halt an active run.

## Supported Course Shapes

The extension is intended to handle both of these broad patterns:

1. Section-based courses

- `Section 1`
- `1.1`
- `1.1.1`

2. Module-based courses

- `Module 1`
- `1.1`
- `1.1.1`

It works best when the course outline ultimately exposes lecture/video units in the left sidebar and transcript links exist in the IIMBx iframe content.

## Reliability Notes

The current implementation is UI-driven, so these habits help:

- keep the IIMBx course tab open
- avoid closing or navigating that tab elsewhere during a run
- switching to other tabs is usually fine
- keeping the course tab in the foreground is the safest option for long runs

## Troubleshooting

### The popup shows `0/0 PDFs`

Check the page console and look for:

- `Found X units in sidebar`
- `TRANSCRIPTS_FOUND_RELAY received`
- `Found X transcript(s), reporting...`

If those appear, transcript detection is working and the problem is usually download handling or state handoff.

### The browser opens `Save As`

Disable:

```text
Ask where to save each file before downloading
```

### It gets stuck on non-lecture pages

The crawler is supposed to skip timed exams, discussion forums, assessments, and similar pages. If a new course shape still causes a stall, capture:

- the page URL
- the popup state
- page console logs

### It misses part of a course

Some IIMBx courses use slightly different module/section DOM structures. If that happens, inspect:

- course home structure
- module/sequential expansion behavior
- sidebar unit rows

## Permissions Used

- `downloads`: save transcript PDFs
- `storage`: persist progress/state
- `unlimitedStorage`: keep crawl state reliably
- `activeTab`: interact with the active IIMBx tab
- `scripting`: inject/coordinate page-side logic

Host permissions are restricted to:

- `https://apps.iimbx.edu.in/*`
- `https://iimbx.edu.in/*`

## Project Files

- [manifest.json](C:\Users\tahci\desktop\t_d\manifest.json) extension manifest
- [popup.html](C:\Users\tahci\desktop\t_d\popup.html) popup UI
- [popup.js](C:\Users\tahci\desktop\t_d\popup.js) popup logic
- [background.js](C:\Users\tahci\desktop\t_d\background.js) download/state worker
- [content.js](C:\Users\tahci\desktop\t_d\content.js) course traversal logic
- [iframe_content.js](C:\Users\tahci\desktop\t_d\iframe_content.js) transcript detection inside IIMBx iframe

## License

This repository includes an MIT license. See [LICENSE](C:\Users\tahci\desktop\t_d\LICENSE).
