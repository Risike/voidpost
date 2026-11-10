// SQLite storage (built into Bun, no native module to compile).
// One table for mail, one for settings, one index for mailbox lookups.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export const RETENTIONS = [
  { seconds: 300, label: "5 minutes" },
  { seconds: 600, label: "10 minutes" },
  { seconds: 900, label: "15 minutes" },
  { seconds: 1800, label: "30 minutes" },
  { seconds: 3600, label: "1 hour" },
  { seconds: 10800, label: "3 hours" },
  { seconds: 21600, label: "6 hours" },
  { seconds: 43200, label: "12 hours" },
  { seconds: 86400, label: "24 hours" },
  { seconds: 259200, label: "3 days" },
  { seconds: 604800, label: "7 days" },
  { seconds: 2592000, label: "30 days" },
  { seconds: 0, label: "Forever" },
];

export const DEFAULT_RETENTION = 3600;

mkdirSync(config.dataDir, { recursive: true });

const db = new Database(join(config.dataDir, "mail.sqlite"), { create: true });
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS mails (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    box          TEXT    NOT NULL,
    rcpt         TEXT    NOT NULL,
    sender       TEXT    NOT NULL,
    sender_name  TEXT,
    subject      TEXT    NOT NULL,
    received_at  INTEGER NOT NULL,
    size         INTEGER NOT NULL,
    preview      TEXT    NOT NULL DEFAULT '',
    text_body    TEXT,
    html_body    TEXT,
    attachments  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS mails_box_time ON mails (box, received_at DESC);
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS boxes (
    name         TEXT PRIMARY KEY,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS boxes_seen ON boxes (last_seen_at DESC);
`);

// An address is created by the first message delivered to it. Mail that predates
// the boxes table is imported once at startup so the list is complete.
db.exec(`
  INSERT OR IGNORE INTO boxes (name, created_at, last_seen_at)
  SELECT box, MIN(received_at), MAX(received_at) FROM mails GROUP BY box
`);

const insertStmt = db.prepare(
  `INSERT INTO mails (box, rcpt, sender, sender_name, subject, received_at, size, preview, text_body, html_body, attachments)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
);

const listStmt = db.prepare(
  `SELECT id, sender, sender_name, subject, received_at, size, preview, attachments,
          (html_body IS NOT NULL AND html_body <> '') AS has_html
   FROM mails
   WHERE box = ?1 AND received_at > ?2
   ORDER BY received_at DESC, id DESC
   LIMIT ?3`
);

const countStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM mails WHERE box = ?1 AND received_at > ?2`
);

const getStmt = db.prepare(
  `SELECT * FROM mails WHERE id = ?1 AND box = ?2 AND received_at > ?3`
);

// Only addresses that still hold unexpired mail are listed, so a mailbox never
// appears empty: it is gone as soon as its last message expires.
const boxesStmt = db.prepare(
  `SELECT b.name, b.created_at, b.last_seen_at, COUNT(m.id) AS n
   FROM boxes b
   JOIN mails m ON m.box = b.name AND m.received_at > ?1
   GROUP BY b.name
   ORDER BY b.last_seen_at DESC
   LIMIT ?2`
);

const deleteStmt = db.prepare(`DELETE FROM mails WHERE received_at <= ?1`);
const settingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?1`);
const settingUpsertStmt = db.prepare(
  `INSERT INTO settings (key, value) VALUES (?1, ?2)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

// Retention is cached so page views never hit the settings table.
let retentionCache = null;

export function getRetentionSeconds() {
  if (retentionCache != null) return retentionCache;
  const row = settingStmt.get("retention_seconds");
  const parsed = row ? Number.parseInt(row.value, 10) : NaN;
  retentionCache =
    Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETENTION;
  return retentionCache;
}

export function setRetentionSeconds(seconds) {
  const allowed = RETENTIONS.some((r) => r.seconds === seconds);
  if (!allowed) return false;
  settingUpsertStmt.run("retention_seconds", String(seconds));
  retentionCache = seconds;
  return true;
}

/** Timestamp before which mail is considered expired. 0 means "keep forever". */
export function cutoff() {
  const seconds = getRetentionSeconds();
  return seconds > 0 ? Date.now() - seconds * 1000 : 0;
}

const insertBoxStmt = db.prepare(
  `INSERT INTO boxes (name, created_at, last_seen_at) VALUES (?1, ?2, ?2)
   ON CONFLICT(name) DO UPDATE SET last_seen_at = excluded.last_seen_at`
);

// Storing a message and registering its address happen together: a message can
// never reference an address that is missing from the list.
const insertMailTx = db.transaction((mail) => {
  insertStmt.run(
    mail.box,
    mail.rcpt,
    mail.sender || "",
    mail.senderName || null,
    mail.subject || "(no subject)",
    mail.receivedAt,
    mail.size,
    mail.preview || "",
    mail.text || null,
    mail.html || null,
    mail.attachments || 0
  );
  insertBoxStmt.run(mail.box, mail.receivedAt);
});

export function insertMail(mail) {
  insertMailTx(mail);
}

export function listMails(box, limit = 200) {
  return listStmt.all(box, cutoff(), limit);
}

export function countMails(box) {
  return countStmt.get(box, cutoff()).n;
}

export function getMail(id, box) {
  return getStmt.get(id, box, cutoff()) ?? null;
}

/** Addresses that currently hold mail, newest activity first, with counts. */
export function listBoxes(limit = 100) {
  return boxesStmt.all(cutoff(), limit);
}

// An address exists only while it has mail: once nothing unexpired is left, the
// row goes away so the address list cannot fill up with empty mailboxes.
const pruneStmt = db.prepare(
  `DELETE FROM boxes
   WHERE NOT EXISTS (
     SELECT 1 FROM mails m WHERE m.box = boxes.name AND m.received_at > ?1
   )`
);

export function pruneEmptyBoxes() {
  return pruneStmt.run(cutoff()).changes;
}

/** Delete everything older than the current retention window. */
export function sweep() {
  pruneEmptyBoxes();
  const seconds = getRetentionSeconds();
  if (seconds <= 0) return 0;
  return deleteStmt.run(Date.now() - seconds * 1000).changes;
}
