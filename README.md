# Voidpost

A tiny disposable-mail server: it accepts mail for **every** address at one domain,
and lets you read any mailbox from a small web interface after entering a single
password.

- Catch-all SMTP receiver on any mailbox name (`anything@your-domain`)
- Web reader: type a mailbox name, no signup
- Addresses exist only while they hold mail: the first message to a name creates
  that mailbox, and it is removed once its last message expires
- Retention setting from 5 minutes to forever
- **Zero npm dependencies** — Bun's built-in SQLite, `node:net`, `node:crypto`
- One process, server-rendered HTML, no build step

Typical footprint when idle: about 30–45 MB of RSS and near-zero CPU; mail only
costs CPU while a message is being parsed.

## Requirements

- [Bun](https://bun.sh) 1.1 or newer
- A server that can receive inbound mail on port 25, with the MX record of your
  domain pointed at it

## Setup

```bash
cp .env.example .env
# edit .env: set DOMAIN and APP_PASSWORD
bun start
```

There is nothing to install: `bun start` runs the whole server.

Open `http://localhost:3000`, sign in with `APP_PASSWORD`, and type a mailbox
name. Mail sent to `<name>@DOMAIN` shows up there.

### Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOMAIN` | – | Mail domain. All local parts are accepted. |
| `APP_PASSWORD` | – | Password for the web interface. |
| `HOST` | `0.0.0.0` | Bind address for both listeners. |
| `PORT` | `3000` | Web interface port. |
| `SMTP_PORT` | `25` | SMTP port. Use `2525` for local testing. |
| `DATA_DIR` | `./data` | SQLite database and session key directory. |
| `MAX_MESSAGE_BYTES` | `10485760` | Largest accepted message (10 MB). |
| `SECURE_COOKIES` | `false` | Set the session cookie as `Secure` (enable behind HTTPS). |

The retention window is changed in the web interface under **Settings** and is
stored in the database, not in `.env`.

## Receiving real mail

For internet mail to arrive, DNS and networking must be right:

1. `A`/`AAAA` record for the host, for example `mail.example.com`.
2. `MX` record for `example.com` (or a subdomain) pointing at that host.
3. Inbound **TCP port 25 open** in the firewall and not blocked by the hoster.
   Many cloud providers block port 25 by default — a small VPS is usually easiest.
4. Ports below 1024 need privileges: either run as root/with `CAP_NET_BIND_SERVICE`,
   set `SMTP_PORT=2525` and redirect with `iptables`, or put a real MTA in front.

The receiver speaks plain SMTP only (no STARTTLS, no AUTH), because delivering
cryptographic TLS to a throwaway inbox adds size and CPU for little benefit. If a
sender requires TLS to deliver (many do nowadays), put Postfix in front and relay
locally:

```conf
# /etc/postfix/main.cf (excerpt)
mydestination = example.com
relayhost =
# transport map: example.com  smtp:[127.0.0.1]:2525
```

Then set `SMTP_PORT=2525` in `.env` and keep Postfix listening on 25 with TLS.

### systemd

```ini
[Unit]
Description=Voidpost mail
After=network.target

[Service]
WorkingDirectory=/opt/voidpost
EnvironmentFile=/opt/voidpost/.env
ExecStart=/usr/local/bin/bun index.js
Restart=always
User=voidpost
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

Put the web interface behind Caddy or nginx for HTTPS and set
`SECURE_COOKIES=true`.

## Testing without real mail

```bash
SMTP_PORT=2525 bun run send-test-mail hello@mail.example.com "Hello there"
```

The script talks real SMTP to the local listener, so a message stored this way
went through the same code path as internet mail.

## How it works

- `src/smtp.js` — line-oriented SMTP state machine; accepts any recipient at
  `DOMAIN`, refuses everything else (no open relay), caps message size.
- `src/mime.js` — minimal MIME parser: headers, RFC 2047 encoded words,
  multipart, base64, quoted-printable, charset decoding, attachment counting.
- `src/db.js` — SQLite schema, address registry (`boxes`), retention setting,
  expiry sweep every minute. Storing a message and registering its address happen
  in one transaction, and the sweep drops addresses that no longer hold mail,
  so the list only ever shows mailboxes you can actually read.
  Reads also filter on the current window, so expiry is exact between sweeps.
- `src/web.js` — routing, HMAC-signed cookie sessions, rate-limited login.
- `src/views.js`, `public/` — server-rendered HTML and ~300 lines of CSS.

### Retention semantics

Changing the setting applies to **all** messages, including ones already received:
a message is visible while `now - received_at < retention`. Expired rows are
deleted by the minute sweep. "Forever" keeps everything.

### Deliberate limits

- A single shared password, no user accounts — the whole server is one inbox set.
- An address is deleted when its last message expires; nothing keeps an empty
  mailbox alive.
- Attachments are not stored; the message view notes how many were dropped.
- No TLS on SMTP (see above), no relay, no user database.
- The raw source of a message is not kept, which keeps storage small.
- Email HTML is served in a sandboxed iframe with `CSP: sandbox; default-src 'none'`,
  so scripts inside a message cannot run or reach the app.
