const SAFE_REQUEST_HEADER_NAMES = [
  "accept",
  "accept-language",
  "accept-encoding",
  "content-type",
  "content-length",
  "user-agent",
  "x-request-id",
  "x-requested-with",
  "range",
  "if-none-match",
  "if-modified-since",
] as const;

const SENSITIVE_QUERY_PARAMS = new Set(["token", "authorization"]);

const BLOCKED_REQUEST_HEADER_NAMES = [
  "cookie",
  "authorization",
  "origin",
  "referer",
] as const;

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "set-cookie",
  "set-cookie2",
  "authorization",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
]);

const ENCODED_NUL_PATTERN = /%00/i;
const ENCODED_SLASH_PATTERN = /%(?:2f|5c)/i;
const INVALID_PATH_SEGMENTS = new Set([".", ".."]);

export function normalizeProxyTargetPath(targetPath: string): string {
  const withLeadingSlash = targetPath.startsWith("/") ? targetPath : `/${targetPath}`;
  return withLeadingSlash.replace(/^\/{2,}/, "/");
}

export function isInvalidProxyTargetPath(targetPath: string): boolean {
  if (
    targetPath.includes("\\") ||
    targetPath.includes("\0") ||
    ENCODED_NUL_PATTERN.test(targetPath)
  ) {
    return true;
  }

  let decodedPath = targetPath;
  for (let round = 0; round < 2; round += 1) {
    if (ENCODED_SLASH_PATTERN.test(decodedPath)) {
      return true;
    }

    let nextDecodedPath: string;
    try {
      nextDecodedPath = decodeURIComponent(decodedPath);
    } catch {
      return true;
    }

    if (nextDecodedPath === decodedPath) {
      break;
    }

    decodedPath = nextDecodedPath;
  }

  return decodedPath
    .split("/")
    .some((segment) => INVALID_PATH_SEGMENTS.has(segment));
}

export function sanitizeProxyQueryParams(searchParams: URLSearchParams): string {
  const sanitized = new URLSearchParams();
  for (const [name, value] of searchParams.entries()) {
    if (name.startsWith("_") || SENSITIVE_QUERY_PARAMS.has(name.toLowerCase())) {
      continue;
    }
    sanitized.append(name, value);
  }
  return sanitized.toString();
}

export function buildSandboxTargetUrl(
  routeUrl: string,
  targetPath: string,
  queryString: string,
): URL {
  const url = new URL(routeUrl);
  url.pathname = normalizeProxyTargetPath(targetPath);
  url.search = queryString;
  return url;
}

export function buildSafeProxyHeaders(
  request: Request,
  targetUrl: string,
  serverInjectedHeaders?: HeadersInit,
): Headers {
  const requestUrl = new URL(request.url);
  const forwardedProto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() ??
    requestUrl.protocol.replace(":", "");
  const normalizedTargetUrl = new URL(targetUrl);
  const headers = new Headers();

  for (const name of SAFE_REQUEST_HEADER_NAMES) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }

  for (const blocked of [...BLOCKED_REQUEST_HEADER_NAMES, ...HOP_BY_HOP_HEADERS]) {
    headers.delete(blocked);
  }

  headers.set("accept-encoding", "identity");
  headers.set("x-forwarded-host", requestUrl.host || normalizedTargetUrl.host);
  headers.set("x-forwarded-proto", forwardedProto);

  if (serverInjectedHeaders) {
    const injected = new Headers(serverInjectedHeaders);
    for (const [name, value] of injected.entries()) {
      headers.set(name, value);
    }
  }

  return headers;
}

export function stripProxyResponseHeaders(
  upstream: Headers,
  secrets?: string[],
): Headers {
  const hadContentEncoding = upstream.has("content-encoding");
  const headers = new Headers();

  for (const [name, value] of upstream.entries()) {
    const lowerName = name.toLowerCase();
    if (STRIP_RESPONSE_HEADERS.has(lowerName)) {
      continue;
    }
    if (hadContentEncoding && lowerName === "content-length") {
      continue;
    }
    if (secrets?.some((secret) => secret && value.includes(secret))) {
      continue;
    }
    headers.append(name, value);
  }

  return headers;
}

export function buildTokenHtmlHeaders(
  gatewayToken: string,
  options: {
    sandboxOrigin: string;
    proxyOrigin: string;
    upstreamHeaders: Headers;
    nonce: string;
  },
): Headers {
  const headers = stripProxyResponseHeaders(options.upstreamHeaders, [gatewayToken]);
  const connectSrc = [
    "'self'",
    options.sandboxOrigin,
    options.sandboxOrigin.replace(/^https:/, "wss:"),
    options.proxyOrigin,
  ];
  const csp = [
    `default-src 'self' 'nonce-${options.nonce}'`,
    `script-src 'nonce-${options.nonce}'`,
    `style-src 'self' 'unsafe-inline'`,
    `connect-src ${connectSrc.join(" ")}`,
    "img-src 'self' data: blob:",
    "form-action 'self'",
    "base-uri 'self'",
  ].join("; ");

  headers.delete("content-length");
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", csp);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store, private");
  return headers;
}

export function buildWaitingPageCsp(nonce: string): string {
  return [
    `default-src 'self' 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `style-src 'self' 'unsafe-inline'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "form-action 'self'",
    "base-uri 'self'",
  ].join("; ");
}
