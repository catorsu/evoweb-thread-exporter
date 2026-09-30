# Development guide

## Source layout

```text
evoweb-exporter-extension/
  manifest.json       Extension metadata, permissions, and content security policy
  background.js       Toolbar action and download connection setup
  download.mjs        Request validation and streamed attachment downloads
  transport.js        Isolated content-script transport and cancellation
  exporter.js         Extraction, folder access, file writing, and reports
scripts/
  check-syntax.cjs    JavaScript syntax and version checks
tests/
  exporter.test.cjs   Export behavior and file/report failure cases
  transport.test.cjs  Worker validation, messaging, and stream behavior
```

The extension directory is the single source of runtime code. Edit it directly, reload the extension in Chrome, and refresh the thread before testing a change. There is no generated copy or console-script entry point.

## Local checks

Use Node.js 22 or later. `npm ci` installs the development formatter; the extension has no runtime package dependencies.

```sh
npm run check
npm test
npm run format:check
```

The tests use Node's built-in test runner, Web Streams, and a VM context. They simulate HTTP responses, Chrome message ports, and file handles to check request restrictions, file integrity, cancellation, media exclusions, unavailable attachments, and report statuses. They read the extension source directly and do not generate report files in the project root.

These tests do not exercise a live Evo-Web account, native Chrome permission dialogs, or network CORS enforcement. For browser validation, use a separate test profile and local fixtures. Verify successful downloads, cancellation, unavailable files, and media exclusions before checking a real thread. Keep generated output under `test-results/`.

## Code and documentation conventions

- Use UTF-8, LF line endings, two-space indentation, and a final newline. Run `npm run format` to apply the shared Prettier configuration.
- Use descriptive English names. Use `camelCase` for variables and functions, `UPPER_SNAKE_CASE` for constants, and lowercase hyphenated names for project and documentation files.
- Write comments in plain English. Explain constraints or non-obvious decisions rather than narrating the code or recording debugging history.
- Document current behavior and installation steps. Keep machine-specific paths, account details, signed storage URLs, screenshots, and historical test logs out of project documentation.
- Keep the versions in `package.json` and `manifest.json` aligned. The exporter reads its displayed version from the extension manifest.

## Data and generated files

Export folders named `thread-*` are ignored at the repository root. Store local audit reports under `reports/` and test artifacts under `test-results/`; both directories are ignored. Preserve user exports during maintenance.

## Download boundaries

Thread pages use same-origin requests with redirects disabled. Attachments use the background worker, which accepts only native Evo-Web attachment routes from the extension's top-level thread content script. Readable responses must resolve to Evo-Web or an allowed HTTPS R2 storage endpoint.

The transport sends bounded chunks on demand and cancels the worker request when the reader or tab disconnects. Do not introduce a page-accessible message bridge, arbitrary URL fetching, or an opaque-response fallback.

Treat unavailable source files separately from request and write failures. Keep diagnostics and source references even when media is intentionally excluded or a server file is unavailable.
