(() => {
  "use strict";
  // Lives only in the extension's isolated world. No page message bridge.
  globalThis.evoAttachmentFetch = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const port = chrome.runtime.connect({ name: "evoweb-attachment-v1" });
      let closed = false,
        bodyController = null,
        pendingPull = null;
      let receivedHeaders = false;
      const heartbeat = setInterval(() => {
        try {
          port.postMessage({ type: "ping" });
        } catch (e) {
          fail(e);
        }
      }, 20000);
      function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        signal?.removeEventListener("abort", abort);
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(disconnected);
        port.disconnect();
      }
      function settlePull() {
        pendingPull?.();
        pendingPull = null;
      }
      function fail(error) {
        if (closed) return;
        if (!receivedHeaders) reject(error);
        else bodyController.error(error);
        settlePull();
        cleanup();
      }
      function abort() {
        fail(signal.reason || new DOMException("Stopped", "AbortError"));
      }
      function disconnected() {
        const message = chrome.runtime.lastError?.message;
        fail(new Error(message || "Extension connection closed before the attachment completed."));
      }
      function onMessage(message) {
        if (closed) return;
        try {
          if (message.type === "headers") {
            if (receivedHeaders) throw new Error("Duplicate attachment headers.");
            receivedHeaders = true;
            const body = new ReadableStream(
              {
                start(controller) {
                  bodyController = controller;
                },
                pull() {
                  return new Promise((done) => {
                    pendingPull = done;
                    try {
                      port.postMessage({ type: "pull" });
                    } catch (e) {
                      fail(e);
                    }
                  });
                },
                cancel() {
                  settlePull();
                  cleanup();
                },
              },
              { highWaterMark: 0 },
            );
            resolve({
              url: message.url,
              redirected: message.redirected,
              type: message.responseType,
              status: message.status,
              headers: new Headers(message.headers),
              body,
            });
          } else if (message.type === "chunk") {
            if (!bodyController || !pendingPull) throw new Error("Unexpected attachment data.");
            const binary = atob(message.data);
            bodyController.enqueue(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
            settlePull();
          } else if (message.type === "end") {
            if (!bodyController) throw new Error("Attachment ended before headers.");
            bodyController.close();
            settlePull();
            cleanup();
          } else if (message.type === "error") {
            const error = new Error(message.message);
            error.name = message.name || "Error";
            if (message.securityDiagnostic) error.securityDiagnostic = message.securityDiagnostic;
            if (message.responseInfo) error.responseInfo = message.responseInfo;
            fail(error);
          } else throw new Error("Invalid attachment response.");
        } catch (e) {
          fail(e);
        }
      }
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(disconnected);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        port.postMessage({ type: "start", url });
      } catch (e) {
        fail(e);
      }
    });
})();
