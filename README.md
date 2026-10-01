# 3D Creator Toolkit — MyMiniFactory exporter

Export your **own public MyMiniFactory object listings** to CSV, then optionally download their images and model files into a folder you choose. The extension uses your signed-in browser session; you do not need to enter a password into the extension.

## Install

You need desktop **Brave or Chrome**. From this GitHub repository's **Releases → Latest** page, download the asset named **`3d-creator-toolkit.zip`**. Releases are built automatically after successful pushes to the default branch. **No Node.js, command line, or build step is needed to install the extension.**

1. Download the ZIP above and **extract it** to a folder you intend to keep. Do not choose the ZIP itself in the browser.
2. Open `brave://extensions` (or `chrome://extensions`) and enable **Developer mode**.
3. Click **Load unpacked** and select the **extracted folder that contains `manifest.json`**. The 3D Creator Toolkit cube icon should appear in your extensions list.
4. Pin the extension to your browser toolbar if you want one-click access. Sign in to [MyMiniFactory](https://www.myminifactory.com/) as the creator whose listings you want, and leave a MyMiniFactory tab open.

Keep the extracted folder in place: the browser loads the extension from there. **To update without losing the browser's saved download job**, pause or close the downloader, extract the new ZIP **over the same installed folder** (replace its files), then click **Reload** on the existing extension card. Do not remove the extension and load a different folder: unpacked extension storage is tied to its browser extension ID, which may change with the folder path. Refresh your MyMiniFactory tab if the updated extension cannot connect to it. If your browser warns about installing an unpacked extension, verify that you obtained the ZIP from a source you trust before continuing.

### Brave: enable folder access for asset downloads

The **Collect CSV** tab works without any browser flag. The **Download assets** workspace needs permission to write inside the destination folder you choose, organize files by listing, and resume after an interruption. The browser's **File System Access API** provides that folder picker and permission; selecting a CSV alone does not grant folder access.

Brave disables this API by default. To enable the folder picker:

1. Open `brave://flags/#file-system-access-api`.
2. Set **File System Access API** to **Enabled** and **Relaunch** Brave.
3. Reopen the downloader workspace. If you still see the compatibility notice, reload the extension at `brave://extensions` and reopen the workspace.

This is a **browser-wide experimental flag**, not an extension setting. Enable it only if you trust applications to which you explicitly grant folder access. The extension cannot enable the flag for you. Chrome generally provides the picker without this flag. Your browser still asks you to choose a folder and may ask for permission again after a restart.

## Step 1 — Collect your CSV

1. Sign in to [MyMiniFactory](https://www.myminifactory.com/) **as the creator whose listings you want**. Keep any MyMiniFactory tab open.
2. Open the extension popup. **Collect CSV** is selected by default and shows the signed-in creator's username and avatar. The username is read-only: viewing another creator's profile does not change the export target.
3. For a catalog-only CSV, leave **Include file download URLs** unchecked. To download model files in Step 2, **check it before exporting**; the CSV will include filenames, file sizes when available, and download links.
4. Click **Export CSV**. Leave the MyMiniFactory tab open until the CSV downloads. You can close and reopen the popup to check progress; the export runs in the site tab.

The CSV contains one row per **public, listed object**, with its title, URL, price, description, tags, categories, collections, and image URLs. It does **not** include bundles or private objects. If the session changes or the listing data is incomplete, the export stops rather than saving a partial CSV.

**Screenshot reference — Collect CSV tab:** `docs/screenshots/collect-csv.png` (add your screenshot later).

<!-- After adding the image, remove this comment wrapper to display it:
![Collect CSV tab with the signed-in creator and export progress](docs/screenshots/collect-csv.png)
-->

## Step 2 — Download images and files

1. Use a CSV exported with **Include file download URLs** checked. A CSV without `files_json` cannot start an asset download.
2. Switch to the popup's **Download assets** tab and click **Open downloader workspace**.
3. Choose that CSV and a destination folder using **Choose folder**. Keep a signed-in MyMiniFactory tab open.
4. Click **Start new download**. One worker downloads images and another downloads files concurrently. Each has a separate progress bar, transferred-byte summary, current speed, and approximate time remaining; completed-file checkpoints are written one at a time.

The downloader workspace follows your browser/OS **light or dark appearance** automatically, including its controls and progress panels. Changing your system theme while it is open does not interrupt downloads.

New jobs save assets under:

```text
<chosen folder>/
  3d-creator-toolkit-progress.json
  listings/
    <listing title>/
      images/
      files/
```

Listing titles and image names are made filesystem-safe. If two titles or image names collide, the extension adds a distinguishing suffix. The progress file records which assets finished so the job can resume; it does **not** store the signed download links.

The speed and remaining-time estimates are **approximate**. Some files may have unknown sizes, and image sizes are learned while downloading, so an ETA may be unavailable at first. Older CSVs without file sizes still work but may not show a file ETA.

**Screenshot reference — Download assets popup tab:** `docs/screenshots/download-assets-tab.png` (add your screenshot later).

<!-- After adding the image, remove this comment wrapper to display it:
![Download assets tab with separate image and file progress](docs/screenshots/download-assets-tab.png)
-->

**Screenshot reference — Downloader workspace:** `docs/screenshots/downloader-workspace.png` (add your screenshot later).

<!-- After adding the image, remove this comment wrapper to display it:
![Downloader workspace with CSV, folder picker, and both progress bars](docs/screenshots/downloader-workspace.png)
-->

### Pause and resume

- **Pause** stops the current transfers. Closing the workspace or the browser also interrupts the job; it does not keep downloading in the background. Reopen **Download assets → Open downloader workspace** and click **Resume saved download**. The workspace checks completed files before skipping them and may request folder permission again.
- Temporary network or server transfer failures are retried automatically (up to four attempts with short delays). After a MyMiniFactory **429 rate limit**, the downloader waits **five seconds** before trying again. Both workers share that pause; repeated 429s keep retrying every five seconds until MyMiniFactory allows the request or you click **Pause**. If the job eventually pauses for another reason, the downloader keeps the **original failing asset and reason** in its saved job and shows it when you reopen the workspace. If the notice says a file link expired or was denied, collect a fresh CSV with file links before starting again.
- Choosing a **different destination folder** clears the visible progress in the downloader and popup to 0 / 0 for a new job. Select a CSV and click **Start new download**. The old job remains saved under the creator account; reopening the workspace restores it until replaced by the new job. Choosing the **same saved folder** retains its progress.
- Jobs and popup progress are scoped to the signed-in creator. Signing out or changing creators pauses the job and hides the previous creator's CSV, folder, and progress. Sign back in as that creator to resume.
- File download URLs may expire. If a pending link no longer works, collect a fresh CSV **while signed in as the same creator**, choose the same folder, and start again. Matching asset paths let the downloader reuse finished files.
- If you are upgrading from an older version, a resumed job keeps its existing folder and image names. For the current title-based folders and CDN image filenames, start a **new job in an empty folder**. The extension does not rename files you previously downloaded.

## Screenshot setup

When you have screenshots, save them in the prepared `docs/screenshots/` directory with these names:

| UI | Image path |
| --- | --- |
| Collect CSV popup tab | `docs/screenshots/collect-csv.png` |
| Download assets popup tab | `docs/screenshots/download-assets-tab.png` |
| Downloader workspace | `docs/screenshots/downloader-workspace.png` |

Each section above contains the matching Markdown image reference in an HTML comment. Remove those comment wrappers after adding the PNGs to show the images without broken links in the meantime. Before sharing screenshots, hide usernames, browser account details, private folder paths, and any file URLs with signed query strings as appropriate.

Maintaining or packaging the extension? See the separate [maintainer guide](docs/development.md). You do not need it to install or use the ZIP.
