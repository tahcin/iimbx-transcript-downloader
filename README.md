# IIMBx Transcript Downloader

Chrome / Brave extension that bulk-downloads transcript PDFs from your enrolled IIMBx courses into a tidy folder hierarchy under your `Downloads`.

## How it works

The extension talks directly to the Open edX JSON APIs that the IIMBx site is built on, so there's no DOM scraping, no page navigation, and no dependence on the course page layout:

1. `GET /api/learner_home/init/` — lists your enrolled courses.
2. `GET /api/courses/v2/blocks/?course_id=…&depth=all` — returns the entire course tree (chapter → sequential → vertical) for each selected course. Cached for 1 hour.
3. `GET /xblock/<vertical-block>?view=student_view` — returns each unit's HTML, which is parsed for transcript PDF anchors.

Everything runs in the service worker using your existing iimbx.edu.in session cookies. There is no content script and no dashboard tab requirement — open the popup from any tab. Up to 5 unit fetches run in parallel; downloads are managed by Chrome's download manager.

If the service worker is evicted mid-run, it picks back up where it left off the next time the popup opens (URL-level dedup keeps already-downloaded files from being re-fetched).

## What it downloads

Transcript PDFs only, saved as:

```
Downloads/Transcripts/<Course Name>/<Module / Chapter Name>/<filename>.pdf
```

Filenames come straight from the asset URL on iimbx, so you get the original IIMBx-curated PDF names.

It does **not** download videos, YouTube subtitles, or non-transcript handouts.

## Installation

There's no build step.

1. Clone or download this repo.
2. Open `chrome://extensions` (or `brave://extensions`).
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked**.
5. Select the repo folder.

To use the extension, also turn off Chrome / Brave's *"Ask where to save each file before downloading"* setting — otherwise every PDF triggers a Save dialog and the run halts.

## Usage

1. Log in to IIMBx in the same browser profile.
2. Click the extension icon. (You don't need to be on the dashboard — any tab works as long as you're logged in.)
3. The popup lists every enrolled course. Use the search box to filter, click the checkboxes to pick the ones you want, then **Download transcripts**.
4. Close the popup if you want — the run continues in the background.

The popup shows the live download counter, the chapter currently being scanned, the unit a worker is on, and an in-flight count. **Stop** halts the active run. If any downloads fail after the auto-retry, **Retry failed** appears on the completion screen. **New download** clears state and re-queries the dashboard.

## Permissions

- `downloads` — save the PDFs
- `storage`, `unlimitedStorage` — persist run state and the outline cache
- Host: `https://apps.iimbx.edu.in/*`, `https://iimbx.edu.in/*` — for API calls and xblock fetches

## Files

- `manifest.json` — MV3 manifest
- `popup.html` / `popup.css` / `popup.js` — popup UI
- `background.js` — service worker: API calls, parallel fetch coordinator, download manager, state, retry
- `icons/` — toolbar icons

## License

MIT — see [LICENSE](LICENSE).
