const http = require("node:http");
const net = require("node:net");

const dotenv = require("dotenv");
dotenv.config();

const { createMountpointChecker } = require("./mpchecker-core");

const DEBUG = process.env.DEBUG === "1" || process.argv.includes("--debug") || process.argv.includes("-d");
const HOST = process.env.HOST || "::";
const PORT = Number(process.env.PORT || 8010);
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 20);
const RATE_LIMIT_PER_HOUR = Number(process.env.RATE_LIMIT_PER_HOUR || 100);
const HELP_TEXT = [
  "crtk-mpchecker HTTP server",
  "checks if a Centipede-RTK mountpoint name is available",
  "",
  "Usage:",
  "  GET /<MOUNTPOINT>",
  "",
  "Responses:",
  "  200 TAKEN",
  "  200 AVAILABLE",
  "",
  "Examples:",
  "  GET /EXISTING -> TAKEN",
  "  GET /NOTEXISTING -> AVAILABLE",
].join("\n");

function debugLog(message) {
  if (DEBUG) {
    console.debug(message);
  }
}

function expandIpv6(address) {
  const normalized = address.toLowerCase();
  const halves = normalized.split("::");

  if (halves.length > 2) {
    return null;
  }

  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const parts = [...left, ...right];
  const ipv4Index = parts.findIndex((part) => part.includes("."));

  if (ipv4Index !== -1) {
    const ipv4 = parts[ipv4Index];
    if (net.isIP(ipv4) !== 4) {
      return null;
    }

    const octets = ipv4.split(".").map(Number);
    parts.splice(
      ipv4Index,
      1,
      ((octets[0] << 8) | octets[1]).toString(16),
      ((octets[2] << 8) | octets[3]).toString(16),
    );
  }

  const missing = 8 - parts.length;
  if (missing < 0) {
    return null;
  }

  const full = halves.length === 2
    ? [...left, ...new Array(missing).fill("0"), ...right]
    : parts;

  if (full.length !== 8) {
    return null;
  }

  return full.map((part) => part.padStart(4, "0"));
}

function getIpv6Subnet64(address) {
  const expanded = expandIpv6(address);
  if (!expanded) {
    return null;
  }

  return `${expanded.slice(0, 4).join(":")}::/64`;
}

function getClientAddress(request) {
  const forwarded = TRUST_PROXY ? request.headers["x-forwarded-for"] : null;
  const candidate = typeof forwarded === "string" && forwarded.length > 0
    ? forwarded.split(",")[0].trim()
    : request.socket.remoteAddress;

  if (!candidate) {
    return null;
  }

  const withoutZone = candidate.split("%")[0];
  const mappedIpv4 = withoutZone.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedIpv4 && net.isIP(mappedIpv4[1]) === 4) {
    return { family: 4, key: `ipv4:${mappedIpv4[1]}` };
  }

  const family = net.isIP(withoutZone);
  if (family === 4) {
    return { family: 4, key: `ipv4:${withoutZone}` };
  }

  if (family === 6) {
    const subnet = getIpv6Subnet64(withoutZone);
    if (!subnet) {
      return null;
    }

    return { family: 6, key: `ipv6:${subnet}` };
  }

  return null;
}

function createRateLimiter({ perMinute, perHour }) {
  const buckets = new Map();
  const minuteWindowMs = 60_000;
  const hourWindowMs = 3_600_000;

  function prune(timestamps, now, windowMs) {
    while (timestamps.length > 0 && now - timestamps[0] >= windowMs) {
      timestamps.shift();
    }
  }

  return {
    check(request) {
      const client = getClientAddress(request);
      const key = client?.key || "unknown";
      const now = Date.now();
      const bucket = buckets.get(key) || { minute: [], hour: [] };

      prune(bucket.minute, now, minuteWindowMs);
      prune(bucket.hour, now, hourWindowMs);

      const minuteLimited = bucket.minute.length >= perMinute;
      const hourLimited = bucket.hour.length >= perHour;

      if (minuteLimited || hourLimited) {
        buckets.set(key, bucket);
        const minuteResetMs = bucket.minute.length > 0 ? minuteWindowMs - (now - bucket.minute[0]) : minuteWindowMs;
        const hourResetMs = bucket.hour.length > 0 ? hourWindowMs - (now - bucket.hour[0]) : hourWindowMs;
        const retryAfterMs = Math.max(
          minuteLimited ? minuteResetMs : 0,
          hourLimited ? hourResetMs : 0,
        );

        return {
          allowed: false,
          key,
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        };
      }

      bucket.minute.push(now);
      bucket.hour.push(now);
      buckets.set(key, bucket);

      return {
        allowed: true,
        key,
        remainingMinute: perMinute - bucket.minute.length,
        remainingHour: perHour - bucket.hour.length,
      };
    },
  };
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "*");
  response.setHeader("Access-Control-Expose-Headers", "*");
  response.setHeader("Access-Control-Max-Age", "86400");
}

function sendText(response, statusCode, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function getMountpointFromRequest(request) {
  let url;
  try {
    url = new URL(request.url || "/", "http://localhost");
  } catch {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);

  if (segments.length !== 1) {
    return null;
  }

  try {
    return decodeURIComponent(segments[0]).trim();
  } catch {
    return null;
  }
}

function createServer(options = {}) {
  const checker = options.checker || createMountpointChecker({ debug: DEBUG });
  const rateLimiter = options.rateLimiter || createRateLimiter({
    perMinute: RATE_LIMIT_PER_MINUTE,
    perHour: RATE_LIMIT_PER_HOUR,
  });

  return http.createServer(async (request, response) => {
    setCorsHeaders(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "METHOD NOT ALLOWED", {
        Allow: "GET, HEAD, OPTIONS",
      });
      return;
    }

    const rateLimit = rateLimiter.check(request);
    if (!rateLimit.allowed) {
      debugLog(`Rate limit exceeded for ${rateLimit.key}`);
      sendText(response, 429, "TOO MANY REQUESTS", {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
      return;
    }

    const mountpoint = getMountpointFromRequest(request);
    if (!mountpoint) {
      sendText(response, 200, HELP_TEXT);
      return;
    }

    try {
      const available = await checker.isMountpointAvailable(mountpoint);
      const body = available ? "AVAILABLE" : "TAKEN";
      sendText(response, 200, body);
    } catch (error) {
      console.error(`Error checking "${mountpoint}":`, error.message);
      sendText(response, 500, "ERROR");
    }
  });
}

function main() {
  const server = createServer();
  server.listen({ port: PORT, host: HOST, ipv6Only: false }, () => {
    const printableHost = net.isIP(HOST) === 6 ? `[${HOST}]` : HOST;
    console.log(`Listening on http://${printableHost}:${PORT}`);
    debugLog(`Rate limits: ${RATE_LIMIT_PER_MINUTE}/minute and ${RATE_LIMIT_PER_HOUR}/hour`);
    debugLog(`Trust proxy: ${TRUST_PROXY ? "enabled" : "disabled"}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  createRateLimiter,
  createServer,
  getClientAddress,
  getIpv6Subnet64,
};
