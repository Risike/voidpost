// HTTP interface: cookie session, server-rendered pages, tiny JSON endpoint for
// live inbox refresh.

import { readFileSync } from "node:fs";
import { config } from "./config.js";
import * as db from "./db.js";
import * as views from "./views.js";
import {
  checkPassword,
  clearSessionCookie,
  clientIp,
  createSessionCookie,
  isAuthenticated,
  loginAllowed,
  noteLoginFailure,
  noteLoginSuccess,
} from "./auth.js";
import { normalizeMailbox } from "./smtp.js";

const appCss = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const faviconSvg = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8");

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const ASSET_HEADERS = {
  "Cache-Control": "public, max-age=3600",
  "X-Content-Type-Options": "nosniff",
};

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { ...PAGE_HEADERS, ...extraHeaders },
  });
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": "no-store", ...extraHeaders },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// CSRF guard for state-changing requests. Proxies rewrite Host and ports, and
// sandboxed preview frames send an opaque "null" origin, so compare against
// every host the request might legitimately have reached us with. The session
// cookie is HttpOnly + SameSite=Lax, which is the primary defence.
function isSameOrigin(request) {
  // Browsers authoritatively mark the relationship for their own requests.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "same-origin" || fetchSite === "none") return true;

  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser client (curl, scripts)
  if (origin === "null") return true; // opaque origin (sandboxed frame)

  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  const hosts = new Set();
  for (const header of ["host", "x-forwarded-host", "x-original-host"]) {
    const value = request.headers.get(header);
    if (!value) continue;
    for (const part of value.split(",")) {
      const host = part.trim().toLowerCase();
      if (host) hosts.add(host);
    }
  }
  const forwarded = request.headers.get("forwarded");
  const forwardedHost = forwarded && /host="?([^";,]+)/i.exec(forwarded);
  if (forwardedHost) hosts.add(forwardedHost[1].toLowerCase());

  if (hosts.size === 0) return true;

  const originHost = originUrl.host.toLowerCase();
  const originName = originUrl.hostname.toLowerCase();
  for (const host of hosts) {
    if (host === originHost || host.split(":")[0] === originName) return true;
  }

  console.warn(
    `Cross-origin request rejected: origin=${origin} host=${[...hosts].join(",")} sec-fetch-site=${fetchSite ?? "-"}`
  );
  return false;
}

function wantsHttps(request, url) {
  if (config.secureCookies) return true;
  if (url.protocol === "https:") return true;
  return request.headers.get("x-forwarded-proto") === "https";
}

async function readForm(request) {
  try {
    const form = await request.formData();
    return (name) => String(form.get(name) ?? "");
  } catch {
    return () => "";
  }
}

export function startWebServer() {
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    async fetch(request) {
      try {
        return await route(request);
      } catch (error) {
        console.error("Request failed:", error);
        return html(views.errorPage({ status: 500, message: "Something went wrong." }), 500);
      }
    },
  });
  console.log(`HTTP  listening on ${config.host}:${config.port}`);
  return server;
}

