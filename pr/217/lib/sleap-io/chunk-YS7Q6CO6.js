// src/io/remote.ts
var URL_SCHEMES = /* @__PURE__ */ new Set([
  "http",
  "https",
  "s3",
  "gs",
  "gcs",
  "az",
  "abfs"
]);
var CLOUD_SCHEMES = /* @__PURE__ */ new Set(["s3", "gs", "gcs", "az", "abfs"]);
var GDRIVE_HOSTS = /* @__PURE__ */ new Set(["drive.google.com", "docs.google.com"]);
var SENSITIVE_HEADERS = /* @__PURE__ */ new Set([
  "authorization",
  "cookie",
  "proxy-authorization"
]);
var SENSITIVE_QUERY_PARAMS = /* @__PURE__ */ new Set([
  "token",
  "access_token",
  "x-amz-security-token",
  "sas",
  "sig"
]);
var RETRYABLE_STATUSES = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var URL_IN_TEXT_PATTERN = /(?:http|https|s3|gs|gcs|az|abfs):\/\/[^\s"'<>]+/gi;
function isUrl(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const colon = value.indexOf(":");
  if (colon <= 1) return false;
  const scheme = value.slice(0, colon).toLowerCase();
  return scheme.length > 1 && URL_SCHEMES.has(scheme);
}
function isGdriveUrl(value) {
  if (!isUrl(value)) return false;
  try {
    return GDRIVE_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}
function redactUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username || parsed.password) {
    parsed.username = "***";
    parsed.password = "***";
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      parsed.searchParams.set(key, "***");
    }
  }
  return parsed.toString();
}
function redactedCauseSummary(e) {
  const typeName = e?.constructor?.name ?? "Error";
  const rawMsg = String(
    e?.message ?? e
  );
  const redactedMsg = rawMsg.replace(URL_IN_TEXT_PATTERN, (m) => redactUrl(m)).replace(/\s*\n\s*/g, " ").trim();
  return `${typeName}: ${redactedMsg}`;
}
var RemoteIOError = class extends Error {
  status;
  /** ALWAYS redacted. */
  url;
  causeSummary;
  /**
   * Delay (ms) hinted by a `Retry-After` response header, threaded to
   * {@link withRetries}. Not part of Python; a JS-side channel so the retry
   * loop can honor server backoff without re-issuing the failed request.
   */
  retryAfterMs;
  constructor(opts) {
    const redactedUrl = redactUrl(opts.url);
    const causeSummary = opts.cause !== void 0 ? redactedCauseSummary(opts.cause) : void 0;
    const parts = [
      opts.message,
      `status=${opts.status ?? "null"}`,
      `url=${redactedUrl}`
    ];
    if (causeSummary) parts.push(`cause=${causeSummary}`);
    super(parts.join("; "));
    this.name = "RemoteIOError";
    this.status = opts.status ?? null;
    this.url = redactedUrl;
    this.causeSummary = causeSummary;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
function resolveUrl(url) {
  if (!isUrl(url)) {
    throw new RemoteIOError({ message: "Not a URL", url, status: null });
  }
  if (isGdriveUrl(url)) {
    return { url, gdrive: true };
  }
  const colon = url.indexOf(":");
  const scheme = url.slice(0, colon).toLowerCase();
  if (scheme === "http" || scheme === "https") {
    return { url, gdrive: false };
  }
  if (scheme === "gs" || scheme === "gcs") {
    const rest = url.slice(url.indexOf("://") + 3);
    const slash = rest.indexOf("/");
    const bucket = slash === -1 ? rest : rest.slice(0, slash);
    const objectPath = slash === -1 ? "" : rest.slice(slash + 1);
    return {
      url: `https://storage.googleapis.com/${bucket}/${objectPath}`,
      gdrive: false
    };
  }
  throw new RemoteIOError({
    message: `Cloud scheme '${scheme}' is not supported in the browser. Pass a presigned https:// URL instead.`,
    url,
    status: null
  });
}
function statusToMessage(status) {
  switch (status) {
    case 404:
      return "file not found";
    case 416:
      return "range past end of file";
    case 412:
      return "file changed since cached (ETag mismatch)";
    default:
      return `HTTP ${status}`;
  }
}
function raiseRemote(url, e, status) {
  let message;
  if (status != null) {
    message = statusToMessage(status);
  } else if (e instanceof Error && (e.name === "AbortError" || typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError")) {
    message = "timeout";
  } else if (e instanceof TypeError) {
    message = "connection error";
  } else {
    const typeName = e?.constructor?.name ?? "Error";
    message = `unexpected error: ${typeName}`;
  }
  throw new RemoteIOError({ message, url, status: status ?? null, cause: e });
}
function identityHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === "accept-encoding") continue;
    out[k] = v;
  }
  out["Accept-Encoding"] = "identity";
  return out;
}
function stripCrossOriginHeaders(headers, fromUrl, toUrl) {
  let sameOrigin = false;
  try {
    sameOrigin = new URL(toUrl).origin === new URL(fromUrl).origin;
  } catch {
    sameOrigin = false;
  }
  if (sameOrigin) return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}
