# IIMBx Transcript Downloader

Chrome / Brave extension that bulk-downloads transcript PDFs from your enrolled IIMBx courses into a tidy folder hierarchy under your `Downloads`.

## How it works

The extension talks directly to the Open edX JSON APIs that the IIMBx site is built on, so there's no DOM scraping, no page navigation, and no dependence on the course page layout:

1. `GET /api/learner_home/init/` — lists your enrolled courses.
2. `GET /api/courses/v2/blocks/?course_id=…&depth=all` — returns the entire course tree (chapter → sequential → vertical) for each selected course. Cached for 1 hour.
3. `GET /xblock/<vertical-block>?view=student_view` — returns each unit's HTML, which is parsed for transcript PDF anchors.

Everything runs in the service worker using your existing iimbx.edu.in session cookies. There is no content script and no dashboard tab requirement — open the popup from any tab. Up to 5 unit fetches run in parallel; downloads are managed by Chrome's download manager.

If the service worker is evicted mid-run, it picks back up where it left off the next time the popup opens. Transcripts already fetched in that run aren't fetched again.

## What it downloads

Transcript PDFs only, saved as:

```
Downloads/Transcripts/<Course Name>/<Module / Chapter Name>/<filename>.pdf
```

Filenames come straight from the asset URL on iimbx, so you get the original IIMBx-curated PDF names.

It does **not** download videos, YouTube subtitles, or non-transcript handouts.

## Skipping transcripts you already have

Connect your `Downloads/Transcripts` folder once and every later run skips the transcripts already in it:

1. In the popup, click **Connect** on the folder bar under the course list. A small setup window opens.
2. Click **Choose folder**, pick the `Transcripts` folder itself (Chrome won't let extensions open all of Downloads), and allow Chrome to let the extension view files.

Once connected, each course shows how many transcripts are already saved, the progress screen shows a **Skipped** count, and a run with nothing new ends with **All caught up**.

How matching works:

- Access is read-only. The extension only lists PDF names and never changes the folder.
- A transcript counts as saved if a PDF with the same name is anywhere inside its course folder, so moving files between section folders is fine. Other files you add are ignored.
- Chrome's `name (1).pdf` copies count as the original.
- The browser only keeps folder access while the setup window is open, so the result of each check is saved. Runs use that list plus every transcript downloaded since, and the folder bar shows when it was last checked. Click **Rescan** after deleting or moving transcripts. (In Chrome, choosing *Allow on every visit* lets the popup read the folder live instead.)

**Brave** ships with folder access switched off. The folder bar shows **Enable**, which walks you through turning on `brave://flags/#file-system-access-api` and relaunching.

Without a connected folder, everything downloads again but replaces the existing file instead of saving a `(1)` copy. The setup window is also available as the extension's **Options** page.

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

While a run is going, the popup shows a live counter and a ledger with one square per transcript: saved, skipped, in flight, queued or failed. Below it are the course, section and file being worked on. **Stop** halts the active run. If any downloads fail after the auto-retry, **Retry failed** appears on the completion screen. **New download** clears state and re-queries the dashboard.

## Permissions

- `downloads` — save the PDFs
- `storage`, `unlimitedStorage` — persist run state and the outline cache
- Host: `https://apps.iimbx.edu.in/*`, `https://iimbx.edu.in/*` — for API calls and xblock fetches

## Files

- `manifest.json` — MV3 manifest
- `popup.html` / `popup.css` / `popup.js`: popup UI (`popup.css` also styles the setup window)
- `fonts.css` / `fonts/`: bundled Geist, Geist Mono and Instrument Serif (SIL Open Font License), so the popup renders instantly and offline
- `folder.html` / `folder.js`: Transcripts folder setup window (also the options page)
- `shared.js`: filename rules, the saved folder handle, folder scanning and the ledger renderer, shared by the popup, setup page and service worker
- `background.js` — service worker: API calls, parallel fetch coordinator, download manager, state, retry
- `icons/` — toolbar icons

## License

MIT — see [LICENSE](LICENSE).