async function route(request) {
  const url = new URL(request.url);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return html(views.errorPage({ status: 400, message: "Bad request path." }), 400);
  }

  const segments = pathname.split("/").filter(Boolean);
  const method = request.method.toUpperCase();

  if (pathname === "/app.css") {
    return new Response(appCss, {
      headers: { ...ASSET_HEADERS, "Content-Type": "text/css; charset=utf-8" },
    });
  }
  if (pathname === "/app.js") {
    return new Response(appJs, {
      headers: { ...ASSET_HEADERS, "Content-Type": "text/javascript; charset=utf-8" },
    });
  }

  if (pathname === "/favicon.svg") {
    return new Response(faviconSvg, {
      headers: { ...ASSET_HEADERS, "Content-Type": "image/svg+xml; charset=utf-8" },
    });
  }

  if (segments.length === 1 && segments[0] === "login") {
    const authed = isAuthenticated(request);
    if (method === "GET" || method === "HEAD") {
      if (authed) return redirect("/m");
      return html(views.loginPage({ domain: config.domain }));
    }
    if (method !== "POST") return methodNotAllowed();

    if (!isSameOrigin(request)) return forbidden();
    const ip = clientIp(request);
    if (!loginAllowed(ip)) {
      return html(
        views.loginPage({ domain: config.domain, error: "Too many attempts. Try again later." }),
        429
      );
    }
    const form = await readForm(request);
    if (!checkPassword(form("password"))) {
      noteLoginFailure(ip);
      return html(
        views.loginPage({ domain: config.domain, error: "Wrong password." }),
        401
      );
    }
    noteLoginSuccess(ip);
    const secure = wantsHttps(request, url);
    return redirect("/m", { "Set-Cookie": createSessionCookie(secure) });
  }

  if (segments.length === 1 && segments[0] === "logout") {
    if (method !== "POST") return methodNotAllowed();
    if (!isSameOrigin(request)) return forbidden();
    return redirect("/login", {
      "Set-Cookie": clearSessionCookie(wantsHttps(request, url)),
    });
  }

  // Everything below requires a session.
  if (!isAuthenticated(request)) {
    if (segments.length > 0 && segments[0] === "api") return json({ error: "unauthorized" }, 401);
    return redirect("/login");
  }

  if (segments.length === 0) return redirect("/m");

  if (segments[0] === "m") {
    if (segments.length === 1) {
      if (method === "GET" || method === "HEAD") {
        const error = url.searchParams.get("error");
        return html(
          views.homePage({
            boxes: db.listBoxes(),
            error: error === "invalid" ? "That mailbox name is not valid." : null,
          })
        );
      }
      if (method === "POST") {
        if (!isSameOrigin(request)) return forbidden();
        const form = await readForm(request);
        const box = normalizeMailbox(form("box"));
        if (!box) return redirect("/m?error=invalid");
        return redirect(`/m/${encodeURIComponent(box)}`);
      }
      return methodNotAllowed();
    }

    const box = normalizeMailbox(segments[1]);
    if (!box) return html(views.errorPage({ status: 404, message: "Mailbox not found." }), 404);

    if (segments.length === 2) {
      if (method !== "GET" && method !== "HEAD") return methodNotAllowed();
      return html(views.mailboxPage({ box, mails: db.listMails(box) }));
    }

    // Empty a whole mailbox: /m/<box>/delete
    if (segments.length === 3 && segments[2] === "delete") {
      if (method !== "POST") return methodNotAllowed();
      if (!isSameOrigin(request)) return forbidden();
      db.deleteMailsInBox(box);
      return redirect(`/m/${encodeURIComponent(box)}`);
    }

    const id = Number.parseInt(segments[2], 10);
    if (!Number.isFinite(id)) {
      return html(views.errorPage({ status: 404, message: "Message not found." }), 404);
    }
    const mail = db.getMail(id, box);
    if (!mail) {
      return html(
        views.errorPage({
          status: 404,
          message: "This message does not exist, was deleted, or has expired.",
        }),
        404
      );
    }

    if (segments.length === 3) {
      if (method !== "GET" && method !== "HEAD") return methodNotAllowed();
      return html(views.messagePage({ box, mail }));
    }

    // Delete a single message: /m/<box>/<id>/delete
    if (segments.length === 4 && segments[3] === "delete") {
      if (method !== "POST") return methodNotAllowed();
      if (!isSameOrigin(request)) return forbidden();
      if (!db.deleteMail(id, box)) {
        return html(
          views.errorPage({ status: 404, message: "This message no longer exists." }),
          404
        );
      }
      return redirect(`/m/${encodeURIComponent(box)}`);
    }

    if (segments.length === 4 && segments[3] === "html") {
      if (!mail.html_body) return html(views.errorPage({ status: 404, message: "No HTML body." }), 404);
      return new Response(mail.html_body, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // No scripts, no form posts, and an opaque origin: email HTML can
          // never touch the app.
          "Content-Security-Policy":
            "sandbox; default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'; font-src * data:",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-store",
        },
      });
    }

    return html(views.errorPage({ status: 404, message: "Page not found." }), 404);
  }

  if (segments[0] === "api" && segments[1] === "mailbox" && segments.length === 3) {
    const box = normalizeMailbox(segments[2]);
    if (!box) return json({ error: "invalid mailbox" }, 400);
    return json({ count: db.countMails(box) });
  }

  if (segments.length === 1 && segments[0] === "settings") {
    if (method === "GET" || method === "HEAD") {
      return html(views.settingsPage({ saved: url.searchParams.get("saved") === "1" }));
    }
    if (method === "POST") {
      if (!isSameOrigin(request)) return forbidden();
      const form = await readForm(request);
      const seconds = Number.parseInt(form("retention"), 10);
      if (!Number.isFinite(seconds) || !db.setRetentionSeconds(seconds)) {
        return html(views.errorPage({ status: 400, message: "Unknown retention value." }), 400);
      }
      db.sweep();
      return redirect("/settings?saved=1");
    }
    return methodNotAllowed();
  }

  if (segments[0] === "api") return json({ error: "not found" }, 404);
  return html(views.errorPage({ status: 404, message: "Page not found." }), 404);
}

function methodNotAllowed() {
  return new Response("Method not allowed", {
    status: 405,
    headers: { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, POST" },
  });
}

function forbidden() {
  return new Response("Forbidden", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
