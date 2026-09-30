// Export behavior tests with simulated network responses and file handles.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const scriptPath = path.join(__dirname, "..", "evoweb-exporter-extension", "exporter.js");
const source = fs.readFileSync(scriptPath, "utf8");
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

function harness(fetchImpl, diskFailure = false, extensionFetch = null) {
  const calls = [],
    files = new Map();
  function directory(parts = []) {
    return {
      async getDirectoryHandle(name) {
        return directory([...parts, name]);
      },
      async removeEntry(name) {
        files.delete([...parts, name].join("/"));
      },
      async getFileHandle(name) {
        const path = [...parts, name].join("/");
        return {
          async createWritable() {
            const chunks = [];
            return {
              async write(chunk) {
                chunks.push(Buffer.from(chunk));
              },
              async close() {
                if (diskFailure) throw new Error("Disk commit failed");
                files.set(path, Buffer.concat(chunks));
              },
              async abort() {},
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
  vm.runInNewContext(
    prefix +
      `
    window.test = { request, saveAttachment, nativeAttachment, attachmentStorageURL, summarizeReport,
      setRoot(handle) { rootHandle = handle; rootName = 'test-export'; } };
  })();`,
    sandbox,
  );
  win.test.setRoot(directory());
  return { ...win.test, state: win.evoThreadExporter, calls, files };
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
    ["HTML login page", { headers: { "content-type": "text/html" }, body: "<html>Login</html>" }],
    ["HTML with false MIME", { body: "<!doctype html><html>Login</html>" }],
    [
      "CORS HTML at R2",
      { url: storage, type: "cors", redirected: true, body: "<html>Error</html>" },
    ],
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
  });
  await test("Disk failure never claims saved file", async () => {
    const h = harness(() => response({ url: storage, type: "cors", redirected: true }), true);
    const a = await save(h);
    assert.equal(a.status, "failed");
    assert.equal(a.path, null);
    assert.match(a.error, /Disk commit failed/);
    assert.equal(h.files.size, 0);
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
  for (const kind of ["attachment", "page", "stopped"]) {
    await test(`Unavailable files never hide actual ${kind} problems`, async () => {
      const h = harness(() => {}),
        r = reportFor(["unavailable"]);
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
