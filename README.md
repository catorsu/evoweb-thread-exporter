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

The exporter reads the thread's discovered pages and records each post's author, date, permalink, text, quotes, and links. Native image, archive, document, and other non-media attachments are saved when available and permitted by the basic security checks.

- External links remain text references; their targets are not downloaded.
- Quoted attachments remain references by default.
- Embedded players, including YouTube, remain references. Video and audio files are excluded by default.
- Recognized video/audio files are skipped before a request. Unknown types are cancelled when response headers identify them as video or audio.
- HTTP 404 and 410 attachments are recorded as unavailable. They are not reported as saved files.
- Attachments rejected by security checks are marked `security-blocked`, with a reason and diagnostics. They do not count as network failures or unavailable resources.

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

| Status                                  | Meaning                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `finished`                              | The run completed without detected errors, blocked files, or unavailable attachments.                      |
| `finished-with-blocked-attachments`     | The run completed, but security checks blocked some attachments; the report also counts unavailable files. |
| `finished-with-unavailable-attachments` | The run completed, but some attachments returned HTTP 404 or 410.                                          |
| `finished-with-errors-or-gaps`          | A page, attachment, or extraction check failed. Inspect the report diagnostics.                            |
| `stopped-partial`                       | The run stopped before completion.                                                                         |

Intentional media and quoted-reference exclusions do not count as errors. A `finished` status describes the export checks; it does not guarantee that every item ever posted still exists on the source site.

## Attachment security checks

The worker and exporter share the `basic-attachment-v1` policy. It checks original and final URL filenames, forum filename hints, response filenames (including `filename*`), MIME types, and recognizable file signatures. It blocks common executable/installable formats, scripts, shortcuts, HTML/SVG active content, macro-enabled Office types, and OLE compound files whose contents cannot be inspected. Obfuscated filenames with control or bidirectional characters are also blocked. A harmless [EICAR test signature](https://www.eicar.org/download-anti-malware-testfile/) is detected anywhere in the body, including across network chunks.

Each attachment is buffered in memory and checked in full before the exporter creates a local file or writable stream. The limit is **64 MiB (67,108,864 bytes) per attachment**. A declared or actual size over this limit is blocked with `size-limit`; this means the file cannot be inspected within the memory budget, not that malware was confirmed. Blocked transfers are cancelled and buffered data is discarded. Failed or cancelled writes are aborted and partial files removed; cleanup failures are recorded.

`manifest.json` and `thread.txt` retain the attachment source, `security-blocked` status, and `securityDiagnostic` with the policy, reason code, inspection stage, and relevant details. The panel and report summary count blocked files separately. Other attachments continue exporting; actual failures or a stopped run take precedence in the overall run status.

These are conservative checks, **not an antivirus engine or a guarantee that saved files are safe**. Archives are not unpacked; encrypted/compressed content, document macros or exploits inside otherwise permitted containers, and unknown malware may go undetected. Prefix checks inspect the first 4 KiB; only the EICAR signature and size check cover the whole stream. No file is uploaded to a scanning service. Use a maintained antivirus scanner before opening downloaded attachments, particularly archives and documents.

## Permissions

The extension requests `scripting` access to show the exporter and host access to Evo-Web and HTTPS Cloudflare R2 storage. Attachment downloads run in the extension's background worker because R2 may omit the CORS headers required by page scripts.

Chrome supplies domain-scoped login cookies. The extension does not request the cookies API, ask for passwords, upload exports, or use a third-party proxy. The worker accepts native Evo-Web attachment URLs as starting requests; host permissions, response validation, and the content security policy restrict storage access.

See Chrome's [cross-origin network request documentation](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) for the permission model.

## Troubleshooting

- **The panel does not open:** use a normal Evo-Web thread page, check extension site access, and refresh the tab after reloading the extension.
- **HTTP 401/403 or an HTML response:** sign in and check whether the attachment opens normally on Evo-Web. Complete any site challenge in the browser.
- **HTTP 404/410:** the attachment is unavailable at the requested endpoint. Repeated exports cannot restore a deleted server object.
- **Security-blocked:** inspect `securityDiagnostic` in the reports. HTML may be a login/error page; sign in or complete the site challenge before retrying. Files above 64 MiB and high-risk formats are intentionally excluded; renaming a file does not make it safe.
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
