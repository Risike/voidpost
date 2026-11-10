// Minimal dependency-free MIME parser: enough to read real-world mail
// (multipart, base64, quoted-printable, RFC 2047 headers) without pulling in
// a mail library.
//
// Raw messages are handled as latin1 strings, i.e. one character per byte, so
// 8-bit parts survive the round trip and can be decoded to text afterwards.

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g;

export function parseMessage(rawInput) {
  const raw = typeof rawInput === "string" ? rawInput : rawInput.toString("latin1");
  const entity = splitEntity(raw);

  const out = {
    sender: "",
    senderName: null,
    subject: "(no subject)",
    text: null,
    html: null,
    attachments: 0,
  };

  collect(entity, 0, out);

  const from = parseAddress(decodeWords(entity.headers.from || ""));
  out.sender = from.address;
  out.senderName = from.name;

  const subject = decodeWords(entity.headers.subject || "").replace(/\s+/g, " ").trim();
  if (subject) out.subject = subject;

  if (out.text !== null) {
    out.text = out.text.replace(/\r\n/g, "\n").trim();
    if (!out.text) out.text = null;
  }
  if (out.html !== null && !out.html.trim()) out.html = null;
  return out;
}

/** Build a short single-line preview from whichever body we have. */
export function makePreview(text, html) {
  let source = text || "";
  if (!source && html) {
    source = html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }
  return source.replace(/\s+/g, " ").trim().slice(0, 180);
}

export function parseAddress(value) {
  if (!value) return { name: null, address: "" };
  const angled = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (angled) {
    return { name: angled[1].trim() || null, address: angled[2].trim() };
  }
  const bare = /<?([^\s<>]+@[^\s<>]+)>?/.exec(value);
  return { name: null, address: bare ? bare[1] : value.trim() };
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

function splitEntity(raw) {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match) return { headers: parseHeaders(raw), body: "" };
  const head = raw.slice(0, match.index);
  const body = raw.slice(match.index + match[0].length);
  return { headers: parseHeaders(head), body };
}

function parseHeaders(block) {
  const headers = {};
  let lastName = null;
  for (const line of block.split(/\r\n|\n/)) {
    if (/^[ \t]/.test(line)) {
      if (lastName) headers[lastName] += " " + line.trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!(name in headers)) headers[name] = value;
    lastName = name;
  }
  return headers;
}

function collect(entity, depth, out) {
  const contentType = parseStructured(entity.headers["content-type"] || "text/plain");
  const disposition = parseStructured(entity.headers["content-disposition"] || "");
  const mediaType = contentType.value.toLowerCase();
  const transferEncoding = (entity.headers["content-transfer-encoding"] || "")
    .trim()
    .toLowerCase();

  if (mediaType.startsWith("multipart/") && contentType.params.boundary) {
    for (const part of splitMultipart(entity.body, contentType.params.boundary)) {
      collect(splitEntity(part), depth + 1, out);
    }
    return;
  }

  const filename = contentType.params.name || disposition.params.filename || "";
  const isAttachment =
    disposition.value.toLowerCase() === "attachment" || Boolean(filename);

  if (isAttachment) {
    out.attachments += 1;
    return;
  }

  if (mediaType === "text/html") {
    if (!out.html) out.html = decodePart(entity.body, transferEncoding, contentType.params.charset);
    return;
  }
  if (mediaType === "text/plain") {
    if (!out.text) out.text = decodePart(entity.body, transferEncoding, contentType.params.charset);
    return;
  }
  if (mediaType !== "") out.attachments += 1;
}

function splitMultipart(body, boundary) {
  const marker = "--" + boundary;
  const terminator = marker + "--";
  const parts = [];
  let current = null;

  for (const line of body.split(/\r\n|\n/)) {
    const trimmed = line.replace(/\s+$/, "");
    if (trimmed === marker || trimmed === terminator) {
      if (current) parts.push(current.join("\r\n"));
      current = trimmed === terminator ? null : [];
      if (trimmed === terminator) break;
      continue;
    }
    if (current) current.push(line);
  }
  if (current && current.length > 0) parts.push(current.join("\r\n"));
  return parts;
}

// ---------------------------------------------------------------------------
// Values and parameters
// ---------------------------------------------------------------------------

function parseStructured(value) {
  if (!value) return { value: "", params: {} };
  const segments = splitParams(value);
  const main = decodeWords((segments.shift() || "").trim());
  const params = {};

  for (const segment of segments) {
    const equals = segment.indexOf("=");
    if (equals === -1) continue;
    let key = segment.slice(0, equals).trim().toLowerCase();
    let raw = segment.slice(equals + 1).trim();

    if (key.endsWith("*")) {
      key = key.slice(0, -1);
      params[key] = decodeRfc2231(raw);
      continue;
    }
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      raw = raw.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    params[key] = decodeWords(raw);
  }

  return { value: main, params };
}