async function withRetries(fn, options) {
  const retries = options?.retries ?? 3;
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e instanceof RemoteIOError && (e.status === null || RETRYABLE_STATUSES.has(e.status ?? -1));
      if (!retryable || attempt >= retries) {
        throw e;
      }
      const retryAfterMs = e.retryAfterMs;
      const delayMs = retryAfterMs != null ? Math.min(retryAfterMs, 3e4) : Math.min(200 * 2 ** attempt, 3e4);
      attempt += 1;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
function parseRetryAfterMs(value) {
  if (!value) return void 0;
  const secs = Number.parseInt(value, 10);
  if (!Number.isFinite(secs) || String(secs) !== value.trim()) return void 0;
  return Math.min(secs * 1e3, 3e4);
}
async function fetchRetrying(url, init, options) {
  return withRetries(async () => {
    let response;
    try {
      response = await fetch(url, init);
    } catch (e) {
      raiseRemote(url, e);
    }
    if (RETRYABLE_STATUSES.has(response.status)) {
      const err = new RemoteIOError({
        message: statusToMessage(response.status),
        url,
        status: response.status
      });
      err.retryAfterMs = parseRetryAfterMs(
        response.headers?.get?.("Retry-After") ?? null
      );
      throw err;
    }
    return response;
  }, options);
}
async function headOrRangeProbe(url, options) {
  let resolved;
  try {
    resolved = resolveUrl(url);
  } catch {
    return false;
  }
  if (resolved.gdrive) {
    try {
      const { parseGdrive: parseGdrive2 } = await import("./gdrive-6DDSPUUK.js");
      parseGdrive2(url);
      return true;
    } catch {
      return false;
    }
  }
  const headers = options?.headers ?? {};
  try {
    const head = await fetch(resolved.url, { method: "HEAD", headers });
    if (head.ok) return true;
  } catch {
  }
  try {
    const ranged = await fetch(resolved.url, {
      method: "GET",
      headers: { ...headers, Range: "bytes=0-0" }
    });
    return ranged.ok || ranged.status === 206;
  } catch {
    return false;
  }
}

// src/io/gdrive.ts
var UC_URL_TEMPLATE = (id) => `https://drive.google.com/uc?id=${id}`;
var BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
var MAX_HOPS = 4;
var DEFAULT_MAX_BYTES = 8 * 1024 ** 3;
var READ_CHUNK = 1024 ** 2;
var DOWNLOAD_HOSTS = /* @__PURE__ */ new Set([
  "drive.google.com",
  "docs.google.com",
  "drive.usercontent.google.com"
]);
var DOWNLOAD_HOST_SUFFIX = ".googleusercontent.com";
var FOLDER_RE = /(?:drive\/)?folders\//;
var FILE_PATH_RE = /^\/file\/(?:u\/[0-9]+\/)?d\/([^/]+)(?:\/(?:edit|view|preview))?\/?$/;
var HREF_RE = /href="(\/uc\?export=download[^"]+)"/;
var DOWNLOAD_URL_JSON_RE = /"downloadUrl":"([^"]+)"/;
var ERROR_CAPTION_RE = /<p class="uc-error-subcaption">([\s\S]*?)<\/p>/;
function isNode() {
  return typeof process !== "undefined" && !!process?.versions?.node;
}
function parseGdrive(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(
      `Could not parse a Google Drive file ID from URL: ${redactUrl(url)}`
    );
  }
  if (FOLDER_RE.test(u.pathname)) {
    throw new Error(
      `Google Drive folder URLs are not supported: ${redactUrl(url)}`
    );
  }
  const idParam = u.searchParams.get("id");
  if (idParam) return idParam;
  const m = FILE_PATH_RE.exec(u.pathname);
  if (m) return m[1];
  throw new Error(
    `Could not parse a Google Drive file ID from URL: ${redactUrl(url)}`
  );
}
function stripTags(html) {
  return html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}
