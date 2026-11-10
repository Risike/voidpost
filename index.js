// Entry point: one process runs the SMTP sink and the web interface.

import { config, validateConfig } from "./src/config.js";
import { sweep } from "./src/db.js";
import { startWebServer } from "./src/web.js";
import { startSmtpServer } from "./src/smtp.js";

validateConfig();

console.log(`Domain:  @${config.domain}`);
console.log(`Storage: ${config.dataDir}`);

const deleted = sweep();
if (deleted > 0) console.log(`Expired ${deleted} old message(s) at startup`);

const smtp = startSmtpServer({
  onMail({ recipients, sender, subject, size }) {
    const to = recipients.join(", ");
    console.log(`[mail] ${sender || "unknown"} -> ${to} (${size} B) "${subject}"`);
  },
});

const web = startWebServer();

// Retention is enforced by a cheap sweep every minute; reads also filter by the
// current window, so expiry is exact even between sweeps.
const timer = setInterval(() => {
  const removed = sweep();
  if (removed > 0) console.log(`[retention] removed ${removed} expired message(s)`);
}, 60_000);
timer.unref?.();

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down`);
  clearInterval(timer);
  smtp.close();
  web.stop(true);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
