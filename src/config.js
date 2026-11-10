// All runtime configuration lives in .env (loaded automatically by Bun).

function normalizeDomain(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\.$/, "");
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toBool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

export const config = {
  domain: normalizeDomain(process.env.DOMAIN),
  password: process.env.APP_PASSWORD ?? "",
  host: process.env.HOST || "0.0.0.0",
  port: toInt(process.env.PORT, 3000),
  smtpPort: toInt(process.env.SMTP_PORT, 25),
  dataDir: process.env.DATA_DIR || "./data",
  maxMessageBytes: toInt(process.env.MAX_MESSAGE_BYTES, 10 * 1024 * 1024),
  secureCookies: toBool(process.env.SECURE_COOKIES),
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
};

export function validateConfig() {
  const problems = [];
  if (!config.domain || !config.domain.includes(".")) {
    problems.push("DOMAIN must be set to the mail domain, for example mail.example.com");
  }
  if (!config.password) {
    problems.push("APP_PASSWORD must be set to the password used to sign in");
  }
  if (problems.length > 0) {
    console.error("Configuration error:\n" + problems.map((p) => "  - " + p).join("\n"));
    process.exit(1);
  }
}
