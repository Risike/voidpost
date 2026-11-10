// Single-password authentication with stateless, HMAC-signed cookies.
// No session table, no database reads per request.

import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

const keyPath = join(config.dataDir, "session.key");

function loadKey() {
  if (existsSync(keyPath)) return readFileSync(keyPath);
  mkdirSync(config.dataDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

const sessionKey = loadKey();
const passwordDigest = createHash("sha256").update(config.password).digest();

export function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    if (equals === -1) continue;
    const name = part.slice(0, equals).trim();
    if (!name) continue;
    cookies[name] = part.slice(equals + 1).trim();
  }
  return cookies;
}

function sign(payload) {
  return createHmac("sha256", sessionKey).update(payload).digest("base64url");
}

export function createSessionCookie(secure = config.secureCookies) {
  const expiresAt = Date.now() + config.sessionTtlMs;
  const payload = String(expiresAt);
  const value = `${payload}.${sign(payload)}`;
  const maxAge = Math.floor(config.sessionTtlMs / 1000);
  return [
    `session=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookie(secure = config.secureCookies) {
  return [
    "session=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function isAuthenticated(request) {
  const token = parseCookies(request.headers.get("cookie")).session;
  if (!token) return false;

  const dot = token.indexOf(".");
  if (dot <= 0) return false;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const expiresAt = Number.parseInt(payload, 10);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export function checkPassword(candidate) {
  const digest = createHash("sha256").update(String(candidate ?? "")).digest();
  return timingSafeEqual(digest, passwordDigest);
}

// Small in-memory throttle against password guessing.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const attempts = new Map();

export function loginAllowed(ip) {
  const entry = attempts.get(ip);
  if (!entry) return true;
  if (entry.resetAt <= Date.now()) {
    attempts.delete(ip);
    return true;
  }
  return entry.count < MAX_ATTEMPTS;
}

export function noteLoginFailure(ip) {
  if (attempts.size > 5000) attempts.clear();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt <= Date.now()) {
    attempts.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function noteLoginSuccess(ip) {
  attempts.delete(ip);
}

export function clientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") || "local";
}