function parseDownloadForm(html) {
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const form = doc.querySelector(
        'form#download-form, form[id="download-form"]'
      );
      if (form) {
        const action = form.getAttribute("action") ?? "";
        if (action) {
          const target2 = new URL(action);
          const inputs = form.querySelectorAll("input");
          inputs.forEach((input) => {
            const name = input.getAttribute("name");
            if (!name) return;
            target2.searchParams.set(name, input.getAttribute("value") ?? "");
          });
          return target2.toString();
        }
      }
    } catch {
    }
  }
  const formMatch = /<form[^>]*id="download-form"[^>]*>([\s\S]*?)<\/form>/i.exec(html) ?? /<form[^>]*\bid='download-form'[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!formMatch) return null;
  const formTag = /<form[^>]*id=["']download-form["'][^>]*>/i.exec(html)?.[0];
  const actionMatch = formTag ? /action=["']([^"']+)["']/i.exec(formTag) : null;
  if (!actionMatch) return null;
  let target;
  try {
    target = new URL(actionMatch[1].replace(/&amp;/g, "&"));
  } catch {
    return null;
  }
  const body = formMatch[1];
  const inputRe = /<input\b[^>]*>/gi;
  for (const match of body.matchAll(inputRe)) {
    const tag = match[0];
    const name = /name=["']([^"']*)["']/i.exec(tag)?.[1];
    if (!name) continue;
    const value = /value=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    target.searchParams.set(name, value);
  }
  return target.toString();
}
function urlFromConfirmation(html, url = "") {
  const href = HREF_RE.exec(html);
  if (href) {
    return "https://docs.google.com" + href[1].replace(/&amp;/g, "&");
  }
  const form = parseDownloadForm(html);
  if (form) return form;
  const json = DOWNLOAD_URL_JSON_RE.exec(html);
  if (json) {
    return json[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&");
  }
  const err = ERROR_CAPTION_RE.exec(html);
  if (err) {
    const caption = stripTags(err[1]);
    throw new RemoteIOError({
      message: `Google Drive refused the download: ${caption} (if quota, retry later; if permission, set sharing to 'Anyone with the link')`,
      url,
      status: null
    });
  }
  throw new Error(
    "Could not find a Google Drive download link in the confirmation page"
  );
}
function checkDownloadHost(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new RemoteIOError({
      message: `Refusing to follow a Google Drive redirect to an unexpected host: ${redactUrl(url)}`,
      url,
      status: null
    });
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  const host = u.hostname.toLowerCase();
  const allowed = (scheme === "http" || scheme === "https") && (DOWNLOAD_HOSTS.has(host) || host.endsWith(DOWNLOAD_HOST_SUFFIX));
  if (!allowed) {
    throw new RemoteIOError({
      message: `Refusing to follow a Google Drive redirect to an unexpected host: ${redactUrl(url)}`,
      url,
      status: null
    });
  }
}
async function readBodyCapped(response, cap, url) {
  const len = response.headers.get("Content-Length");
  if (len && Number(len) > cap) {
    throw new RemoteIOError({
      message: `Google Drive file exceeds the maximum in-memory download size (cap=${cap}, Content-Length=${len})`,
      url,
      status: null
    });
  }
  const chunks = [];
  let total = 0;
  const overflow = () => {
    chunks.length = 0;
    throw new RemoteIOError({
      message: `Google Drive file exceeds the maximum in-memory download size (cap=${cap})`,
      url,
      status: null
    });
  };
  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > cap) overflow();
        chunks.push(value);
      }
    }
  } else {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > cap) overflow();
    return buf;
  }
  void READ_CHUNK;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
