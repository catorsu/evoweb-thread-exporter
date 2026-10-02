import "./safety.js";

const safety = globalThis.evoAttachmentSafety;
export const FORUM_ORIGIN = "https://evoweb.uk";
export const PORT_NAME = "evoweb-attachment-v1";
const CHUNK_SIZE = 64 * 1024;

export function isThread(raw) {
  try {
    const u = new URL(raw);
    return (
      u.origin === FORUM_ORIGIN &&
      !u.username &&
      !u.password &&
      (/^\/threads\/[^/]+(?:\/page-[1-9]\d*)?\/?$/.test(u.pathname) ||
        (u.pathname === "/index.php" && /^\?threads\/[^&]+/.test(u.search)))
    );
  } catch {
    return false;
  }
}

export function nativeAttachment(raw) {
  try {
    const u = new URL(raw);
    if (
      u.origin !== FORUM_ORIGIN ||
      u.username ||
      u.password ||
      u.hash ||
      u.searchParams.has("thumbnail") ||
      /%2f|%5c|%00/i.test(u.href)
    )
      return null;
    const route = u.pathname.startsWith("/attachments/")
      ? u.pathname.slice(13)
      : u.pathname === "/index.php"
        ? u.search.match(/^\?attachments\/([^&]*)/)?.[1]
        : null;
    const id = route?.match(/^(?:[^/]+\.)?([1-9]\d*)\/?$/)?.[1];
    return id ? { url: u.href, id } : null;
  } catch {
    return null;
  }
}

export function isStorage(u) {
  return (
    u.protocol === "https:" &&
    !u.port &&
    !u.username &&
    !u.password &&
    /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(u.hostname)
  );
}

export function validateFinal(response, original) {
  const u = new URL(response.url);
  if (
    !["basic", "cors"].includes(response.type) ||
    (u.origin !== FORUM_ORIGIN && !(response.redirected && isStorage(u)))
  ) {
    throw new Error("Attachment response is not readable Evo-Web or HTTPS R2 storage.");
  }
  const finalAttachment = nativeAttachment(u.href);
  if (finalAttachment && finalAttachment.id !== original.id) {
    throw new Error("Redirect changed the attachment ID.");
  }
  if (u.searchParams.has("thumbnail")) throw new Error("Thumbnail redirect rejected.");
}

export function attachDownloadPort(port, { extensionId, fetchImpl = fetch }) {
  const sender = port.sender;
  if (
    port.name !== PORT_NAME ||
    sender?.id !== extensionId ||
    !Number.isInteger(sender?.tab?.id) ||
    sender.frameId !== 0 ||
    !isThread(sender.url)
  ) {
    port.disconnect();
    return;
  }
  const controller = new AbortController();
  let started = false,
    closed = false,
    reading = false,
    reader = null;
  let pending = null,
    offset = 0,
    scanner = null,
    responseInfo = null;
  // Independent limit also covers a disconnected or stalled content script.
  const timer = setTimeout(() => fail(new Error("Attachment transfer timed out.")), 180000);
  function send(message) {
    if (!closed) port.postMessage(message);
  }
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    controller.abort();
    reader?.cancel().catch(() => {});
    pending = null;
    scanner = null;
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(close);
  }
  function fail(error) {
    try {
      send({
        type: "error",
        name: error.name,
        message: error.message,
        securityDiagnostic: error.securityDiagnostic,
        responseInfo,
      });
    } finally {
      close();
    }
  }
  async function start(url) {
    if (started) throw new Error("Only one attachment is allowed per connection.");
    started = true;
    const original = nativeAttachment(url);
    if (!original) throw new Error("Only native Evo-Web attachment URLs can be downloaded.");
    // Browser supplies domain-scoped cookies. No Cookie header or cookies API.
    // Manifest connect-src constrains redirect destinations, as do host grants.
    const response = await fetchImpl(original.url, {
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    });
    if (closed) {
      await response.body?.cancel();
      return;
    }
    try {
      validateFinal(response, original);
      responseInfo = {
        finalUrl: response.url,
        redirected: response.redirected,
        httpStatus: response.status,
        contentType: response.headers.get("content-type"),
      };
      // Preserve HTTP/challenge handling in the exporter. Error pages are not files.
      if (response.status === 200 && response.headers.get("cf-mitigated") !== "challenge") {
        safety.checkMetadata({
          headers: response.headers,
          requestedUrl: original.url,
          finalUrl: response.url,
        });
        scanner = safety.createScanner();
      }
    } catch (e) {
      try {
        await response.body?.cancel();
      } catch {
        // Preserve the rejection diagnostic even if cancellation also fails.
      }
      throw e;
    }
    reader = response.body?.getReader();
    if (!reader) throw new Error("Attachment response has no body.");
    // Only download metadata crosses to the content script, never Set-Cookie.
    const headers = {};
    for (const name of [
      "content-type",
      "content-disposition",
      "content-length",
      "retry-after",
      "cf-mitigated",
    ]) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    send({
      type: "headers",
      url: response.url,
      redirected: response.redirected,
      responseType: response.type,
      status: response.status,
      headers,
    });
  }
  async function pull() {
    if (!reader || reading) throw new Error("Unexpected attachment stream request.");
    reading = true;
    try {
      while (!pending || offset >= pending.length) {
        const next = await reader.read();
        if (closed) return;
        if (next.done) {
          scanner?.finish();
          send({ type: "end" });
          close();
          return;
        }
        scanner?.push(next.value);
        pending = next.value;
        offset = 0;
      }
      const chunk = pending.subarray(offset, offset + CHUNK_SIZE);
      offset += chunk.length;
      // Chrome Port messages use JSON serialization, not transferable buffers.
      let binary = "";
      for (let i = 0; i < chunk.length; i += 8192)
        binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
      send({ type: "chunk", data: btoa(binary) });
    } finally {
      reading = false;
    }
  }
  function onMessage(message) {
    if (closed) return;
    if (message?.type === "ping") return; // Active transfer heartbeat, no network traffic.
    if (message?.type === "cancel") {
      close();
      return;
    }
    const operation =
      message?.type === "start"
        ? start(message.url)
        : message?.type === "pull"
          ? pull()
          : Promise.reject(new Error("Invalid attachment message."));
    operation.catch(fail);
  }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(close);
}
