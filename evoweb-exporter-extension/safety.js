// Shared by the background module and the isolated content script.
(() => {
  "use strict";

  const policy = Object.freeze({ id: "basic-attachment-v1", maxBytes: 64 * 1024 * 1024 });
  const riskyExtension =
    /(?:^|[.-])(?:exe|dll|com|scr|cpl|msi|msp|mst|msix|msixbundle|appx|appxbundle|bat|cmd|ps1|psm1|psd1|vbs|vbe|js|mjs|cjs|jse|wsf|wsh|sct|hta|sh|bash|zsh|ksh|fish|command|desktop|py|pyw|pl|rb|php|jar|class|wasm|lnk|url|scf|reg|inf|chm|application|gadget|iso|img|vhd|vhdx|dmg|pkg|app|docm|dotm|xlsm|xltm|xlam|xll|pptm|potm|ppam|ppsm|sldm|html?|xhtml|svg|svgz)(?=$|[.\s:])/i;
  const riskyType =
    /^(?:(?:text|application)\/(?:html|xhtml\+xml|javascript|x-javascript|ecmascript)|image\/svg\+xml|application\/(?:x-msdownload|x-msdos-program|x-dosexec|vnd\.microsoft\.portable-executable|x-ms-installer|x-executable|x-sharedlib|x-mach-binary|java-archive|x-java-archive|x-sh|x-csh|x-bat|x-powershell|hta|x-ms-shortcut|wasm)|text\/(?:x-shellscript|x-python|vbscript))$/i;
  // Construct the harmless test signature at runtime; never write a test file to disk.
  const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

  function block(code, reason, details = {}) {
    const error = new Error(reason);
    error.name = "AttachmentSecurityError";
    error.securityDiagnostic = { policy: policy.id, code, reason, ...details };
    throw error;
  }

  function decode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function checkName(value, source) {
    if (!value) return;
    const name = decode(String(value)).normalize("NFKC");
    if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name)) {
      block("obfuscated-filename", "Filename contains control or direction-changing characters.", {
        stage: "metadata",
        source,
      });
    }
    const match = name.match(riskyExtension);
    if (match) {
      block("dangerous-extension", "Executable, active-content, or other high-risk filename.", {
        stage: "metadata",
        source,
        extension: match[0].replace(/^[.-]/, "").toLowerCase(),
        filename: name.slice(0, 240),
      });
    }
  }

  function urlName(raw) {
    if (!raw) return "";
    const url = new URL(raw);
    const route =
      url.pathname === "/index.php"
        ? url.search.match(/^\?attachments\/([^&]*)/)?.[1]
        : url.pathname;
    let name = (route || "").split("/").filter(Boolean).pop() || "";
    if (url.pathname.startsWith("/attachments/") || route !== url.pathname)
      name = name.replace(/(?:^|\.)[1-9]\d*$/, "");
    return name;
  }

  function checkMetadata({ headers, requestedUrl, finalUrl, filenames = [] }) {
    checkName(urlName(requestedUrl), "requested-url");
    checkName(urlName(finalUrl), "final-url");
    // Check every supplied filename, including filename and filename* when both exist.
    const disposition = headers.get("content-disposition") || "";
    const parameters = /(?:^|;)\s*filename(\*)?\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))/gi;
    for (const match of disposition.matchAll(parameters)) {
      let name = (match[2] ?? match[3]).trim().replace(/\\(["\\])/g, "$1");
      if (match[1]) name = name.replace(/^[^']*'[^']*'/, "");
      checkName(name, match[1] ? "content-disposition:filename*" : "content-disposition:filename");
    }
    for (const { name, source } of filenames) checkName(name, source);
    const contentType = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (riskyType.test(contentType) || /macroenabled/.test(contentType)) {
      block("dangerous-content-type", "Executable or active-content MIME type rejected.", {
        stage: "metadata",
        contentType,
      });
    }
    const length = headers.get("content-length");
    if (length && /^\d+$/.test(length.trim()) && Number(length) > policy.maxBytes) {
      block("size-limit", "Attachment exceeds the in-memory security inspection limit.", {
        stage: "metadata",
        declaredBytes: length,
        maxBytes: policy.maxBytes,
      });
    }
  }

  function createScanner() {
    const prefix = new Uint8Array(4096);
    let prefixLength = 0,
      bytes = 0,
      tail = "";
    function rejectSignature(signature) {
      block("dangerous-signature", "Executable or active-content file signature rejected.", {
        stage: "body",
        signature,
        bytesInspected: bytes,
      });
    }
    function inspectPrefix() {
      const starts = (...values) =>
        prefixLength >= values.length && values.every((value, i) => prefix[i] === value);
      if (starts(0x4d, 0x5a)) rejectSignature("DOS/Windows executable (MZ)");
      if (starts(0x7f, 0x45, 0x4c, 0x46)) rejectSignature("ELF executable");
      if (
        starts(0xfe, 0xed, 0xfa, 0xce) ||
        starts(0xfe, 0xed, 0xfa, 0xcf) ||
        starts(0xce, 0xfa, 0xed, 0xfe) ||
        starts(0xcf, 0xfa, 0xed, 0xfe) ||
        starts(0xca, 0xfe, 0xba, 0xbe) ||
        starts(0xbe, 0xba, 0xfe, 0xca) ||
        starts(0xca, 0xfe, 0xba, 0xbf) ||
        starts(0xbf, 0xba, 0xfe, 0xca)
      )
        rejectSignature("Mach-O executable or Java class");
      if (starts(0, 0x61, 0x73, 0x6d)) rejectSignature("WebAssembly executable");
      if (starts(0x4c, 0, 0, 0, 1, 0x14, 2, 0)) rejectSignature("Windows shortcut");
      if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))
        rejectSignature("OLE compound document/installer (contents not inspected)");
      const encoding = starts(0xff, 0xfe) ? "utf-16le" : starts(0xfe, 0xff) ? "utf-16be" : "utf-8";
      const text = new TextDecoder(encoding).decode(prefix.subarray(0, prefixLength));
      if (/^\s*#!/.test(text)) rejectSignature("Script interpreter directive");
      if (/^\s*@?echo\s+off\b/i.test(text)) rejectSignature("Windows command script");
      // Include XML declarations/comments before an HTML or SVG root in the prefix.
      if (/<(?:!doctype\s+html|html\b|head\b|body\b|script\b|svg\b|hta:application\b)/i.test(text))
        rejectSignature("HTML, SVG, or script content");
    }
    return {
      push(chunk) {
        bytes += chunk.byteLength;
        if (bytes > policy.maxBytes) {
          block("size-limit", "Attachment exceeds the in-memory security inspection limit.", {
            stage: "body",
            bytesInspected: bytes,
            maxBytes: policy.maxBytes,
          });
        }
        if (prefixLength < prefix.length) {
          const part = chunk.subarray(0, prefix.length - prefixLength);
          prefix.set(part, prefixLength);
          prefixLength += part.length;
          inspectPrefix();
        }
        // A bounded overlap finds the signature anywhere, even across chunk boundaries.
        const text = tail + new TextDecoder("latin1").decode(chunk);
        const index = text.indexOf(eicar);
        if (index !== -1) {
          block("eicar-test-signature", "EICAR antivirus test signature detected.", {
            stage: "body",
            offset: bytes - chunk.byteLength - tail.length + index,
            bytesInspected: bytes,
          });
        }
        tail = text.slice(-(eicar.length - 1));
      },
      finish() {
        return { policy: policy.id, result: "passed-basic-checks", bytesInspected: bytes };
      },
    };
  }

  globalThis.evoAttachmentSafety = Object.freeze({ policy, checkMetadata, createScanner });
})();