function splitParams(value) {
  const segments = [];
  let buffer = "";
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '"' ) quoted = !quoted;
    if (char === "\\" && quoted && i + 1 < value.length) {
      buffer += char + value[i + 1];
      i += 1;
      continue;
    }
    if (char === ";" && !quoted) {
      segments.push(buffer);
      buffer = "";
      continue;
    }
    buffer += char;
  }
  segments.push(buffer);
  return segments;
}

function decodeRfc2231(value) {
  const match = /^([^']*)'[^']*'(.*)$/.exec(value);
  const charset = match && match[1] ? match[1] : "utf-8";
  const encoded = match ? match[2] : value;
  const bytes = new Uint8Array(encoded.length);
  let length = 0;
  for (let i = 0; i < encoded.length; i += 1) {
    if (encoded[i] === "%" && i + 2 < encoded.length) {
      const byte = Number.parseInt(encoded.slice(i + 1, i + 3), 16);
      if (Number.isFinite(byte)) {
        bytes[length++] = byte;
        i += 2;
        continue;
      }
    }
    bytes[length++] = encoded.charCodeAt(i) & 0xff;
  }
  return decodeBytes(bytes.subarray(0, length), charset);
}

// ---------------------------------------------------------------------------
// RFC 2047 encoded words
// ---------------------------------------------------------------------------

function decodeWords(input) {
  if (!input || !input.includes("=?")) return input;

  let result = "";
  let cursor = 0;
  let previousEncoded = false;
  let match;
  ENCODED_WORD.lastIndex = 0;

  while ((match = ENCODED_WORD.exec(input)) !== null) {
    let between = input.slice(cursor, match.index);
    // Whitespace that only separates two encoded words is not real content.
    if (previousEncoded && /^[ \t\r\n]*$/.test(between)) between = "";
    result += between;
    result += decodeEncodedWord(match[1], match[2], match[3]);
    previousEncoded = true;
    cursor = match.index + match[0].length;
  }

  return result + input.slice(cursor);
}

function decodeEncodedWord(charset, encoding, text) {
  const label = charset.split("*")[0];
  if (/^b$/i.test(encoding)) {
    return decodeBytes(new Uint8Array(Buffer.from(text, "base64")), label);
  }
  const bytes = new Uint8Array(text.length);
  let length = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "_") {
      bytes[length++] = 0x20;
      continue;
    }
    if (char === "=" && i + 2 < text.length) {
      const byte = Number.parseInt(text.slice(i + 1, i + 3), 16);
      if (Number.isFinite(byte)) {
        bytes[length++] = byte;
        i += 2;
        continue;
      }
    }
    bytes[length++] = char.charCodeAt(0) & 0xff;
  }
  return decodeBytes(bytes.subarray(0, length), label);
}

// ---------------------------------------------------------------------------
// Transfer encodings and charsets
// ---------------------------------------------------------------------------

function decodePart(body, transferEncoding, charset) {
  let bytes;
  if (transferEncoding === "base64") {
    bytes = new Uint8Array(Buffer.from(body.replace(/\s+/g, ""), "base64"));
  } else if (transferEncoding === "quoted-printable") {
    bytes = decodeQuotedPrintable(body);
  } else {
    bytes = latin1Bytes(body);
  }
  return decodeBytes(bytes, charset);
}

function decodeQuotedPrintable(input) {
  const bytes = new Uint8Array(input.length);
  let length = 0;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === "=") {
      if (input[i + 1] === "\r" && input[i + 2] === "\n") {
        i += 2;
        continue;
      }
      if (input[i + 1] === "\n") {
        i += 1;
        continue;
      }
      if (i + 2 < input.length) {
        const byte = Number.parseInt(input.slice(i + 1, i + 3), 16);
        if (Number.isFinite(byte)) {
          bytes[length++] = byte;
          i += 2;
          continue;
        }
      }
    }
    bytes[length++] = char.charCodeAt(0) & 0xff;
  }
  return bytes.subarray(0, length);
}

function latin1Bytes(input) {
  const bytes = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 1) bytes[i] = input.charCodeAt(i) & 0xff;
  return bytes;
}

function decodeBytes(bytes, charset) {
  const label = normalizeCharset(charset);
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function normalizeCharset(charset) {
  if (!charset) return "utf-8";
  const label = String(charset).replace(/["']/g, "").trim().toLowerCase().split("*")[0];
  if (!label || label === "us-ascii" || label === "ascii") return "utf-8";
  if (label === "utf8") return "utf-8";
  if (label === "latin1" || label === "latin-1") return "windows-1252";
  return label;
}