function extractCookie(response) {
  const getSetCookie = response.headers.getSetCookie;
  let raw = null;
  if (typeof getSetCookie === "function") {
    const all = getSetCookie.call(response.headers);
    if (all?.length) raw = all.join(", ");
  }
  if (!raw) raw = response.headers.get("set-cookie");
  if (!raw) return null;
  const pairs = raw.split(/,(?=[^;]+=)/).map((c) => c.split(";")[0].trim()).filter(Boolean);
  return pairs.length ? pairs.join("; ") : null;
}
async function openGdrive(url, options) {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const fileId = parseGdrive(url);
  let current = UC_URL_TEMPLATE(fileId);
  const baseHeaders = {};
  for (const [k, v] of Object.entries(options?.headers ?? {})) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) continue;
    baseHeaders[k] = v;
  }
  baseHeaders["User-Agent"] = BROWSER_UA;
  const node = isNode();
  let cookie = null;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    checkDownloadHost(current);
    const headers = { ...baseHeaders };
    if (node && cookie) headers["Cookie"] = cookie;
    let response = await fetchRetrying(
      current,
      node ? { headers, redirect: "manual" } : { headers }
    );
    if (node) {
      let redirects = 0;
      while (response.status >= 300 && response.status < 400 && redirects < MAX_HOPS) {
        const location = response.headers.get("location");
        if (!location) break;
        const next = new URL(location, current).toString();
        checkDownloadHost(next);
        const setCookie2 = extractCookie(response);
        if (setCookie2) cookie = cookie ? `${cookie}; ${setCookie2}` : setCookie2;
        const hopHeaders = { ...baseHeaders };
        if (cookie) hopHeaders["Cookie"] = cookie;
        current = next;
        response = await fetchRetrying(current, {
          headers: hopHeaders,
          redirect: "manual"
        });
        redirects++;
      }
      const setCookie = extractCookie(response);
      if (setCookie) cookie = cookie ? `${cookie}; ${setCookie}` : setCookie;
    }
    if (!response.ok) {
      raiseRemote(current, void 0, response.status);
    }
    const contentDisposition = response.headers.get("Content-Disposition");
    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentDisposition || !contentType.startsWith("text/html")) {
      return readBodyCapped(response, maxBytes, current);
    }
    const html = await response.text();
    current = urlFromConfirmation(html, current);
  }
  throw new RemoteIOError({
    message: `Google Drive download did not converge within ${MAX_HOPS} hops`,
    url,
    status: null
  });
}

export {
  DEFAULT_MAX_BYTES,
  parseGdrive,
  urlFromConfirmation,
  checkDownloadHost,
  openGdrive,
  URL_SCHEMES,
  CLOUD_SCHEMES,
  GDRIVE_HOSTS,
  SENSITIVE_HEADERS,
  SENSITIVE_QUERY_PARAMS,
  RETRYABLE_STATUSES,
  isUrl,
  isGdriveUrl,
  redactUrl,
  redactedCauseSummary,
  RemoteIOError,
  resolveUrl,
  statusToMessage,
  raiseRemote,
  identityHeaders,
  stripCrossOriginHeaders,
  withRetries,
  parseRetryAfterMs,
  fetchRetrying,
  headOrRangeProbe
};
