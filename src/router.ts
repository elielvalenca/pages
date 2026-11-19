export type RouteType = "redirect" | "page";

export type RedirectStatusCode = 301 | 302;

export interface RouteRecord {
  slug: string;
  type: RouteType;
  target: string;
  status_code: RedirectStatusCode;
  active: 0 | 1;
  track_hits: 0 | 1;
}

export type PathClassification =
  | { kind: "root" }
  | { kind: "blocked" }
  | { kind: "global_asset"; assetPath: string }
  | { kind: "route"; slug: string; subpath: string };

export type ParsedPath = PathClassification;

export interface RedirectResult {
  location: string;
  status: RedirectStatusCode;
  cacheControl: string;
}

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * Checks whether a pathname contains path traversal segments, encoded slashes,
 * backslashes, control characters, or malformed empty segments.
 */
export function hasUnsafePathSegment(pathname: string): boolean {
  if (!pathname || pathname.includes("\\") || CONTROL_CHARS_RE.test(pathname)) {
    return true;
  }

  if (pathname.includes("//")) {
    return true;
  }

  const trimmed = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (trimmed === "") {
    return false;
  }

  const segments = trimmed.endsWith("/")
    ? trimmed.slice(0, -1).split("/")
    : trimmed.split("/");

  for (const rawSegment of segments) {
    if (rawSegment === "" || rawSegment === "." || rawSegment === "..") {
      return true;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      return true;
    }

    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      CONTROL_CHARS_RE.test(decoded)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Classifies a request pathname into root, blocked internal path,
 * global shared asset, or dynamic route slug + optional subpath.
 */
export function classifyPathname(pathname: string): PathClassification {
  if (pathname === "" || pathname === "/") {
    return { kind: "root" };
  }

  if (hasUnsafePathSegment(pathname)) {
    return { kind: "blocked" };
  }

  if (
    pathname === "/404.html" ||
    pathname === "/_pages" ||
    pathname.startsWith("/_pages/")
  ) {
    return { kind: "blocked" };
  }

  if (pathname === "/_assets" || pathname === "/_assets/") {
    return { kind: "blocked" };
  }

  if (pathname.startsWith("/_assets/")) {
    return { kind: "global_asset", assetPath: pathname };
  }

  const withoutLeading = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  const slashIndex = withoutLeading.indexOf("/");

  if (slashIndex === -1) {
    return { kind: "route", slug: withoutLeading, subpath: "" };
  }

  const slug = withoutLeading.slice(0, slashIndex);
  const subpath = withoutLeading.slice(slashIndex + 1);

  if (!slug) {
    return { kind: "blocked" };
  }

  return { kind: "route", slug, subpath };
}

/**
 * Merges incoming query parameters into targetUrl, letting incoming parameters
 * override matching keys already present in targetUrl.
 */
export function mergeRedirectUrl(targetUrl: string, requestSearch: string): string {
  const target = new URL(targetUrl);

  if (!requestSearch || requestSearch === "?") {
    return target.toString();
  }

  const incoming = new URLSearchParams(requestSearch);
  const uniqueKeys = new Set(incoming.keys());

  for (const key of uniqueKeys) {
    const values = incoming.getAll(key);
    if (values.length === 1) {
      target.searchParams.set(key, values[0]);
      continue;
    }

    target.searchParams.delete(key);
    for (const value of values) {
      target.searchParams.append(key, value);
    }
  }

  return target.toString();
}

/**
 * Returns the Cache-Control header value for a redirect status code.
 */
export function getRedirectCacheControl(statusCode: number): string {
  return statusCode === 302
    ? "public, max-age=0, s-maxage=3600"
    : "public, max-age=3600, s-maxage=86400";
}

/**
 * Builds the redirect Location, status code, and Cache-Control header.
 */
export function buildRedirectResult(
  targetUrl: string,
  statusCode: RedirectStatusCode,
  requestSearch: string,
): RedirectResult {
  return {
    location: mergeRedirectUrl(targetUrl, requestSearch),
    status: statusCode,
    cacheControl: getRedirectCacheControl(statusCode),
  };
}

/**
 * Resolves the internal static asset path inside /_pages/<targetFolder>/.
 */
export function buildInternalPageAssetPath(
  targetFolder: string,
  subpath: string,
): string {
  if (subpath === "") {
    return `/_pages/${targetFolder}/index.html`;
  }

  if (subpath.endsWith("/")) {
    return `/_pages/${targetFolder}/${subpath}index.html`;
  }

  return `/_pages/${targetFolder}/${subpath}`;
}

/**
 * Builds the synthetic Cache API key used to cache route metadata per slug.
 */
export function getRouteCacheKey(slug: string): string {
  return `https://cache.eliel.page/_routes/${encodeURIComponent(slug)}`;
}
