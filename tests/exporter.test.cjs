// Export behavior tests with simulated network responses and file handles.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const scriptPath = path.join(__dirname, "..", "evoweb-exporter-extension", "exporter.js");
const source = fs.readFileSync(scriptPath, "utf8");
const safetySource = fs.readFileSync(path.join(path.dirname(scriptPath), "safety.js"), "utf8");
const origin = "https://evoweb.uk";
const thread = `${origin}/threads/example.103466/`;
const attachment = `${origin}/attachments/example-png.426709/`;
const storage = `https://${"e1c48f9".padEnd(32, "0")}.r2.cloudflarestorage.com/evoweb-attachments/example.png?X-Amz-Signature=fixture`;
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

function response(options = {}) {
  const {
    url = attachment,
    type = "basic",
    redirected = false,
    status = 200,
    body = bytes,
    headers = { "content-type": "image/png" },
  } = options;
  const r = new Response(body, { status, headers });
  Object.defineProperties(r, {
    url: { value: url },
    type: { value: type },
    redirected: { value: redirected },
  });
  return r;
}

function harness(fetchImpl, diskFailure = false, extensionFetch = null, diskHooks = {}) {
  const calls = [],
    files = new Map(),
    staged = new Map(),
    fileOps = [];
  function directory(parts = []) {
    return {
      async getDirectoryHandle(name) {
        fileOps.push({ operation: "directory", name });
        return directory([...parts, name]);
      },
      async removeEntry(name) {
        fileOps.push({ operation: "remove", name });
        diskHooks.remove?.();
        files.delete([...parts, name].join("/"));
      },
      async getFileHandle(name) {
        const path = [...parts, name].join("/");
        fileOps.push({ operation: "create", path });
        files.set(path, Buffer.alloc(0));
        return {
          async createWritable() {
            fileOps.push({ operation: "writable", path });
            const chunks = [];
            staged.set(path, chunks);
            return {
              async write(chunk) {
                fileOps.push({ operation: "write", path });
                chunks.push(Buffer.from(chunk));
                diskHooks.write?.();
              },
              async close() {
                fileOps.push({ operation: "close", path });
                if (diskFailure) throw new Error("Disk commit failed");
                files.set(path, Buffer.concat(chunks));
                staged.delete(path);
              },
              async abort() {
                fileOps.push({ operation: "abort", path });
                staged.delete(path);
              },
            };
          },
        };
      },
    };
  }
  const win = { isSecureContext: true, showDirectoryPicker() {} };
  win.self = win.top = win;
  const sandbox = {
    window: win,
    location: { href: thread, origin },
    document: {},
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
    console: { warn() {}, error() {}, log() {} },
    fetch: async (url, options) => {
      calls.push({ url, options, transport: "page" });
      return fetchImpl(url, options);
    },
    chrome: { runtime: { id: "test-extension", getManifest: () => ({ version: "test" }) } },
    evoAttachmentFetch:
      extensionFetch ||
      (async (url, options) => {
        calls.push({ url, options, transport: "extension" });
        return fetchImpl(url, options);
      }),
  };
  // Run production functions, stopping before UI creation. Only pacing changes.
  const prefix = source
    .slice(0, source.indexOf('  document.getElementById("evoweb-export-panel")'))
    .replace("REQUEST_GAP_MS: 1200", "REQUEST_GAP_MS: 0");
  vm.createContext(sandbox);
  vm.runInContext(safetySource, sandbox);
  vm.runInContext(
    prefix +
      `
    window.test = { request, saveAttachment, nativeAttachment, attachmentStorageURL, summarizeReport,
      reportText, checkpoint, completionStatus, safety,
      setRoot(handle) { rootHandle = handle; rootName = 'test-export'; } };
  })();`,
    sandbox,
  );
  win.test.setRoot(directory());
  return { ...win.test, state: win.evoThreadExporter, calls, files, staged, fileOps };
}
const item = () => ({
  id: "426709",
  url: attachment,
  segment: "example-png.426709",
  nameHint: "",
  contexts: ["body"],
  status: "pending",
  path: null,
});
async function save(h) {
  const a = item();
  await h.saveAttachment(a, { key: "123" });
  return a;
}
const eicarBytes = () =>
  Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
