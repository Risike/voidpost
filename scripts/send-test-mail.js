// Send a test message to the local SMTP listener.
//   bun run send-test-mail [rcpt@domain] [subject]

import net from "node:net";

const host = process.env.SMTP_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.SMTP_PORT || "2525", 10);
const domain = process.env.DOMAIN || "mail.example.com";

const to = process.argv[2] || `hello@${domain}`;
const subject = process.argv[3] || "Test message";
const from = "sender@example.org";

const boundary = "b1_" + Math.random().toString(36).slice(2);
const html = `<div style="font-family:sans-serif;padding:16px">
  <h1 style="margin:0 0 8px">Hello from the test client</h1>
  <p>This is the <strong>HTML</strong> part of a multipart message.</p>
  <p>It arrived through SMTP and was parsed by the server.</p>
</div>`;

const message = [
  `From: Test Sender <${from}>`,
  `To: ${to}`,
  `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
  `Date: ${new Date().toUTCString()}`,
  "MIME-Version: 1.0",
  `Content-Type: multipart/alternative; boundary="${boundary}"`,
  "",
  `--${boundary}`,
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Hello from the test client.",
  "",
  "This is the plain text part, quoted-printable encoded with an accent: caf=C3=A9.",
  "",
  `--${boundary}`,
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from(html).toString("base64").replace(/(.{76})/g, "$1\r\n"),
  "",
  `--${boundary}--`,
  "",
].join("\r\n");

const socket = net.connect(port, host);
socket.setEncoding("latin1");

let buffer = "";
const waiters = [];

socket.on("data", (chunk) => {
  buffer += chunk;
  flush();
});

socket.on("error", (error) => {
  console.error(`Connection failed: ${error.message}`);
  process.exit(1);
});

function flush() {
  while (waiters.length > 0) {
    const newline = buffer.indexOf("\r\n");
    if (newline === -1) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 2);
    // Skip continuation lines of a multi-line reply (250-...).
    if (line.length > 3 && line[3] === "-") continue;
    const waiter = waiters.shift();
    waiter(line);
  }
}

const read = () =>
  new Promise((resolve) => {
    waiters.push(resolve);
    flush();
  });

const send = (line) => socket.write(line + "\r\n");

const step = async (command) => {
  if (command) send(command);
  const reply = await read();
  console.log(`${command ? "> " + command : "< greeting"}  >>  ${reply}`);
  if (reply.startsWith("4") || reply.startsWith("5")) {
    throw new Error(`Server rejected the transaction: ${reply}`);
  }
  return reply;
};

try {
  await step(null);
  await step("EHLO test.local");
  await step(`MAIL FROM:<${from}>`);
  await step(`RCPT TO:<${to}>`);
  await step("DATA");
  socket.write(message.replace(/^\./gm, "..") + "\r\n.\r\n");
  console.log("> <message>  >>  " + (await read()));
  send("QUIT");
  socket.end();
  console.log(`Sent "${subject}" to ${to}`);
} catch (error) {
  console.error(error.message);
  socket.destroy();
  process.exit(1);
}
