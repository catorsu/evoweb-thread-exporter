# Evo-Web Thread Exporter

[English](README.md) | [简体中文](README.zh-CN.md)

A Chrome extension that exports an Evo-Web thread to a local folder, including post text, quotes, links, and native forum attachments.

## Install and use

1. Open `chrome://extensions` in the Chrome profile you use for Evo-Web.
2. Enable **Developer mode**, select **Load unpacked**, and choose the `evoweb-exporter-extension` folder in this project.
3. Open a thread at `https://evoweb.uk` and sign in if needed.
4. Open Chrome's Extensions menu and select **Evo-Web Thread Exporter**.
5. Select **Choose folder & export** in the page panel. If prompted, select **Grant write access & export** and approve Chrome's folder permission request.
6. Keep the tab open until the export finishes. Use **Stop & save partial** to stop the current transfer and save the available reports.

After updating the extension files, select **Reload** on `chrome://extensions`, refresh the thread, and open the exporter again. No build step is required. If you move or rename the project directory, load the unpacked extension again from its new location.

## Export scope

The exporter reads the thread's discovered pages and records each post's author, date, permalink, text, quotes, and links. Native image, archive, document, and other non-media attachments are saved when available.

- External links remain text references; their targets are not downloaded.
- Quoted attachments remain references by default.
- Embedded players, including YouTube, remain references. Video and audio files are excluded by default.
- Recognized video/audio files are skipped before a request. Unknown types are cancelled when response headers identify them as video or audio.
- HTTP 404 and 410 attachments are recorded as unavailable. They are not reported as saved files.

## Output

Each run creates a new directory inside the selected folder:

```text
thread-<id>_<title>_<timestamp>_<run-id>/
├── manifest.json
├── thread.txt
└── posts/
    └── post-<id>/
        └── <category>/
            └── <attachment-id>__<filename>
```

`thread.txt` is the readable report. `manifest.json` contains structured posts, file paths, statuses, and diagnostics. Paths in both reports are relative to the selected folder. Reports are updated after each page, and a file is marked saved only after its write commits.

| Status                                  | Meaning                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `finished`                              | The run completed without detected errors or unavailable attachments.           |
| `finished-with-unavailable-attachments` | The run completed, but some attachments returned HTTP 404 or 410.               |
| `finished-with-errors-or-gaps`          | A page, attachment, or extraction check failed. Inspect the report diagnostics. |
| `stopped-partial`                       | The run stopped before completion.                                              |

Intentional media and quoted-reference exclusions do not count as errors. A `finished` status describes the export checks; it does not guarantee that every item ever posted still exists on the source site.

## Permissions

The extension requests `scripting` access to show the exporter and host access to Evo-Web and HTTPS Cloudflare R2 storage. Attachment downloads run in the extension's background worker because R2 may omit the CORS headers required by page scripts.

Chrome supplies domain-scoped login cookies. The extension does not request the cookies API, ask for passwords, upload exports, or use a third-party proxy. The worker accepts native Evo-Web attachment URLs as starting requests; host permissions, response validation, and the content security policy restrict storage access.

See Chrome's [cross-origin network request documentation](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) for the permission model.

## Troubleshooting

- **The panel does not open:** use a normal Evo-Web thread page, check extension site access, and refresh the tab after reloading the extension.
- **HTTP 401/403 or an HTML response:** sign in and check whether the attachment opens normally on Evo-Web. Complete any site challenge in the browser.
- **HTTP 404/410:** the attachment is unavailable at the requested endpoint. Repeated exports cannot restore a deleted server object.
- **Folder access fails:** choose a writable folder and grant permission from the on-page button. Cancelled or denied permissions can be retried.
- **A run stops or reports gaps:** inspect `manifest.json` and `thread.txt` before starting another run. Each run uses a separate directory.

## Development

The project name is **Evo-Web Thread Exporter**. Use `evoweb-thread-exporter` for the project directory and npm package name. The extension source lives in `evoweb-exporter-extension/`; the folder can be loaded directly into Chrome.

With Node.js 22 or later:

```sh
npm ci
npm run check
npm test
npm run format:check
```

See [Development guide](docs/development.md) for the source layout, test scope, and maintenance conventions. Export directories, local audit reports, and generated test output are excluded from Git.
