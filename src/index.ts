import {
  buildInternalPageAssetPath,
  buildRedirectResult,
  classifyPathname,
  getRouteCacheKey,
  mergeRedirectUrl,
  type RouteRecord,
} from "./router.ts";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ROOT_REDIRECT_URL: string;
}

export interface RouteCacheLike {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
}

const CACHE_TTL_SECONDS = 86400;

function getDefaultCache(): RouteCacheLike | null {
  try {
    const cacheStorage = (
      globalThis as { caches?: { default?: RouteCacheLike } }
    ).caches;
    return cacheStorage?.default ?? null;
  } catch {
    return null;
  }
}

async function serveNotFound(
  origin: string,
  env: Env,
  method: string,
): Promise<Response> {
  const notFoundUrl = new URL("/404.html", origin);
  const notFoundAsset = await env.ASSETS.fetch(
    new Request(notFoundUrl, { method: "GET" }),
  );
  const headers = new Headers(notFoundAsset.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "text/html; charset=UTF-8");
  }

  return new Response(method === "HEAD" ? null : notFoundAsset.body, {
    status: 404,
    headers,
  });
}

async function resolveRoute(
  slug: string,
  db: D1Database,
  routeCache: RouteCacheLike | null,
): Promise<RouteRecord | null> {
  const cacheKey = getRouteCacheKey(slug);

  if (routeCache) {
    try {
      const cached = await routeCache.match(cacheKey);
      if (cached) {
        return (await cached.json()) as RouteRecord;
      }
    } catch {
      // Fallback to D1 when Cache API fails or is unavailable
    }
  }

  const row = await db
    .prepare(
      "SELECT slug, type, target, status_code, active, track_hits FROM routes WHERE slug = ? LIMIT 1",
    )
    .bind(slug)
    .first<RouteRecord>();

  if (!row) {
    return null;
  }

  if (routeCache) {
    try {
      const cacheResponse = new Response(JSON.stringify(row), {
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS}`,
        },
      });
      await routeCache.put(cacheKey, cacheResponse);
    } catch {
      // Non-fatal: cache write failure must not break request handling
    }
  }

  return row;
}

async function incrementRouteHits(db: D1Database, slug: string): Promise<void> {
  try {
    await db
      .prepare(
        "UPDATE routes SET hits = hits + 1, last_hit_at = ? WHERE slug = ?",
      )
      .bind(new Date().toISOString(), slug)
      .run();
  } catch (error) {
    console.error("Failed to increment hits for slug:", slug, error);
  }
}

function scheduleHitIncrement(
  db: D1Database,
  slug: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): void {
  const updatePromise = incrementRouteHits(db, slug);
  if (ctx) {
    ctx.waitUntil(updatePromise);
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx?: Pick<ExecutionContext, "waitUntil">,
  routeCache: RouteCacheLike | null = getDefaultCache(),
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const url = new URL(request.url);
  const classification = classifyPathname(url.pathname);

  if (classification.kind === "root") {
    const location = mergeRedirectUrl(env.ROOT_REDIRECT_URL, url.search);
    return new Response(null, {
      status: 301,
      headers: { Location: location },
    });
  }

  if (classification.kind === "blocked") {
    return serveNotFound(url.origin, env, request.method);
  }

  if (classification.kind === "global_asset") {
    const assetUrl = new URL(classification.assetPath, url.origin);
    const assetResponse = await env.ASSETS.fetch(
      new Request(assetUrl, {
        method: request.method,
        headers: request.headers,
      }),
    );

    if (assetResponse.status === 404) {
      return serveNotFound(url.origin, env, request.method);
    }

    return assetResponse;
  }

  const route = await resolveRoute(classification.slug, env.DB, routeCache);
  if (!route || route.active !== 1) {
    return serveNotFound(url.origin, env, request.method);
  }

  if (route.type === "redirect") {
    if (classification.subpath !== "") {
      return serveNotFound(url.origin, env, request.method);
    }

    if (route.track_hits === 1 && request.method === "GET") {
      scheduleHitIncrement(env.DB, route.slug, ctx);
    }

    const redirect = buildRedirectResult(
      route.target,
      route.status_code,
      url.search,
    );

    return new Response(null, {
      status: redirect.status,
      headers: {
        Location: redirect.location,
        "Cache-Control": redirect.cacheControl,
      },
    });
  }

  const internalPath = buildInternalPageAssetPath(
    route.target,
    classification.subpath,
  );
  const assetResponse = await env.ASSETS.fetch(
    new Request(new URL(internalPath, url.origin), {
      method: request.method,
      headers: request.headers,
    }),
  );

  if (assetResponse.status === 404) {
    return serveNotFound(url.origin, env, request.method);
  }

  if (
    route.track_hits === 1 &&
    request.method === "GET" &&
    classification.subpath === ""
  ) {
    scheduleHitIncrement(env.DB, route.slug, ctx);
  }

  return new Response(
    request.method === "HEAD" ? null : assetResponse.body,
    {
      status: assetResponse.status,
      headers: assetResponse.headers,
    },
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
