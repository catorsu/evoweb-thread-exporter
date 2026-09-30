// Worker and content-script transport tests with JSON-serialized Chrome port fixtures.
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const ROOT = path.join(__dirname, "..", "evoweb-exporter-extension");
const ORIGIN = "https://evoweb.uk";
const NATIVE = `${ORIGIN}/attachments/example.426709/`;
const STORAGE = `https://${"a".repeat(32)}.r2.cloudflarestorage.com/bucket/file.png?signature=fixture`;
const DATA = Buffer.alloc(250321);
for (let i = 0; i < DATA.length; i++) DATA[i] = i % 251;
function event() {
  const listeners = new Set();
  return {
    addListener: (f) => listeners.add(f),
    removeListener: (f) => listeners.delete(f),
    dispatch: (message) => {
      for (const f of [...listeners]) f(message);
    },
  };
}
function response(options = {}) {
  const {
    body = DATA,
    url = STORAGE,
    type = "basic",
    redirected = true,
    status = 200,
    headers = {
      "content-type": "image/png",
      "content-disposition": 'attachment; filename="test.png"',
      "set-cookie": "not exposed",
    },
  } = options;
  const r = new Response(body, { status, headers });
  Object.defineProperties(r, {
    url: { value: url },
    type: { value: type },
    redirected: { value: redirected },
  });
  return r;
}
(async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, "download.mjs")));
  const transport = fs.readFileSync(path.join(ROOT, "transport.js"), "utf8");
  function harness(fetchImpl = () => response(), senderChanges = {}) {
    const messages = [],
      calls = [];
    let disconnected = false;
    const client = { onMessage: event(), onDisconnect: event() };
    const server = {
      name: mod.PORT_NAME,
      onMessage: event(),
      onDisconnect: event(),
      sender: {
        id: "test-extension",
        tab: { id: 5 },
        frameId: 0,
        url: ORIGIN + "/threads/example.103466/",
        ...senderChanges,
      },
    };
    for (const [from, to] of [
      [client, server],
      [server, client],
    ]) {
      from.postMessage = (message) => {
        if (disconnected) throw new Error("Port disconnected");
        messages.push({ side: from === client ? "client" : "server", ...message });
        const clone = JSON.parse(JSON.stringify(message));
        queueMicrotask(() => {
          if (!disconnected) to.onMessage.dispatch(clone);
        });
      };
      from.disconnect = () => {
        if (disconnected) return;
        disconnected = true;
        queueMicrotask(() => {
          client.onDisconnect.dispatch();
          server.onDisconnect.dispatch();
        });
      };
    }
    const timers = new Set();
    const chrome = {
      runtime: {
        id: "test-extension",
        connect() {
          mod.attachDownloadPort(server, {
            extensionId: "test-extension",
            fetchImpl: async (url, opts) => {
              calls.push({ url, opts });
              return fetchImpl(url, opts);
            },
          });
          return client;
        },
      },
    };
    const sandbox = {
      chrome,
      ReadableStream,
      Headers,
      Uint8Array,
      DOMException,
      atob,
      setInterval(fn, ms) {
        const id = setInterval(fn, ms);
        timers.add(id);
        return id;
      },
      clearInterval(id) {
        timers.delete(id);
        clearInterval(id);
      },
    };
    vm.runInNewContext(transport, sandbox);
    return {
      fetch: sandbox.evoAttachmentFetch,
      calls,
      messages,
      timers,
      disconnect: client.disconnect,
      get disconnected() {
        return disconnected;
      },
    };
  }
  for (const url of [
    NATIVE,
    `${ORIGIN}/attachments/426709/`,
    `${ORIGIN}/index.php?attachments/example.426709/&download=1`,
  ]) {
    await test(`Native URL recognized: ${new URL(url).pathname}${new URL(url).search}`, async () =>
      assert.equal(mod.nativeAttachment(url)?.id, "426709"));
  }
  for (const url of [
    STORAGE,
    "https://evil.test/attachments/example.426709/",
    `${ORIGIN}/proxy.php?link=x`,
    `${NATIVE}?thumbnail=1`,
    `${ORIGIN}/attachments/evil%2f.426709/`,
    `${ORIGIN}/attachments/0/`,
  ]) {
    await test(`Reject non-original request: ${new URL(url).pathname}${new URL(url).search}`, async () =>
      assert.equal(mod.nativeAttachment(url), null));
  }
  await test("Production client/worker stream byte-exact 250321-byte payload with backpressure", async () => {
    const h = harness();
    const r = await h.fetch(NATIVE);
    assert.equal(
      h.messages.filter((m) => m.type === "chunk").length,
      0,
      "Must wait for reader demand",
    );
    assert.equal(r.headers.get("set-cookie"), null);
    assert.equal(r.headers.get("content-disposition"), 'attachment; filename="test.png"');
    const actual = Buffer.from(await new Response(r.body).arrayBuffer());
    assert.deepEqual(actual, DATA);
    assert.ok(h.messages.filter((m) => m.type === "chunk").length >= 4);
    assert.ok(
      h.messages
        .filter((m) => m.type === "chunk")
        .every((m) => Buffer.from(m.data, "base64").length <= 65536),
    );
    assert.equal(h.calls[0].opts.credentials, "include");
    assert.equal(h.calls[0].opts.cache, "no-store");
    assert.equal(h.timers.size, 0);
    assert.equal(h.disconnected, true);
  });
  await test("Status/Retry-After delivered intact for exporter rate-limit handling", async () => {
    const h = harness(() => response({ status: 429, headers: { "retry-after": "60" } }));
    const r = await h.fetch(NATIVE);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "60");
    await r.body.cancel();
    assert.equal(h.timers.size, 0);
  });
  await test("Invalid request never reaches fetch", async () => {
    const h = harness();
    await assert.rejects(h.fetch(STORAGE), /Only native/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.timers.size, 0);
  });
  for (const sender of [
    { id: "other-extension" },
    { frameId: 1 },
    { url: "https://evil.test/threads/test.1/" },
    { tab: null },
  ]) {
    await test(`Reject unauthorized port sender ${JSON.stringify(sender)}`, async () => {
      const h = harness(undefined, sender);
      await assert.rejects(h.fetch(NATIVE));
      assert.equal(h.calls.length, 0);
      assert.equal(h.timers.size, 0);
    });
  }
  for (const opts of [
    { url: "https://evil.test/file" },
    { url: STORAGE.replace(".com/", ".com.evil.test/") },
    { url: STORAGE.replace("https:", "http:") },
    { url: STORAGE, redirected: false },
    { type: "opaque" },
    { url: ORIGIN + "/attachments/wrong.123/" },
    { url: NATIVE + "?thumbnail=1" },
  ]) {
    await test(`Reject unapproved final response ${JSON.stringify(opts)}`, async () => {
      const h = harness(() => response(opts));
      await assert.rejects(h.fetch(NATIVE));
      assert.equal(h.timers.size, 0);
    });
  }
  await test("Network exception propagates with cleanup", async () => {
    const h = harness(() => {
      throw new TypeError("Network failed");
    });
    await assert.rejects(h.fetch(NATIVE), /Network failed/);
    assert.equal(h.timers.size, 0);
  });
  await test("Abort before headers cancels background fetch", async () => {
    let ready;
    const started = new Promise((r) => (ready = r));
    let signal;
    const h = harness(
      (url, opts) =>
        new Promise((resolve, reject) => {
          signal = opts.signal;
          signal.addEventListener("abort", () => reject(signal.reason));
          ready();
        }),
    );
    const controller = new AbortController();
    const pending = h.fetch(NATIVE, { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await new Promise(setImmediate);
    assert.equal(signal.aborted, true);
    assert.equal(h.timers.size, 0);
  });
  await test("Abort during stalled body read cancels worker reader and client stream", async () => {
    let cancelled = false;
    const h = harness(() =>
      response({
        body: new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      }),
    );
    const controller = new AbortController();
    const r = await h.fetch(NATIVE, { signal: controller.signal });
    const pending = r.body.getReader().read();
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await new Promise(setImmediate);
    assert.equal(cancelled, true);
    assert.equal(h.timers.size, 0);
  });
  await test("Unexpected worker disconnection errors a pending read", async () => {
    const h = harness(() => response({ body: new ReadableStream() }));
    const r = await h.fetch(NATIVE);
    const pending = r.body.getReader().read();
    h.disconnect();
    await assert.rejects(pending, /connection closed/);
    assert.equal(h.timers.size, 0);
  });
  await test("Manifest grants only forum/R2 hosts and no cookie/export APIs", async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.permissions, ["scripting"]);
    assert.deepEqual(manifest.host_permissions, [
      "https://evoweb.uk/*",
      "https://*.r2.cloudflarestorage.com/*",
    ]);
    assert.match(
      manifest.content_security_policy.extension_pages,
      /connect-src https:\/\/evoweb.uk https:\/\/\*\.r2\.cloudflarestorage\.com$/,
    );
    assert.equal(manifest.externally_connectable, undefined);
    assert.equal(manifest.web_accessible_resources, undefined);
  });
})();
