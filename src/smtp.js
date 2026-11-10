// Catch-all SMTP receiver. Every address at the configured domain is accepted;
// messages for other domains are refused so this cannot be used as an open relay.
//
// Deliberately small: no TLS, no AUTH, no relay queue. Put it behind Postfix (or
// any MTA) if you need STARTTLS on port 25.

import net from "node:net";
import { config } from "./config.js";
import { insertMail } from "./db.js";
import { makePreview, parseMessage } from "./mime.js";

const MAX_LINE = 4096;
const MAX_RECIPIENTS = 50;

export function normalizeMailbox(value) {
  const box = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/.test(box) ? box : null;
}

export function startSmtpServer({ onMail = () => {} } = {}) {
  const server = net.createServer({ allowHalfOpen: false }, (socket) => {
    new SmtpSession(socket, onMail);
  });

  server.on("error", (error) => {
    console.error(`SMTP server error on port ${config.smtpPort}: ${error.message}`);
  });

  server.listen(config.smtpPort, config.host, () => {
    console.log(`SMTP  listening on ${config.host}:${config.smtpPort} (catch-all @${config.domain})`);
  });

  return server;
}

class SmtpSession {
  constructor(socket, onMail) {
    this.socket = socket;
    this.onMail = onMail;
    this.buffer = "";
    this.inData = false;
    this.mailFrom = null;
    this.recipients = [];
    this.tooBig = false;
    this.closed = false;

    socket.setEncoding("latin1");
    socket.setTimeout(120_000, () => {
      this.reply("421 4.4.2 Timeout, closing connection");
      socket.destroy();
    });
    socket.on("data", (chunk) => this.onChunk(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      this.closed = true;
    });

    this.reply(`220 ${config.domain} ESMTP Voidpost ready`);
  }

  reply(line) {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(line + "\r\n");
  }

  onChunk(chunk) {
    this.buffer += chunk;
    while (!this.closed) {
      if (this.inData) {
        if (!this.consumeData()) return;
      } else if (!this.consumeCommand()) {
        return;
      }
    }
  }

  consumeCommand() {
    const newline = this.buffer.indexOf("\n");
    if (newline === -1) {
      if (this.buffer.length > MAX_LINE) {
        this.reply("500 5.5.2 Line too long");
        this.socket.destroy();
        this.closed = true;
      }
      return false;
    }

    const line = this.buffer.slice(0, newline).replace(/\r$/, "");
    this.buffer = this.buffer.slice(newline + 1);
    this.handleCommand(line);
    return this.buffer.length > 0 && !this.closed;
  }

  handleCommand(line) {
    const space = line.indexOf(" ");
    const verb = (space === -1 ? line : line.slice(0, space)).toUpperCase();
    const argument = space === -1 ? "" : line.slice(space + 1).trim();

    switch (verb) {
      case "HELO":
        this.reply(`250 ${config.domain} hello`);
        return;
      case "EHLO":
        this.reply(
          [
            `250-${config.domain} hello`,
            `250-SIZE ${config.maxMessageBytes}`,
            "250-8BITMIME",
            "250 HELP",
          ].join("\r\n")
        );
        return;
      case "MAIL":
        this.handleMail(argument);
        return;
      case "RCPT":
        this.handleRcpt(argument);
        return;
      case "DATA":
        if (!this.mailFrom) {
          this.reply("503 5.5.1 Need MAIL before DATA");
          return;
        }
        if (this.recipients.length === 0) {
          this.reply("503 5.5.1 Need RCPT before DATA");
          return;
        }
        this.inData = true;
        this.buffer = "";
        this.parts = [];
        this.dataSize = 0;
        this.tooBig = false;
        this.reply("354 End data with <CR><LF>.<CR><LF>");
        return;
      case "RSET":
        this.resetEnvelope();
        this.reply("250 2.0.0 Reset");
        return;
      case "NOOP":
        this.reply("250 2.0.0 Ok");
        return;
      case "VRFY":
        this.reply("252 2.5.0 Cannot verify user, but will accept message");
        return;
      case "HELP":
        this.reply("214 2.0.0 Commands: EHLO HELO MAIL RCPT DATA RSET NOOP VRFY QUIT");
        return;
      case "QUIT":
        this.reply("221 2.0.0 Bye");
        this.socket.end();
        this.closed = true;
        return;
      case "":
        this.reply("500 5.5.2 Empty command");
        return;
      default:
        this.reply("502 5.5.2 Command not implemented");
    }
  }

