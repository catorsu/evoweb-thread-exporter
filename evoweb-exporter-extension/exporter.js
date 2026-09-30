/*
 * Evo-Web Thread Exporter: thread extraction, folder access, and report writing.
 * Runs in the extension's isolated content-script context after transport.js.
 *
 * Only same-origin, recognized XenForo attachment routes are fetched as files.
 * Attachments stream through the background worker using extension host permissions.
 * Only same-origin or HTTPS Cloudflare R2 final responses are saved.
 * Final-URL validation is a save policy, not a per-hop network allowlist.
 * External post links and embedded media remain references.
 * Thread-page requests stay same-origin and reject redirects.
 * Paths in reports are relative to the directory you select, not OS paths.
 */
(() => {
  "use strict";

  const CONFIG = {
    REQUEST_GAP_MS: 1200, // Minimum pause after each completed request.
    REQUEST_TIMEOUT_MS: 180000, // Includes transferring/writing the response.
    MAX_PAGES: 10000, // Safety ceiling; reaching it is reported.
    DOWNLOAD_QUOTED_ATTACHMENTS: false,
    DOWNLOAD_AUDIO_VIDEO: false, // Embedded players are always references only.
  };
  const KEY = "evoThreadExporter";
  const extensionFetch =
    typeof chrome !== "undefined" &&
    chrome.runtime?.id &&
    typeof globalThis.evoAttachmentFetch === "function"
      ? globalThis.evoAttachmentFetch
      : null;
  if (!extensionFetch) {
    console.error("Open Evo-Web Thread Exporter from Chrome's Extensions menu.");
    return;
  }
  const VERSION = chrome.runtime.getManifest().version;
  if (window[KEY]?.running || window[KEY]?.busy) {
    console.warn(
      "An exporter is busy. Finish the open picker/permission dialog, or stop the current export first.",
    );
    return;
  }
  if (!window.isSecureContext || typeof window.showDirectoryPicker !== "function") {
    console.error(
      "This exporter needs HTTPS and showDirectoryPicker. Use a supporting desktop browser, such as Chrome or Edge.",
    );
    return;
  }

  if (window.self !== window.top) {
    console.error("Open the exporter in the top-level Evo-Web thread tab.");
    return;
  }

  const ORIGIN = location.origin;
  const urlOf = (raw, base = location.href) => {
    if (!raw || !String(raw).trim()) return null;
    try {
      const u = new URL(String(raw).trim(), base);
      return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u : null;
    } catch {
      return null;
    }
  };
  const cleanText = (s) =>
    String(s ?? "")
      .replace(/\u00a0/g, " ")
      .trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const decode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };

  // Both friendly URLs and index.php?threads/... routes are recognized.
  function threadInfo(raw, base) {
    const u = urlOf(raw, base);
    if (!u || u.origin !== ORIGIN) return null;
    let root,
      route,
      queryStyle = false;
    const friendly = u.pathname.match(/^(.*\/)threads\/(.*)$/);
    if (friendly) [root, route] = [friendly[1], friendly[2]];
    else {
      const php = u.pathname.match(/^(.*\/)index\.php$/);
      const query = u.search.match(/^\?threads\/([^&]*)/);
      if (!php || !query) return null;
      [root, route, queryStyle] = [php[1], query[1], true];
    }
    const m = route.match(/^([^/]+)(?:\/page-([1-9]\d*))?\/?$/);
    const id = m?.[1].match(/(?:^|\.)([1-9]\d*)$/)?.[1];
    if (!m || !id) return null;
    return { root, slug: m[1], id, page: Number(m[2] || 1), queryStyle };
  }
  const THREAD =
    threadInfo(location.href) ||
    threadInfo(
      document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
      document.baseURI,
    );
  if (!THREAD) {
    console.error("Open a normal thread page first; the current thread URL was not recognized.");
    return;
  }
  const SITE_BASE = new URL(THREAD.root, ORIGIN).href;
  function pageURL(page) {
    const route = `threads/${THREAD.slug}/${page === 1 ? "" : `page-${page}`}`;
    return new URL(THREAD.queryStyle ? `index.php?${route}` : route, SITE_BASE).href;
  }
  const sameThread = (info) => info && info.id === THREAD.id && info.root === THREAD.root;

  // File extensions, link labels, and CSS classes do not establish attachment identity.
  function nativeAttachment(raw, base) {
    const u = urlOf(raw, base);
    if (!u || u.origin !== ORIGIN) return null;
    let segment;
    const prefix = `${THREAD.root}attachments/`;
    if (u.pathname.startsWith(prefix)) segment = u.pathname.slice(prefix.length);
    else if (u.pathname === `${THREAD.root}index.php`) {
      segment = u.search.match(/^\?attachments\/([^&]*)/)?.[1];
    }
    if (!segment || /%2f|%5c|%00/i.test(segment)) return null;
    const m = segment.match(/^([^/]+)\/?$/);
    const id = m?.[1].match(/(?:^|\.)([1-9]\d*)$/)?.[1];
    if (!m || !id) return null;
    // A thumbnail request is a preview, not the downloadable original.
    const thumbnail = u.searchParams.has("thumbnail");
    u.hash = ""; // Only native request fragments are removed; external URLs are intact.
    return { id, url: u.href, segment: decode(m[1]), thumbnail };
  }

  function attachmentStorageURL(u) {
    // R2 storage is accepted only after a recognized native attachment request.
    return (
      u &&
      u.protocol === "https:" &&
      !u.port &&
      /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(u.hostname)
    );
  }

  function safeName(value, limit = 100) {
    let s = cleanText(value)
      .normalize("NFC")
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "_")
      .replace(/^[. ]+|[. ]+$/g, "");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) s = `_${s}`;
    let out = "",
      bytes = 0;
    const encoder = new TextEncoder();
    for (const char of s || "unnamed") {
      const size = encoder.encode(char).length;
      if (bytes + size > limit) break;
      out += char;
      bytes += size;
    }
    return out.replace(/[. ]+$/g, "") || "unnamed";
  }
  function safeFileName(value) {
    const s = safeName(value, 240);
    const ext = s.match(/\.[a-z0-9]{1,12}$/i)?.[0] || "";
    return ext ? safeName(s.slice(0, -ext.length), 85) + ext : safeName(s, 100);
  }

  // Parse into an inert template, never inserting fetched HTML into the page.
  function parseHTML(html) {
    const t = document.createElement("template");
    t.innerHTML = html;
    return t.content;
  }
  function textOf(node) {
    const blocks = /^(DIV|P|LI|UL|OL|BLOCKQUOTE|PRE|H[1-6]|TR|TABLE|SECTION|FIGURE)$/;
    const walk = (n) => {
      if (n.nodeType === Node.TEXT_NODE) return n.nodeValue;
      if (n.nodeType !== Node.ELEMENT_NODE && n.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return "";
      if (/^(SCRIPT|STYLE|NOSCRIPT|BUTTON|IFRAME)$/.test(n.nodeName)) return "";
      if (n.nodeName === "BR") return "\n";
      if (n.nodeName === "IMG") return n.getAttribute("alt") ? `[${n.getAttribute("alt")}]` : "";
      const text = Array.from(n.childNodes, walk).join("");
      return blocks.test(n.nodeName) ? `\n${text}\n` : text;
    };
    return cleanText(
      node
        ? walk(node)
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
        : "",
    );
  }
  function postBody(post) {
    return post.querySelector(".message-body .bbWrapper") || post.querySelector(".bbWrapper");
  }
  function splitBody(body) {
    if (!body) return { body: "[Body not found]", quotes: [] };
    const clone = body.cloneNode(true);
    const topQuotes = Array.from(clone.querySelectorAll("blockquote")).filter(
      (q) => !q.parentElement?.closest("blockquote"),
    );
    const quotes = topQuotes.map((q) => {
      const author = cleanText(
        q.querySelector(".bbCodeBlock-title a")?.textContent ||
          q.getAttribute("data-quote") ||
          "Unknown",
      ).replace(/\s+said:\s*$/i, "");
      const result = { author, text: textOf(q.querySelector(".bbCodeBlock-expandContent") || q) };
      q.remove();
      return result;
    });
    return { body: textOf(clone), quotes };
  }

  function documentBase(doc, page) {
    return urlOf(doc.querySelector("base[href]")?.getAttribute("href"), page)?.href || page;
  }
  function discoverMaxPage(doc, base) {
    base = documentBase(doc, base);
    let max = 1;
    for (const a of doc.querySelectorAll(
      '.pageNav a[href], .pageNav-page a[href], .pageNavSimple a[href], link[rel="next"], link[rel="last"]',
    )) {
      const info = threadInfo(a.getAttribute("href"), base);
      if (sameThread(info)) max = Math.max(max, info.page);
    }
    for (const el of doc.querySelectorAll(
      ".pageNav-page, .pageNavSimple [data-last], .pageNavSimple-el[data-last]",
    )) {
      const n = Number(
        (el.getAttribute("data-last") || cleanText(el.textContent)).replace(/,/g, ""),
      );
      if (Number.isSafeInteger(n) && n > 0) max = Math.max(max, n);
    }
    return max;
  }

  const DOWNLOAD_HOSTS = [
    "mediafire.com",
    "mega.nz",
    "mega.co.nz",
    "drive.google.com",
    "docs.google.com",
    "dropbox.com",
    "1drv.ms",
    "onedrive.live.com",
    "pixeldrain.com",
    "gofile.io",
    "sendspace.com",
    "we.tl",
    "wetransfer.com",
    "workupload.com",
    "sharemods.com",
    "modsfire.com",
    "4shared.com",
    "krakenfiles.com",
    "archive.org",
  ];
  function likelyDownload(u, label) {
    return (
      DOWNLOAD_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)) ||
      /\.(zip|rar|7z|tar|gz|bz2|xz|zst|iso|exe|msi|apk|pdf|bin|img|torrent|png|jpe?g|webp|mp[34]|wav)$/i.test(
        u.pathname,
      ) ||
      /(?:\bdownload\b|\bmirror\b|下载|下載)/i.test(`${label} ${u.pathname}`)
    );
  }
  function rawTextURL(token) {
    let s = token.replace(/[.,;:!?，。；：！？]+$/u, "");
    for (const [open, close] of [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ]) {
      while (s.endsWith(close) && s.split(close).length > s.split(open).length) s = s.slice(0, -1);
    }
    return s;
  }

  function extractReferences(post, body, base) {
    const attachments = new Map(),
      external = new Map(),
      internal = new Map(),
      warnings = [];
    const roots = [body, ...post.querySelectorAll(".attachmentList, .message-attachments")].filter(
      Boolean,
    );
    const scopes = roots.filter(
      (r, i) => roots.indexOf(r) === i && !roots.some((other) => other !== r && other.contains(r)),
    );
    const contextOf = (node) =>
      node.closest("blockquote")
        ? "quote"
        : node.closest(".attachmentList, .message-attachments")
          ? "attachment-list"
          : "body";
    function addLink(map, u, raw, label, context, via = null) {
      let item = map.get(u.href);
      if (!item) {
        item = {
          url: u.href,
          rawValues: [],
          labels: [],
          contexts: [],
          via: [],
          likelyDownload: likelyDownload(u, label),
        };
        map.set(u.href, item);
      }
      for (const [key, value] of [
        ["rawValues", raw],
        ["labels", label],
        ["contexts", context],
        ["via", via],
      ]) {
        if (value && !item[key].includes(value)) item[key].push(value);
      }
      item.likelyDownload ||= likelyDownload(u, label);
    }
    function register(raw, node, allowNative = true, media = false) {
      const u = urlOf(raw, base);
      if (!u) return;
      const context = contextOf(node);
      const label = cleanText(
        node.getAttribute("data-filename") || node.getAttribute("alt") || node.textContent,
      ).slice(0, 500);
      const native = allowNative ? nativeAttachment(u.href, base) : null;
      if (native) {
        let item = attachments.get(native.id);
        const containerName = cleanText(
          node.closest(".attachment")?.querySelector(".attachment-name")?.textContent,
        );
        const hint = containerName || (/\.[a-z0-9]{1,12}$/i.test(label) ? label : "");
        if (!item) {
          item = {
            ...native,
            nameHint: hint,
            sourceURLs: [],
            contexts: [],
            status: "pending",
            path: null,
          };
          attachments.set(native.id, item);
        }
        if (item.thumbnail && !native.thumbnail) Object.assign(item, native);
        if (node.closest("video, audio")) item.embeddedAudioVideo = true;
        if (hint && !item.nameHint) item.nameHint = hint;
        if (!item.sourceURLs.includes(u.href)) item.sourceURLs.push(u.href);
        if (!item.contexts.includes(context)) item.contexts.push(context);
        return;
      }
      // Do not turn avatars, remote embedded images, or thumbnails into downloads.
      if (media) return;
      if (u.origin !== ORIGIN) addLink(external, u, raw, label, context);
      else {
        // Decode link wrappers for reporting without requesting their targets.
        const target =
          u.pathname === `${THREAD.root}proxy.php` ? urlOf(u.searchParams.get("link"), base) : null;
        if (target && target.origin !== ORIGIN)
          addLink(external, target, raw, label, context, u.href);
        else addLink(internal, u, raw, label, context);
      }
    }
    for (const root of scopes) {
      for (const a of root.querySelectorAll("a[href]")) register(a.getAttribute("href"), a);
      for (const el of root.querySelectorAll("img, video, audio, source, [data-attachment-id]")) {
        for (const attr of [
          "data-full-url",
          "data-lb-src",
          "data-url",
          "data-src",
          "data-original",
          "src",
        ]) {
          if (el.hasAttribute(attr)) register(el.getAttribute(attr), el, true, true);
        }
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode,
          parent = node.parentElement;
        if (!parent || parent.closest("a, script, style, button")) continue;
        for (const m of node.nodeValue.matchAll(/https?:\/\/[^\s<>"`]+/gi)) {
          // Raw text is preserved in the body, too. Plain-text native references
          // are records, not proof of an uploaded attachment.
          register(rawTextURL(m[0]), parent, false);
        }
      }
      for (const el of root.querySelectorAll("[data-attachment-id]")) {
        const id = el.getAttribute("data-attachment-id");
        if (/^[1-9]\d*$/.test(id || "") && !attachments.has(id)) {
          warnings.push(
            `Attachment ID ${id}: no recognized original download URL; not downloaded.`,
          );
        }
      }
    }
    return {
      attachments: [...attachments.values()],
      externalLinks: [...external.values()],
      otherInternalLinks: [...internal.values()],
      warnings: [...new Set(warnings)],
    };
  }

  function embeddedMediaReferences(body, base) {
    if (!body) return [];
    const nodes = [...body.querySelectorAll("iframe, video, audio, [data-s9e-mediaembed]")];
    // A media wrapper and its iframe describe one embed, not two.
    return nodes
      .filter((node) => !nodes.some((parent) => parent !== node && parent.contains(node)))
      .map((node) => {
        const urls = new Set();
        for (const el of [node, ...node.querySelectorAll("iframe, video, audio, source")]) {
          for (const attr of ["src", "data-src"]) {
            const u = urlOf(el.getAttribute(attr), base);
            if (u) urls.add(u.href);
          }
        }
        return {
          kind: /^(VIDEO|AUDIO)$/.test(node.nodeName) ? node.nodeName.toLowerCase() : "embed",
          context: node.closest("blockquote") ? "quote" : "body",
          status: "media-reference-only",
          urls: [...urls],
        };
      });
  }

  function extractPost(post, page, index, base, linkBase = base) {
    const attribution = post.querySelector(".message-attribution");
    const links = [...(attribution?.querySelectorAll("a[href]") || [])];
    const floor =
      links.map((a) => cleanText(a.textContent)).find((s) => /^#[\d,]+$/.test(s)) || null;
    const id =
      `${post.id} ${post.getAttribute("data-content") || ""}`.match(
        /(?:js-)?post-([1-9]\d*)/,
      )?.[1] ||
      links
        .map((a) => a.getAttribute("href").match(/(?:#post-|\/posts\/)([1-9]\d*)/)?.[1])
        .find(Boolean) ||
      null;
    const body = postBody(post);
    const key = id || `page-${page}-item-${index + 1}`;
    return {
      id,
      key,
      floor,
      page,
      indexOnPage: index + 1,
      url: id ? `${base}#post-${id}` : base,
      author:
        cleanText(
          post.querySelector(".message-name .username, .message-userDetails .username, .username")
            ?.textContent,
        ) || "Unknown",
      date: post.querySelector(".message-attribution time")?.getAttribute("datetime") || null,
      ...splitBody(body),
      ...extractReferences(post, body, linkBase),
      embeddedMedia: embeddedMediaReferences(body, linkBase),
    };
  }

  function dispositionName(header) {
    const star = header.match(/filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i);
    if (star) {
      const encoded = (star[1] || star[2]).trim().match(/^UTF-8'[^']*'(.*)$/i);
      if (encoded) {
        try {
          return decodeURIComponent(encoded[1]);
        } catch {
          /* fall through */
        }
      }
    }
    const plain = header.match(/(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))/i);
    return plain ? (plain[1] ?? plain[2]).trim().replace(/\\(["\\])/g, "$1") : "";
  }
  const MIME_EXT = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/zip": ".zip",
    "application/x-7z-compressed": ".7z",
    "application/vnd.rar": ".rar",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "audio/mpeg": ".mp3",
    "video/mp4": ".mp4",
  };
  function attachmentName(item, response) {
    let name = dispositionName(response.headers.get("content-disposition") || "") || item.nameHint;
    if (!name) {
      name =
        item.segment
          .replace(new RegExp(`(?:^|\\.)${item.id}$`), "")
          .replace(/-(zip|rar|7z|png|jpe?g|gif|webp|pdf|txt|mp[34]|wav|bin)$/i, ".$1") ||
        `attachment-${item.id}`;
    }
    if (!/\.[a-z0-9]{1,12}$/i.test(name)) {
      name +=
        MIME_EXT[(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()] ||
        ".bin";
    }
    return `${item.id}__${safeFileName(name)}`;
  }
  function category(name, type) {
    if (/\.(zip|rar|7z|tar|gz|bz2|xz|zst|cab)$/i.test(name)) return "archives";
    if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?)$/i.test(name))
      return "images";
    if (type.startsWith("video/") || /\.(mp4|mkv|avi|mov|webm)$/i.test(name)) return "video";
    if (type.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a)$/i.test(name)) return "audio";
    if (/\.(pdf|txt|md|csv|json|xml|docx?|xlsx?|pptx?)$/i.test(name)) return "documents";
    return "other";
  }

  const state = (window[KEY] = {
    version: VERSION,
    transport: "extension",
    phase: "idle",
    busy: false,
    running: false,
    selectedHandle: null,
    permission: "unknown",
    lastError: null,
    startupDiagnostics: [],
    lastRequestError: null,
    stopRequested: false,
    activeController: null,
    haltReason: null,
    report: null,
    stop() {
      if (!this.running) return;
      this.stopRequested = true;
      this.activeController?.abort();
    },
  });
  let rootHandle = null,
    rootName = null,
    lastFinished = 0;
  function checkStop() {
    if (state.stopRequested || state.haltReason)
      throw new DOMException(state.haltReason || "Stopped by user", "AbortError");
  }
  async function request(url, kind, consume) {
    const u = urlOf(url);
    const allowed =
      kind === "attachment"
        ? nativeAttachment(url)
        : kind === "page"
          ? sameThread(threadInfo(url))
          : false;
    if (!u || u.origin !== ORIGIN || !allowed)
      throw new Error("Request rejected by native-only policy");
    await sleep(Math.max(0, CONFIG.REQUEST_GAP_MS - (Date.now() - lastFinished)));
    checkStop();
    const controller = new AbortController();
    state.activeController = controller;
    const timer = setTimeout(
      () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
      CONFIG.REQUEST_TIMEOUT_MS,
    );
    let response = null,
      stage = "fetch";
    try {
      // The worker can read R2 responses using host permissions. Thread pages
      // use the tab's session and must not redirect to another resource.
      response =
        kind === "attachment"
          ? await extensionFetch(u.href, { signal: controller.signal })
          : await fetch(u.href, {
              credentials: "same-origin",
              mode: "same-origin",
              redirect: "error",
              signal: controller.signal,
            });
      stage = "validate-response";
      const finalURL = response.url ? urlOf(response.url) : null;
      const sameOrigin = finalURL?.origin === ORIGIN;
      const storageResponse =
        kind === "attachment" && response.redirected && attachmentStorageURL(finalURL);
      if (
        !["basic", "cors"].includes(response.type) ||
        !finalURL ||
        (!sameOrigin && !storageResponse) ||
        (kind === "page" && (response.type !== "basic" || response.redirected))
      ) {
        throw new Error(
          "Unreadable or unapproved response rejected; only same-origin or HTTPS R2 attachment storage may be saved.",
        );
      }
      const challenged = response.headers.get("cf-mitigated") === "challenge";
      if (response.status !== 200 || challenged) {
        const retryAfter = response.headers.get("retry-after");
        const reason =
          `HTTP ${response.status}${retryAfter ? `; Retry-After: ${retryAfter}` : ""}` +
          (challenged ? "; browser challenge required" : "");
        if (
          response.status === 429 ||
          challenged ||
          (kind === "page" && [401, 403].includes(response.status))
        )
          state.haltReason = reason;
        throw new Error(reason);
      }
      if (kind === "attachment" && finalURL) {
        const resolvedAttachment = nativeAttachment(finalURL.href);
        if (
          resolvedAttachment &&
          (resolvedAttachment.id !== allowed.id || resolvedAttachment.thumbnail)
        ) {
          throw new Error(
            "Attachment redirected to a different attachment ID or a thumbnail; not saved under the original ID.",
          );
        }
        // Storage paths may differ from the original native attachment route.
      }
      stage = "consume-response";
      return await consume(response);
    } catch (cause) {
      if (response?.body && !response.body.locked) {
        try {
          await response.body.cancel();
        } catch {
          /* Keep the original failure. */
        }
      }
      const original = controller.signal.aborted ? controller.signal.reason || cause : cause;
      let message = original?.message || String(original);
      if (stage === "fetch" && original?.name === "TypeError" && kind === "attachment") {
        message +=
          " Attachment request failed. Check extension site access to Evo-Web and Cloudflare R2, and that you are signed in.";
      }
      const error = new Error(message, { cause: original });
      error.name = original?.name || "Error";
      error.requestInfo = {
        time: new Date().toISOString(),
        kind,
        stage,
        requestedUrl: u.href,
        finalUrl: response?.url || null,
        redirected: response ? !!response.redirected : null,
        httpStatus: response?.status ?? null,
        challenged: response?.headers.get("cf-mitigated") === "challenge",
        error: `${error.name}: ${error.message}`,
      };
      state.lastRequestError = error.requestInfo;
      throw error;
    } finally {
      clearTimeout(timer);
      state.activeController = null;
      lastFinished = Date.now();
    }
  }
  async function directory(parts) {
    let dir = rootHandle;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    return dir;
  }
  async function writeText(name, text) {
    const file = await rootHandle.getFileHandle(name, { create: true });
    const stream = await file.createWritable();
    try {
      await stream.write(text);
      await stream.close();
    } catch (e) {
      try {
        await stream.abort();
      } catch {}
      throw e;
    }
  }

  function isAudioVideoName(name) {
    return /[.-](?:mp4|m4v|mkv|webm|mov|avi|wmv|flv|mpeg|mpg|3gp|ogv|ts|m2ts|mp3|wav|ogg|oga|opus|flac|m4a|aac|wma|aiff|aif|mid|midi)$/i.test(
      name || "",
    );
  }
  async function saveAttachment(item, post) {
    if (item.contexts.every((c) => c === "quote") && !CONFIG.DOWNLOAD_QUOTED_ATTACHMENTS) {
      item.status = "quoted-reference-only";
      return;
    }
    const stem = item.segment.replace(new RegExp(`(?:^|\\.)${item.id}$`), "");
    if (
      item.embeddedAudioVideo ||
      (!CONFIG.DOWNLOAD_AUDIO_VIDEO && (isAudioVideoName(item.nameHint) || isAudioVideoName(stem)))
    ) {
      item.status = "media-reference-only";
      item.skipReason = "Video/audio content excluded from this export.";
      return;
    }
    if (item.thumbnail) {
      item.status = "original-url-unavailable";
      item.error =
        "Only a thumbnail URL was found; a preview was not substituted for the original.";
      return;
    }
    let reader,
      stream,
      dir,
      filename,
      committed = false;
    try {
      await request(item.url, "attachment", async (response) => {
        item.finalUrl = response.url || null;
        item.redirected = !!response.redirected;
        item.httpStatus = response.status;
        item.contentType = (response.headers.get("content-type") || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        // Fail closed on HTML, including login/error/challenge pages.
        if (/^(text\/html|application\/xhtml\+xml)$/.test(item.contentType)) {
          await response.body?.cancel();
          throw new Error("HTML response rejected; this may be a login/error/challenge page.");
        }
        filename = attachmentName(item, response);
        if (
          !CONFIG.DOWNLOAD_AUDIO_VIDEO &&
          (/^(audio|video)\//.test(item.contentType) || isAudioVideoName(filename))
        ) {
          await response.body?.cancel();
          item.status = "media-reference-only";
          item.skipReason = "Video/audio identified at response headers; body not read or saved.";
          return;
        }
        if (!response.body) throw new Error("No response stream");
        reader = response.body.getReader();
        const prefix = [];
        let prefixLength = 0;
        while (prefixLength < 1024) {
          const chunk = await reader.read();
          if (chunk.done) break;
          prefix.push(chunk.value);
          prefixLength += chunk.value.length;
        }
        const sniff = new Uint8Array(Math.min(prefixLength, 1024));
        let offset = 0;
        for (const chunk of prefix) {
          const part = chunk.subarray(0, sniff.length - offset);
          sniff.set(part, offset);
          offset += part.length;
          if (offset === sniff.length) break;
        }
        if (
          /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(new TextDecoder().decode(sniff))
        ) {
          throw new Error("HTML-looking response rejected, despite its MIME type.");
        }
        item.category = category(filename, item.contentType);
        const parts = ["posts", `post-${post.key}`, item.category];
        dir = await directory(parts);
        const handle = await dir.getFileHandle(filename, { create: true });
        stream = await handle.createWritable();
        let bytes = 0;
        for (const chunk of prefix) {
          checkStop();
          await stream.write(chunk);
          bytes += chunk.length;
        }
        while (true) {
          checkStop();
          const chunk = await reader.read();
          if (chunk.done) break;
          await stream.write(chunk.value);
          bytes += chunk.value.length;
        }
        // Only after the write is committed may the report claim a local path.
        await stream.close();
        committed = true;
        item.status = "saved";
        item.path = [rootName, ...parts, filename].join("/");
        item.filename = filename;
        item.bytes = bytes;
      });
    } catch (e) {
      const unavailable =
        e.requestInfo?.stage === "validate-response" &&
        [404, 410].includes(e.requestInfo.httpStatus) &&
        !e.requestInfo.challenged;
      item.status = state.stopRequested ? "cancelled" : unavailable ? "unavailable" : "failed";
      item.error = `${e.name}: ${e.message}`;
      if (e.requestInfo) {
        item.requestDiagnostic = e.requestInfo;
        item.finalUrl = e.requestInfo.finalUrl;
        item.redirected = e.requestInfo.redirected;
        item.httpStatus = e.requestInfo.httpStatus;
      }
      (unavailable ? console.log : console.warn)(
        `Attachment ${item.id} [${item.status}]: ${item.error}`,
        item.requestDiagnostic || { requestedUrl: item.url },
      );
    } finally {
      if (reader) {
        try {
          await reader.cancel();
        } catch {}
        try {
          reader.releaseLock();
        } catch {}
      }
      if (!committed) {
        if (stream) {
          try {
            await stream.abort();
          } catch {}
        }
        if (dir && filename) {
          try {
            await dir.removeEntry(filename);
          } catch {}
        }
      }
    }
  }

  function summarizeReport(report) {
    const attachments = report.posts.flatMap((p) => p.attachments);
    const count = (status) => attachments.filter((a) => a.status === status).length;
    const attachmentIssues = attachments.filter(
      (a) =>
        !["saved", "unavailable", "quoted-reference-only", "media-reference-only"].includes(
          a.status,
        ),
    ).length;
    const unavailableAttachments = count("unavailable");
    const warnings = report.posts.some((p) => p.warnings.length);
    report.status = report.haltReason
      ? "stopped-partial"
      : report.errors.length ||
          report.pagesOK.length < report.maxPage ||
          attachmentIssues ||
          warnings
        ? "finished-with-errors-or-gaps"
        : unavailableAttachments
          ? "finished-with-unavailable-attachments"
          : "finished";
    report.summary = {
      savedAttachments: count("saved"),
      unavailableAttachments,
      attachmentIssues,
      skippedMediaAttachments: count("media-reference-only"),
      quotedReferences: count("quoted-reference-only"),
      embeddedMediaReferences: report.posts.reduce((n, p) => n + (p.embeddedMedia?.length || 0), 0),
      externalLinks: report.posts.reduce((n, p) => n + p.externalLinks.length, 0),
    };
  }

  function reportText(report) {
    const lines = [
      `Thread: ${report.title}`,
      `Source: ${report.url}`,
      `Status: ${report.status}`,
      `Started: ${report.startedAt}`,
      `Updated: ${report.updatedAt}`,
      `Pages discovered: ${report.maxPage}; pages exported: ${report.pagesOK.length}; posts: ${report.posts.length}`,
      `Selected directory name: ${report.selectedDirectory}`,
      "All local paths below are relative to the SELECTED directory (not absolute OS paths).",
      "External links were recorded only; their targets were not requested by the downloader.",
      `Attachment transport: ${state.transport}; only same-origin or HTTPS Cloudflare R2 final responses are saved.`,
      "Redirect hops are browser-managed; extension host permissions and connect-src restrict background destinations.",
      "Likely-download labels are heuristics, not verification. Other external links are retained too.",
      "Quoted attachments are references, not evidence of upload ownership.",
      `Quoted attachment downloads enabled: ${CONFIG.DOWNLOAD_QUOTED_ATTACHMENTS}`,
      "Embedded players are references only; video/audio files are excluded by default.",
      "HTTP 404/410 attachments are recorded as unavailable, separately from export failures.",
      "=".repeat(72),
      "",
    ];
    for (const post of report.posts) {
      lines.push(
        `Post: ${post.floor || "[floor unavailable]"}; ID: ${post.id || "[unavailable]"}; page: ${post.page}`,
        `Author: ${post.author}`,
        `Date: ${post.date || "[unavailable]"}`,
        `Permalink: ${post.url}`,
      );
      if (post.quotes.length) {
        lines.push("--- Quotes ---");
        for (const q of post.quotes) lines.push(`[Quote: ${q.author}]`, q.text, "");
      }
      lines.push(
        "--- Body ---",
        post.body ||
          (post.embeddedMedia?.some((m) => m.context === "body")
            ? "[No exported text; embedded media intentionally excluded.]"
            : "[Empty body]"),
      );
      if (post.embeddedMedia?.length) {
        lines.push("", "--- Embedded media — REFERENCE ONLY ---");
        for (const media of post.embeddedMedia)
          lines.push(`[${media.kind}; ${media.context}] Content not downloaded.`, ...media.urls);
      }
      lines.push("", "--- Native forum attachments ---");
      if (!post.attachments.length) lines.push("[None recognized]");
      for (const a of post.attachments) {
        lines.push(
          `[${a.status}] ID ${a.id}; context: ${a.contexts.join(", ")}`,
          `  Source: ${a.url}`,
          `  Local path: ${a.path || "[not saved]"}`,
        );
        if (a.finalUrl) lines.push(`  Resolved URL: ${a.finalUrl}`);
        if (a.redirected != null) lines.push(`  Redirect followed: ${a.redirected ? "yes" : "no"}`);
        if (a.httpStatus != null) lines.push(`  Final HTTP status: ${a.httpStatus}`);
        if (a.requestDiagnostic) lines.push(`  Failure stage: ${a.requestDiagnostic.stage}`);
        if (a.status === "saved") lines.push(`  Category: ${a.category}; bytes: ${a.bytes}`);
        if (a.error) lines.push(`  Error: ${a.error}`);
        if (a.skipReason) lines.push(`  Skipped: ${a.skipReason}`);
      }
      for (const [heading, items] of [
        [
          "External download candidates — TEXT ONLY",
          post.externalLinks.filter((x) => x.likelyDownload),
        ],
        [
          "Other/unknown external links — TEXT ONLY",
          post.externalLinks.filter((x) => !x.likelyDownload),
        ],
        ["Other internal links — NOT attachment downloads", post.otherInternalLinks],
      ]) {
        lines.push("", `--- ${heading} ---`);
        if (!items.length) lines.push("[None]");
        for (const x of items) {
          lines.push(`URL: ${x.url}`, `  Context: ${x.contexts.join(", ")}`);
          if (x.labels.length) lines.push(`  Label: ${x.labels.join(" | ")}`);
          if (x.via.length) lines.push(`  Wrapper: ${x.via.join(" | ")}`);
        }
      }
      if (post.warnings.length) lines.push("", "--- Warnings ---", ...post.warnings);
      lines.push("", "-".repeat(72), "");
    }
    lines.push("--- Export diagnostics ---", ...report.errors.map((e) => JSON.stringify(e)));
    if (report.haltReason) lines.push(`Stopped: ${report.haltReason}`);
    return "\uFEFF" + lines.join("\n");
  }
  async function checkpoint() {
    const r = state.report;
    r.updatedAt = new Date().toISOString();
    await writeText("thread.txt", reportText(r));
    await writeText("manifest.json", JSON.stringify(r, null, 2));
  }

  document.getElementById("evoweb-export-panel")?.remove();
  const panel = document.createElement("div");
  panel.id = "evoweb-export-panel";
  panel.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;color:#111;border:2px solid #555;padding:14px;max-width:440px;max-height:80vh;overflow:auto;font:14px/1.5 sans-serif;box-shadow:0 4px 20px #0005";
  const heading = document.createElement("strong");
  heading.textContent = `Evo-Web Thread Exporter v${VERSION}`;
  heading.style.display = "block";
  const start = document.createElement("button");
  const authorize = document.createElement("button");
  const stop = document.createElement("button");
  const status = document.createElement("div");
  start.id = "evoweb-export-choose";
  authorize.id = "evoweb-export-authorize";
  stop.id = "evoweb-export-stop";
  status.id = "evoweb-export-status";
  for (const button of [start, authorize, stop]) {
    button.type = "button"; // Do not submit a surrounding forum form.
    button.style.cssText = "margin:6px 6px 6px 0;padding:6px 9px;white-space:normal";
  }
  start.textContent = "Choose folder & export";
  authorize.textContent = "Grant write access & export";
  stop.textContent = "Stop & save partial";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;margin-top:6px";
  status.textContent =
    "Choose a dedicated destination folder. Write access is checked before any downloads. External links are text only.";
  panel.append(heading, start, authorize, stop, status);
  document.body.append(panel);

  function refreshControls() {
    const locked = state.busy || state.running;
    start.disabled = locked;
    authorize.disabled = locked;
    authorize.hidden =
      !state.selectedHandle ||
      !["awaiting-permission", "startup-error", "authorizing"].includes(state.phase);
    authorize.textContent =
      state.permission === "granted"
        ? "Retry export in selected folder"
        : state.permission === "denied"
          ? "Retry write permission & export"
          : "Grant write access & export";
    stop.disabled = !state.running || state.stopRequested;
  }

  function requireUserClick(event) {
    // Both APIs must be entered from the page button, not a delayed task or
    // a synthetic button.click(). No asynchronous work precedes either call.
    if (!event?.isTrusted || (navigator.userActivation && !navigator.userActivation.isActive)) {
      throw new DOMException(
        "Click the exporter button directly in the active Evo-Web tab.",
        "SecurityError",
      );
    }
  }

  function rememberStartupError(stage, error) {
    const info = {
      time: new Date().toISOString(),
      stage,
      name: error?.name || "Error",
      message: error?.message || String(error),
      selectedDirectory: state.selectedHandle?.name || null,
      permission: state.permission,
      secureContext: window.isSecureContext,
      topLevel: window.self === window.top,
      userActivation: navigator.userActivation?.isActive ?? null,
    };
    state.lastError = info;
    state.startupDiagnostics.push(info);
    if (state.startupDiagnostics.length > 50) state.startupDiagnostics.shift();
    console.warn("Evo-Web startup diagnostic:", info);
    return info;
  }

  function showStartupError(stage, error) {
    const info = rememberStartupError(stage, error);
    state.phase = "startup-error";
    let message;
    if (stage === "pick-directory" && info.name === "AbortError") {
      message =
        "No folder handle was returned. The browser may have cancelled the picker, rejected this location, or not granted access.\n" +
        "Click Choose folder & export to try again. Select an ordinary dedicated subfolder (for example, Downloads/EvoWebExports), not a drive root or system folder.";
    } else if (stage === "request-write-permission" && info.name === "AbortError") {
      message =
        "Write authorization was cancelled or could not be completed. Your folder selection is retained.\n" +
        "Click Grant write access & export again, or choose another folder.";
    } else if (info.name === "SecurityError") {
      message =
        "The browser blocked this operation. Use the top-level HTTPS Evo-Web tab and click the on-page button directly.\n" +
        "Retry from a fresh click; a delayed or programmatic retry cannot supply a new user gesture.";
    } else if (info.name === "NotAllowedError") {
      message =
        "Write access is not available. Approve the browser's file-editing permission, or check the site's file-access setting and select a writable folder.";
    } else if (info.name === "NotFoundError") {
      message =
        "The selected folder or a required file is no longer available. Choose the destination folder again.";
    } else if (info.name === "NotSupportedError") {
      message =
        "This browser context does not provide all required directory/permission APIs. Use a supporting desktop browser on the HTTPS thread page.";
    } else {
      message = `Startup stopped during ${stage}. Retry with a writable folder; check available disk space and operating-system permissions.`;
    }
    if (stage === "preflight") {
      message +=
        "\nNo thread or attachment requests were started. The failed attempt may have left a small incomplete export directory.";
    }
    status.textContent = `${message}\nDiagnostic: ${info.name}: ${info.message}`;
  }

  function validateDirectory(handle) {
    if (
      !handle ||
      handle.kind !== "directory" ||
      typeof handle.getDirectoryHandle !== "function" ||
      typeof handle.getFileHandle !== "function"
    ) {
      throw new TypeError("The picker did not return a valid directory handle.");
    }
    if (
      typeof handle.queryPermission !== "function" ||
      typeof handle.requestPermission !== "function"
    ) {
      throw new DOMException(
        "queryPermission/requestPermission are unavailable on the selected handle.",
        "NotSupportedError",
      );
    }
  }

  async function readWritePermission(handle) {
    const permission = await handle.queryPermission({ mode: "readwrite" });
    if (!["granted", "prompt", "denied"].includes(permission)) {
      throw new Error(`Unexpected write permission state: ${String(permission)}`);
    }
    state.permission = permission;
    return permission;
  }

  function waitForWritePermission() {
    state.phase = "awaiting-permission";
    const folder = state.selectedHandle?.name || "selected folder";
    status.textContent =
      state.permission === "denied"
        ? `Selected: ${folder}. Write permission was not granted; no downloads have started.\n` +
          "Review the browser's file-access setting for this site, retry permission explicitly, or choose another folder. The script will not repeatedly prompt you."
        : `Selected: ${folder}. Click Grant write access & export, then approve the browser's file-editing prompt.\n` +
          "Export starts automatically after permission and the write test succeed.";
  }

  async function verifyDirectoryWrite(dir) {
    // Verify a committed write using a temporary file inside this run's directory.
    const name = `.evoweb-write-test-${crypto.randomUUID()}.tmp`;
    const contents = `Evo-Web write test ${crypto.randomUUID()}\n`;
    let stream = null,
      created = false,
      removed = false;
    try {
      const file = await dir.getFileHandle(name, { create: true });
      created = true;
      stream = await file.createWritable();
      await stream.write(contents);
      await stream.close();
      stream = null;
      if ((await (await file.getFile()).text()) !== contents) {
        throw new Error("Write test read-back did not match the data written.");
      }
      await dir.removeEntry(name);
      removed = true;
    } finally {
      if (stream) {
        try {
          await stream.abort();
        } catch {}
      }
      if (created && !removed) {
        try {
          await dir.removeEntry(name);
        } catch (cleanupError) {
          rememberStartupError("write-test-cleanup", cleanupError);
        }
      }
    }
  }

  stop.onclick = () => {
    state.stop();
    refreshControls();
    status.textContent = "Stopping; saving partial reports...";
  };

  start.onclick = async (event) => {
    if (state.busy || state.running) return;
    state.busy = true; // Lock before opening any dialog; prevents duplicate starts.
    state.phase = "picking";
    state.selectedHandle = null; // Never fall back to an old folder after cancellation.
    state.permission = "unknown";
    state.lastError = null;
    refreshControls();
    let stage = "pick-directory";
    try {
      requireUserClick(event);
      status.textContent = "Choose a dedicated destination folder in the browser dialog...";
      // Deliberately do not combine selection and write authorization. No fixed
      // startIn or remembered picker ID is imposed. No await occurs before this.
      const selected = await window.showDirectoryPicker({ mode: "read" });
      stage = "validate-directory";
      validateDirectory(selected);
      state.selectedHandle = selected;
      state.phase = "checking-permission";
      stage = "query-write-permission";
      status.textContent = `Selected: ${selected.name}. Checking write permission...`;
      if ((await readWritePermission(selected)) !== "granted") {
        waitForWritePermission();
        return; // A separate real click supplies fresh activation for the prompt.
      }
      stage = "preflight";
      await runExport(selected);
    } catch (error) {
      showStartupError(stage, error);
    } finally {
      state.busy = false;
      refreshControls();
    }
  };

  authorize.onclick = async (event) => {
    if (state.busy || state.running || !state.selectedHandle) return;
    state.busy = true;
    state.phase = "authorizing";
    state.lastError = null;
    refreshControls();
    let stage = "request-write-permission";
    try {
      requireUserClick(event);
      const selected = state.selectedHandle;
      status.textContent = `Approve file-editing access to ${selected.name} in the browser prompt...`;
      // Request permission before awaiting anything that would lose user activation.
      const permission = await selected.requestPermission({ mode: "readwrite" });
      if (!["granted", "prompt", "denied"].includes(permission)) {
        throw new Error(`Unexpected permission result: ${String(permission)}`);
      }
      state.permission = permission;
      if (permission !== "granted") {
        waitForWritePermission();
        return;
      }
      stage = "query-write-permission";
      if ((await readWritePermission(selected)) !== "granted") {
        waitForWritePermission();
        return;
      }
      stage = "preflight";
      await runExport(selected);
    } catch (error) {
      showStartupError(stage, error);
    } finally {
      state.busy = false;
      refreshControls();
    }
  };

  async function runExport(selected) {
    // Permission has been verified by the caller. File operations can still fail
    // (revocation, disk errors, OS restrictions), so preflight is separate from
    // the export loop and must complete before the first network request.
    state.phase = "preflight";
    state.running = false;
    state.stopRequested = false;
    state.haltReason = null;
    state.lastRequestError = null;
    rootHandle = null;
    rootName = null;
    lastFinished = 0;
    state.report = null;
    status.textContent = `Selected: ${selected.name}. Verifying file creation, writing, and cleanup...`;
    const title = cleanText(
      document.querySelector("h1.p-title-value")?.textContent || document.title.replace(/\|.*/, ""),
    );
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    rootName = `thread-${THREAD.id}_${safeName(title, 35)}_${stamp}_${crypto.randomUUID().slice(0, 8)}`;
    const report = (state.report = {
      version: 1,
      exporterVersion: state.version,
      title,
      url: pageURL(1),
      startedAt: new Date().toISOString(),
      updatedAt: null,
      status: "initializing",
      selectedDirectory: selected.name,
      exportDirectory: rootName,
      pathBase: "selected-directory",
      config: { ...CONFIG },
      attachmentTransport: state.transport,
      directoryAccess: { mode: "readwrite", permission: state.permission, writeTestPassed: false },
      maxPage: Math.max(THREAD.page, discoverMaxPage(document, location.href)),
      pagesOK: [],
      posts: [],
      errors: [],
      haltReason: null,
    });
    try {
      rootHandle = await selected.getDirectoryHandle(rootName, { create: true });
      await verifyDirectoryWrite(rootHandle);
      report.directoryAccess.writeTestPassed = true;
      report.directoryAccess.verifiedAt = new Date().toISOString();
      await checkpoint(); // Both report writes must also commit before downloads.
    } catch (error) {
      report.status = "not-started";
      report.errors.push({ stage: "preflight", error: `${error.name}: ${error.message}` });
      throw error; // The picker/controller shows a recoverable startup diagnostic.
    }
    state.running = true;
    state.phase = "running";
    report.status = "running";
    refreshControls();
    const seen = new Set();
    try {
      for (let p = 1; p <= Math.min(report.maxPage, CONFIG.MAX_PAGES); p++) {
        checkStop();
        status.textContent = `Page ${p}/${report.maxPage}; ${report.posts.length} posts exported`;
        const base = pageURL(p);
        let pagePosts;
        try {
          const doc = await request(base, "page", async (response) =>
            parseHTML(await response.text()),
          );
          const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
          if (canonical && !sameThread(threadInfo(canonical, documentBase(doc, base))))
            throw new Error("Response is not the requested thread");
          const active = cleanText(
            doc.querySelector(".pageNav-page--current")?.textContent,
          ).replace(/,/g, "");
          if (/^\d+$/.test(active) && Number(active) !== p)
            throw new Error(`Wrong page received: expected ${p}, got ${active}`);
          const nodes = [...doc.querySelectorAll("article.message")].filter((el) => postBody(el));
          if (!nodes.length)
            throw new Error("No readable posts found; possible login, challenge or changed markup");
          report.maxPage = Math.max(report.maxPage, discoverMaxPage(doc, base));
          pagePosts = nodes.map((node, i) =>
            extractPost(node, p, i, base, documentBase(doc, base)),
          );
          if (pagePosts.every((post) => seen.has(post.key)))
            throw new Error(
              "Page contains only already-exported posts; not counted as a successful page",
            );
          // Record all new page text before downloading its files.
          pagePosts = pagePosts.filter((post) => {
            if (seen.has(post.key)) return false;
            seen.add(post.key);
            report.posts.push(post);
            return true;
          });
          report.pagesOK.push(p);
        } catch (e) {
          report.errors.push({
            stage: "page",
            page: p,
            url: base,
            error: `${e.name}: ${e.message}`,
          });
          console.warn(`Page ${p}:`, e);
          if (state.stopRequested || state.haltReason) break;
          await checkpoint();
          continue;
        }
        for (const post of pagePosts) {
          for (const attachment of post.attachments) {
            checkStop();
            if (attachment.status !== "pending") continue;
            status.textContent = `Page ${p}/${report.maxPage}; post ${post.floor || post.key}; attachment ${attachment.id}`;
            await saveAttachment(attachment, post);
          }
        }
        await checkpoint(); // Completed pages survive a later interruption.
      }
    } catch (e) {
      report.errors.push({ stage: "run", error: `${e.name}: ${e.message}` });
    } finally {
      for (const post of report.posts)
        for (const a of post.attachments) {
          if (a.status === "pending") a.status = "not-attempted";
        }
      report.haltReason = state.haltReason || (state.stopRequested ? "Stopped by user" : null);
      summarizeReport(report);
      try {
        if (!rootHandle) throw new Error("No writable export directory was created");
        await checkpoint();
        status.textContent =
          `${report.status}: ${report.posts.length} posts, ${report.summary.savedAttachments} files, ` +
          `${report.summary.unavailableAttachments} unavailable, ${report.summary.attachmentIssues} failed/incomplete attachments. ` +
          `Reports: ${rootName}/thread.txt and manifest.json`;
        console.log("Export reports saved:", report);
      } catch (e) {
        status.textContent = `Report write failed: ${e.message}. The in-memory report is window.${KEY}.report.`;
        console.error("Report write failed. In-memory report:", report, e);
      }
      state.running = false;
      state.phase = "completed";
      refreshControls();
      // Choose again to create a fresh run directory; previous exports stay intact.
    }
  }
  refreshControls();
  console.log(
    `Evo-Web Thread Exporter v${VERSION} ready. Click 'Choose folder & export'; grant write access if asked.`,
  );
})();