function chunkedBody(chunks, onCancel = () => {}) {
  let index = 0;
  return new ReadableStream(
    {
      pull(controller) {
        if (index === chunks.length) controller.close();
        else controller.enqueue(chunks[index++]);
      },
      cancel: onCancel,
    },
    { highWaterMark: 0 },
  );
}
function assertBlocked(h, a, code) {
  assert.equal(a.status, "security-blocked", a.error);
  assert.equal(a.path, null);
  assert.equal(a.bytes, undefined);
  assert.equal(a.securityDiagnostic.code, code);
  assert.equal(a.securityDiagnostic.policy, "basic-attachment-v1");
  assert.ok(a.securityDiagnostic.reason);
  assert.equal(a.requestDiagnostic.stage, "security-check");
  assert.equal(h.files.size, 0);
  assert.equal(h.staged.size, 0);
  assert.equal(h.fileOps.length, 0, "Rejected bytes must never reach a filesystem operation");
  assert.equal(h.state.haltReason, null);
}

(async () => {
  await test("Readable R2 redirect saves exact bytes with original attachment identity", async () => {
    const h = harness(() => response({ url: storage, type: "cors", redirected: true }));
    const a = await save(h);
    assert.equal(a.status, "saved", a.error);
    assert.equal(a.filename, "426709__example.png");
    assert.equal(a.bytes, bytes.length);
    assert.equal(a.finalUrl, storage);
    assert.deepEqual([...h.files.values()][0], Buffer.from(bytes));
    assert.equal(h.calls[0].transport, "extension");
    assert.ok(h.calls[0].options.signal);
  });
  await test("Standalone execution stops before UI creation or network requests", async () => {
    const errors = [];
    vm.runInNewContext(source, { console: { error: (message) => errors.push(message) } });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Extensions menu/);
  });
  await test("A missing security module prevents exporter startup", () => {
    const errors = [];
    vm.runInNewContext(source, {
      chrome: { runtime: { id: "test-extension", getManifest: () => ({ version: "test" }) } },
      evoAttachmentFetch() {
        throw new Error("must not fetch");
      },
      console: { error: (message) => errors.push(message) },
    });
    assert.match(errors[0], /security checks are unavailable/);
  });
  await test("Extension R2 basic response uses privileged transport and saves exact bytes", async () => {
    const h = harness(
      () => {
        throw new Error("Page fetch must not run");
      },
      false,
      () => response({ url: storage, type: "basic", redirected: true }),
    );
    const a = await save(h);
    assert.equal(a.status, "saved", a.error);
    assert.equal(h.state.transport, "extension");
    assert.deepEqual([...h.files.values()][0], Buffer.from(bytes));
    assert.equal(h.calls.length, 0);
  });
  for (const url of [attachment, `${origin}/data/attachments/example.png`]) {
    await test(`Same-origin file still saves: ${new URL(url).pathname}`, async () => {
      const h = harness(() => response({ url, redirected: url !== attachment }));
      assert.equal((await save(h)).status, "saved");
    });
  }
  await test("Thread pages retain same-origin mode and reject redirects", async () => {
    const h = harness(() => response({ url: thread }));
    await h.request(thread, "page", (r) => r.body.cancel());
    assert.equal(h.calls[0].options.mode, "same-origin");
    assert.equal(h.calls[0].options.redirect, "error");
  });
  for (const url of [storage, "https://example.com/archive.zip", `${origin}/proxy.php?link=x`]) {
    await test(`Non-native request is rejected before fetch: ${new URL(url).host}${new URL(url).pathname}`, async () => {
      const h = harness(() => {
        throw new Error("must not fetch");
      });
      await assert.rejects(
        h.request(url, "attachment", () => {}),
        /native-only/,
      );
      assert.equal(h.calls.length, 0);
    });
  }
  for (const [name, opts] of [
    ["opaque", { type: "opaque" }],
    ["opaqueredirect", { type: "opaqueredirect" }],
    ["error response", { type: "error" }],
    ["missing final URL", { url: "", redirected: true }],
    [
      "unrelated external host",
      { url: "https://example.com/file.png", type: "cors", redirected: true },
    ],
    [
      "R2 lookalike host",
      { url: storage.replace(".com/", ".com.evil.test/"), type: "cors", redirected: true },
    ],
    ["HTTP R2", { url: storage.replace("https:", "http:"), type: "cors", redirected: true }],
    [
      "nonstandard R2 port",
      { url: storage.replace(".com/", ".com:8443/"), type: "cors", redirected: true },
    ],
    ["R2 without redirect provenance", { url: storage, type: "cors" }],
    ["different attachment ID", { url: `${origin}/attachments/other.123/`, redirected: true }],
    ["thumbnail redirect", { url: `${attachment}?thumbnail=1`, redirected: true }],
    ["HTTP 403", { status: 403 }],
  ]) {
    await test(`Reject ${name} without saving a file`, async () => {
      const h = harness(() => response(opts));
      const a = await save(h);
      assert.equal(a.status, "failed");
      assert.equal(a.path, null);
      assert.equal(h.files.size, 0);
      assert.ok(a.requestDiagnostic);
    });
  }
  await test("Network failure has an actionable diagnostic and no fallback request", async () => {
    const h = harness(() => {
      throw new TypeError("Failed to fetch");
    });
    const a = await save(h);
    assert.equal(a.status, "failed");
    assert.match(a.error, /Check extension site access/);
    assert.equal(a.requestDiagnostic.stage, "fetch");
    assert.equal(h.calls.length, 1);
    assert.equal(h.files.size, 0);
    assert.equal(h.staged.size, 0);
    assert.equal(h.fileOps.length, 0);
  });
  await test("Disk failure never claims saved file", async () => {
    const h = harness(() => response({ url: storage, type: "cors", redirected: true }), true);
    const a = await save(h);
    assert.equal(a.status, "failed");
    assert.equal(a.path, null);
    assert.match(a.error, /Disk commit failed/);
    assert.equal(h.files.size, 0);
    assert.equal(h.staged.size, 0);
    assert.ok(h.fileOps.some((op) => op.operation === "abort"));
    assert.ok(h.fileOps.some((op) => op.operation === "remove"));
  });
  for (const disposition of [
    'attachment; filename="photo.jpg.EXE"',
    'attachment; filename="setup.exe.png"',
    'attachment; filename="run.PS1. "',
    'attachment; filename="shortcut.lnk"',
    'attachment; filename="script.mjs"',
    'attachment; filename="script.cjs"',
    'attachment; filename="launch.desktop"',
    'attachment; filename="macro.docm"',
    'attachment; filename="image.svg"',
    "attachment; filename*=UTF-8''photo%2Eexe",
    "attachment; filename=\"setup.exe\"; filename*=UTF-8''safe.png",
    'attachment; filename="safe.png"; filename="setup.cmd"',
  ]) {
    await test(`Block risky disposition before reading the body: ${disposition}`, async () => {
      let cancelled = false;
      const body = new ReadableStream(
        {
          pull() {
            throw new Error("Unsafe metadata must prevent body reads");
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const h = harness(() => response({ body, headers: { "content-disposition": disposition } }));
      assertBlocked(h, await save(h), "dangerous-extension");
      assert.equal(cancelled, true);
    });
  }
  for (const contentType of [
    "Application/X-Msdownload; charset=binary",
    "application/vnd.microsoft.portable-executable",
    "text/javascript",
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
  ]) {
    await test(`Block risky MIME type: ${contentType}`, async () => {
      const h = harness(() => response({ headers: { "content-type": contentType } }));
      assertBlocked(h, await save(h), "dangerous-content-type");
    });
  }
  for (const [label, changes, opts, code] of [
    ["forum label despite safe response", { nameHint: "setup.exe" }, {}, "dangerous-extension"],
    ["untruncated filename", { nameHint: "a".repeat(260) + ".exe" }, {}, "dangerous-extension"],
    ["bidi filename", { nameHint: "image\u202egnp.exe" }, {}, "obfuscated-filename"],
    [
      "friendly route",
      { url: `${origin}/attachments/setup-exe.426709/` },
      {},
      "dangerous-extension",
    ],
    [
      "query route",
      { url: `${origin}/index.php?attachments/setup-exe.426709/` },
      {},
      "dangerous-extension",
    ],
    [
      "storage filename",
      {},
      { url: storage.replace("example.png", "setup.cmd"), type: "cors", redirected: true },
      "dangerous-extension",
    ],
  ]) {
    await test(`Block ${label}`, async () => {
      const h = harness(() => response(opts));
      const a = { ...item(), ...changes };
      await h.saveAttachment(a, { key: "123" });
      assertBlocked(h, a, code);
    });
  }
  for (const [label, body] of [
    ["Windows executable", Buffer.from([0x4d, 0x5a, 0, 0])],
    ["ELF", Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
    ["Mach-O", Buffer.from([0xcf, 0xfa, 0xed, 0xfe])],
    ["Java class", Buffer.from([0xca, 0xfe, 0xba, 0xbe])],
    ["WebAssembly", Buffer.from([0, 0x61, 0x73, 0x6d])],
    ["Windows shortcut", Buffer.from([0x4c, 0, 0, 0, 1, 0x14, 2, 0])],
    ["OLE container", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
    ["shell script", Buffer.from("#!/bin/sh\necho fixture")],
    ["batch script", Buffer.from("@echo off\necho fixture")],
    ["HTML login page with false MIME", Buffer.from("<!doctype html><html>Login</html>")],
    ["SVG with XML prefix", Buffer.from('<?xml version="1.0"?><!--fixture--><svg/>')],
    ["UTF-16 HTML", Buffer.from("\uFEFF<html>fixture</html>", "utf16le")],
  ]) {
    await test(`Block ${label} with innocent filename/MIME and split magic bytes`, async () => {
      let cancelled = false;
      const chunks = Array.from(body, (byte) => Uint8Array.of(byte));
      const h = harness(() =>
        response({
          body: chunkedBody(chunks, () => {
            cancelled = true;
          }),
        }),
      );
      assertBlocked(h, await save(h), "dangerous-signature");
      assert.equal(cancelled, true);
    });
  }
  await test("A late EICAR signature across chunks aborts immediately without staging bytes", async () => {
    const prefix = Buffer.alloc(70000, 0x20);
    const signature = eicarBytes();
    let cancelled = false;
    let pulls = 0;
    const chunks = [prefix, signature.subarray(0, 31), signature.subarray(31)];
    const body = new ReadableStream(
      {
        pull(controller) {
          assert.ok(pulls < chunks.length, "Must stop before requesting any more data");
          controller.enqueue(chunks[pulls++]);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const h = harness(() => response({ body }));
    const a = await save(h);
    assertBlocked(h, a, "eicar-test-signature");
    assert.equal(a.securityDiagnostic.offset, prefix.length);
    assert.equal(cancelled, true);
    assert.equal(pulls, chunks.length);
  });
  await test("EICAR detection handles every possible split and one-byte chunks", () => {
    const h = harness(() => {});
    const signature = eicarBytes();
    for (let split = 1; split < signature.length; split++) {
      const scanner = h.safety.createScanner();
      scanner.push(signature.subarray(0, split));
      assert.throws(() => scanner.push(signature.subarray(split)), {
        name: "AttachmentSecurityError",
      });
    }
    const scanner = h.safety.createScanner();
    for (const byte of signature.subarray(0, -1)) scanner.push(Uint8Array.of(byte));
    assert.throws(() => scanner.push(signature.subarray(-1)), { name: "AttachmentSecurityError" });
  });
  await test("Declared oversized attachments are rejected before filesystem access", async () => {
    const h = harness(() =>
      response({ headers: { "content-length": String(64 * 1024 * 1024 + 1) } }),
    );
    assertBlocked(h, await save(h), "size-limit");
  });
  for (const length of [undefined, "1"]) {
    await test(`Actual size limit works with ${length ? "misleading" : "absent"} Content-Length`, async () => {
      const chunk = new Uint8Array(1024 * 1024);
      let cancelled = false;
      const body = chunkedBody([...Array(64).fill(chunk), Uint8Array.of(0)], () => {
        cancelled = true;
      });
      const h = harness(() =>
        response({ body, headers: length ? { "content-length": length } : {} }),
      );
      const a = await save(h);
      assertBlocked(h, a, "size-limit");
      assert.equal(a.securityDiagnostic.bytesInspected, 64 * 1024 * 1024 + 1);
      assert.equal(cancelled, true);
    });
  }
  for (const [filename, contentType, data] of [
    ["image.png", "image/png", bytes],
    ["archive.zip", "application/zip", Buffer.from([0x50, 0x4b, 3, 4, 0, 1, 2])],
    ["readme.txt", "text/plain", Buffer.from("Safe fixture text")],
    ["document.pdf", "application/pdf", Buffer.from("%PDF-1.7\nfixture")],
    ["unknown.bin", "application/octet-stream", Buffer.from([0, 1, 2, 3, 4])],
  ]) {
    await test(`Allowed ${filename} is written byte-exact only after EOF`, async () => {
      let h;
      let offset = 0;
      const body = new ReadableStream(
        {
          pull(controller) {
            assert.equal(h.fileOps.length, 0, "No file creation before full inspection");
            if (offset === data.length) controller.close();
            else controller.enqueue(data.subarray(offset, ++offset));
          },
        },
        { highWaterMark: 0 },
      );
      h = harness(() =>
        response({
          body,
          headers: {
            "content-type": contentType,
            "content-disposition": `attachment; filename="${filename}"`,
          },
        }),
      );
      const a = await save(h);
      assert.equal(a.status, "saved", a.error);
      assert.equal(a.securityCheck.result, "passed-basic-checks");
      assert.equal(a.securityCheck.bytesInspected, data.length);
      assert.deepEqual([...h.files.values()][0], Buffer.from(data));
      assert.equal(h.staged.size, 0);
    });
  }
  await test("Safe content spanning memory buffers retains every byte", async () => {
    const data = Buffer.alloc(180123, 0x61);
    const h = harness(() =>
      response({ body: chunkedBody([data.subarray(0, 70000), data.subarray(70000)]) }),
    );
    assert.equal((await save(h)).status, "saved");
    assert.deepEqual([...h.files.values()][0], data);
  });
  await test("Read failure discards buffered content before any local file exists", async () => {
    let pulls = 0;
    const body = new ReadableStream(
      {
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(new Uint8Array(70000));
          else controller.error(new Error("Connection lost after prefix"));
        },
      },
      { highWaterMark: 0 },
    );
    const h = harness(() => response({ body }));
    const a = await save(h);
    assert.equal(a.status, "failed");
    assert.match(a.error, /Connection lost/);
    assert.equal(h.fileOps.length, 0);
  });
  await test("Stop after the final write aborts staging and removes the empty file", async () => {
    let h;
    h = harness(() => response(), false, null, {
      write() {
        h.state.stop();
      },
    });
    h.state.running = true;
    const a = await save(h);
    assert.equal(a.status, "cancelled");
    assert.equal(a.path, null);
    assert.equal(h.staged.size, 0);
    assert.equal(h.files.size, 0);
    assert.ok(h.fileOps.some((op) => op.operation === "abort"));
    assert.ok(h.fileOps.some((op) => op.operation === "remove"));
    assert.ok(!h.fileOps.some((op) => op.operation === "close"));
  });
  await test("A blocked file does not stop subsequent allowed attachments", async () => {
    let requests = 0;
    const h = harness(() => response(requests++ === 0 ? { body: eicarBytes() } : {}));
    assert.equal((await save(h)).status, "security-blocked");
    assert.equal((await save(h)).status, "saved");
    assert.equal(h.files.size, 1);
  });
  await test("Background metadata rejection retains its security and response diagnostics", async () => {
    const securityDiagnostic = {
      policy: "basic-attachment-v1",
      code: "dangerous-content-type",
      stage: "metadata",
      reason: "Executable MIME type",
      contentType: "application/x-msdownload",
    };
    const h = harness(() => {
      const error = new Error(securityDiagnostic.reason);
      error.name = "AttachmentSecurityError";
      error.securityDiagnostic = securityDiagnostic;
      error.responseInfo = {
        finalUrl: storage,
        redirected: true,
        httpStatus: 200,
        contentType: "application/x-msdownload",
      };
      throw error;
    });
    const a = await save(h);
    assertBlocked(h, a, "dangerous-content-type");
    assert.deepEqual(a.securityDiagnostic, securityDiagnostic);
    assert.equal(a.finalUrl, storage);
    assert.equal(a.redirected, true);
    assert.equal(a.httpStatus, 200);
    assert.equal(a.contentType, "application/x-msdownload");
  });
  await test("Rate limit halts export and preserves Retry-After", async () => {
    const h = harness(() => response({ status: 429, headers: { "retry-after": "60" } }));
    await save(h);
    assert.match(h.state.haltReason, /Retry-After: 60/);
  });
  for (const status of [404, 410]) {
    await test(`HTTP ${status} is unavailable, not an export failure`, async () => {
      const h = harness(() => response({ status }));
      const a = await save(h);
      assert.equal(a.status, "unavailable");
      assert.equal(a.httpStatus, status);
      assert.equal(a.path, null);
      assert.equal(h.files.size, 0);
    });
  }
  await test("404 browser challenge remains a failure and halts export", async () => {
    const h = harness(() => response({ status: 404, headers: { "cf-mitigated": "challenge" } }));
    const a = await save(h);
    assert.equal(a.status, "failed");
    assert.match(h.state.haltReason, /challenge/);
  });
  for (const hint of [
    { nameHint: "movie.mp4" },
    { segment: "recording-flac.426709" },
    { embeddedAudioVideo: true },
  ]) {
    await test(`Known audio/video is skipped without any request: ${JSON.stringify(hint)}`, async () => {
      const h = harness(() => {
        throw new Error("must not fetch");
      });
      const a = { ...item(), ...hint };
      await h.saveAttachment(a, { key: "123" });
      assert.equal(a.status, "media-reference-only");
      assert.equal(h.calls.length, 0);
      assert.equal(h.files.size, 0);
    });
  }
  for (const headers of [
    { "content-type": "audio/ogg" },
    { "content-type": "video/webm" },
    {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="movie.mov"',
    },
  ]) {
    await test(`Media recognized at headers is cancelled before body read: ${JSON.stringify(headers)}`, async () => {
      let cancelled = false;
      const body = new ReadableStream(
        {
          pull() {
            throw new Error("Media body must not be read");
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const h = harness(() => response({ headers, body }));
      const a = await save(h);
      assert.equal(a.status, "media-reference-only", a.error);
      assert.equal(cancelled, true);
      assert.equal(h.files.size, 0);
    });
  }
  function reportFor(statuses) {
    return {
      posts: [
        {
          attachments: statuses.map((status) => ({ status })),
          embeddedMedia: [],
          quotes: [],
          otherInternalLinks: [],
          warnings: [],
          externalLinks: [],
        },
      ],
      errors: [],
      pagesOK: [1],
      maxPage: 1,
      haltReason: null,
    };
  }
  await test("Only unavailable files produce a separate completion status", async () => {
    const h = harness(() => {}),
      r = reportFor(["saved", "unavailable", "media-reference-only", "quoted-reference-only"]);
    h.summarizeReport(r);
    assert.equal(r.status, "finished-with-unavailable-attachments");
    assert.equal(r.summary.attachmentIssues, 0);
    assert.equal(r.summary.unavailableAttachments, 1);
    assert.equal(r.summary.skippedMediaAttachments, 1);
  });
  await test("Intentional media/quote exclusions alone finish normally", async () => {
    const h = harness(() => {}),
      r = reportFor(["saved", "media-reference-only", "quoted-reference-only"]);
    h.summarizeReport(r);
    assert.equal(r.status, "finished");
  });
  await test("Security interception is distinct in manifest.json, thread.txt and the UI summary", async () => {
    const h = harness(() => response({ body: eicarBytes() }));
    const a = await save(h);
    const r = reportFor(["saved", "unavailable"]);
    r.posts[0].attachments = [{ ...item(), status: "unavailable" }, a];
    h.summarizeReport(r);
    assert.equal(r.status, "finished-with-blocked-attachments");
    assert.equal(r.summary.blockedAttachments, 1);
    assert.equal(r.summary.unavailableAttachments, 1);
    assert.equal(r.summary.attachmentIssues, 0);
    assert.match(h.completionStatus(r), /1 security-blocked/);
    assert.match(h.completionStatus(r), /1 unavailable, 0 failed/);
    h.state.report = r;
    await h.checkpoint();
    const manifest = JSON.parse(h.files.get("manifest.json").toString());
    const blocked = manifest.posts[0].attachments[1];
    assert.equal(blocked.status, "security-blocked");
    assert.equal(blocked.securityDiagnostic.code, "eicar-test-signature");
    assert.equal(blocked.path, null);
    const text = h.files.get("thread.txt").toString();
    assert.match(text, /Security-blocked attachments: 1/);
    assert.match(text, /\[security-blocked\]/);
    assert.match(text, /Local path: \[not saved\]/);
    assert.match(text, /Security diagnostic: .*eicar-test-signature/);
    assert.match(text, /Failure stage: security-check/);
  });
  await test("Partial-file cleanup failure is retained in both reports", async () => {
    let failWrites = true;
    const h = harness(() => response(), false, null, {
      write() {
        if (failWrites) throw new Error("Disk write failed");
      },
      remove() {
        throw new Error("Permission revoked during cleanup");
      },
    });
    const a = await save(h);
    assert.equal(a.status, "failed");
    assert.equal(a.path, null);
    assert.equal(h.staged.size, 0);
    assert.equal(h.files.size, 1, "Simulate an empty file that could not be removed");
    assert.match(a.cleanupError, /Could not remove partial file 426709__example.png/);
    assert.match(a.cleanupError, /Permission revoked/);
    const r = reportFor([]);
    r.posts[0].attachments = [a];
    h.summarizeReport(r);
    assert.equal(r.status, "finished-with-errors-or-gaps");
    h.state.report = r;
    failWrites = false;
    await h.checkpoint();
    assert.match(h.files.get("thread.txt").toString(), /Cleanup error: .*Permission revoked/);
    assert.match(
      JSON.parse(h.files.get("manifest.json")).posts[0].attachments[0].cleanupError,
      /Permission revoked/,
    );
  });
  for (const kind of ["attachment", "page", "stopped"]) {
    await test(`Unavailable files never hide actual ${kind} problems`, async () => {
      const h = harness(() => {}),
        r = reportFor(["unavailable", "security-blocked"]);
      if (kind === "attachment") r.posts[0].attachments.push({ status: "failed" });
      if (kind === "page") r.pagesOK = [];
      if (kind === "stopped") r.haltReason = "Stopped by user";
      h.summarizeReport(r);
      assert.equal(
        r.status,
        kind === "stopped" ? "stopped-partial" : "finished-with-errors-or-gaps",
      );
    });
  }
  await test("Stop aborts in-flight request and records cancellation", async () => {
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const h = harness(
      (url, options) =>
        new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
          started();
        }),
    );
    h.state.running = true;
    const pending = save(h);
    await ready;
    h.state.stop();
    assert.equal((await pending).status, "cancelled");
    assert.equal(h.files.size, 0);
  });
})();
