// Server-rendered HTML. No client framework, no build step.

import { RETENTIONS, getRetentionSeconds } from "./db.js";
import { config } from "./config.js";

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(timestamp) {
  return new Date(timestamp).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function retentionLabel() {
  const seconds = getRetentionSeconds();
  const found = RETENTIONS.find((entry) => entry.seconds === seconds);
  return found ? found.label : `${Math.round(seconds / 60)} minutes`;
}

export function timeLeft(timestamp) {
  const seconds = getRetentionSeconds();
  if (seconds === 0) return "kept forever";
  const remaining = Math.max(0, timestamp + seconds * 1000 - Date.now());
  const minutes = Math.ceil(remaining / 60000);
  if (minutes < 60) return `expires in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `expires in ${hours}h`;
  return `expires in ${Math.floor(hours / 24)}d`;
}

function layout({ title, body, signedIn = true, box = null, count = null }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Voidpost</title>
<link rel="stylesheet" href="/app.css">
${box ? `<script src="/app.js" defer></script>` : ""}
</head>
<body${box ? ` data-box="${esc(box)}" data-count="${count ?? 0}"` : ""}>
<header class="top">
  <a class="brand" href="/m"><span class="mark">◍</span> Voidpost</a>
  <nav class="nav">
    ${signedIn
      ? `<a href="/m">Inbox</a><a href="/settings">Settings</a>
         <form method="post" action="/logout" class="inline"><button class="link" type="submit">Sign out</button></form>`
      : ""}
  </nav>
</header>
<main class="wrap">
${body}
</main>
<footer class="foot">
  <span>${esc(config.domain)}</span>
  <span>Mail is deleted after ${esc(retentionLabel().toLowerCase())}</span>
</footer>
</body>
</html>`;
}

export function loginPage({ error = null, domain }) {
  return layout({
    title: "Sign in",
    signedIn: false,
    body: `
<section class="login">
  <div class="card">
    <div class="eyebrow">Disposable inbox</div>
    <h1>Sign in</h1>
    <p class="muted">Any address at <strong>@${esc(domain)}</strong> receives mail. Enter the server password to read it.</p>
    <form method="post" action="/login" class="stack">
      <label class="field">
        <span>Password</span>
        <input type="password" name="password" autocomplete="current-password" autofocus required>
      </label>
      ${error ? `<p class="error">${esc(error)}</p>` : ""}
      <button class="btn primary" type="submit">Unlock inbox</button>
    </form>
  </div>
</section>`,
  });
}

export function homePage({ boxes, error = null }) {
  return layout({
    title: "Inbox",
    body: `
<section class="hero">
  <div>
    <h1>Open a mailbox</h1>
    <p class="muted">Every address at <strong>@${esc(config.domain)}</strong> is live. The first message delivered to a name creates that mailbox; it disappears again once its last message expires.</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
  </div>
</section>

<section class="card">
  <form method="post" action="/m" class="open-form">
    <div class="input-group">
      <input type="text" name="box" placeholder="newsletter" autocomplete="off" autocapitalize="none" spellcheck="false" required>
      <span class="suffix">@${esc(config.domain)}</span>
    </div>
    <button class="btn primary" type="submit">Open inbox</button>
  </form>
</section>

<section class="section">
  <h2>Your addresses</h2>
  ${
    boxes.length === 0
      ? `<div class="card empty">
    <p class="empty-title">No addresses yet</p>
    <p class="muted">Send a message to anything@${esc(config.domain)}. The address is created on delivery and appears here on its own.</p>
  </div>`
      : `<ul class="address-list">
    ${boxes
      .map(
        (entry) => `<li>
      <a class="address-item" href="/m/${esc(encodeURIComponent(entry.name))}">
        <span class="address-name">${esc(entry.name)}<span>@${esc(config.domain)}</span></span>
        <span class="address-meta">
          <span class="badge">${entry.n}</span>
          <span class="muted small">${entry.n} message${entry.n === 1 ? "" : "s"} · ${esc(timeAgo(entry.last_seen_at))}</span>
        </span>
      </a>
    </li>`
      )
      .join("")}
  </ul>
  <p class="hint">Addresses are removed as soon as their last message expires. <strong>${boxes.reduce((total, entry) => total + entry.n, 0)}</strong> message${boxes.reduce((total, entry) => total + entry.n, 0) === 1 ? "" : "s"} waiting across ${boxes.length} address${boxes.length === 1 ? "" : "es"}.</p>`
  }
</section>
`,
  });
}

export function mailboxPage({ box, mails }) {
  const address = `${box}@${config.domain}`;
  return layout({
    title: `${address}`,
    box,
    count: mails.length,
    body: `
<section class="page-head">
  <div>
    <div class="eyebrow"><a href="/m">Inbox</a> /</div>
    <h1 class="address">${esc(box)}<span>@${esc(config.domain)}</span></h1>
  </div>
  <div class="actions">
    <button class="btn" type="button" data-copy="${esc(address)}">Copy address</button>
    ${mails.length > 0
      ? `<form method="post" action="/m/${esc(encodeURIComponent(box))}/delete" class="inline">
      <button class="btn danger" type="submit">Delete all</button>
    </form>`
      : ""}
  </div>
</section>

${
  mails.length === 0
    ? `<div class="card empty">
    <p class="empty-title">Waiting for mail</p>
    <p class="muted">Send anything to <strong>${esc(address)}</strong>. Messages appear here on their own.</p>
  </div>`
    : `<ul class="mail-list">
  ${mails
    .map(
      (mail) => `<li>
    <a class="mail-row" href="/m/${esc(encodeURIComponent(box))}/${mail.id}">
      <span class="mail-from">
        <span class="from-name">${esc(mail.sender_name || mail.sender || "Unknown sender")}</span>
        <span class="from-addr">${esc(mail.sender || "")}</span>
      </span>
      <span class="mail-main">
        <span class="mail-subject">${esc(mail.subject)}</span>
        <span class="mail-preview">${esc(mail.preview || "")}</span>
      </span>
      <span class="mail-meta">
        <span>${esc(timeAgo(mail.received_at))}</span>
        <span class="muted small">${esc(timeLeft(mail.received_at))}</span>
      </span>
    </a>
  </li>`
    )
    .join("")}
</ul>`
}

<p class="hint">Showing the newest ${mails.length} message${mails.length === 1 ? "" : "s"} · retention ${esc(retentionLabel().toLowerCase())} · <a href="/settings">change</a></p>
`,
  });
}

export function messagePage({ box, mail }) {
  const hasHtml = Boolean(mail.html_body && mail.html_body.trim());
  const hasText = Boolean(mail.text_body && mail.text_body.trim());
  const base = `/m/${encodeURIComponent(box)}/${mail.id}`;

  return layout({
    title: mail.subject,
    box,
    count: null,
    body: `
<section class="page-head">
  <div>
    <div class="eyebrow"><a href="/m/${esc(encodeURIComponent(box))}">${esc(box)}@${esc(config.domain)}</a> /</div>
    <h1 class="subject">${esc(mail.subject)}</h1>
  </div>
  <div class="actions">
    <a class="btn" href="/m/${esc(encodeURIComponent(box))}">Back to inbox</a>
    <form method="post" action="${esc(base)}/delete" class="inline">
      <button class="btn danger" type="submit">Delete</button>
    </form>
  </div>
</section>

<dl class="meta-grid card">
  <div><dt>From</dt><dd>${esc(mail.sender_name ? `${mail.sender_name} <${mail.sender}>` : mail.sender || "unknown")}</dd></div>
  <div><dt>To</dt><dd>${esc(mail.rcpt)}</dd></div>
  <div><dt>Received</dt><dd>${esc(formatDate(mail.received_at))}</dd></div>
  <div><dt>Size</dt><dd>${esc(formatSize(mail.size))}${mail.attachments > 0 ? ` · ${mail.attachments} attachment${mail.attachments === 1 ? "" : "s"} (not stored)` : ""}</dd></div>
</dl>

${
  hasHtml
    ? `<div class="body-frame">
  <iframe class="mail-html" src="${esc(base)}/html" sandbox referrerpolicy="no-referrer" title="Message body" loading="lazy"></iframe>
</div>`
    : ""
}

${hasText || !hasHtml
  ? `<details class="plain" ${hasHtml ? "" : "open"}>
  <summary>Plain text</summary>
  <pre class="mail-text">${esc(mail.text_body || "(This message has no readable body.)")}</pre>
</details>`
  : ""}
`,
  });
}

export function settingsPage({ saved = false }) {
  const current = getRetentionSeconds();
  return layout({
    title: "Settings",
    body: `
<section class="page-head">
  <div>
    <div class="eyebrow">Server</div>
    <h1>Settings</h1>
  </div>
</section>

<form method="post" action="/settings" class="card stack">
  <label class="field">
    <span>Delete mail after</span>
    <select name="retention">
      ${RETENTIONS.map(
        (entry) =>
          `<option value="${entry.seconds}"${entry.seconds === current ? " selected" : ""}>${esc(entry.label)}</option>`
      ).join("")}
    </select>
  </label>
  <p class="muted small">Applies to every mailbox, including messages already received. Expired mail is removed within a minute and cannot be recovered.</p>
  <div><button class="btn primary" type="submit">Save</button>${saved ? `<span class="saved">Saved</span>` : ""}</div>
</form>

<section class="card">
  <h2>Server</h2>
  <dl class="meta-grid flat">
    <div><dt>Domain</dt><dd>@${esc(config.domain)}</dd></div>
    <div><dt>SMTP</dt><dd>port ${config.smtpPort}</dd></div>
    <div><dt>Web</dt><dd>port ${config.port}</dd></div>
    <div><dt>Max message</dt><dd>${esc(formatSize(config.maxMessageBytes))}</dd></div>
  </dl>
</section>
`,
  });
}

export function errorPage({ status, message, signedIn = true }) {
  return layout({
    title: `Error ${status}`,
    signedIn,
    body: `
<section class="card empty">
  <p class="empty-title">${status}</p>
  <p class="muted">${esc(message)}</p>
  <p><a class="btn" href="/m">Back to inbox</a></p>
</section>`,
  });
}