  handleMail(argument) {
    if (this.mailFrom) {
      this.reply("503 5.5.1 Nested MAIL command");
      return;
    }
    const address = extractPath(argument, "FROM");
    if (address === null) {
      this.reply("501 5.5.4 Syntax: MAIL FROM:<address>");
      return;
    }
    this.mailFrom = address;
    this.reply("250 2.1.0 Sender accepted");
  }

  handleRcpt(argument) {
    if (!this.mailFrom) {
      this.reply("503 5.5.1 Need MAIL before RCPT");
      return;
    }
    const address = extractPath(argument, "TO");
    if (address === null) {
      this.reply("501 5.5.4 Syntax: RCPT TO:<address>");
      return;
    }
    if (this.recipients.length >= MAX_RECIPIENTS) {
      this.reply("452 4.5.3 Too many recipients");
      return;
    }

    const at = address.lastIndexOf("@");
    if (at <= 0) {
      this.reply("501 5.1.3 Bad recipient address syntax");
      return;
    }
    const localPart = address.slice(0, at);
    const domain = address.slice(at + 1).toLowerCase();
    if (domain !== config.domain) {
      this.reply("550 5.7.1 Relay access denied: we only accept mail for " + config.domain);
      return;
    }
    const box = normalizeMailbox(localPart);
    if (!box) {
      this.reply("550 5.1.1 Invalid mailbox name");
      return;
    }
    const rcpt = `${box}@${config.domain}`;
    if (!this.recipients.includes(rcpt)) this.recipients.push(rcpt);
    this.reply("250 2.1.5 Recipient accepted");
  }

  /** Returns true when a complete message was handled and the loop may continue. */
  consumeData() {
    const terminator = findTerminator(this.buffer);
    if (!terminator) {
      if (this.buffer.length > config.maxMessageBytes + 4096) {
        this.tooBig = true;
        this.inData = false;
        this.buffer = "";
        this.reply("552 5.3.4 Message size exceeds fixed maximum message size");
        this.socket.end();
        this.closed = true;
      }
      return false;
    }

    const data = this.buffer.slice(0, terminator.index);
    this.buffer = this.buffer.slice(terminator.index + terminator.length);
    this.inData = false;

    if (this.tooBig) return true;

    this.finishMessage(data);
    return this.buffer.length > 0;
  }

  finishMessage(data) {
    // Remove the transparency dot added by SMTP clients.
    const unstuffed = data.replace(/^\./gm, "");
    const recipients = this.recipients.slice();
    const receivedAt = Date.now();
    const size = Buffer.byteLength(unstuffed, "latin1");

    this.resetEnvelope();

    try {
      const parsed = parseMessage(unstuffed);
      const preview = makePreview(parsed.text, parsed.html);
      for (const rcpt of recipients) {
        const box = rcpt.slice(0, rcpt.lastIndexOf("@"));
        insertMail({
          box,
          rcpt,
          sender: parsed.sender,
          senderName: parsed.senderName,
          subject: parsed.subject,
          receivedAt,
          size,
          preview,
          text: parsed.text,
          html: parsed.html,
          attachments: parsed.attachments,
        });
      }
      this.onMail({
        recipients,
        sender: parsed.sender,
        subject: parsed.subject,
        size,
      });
      this.reply(`250 2.0.0 Ok: ${recipients.length} message(s) stored`);
    } catch (error) {
      console.error("Failed to store message:", error);
      this.reply("451 4.3.0 Temporary storage failure");
    }
  }

  resetEnvelope() {
    this.mailFrom = null;
    this.recipients = [];
    this.parts = [];
    this.dataSize = 0;
  }
}

function findTerminator(buffer) {
  if (buffer.startsWith(".\r\n")) return { index: 0, length: 3 };
  if (buffer.startsWith(".\n")) return { index: 0, length: 2 };

  const crlf = buffer.indexOf("\r\n.\r\n");
  const lf = buffer.indexOf("\n.\n");
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { index: crlf, length: 5 };
  }
  if (lf !== -1) return { index: lf, length: 3 };
  return null;
}

/** Extract the address from "FROM:<a@b> SIZE=123" style arguments. */
function extractPath(argument, keyword) {
  const upper = argument.toUpperCase();
  if (!upper.startsWith(keyword)) return null;
  let rest = argument.slice(keyword.length).trim();
  if (rest.startsWith(":")) rest = rest.slice(1).trim();

  if (rest.startsWith("<")) {
    const end = rest.indexOf(">");
    if (end === -1) return null;
    return rest.slice(1, end).trim().toLowerCase();
  }
  // Tolerate clients that omit the angle brackets.
  const address = rest.split(/\s+/)[0];
  if (!address) return null;
  return address.replace(/^<|>$/g, "").toLowerCase();
}
