import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import worker, { handleRequest, type Env, type RouteCacheLike } from "./index.ts";
import type { RouteRecord } from "./router.ts";

interface StoredRoute extends RouteRecord {
  hits: number;
  last_hit_at: string | null;
}

function createFakeDb(initialRoutes: StoredRoute[]) {
  const routes = new Map<string, StoredRoute>(
    initialRoutes.map((route) => [route.slug, { ...route }]),
  );
  let selectCount = 0;
  let updateCount = 0;

  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>() {
              if (sql.startsWith("SELECT ")) {
                selectCount += 1;
                const slug = String(params[0]);
                const row = routes.get(slug);
                return (row ? { ...row } : null) as T | null;
              }
              return null;
            },
            async run() {
              if (sql.startsWith("UPDATE routes SET hits = hits + 1")) {
                updateCount += 1;
                const timestamp = String(params[0]);
                const slug = String(params[1]);
                const existing = routes.get(slug);
                if (existing) {
                  existing.hits += 1;
                  existing.last_hit_at = timestamp;
                }
              }
              return { success: true };
            },
          };
        },
      };
    },
  };

  return {
    db: db as unknown as D1Database,
    getSelectCount: () => selectCount,
    getUpdateCount: () => updateCount,
    getRoute: (slug: string) => routes.get(slug),
  };
}

function createFakeAssets(files: Record<string, { body: string; contentType: string }>) {
  const requestedPaths: string[] = [];

  const assets = {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input);
      const pathname = new URL(request.url).pathname;
      requestedPaths.push(pathname);

      const file = files[pathname];
      if (!file) {
        return new Response("Not Found", { status: 404 });
      }

      return new Response(request.method === "HEAD" ? null : file.body, {
        status: 200,
        headers: { "Content-Type": file.contentType },
      });
    },
  };

  return {
    assets: assets as unknown as Fetcher,
    requestedPaths,
  };
}

function createFakeCache(): RouteCacheLike & { size: () => number } {
  const store = new Map<string, Response>();

  return {
    async match(input: RequestInfo | URL): Promise<Response | undefined> {
      const key = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const hit = store.get(key);
      return hit ? hit.clone() : undefined;
    },
    async put(input: RequestInfo | URL, response: Response): Promise<void> {
      const key = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      store.set(key, response.clone());
    },
    size: () => store.size,
  };
}

function createFakeContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
  };

  return {
    ctx: ctx as unknown as ExecutionContext,
    flush: async () => {
      await Promise.all(pending);
    },
    pendingCount: () => pending.length,
  };
}

const originalCaches = (globalThis as { caches?: unknown }).caches;

afterEach(() => {
  if (originalCaches === undefined) {
    delete (globalThis as { caches?: unknown }).caches;
  } else {
    (globalThis as { caches?: unknown }).caches = originalCaches;
  }
});

describe("Edge Router Worker (src/index.ts)", () => {
  const defaultFiles = {
    "/404.html": { body: "<h1>404 Custom</h1>", contentType: "text/html; charset=UTF-8" },
    "/_assets/logo.svg": { body: "<svg></svg>", contentType: "image/svg+xml" },
    "/_pages/mentoria-v1/index.html": {
      body: "<h1>Mentoria</h1>",
      contentType: "text/html; charset=UTF-8",
    },
    "/_pages/mentoria-v1/styles.css": {
      body: "body { color: #fff; }",
      contentType: "text/css; charset=UTF-8",
    },
  };

  it("redireciona a rota raiz com 301 e preserva query params", async () => {
    const dbMock = createFakeDb([]);
    const assetsMock = createFakeAssets(defaultFiles);
    const cache = createFakeCache();
    (globalThis as { caches?: unknown }).caches = { default: cache };
    const ctxMock = createFakeContext();

    const env: Env = {
      ASSETS: assetsMock.assets,
      DB: dbMock.db,
      ROOT_REDIRECT_URL: "https://elielvalenca.com",
    };

    const resRoot = await worker.fetch(
      new Request("https://eliel.page/") as unknown as Parameters<typeof worker.fetch>[0],
      env,
      ctxMock.ctx,
    );
    assert.equal(resRoot.status, 301);
    assert.equal(resRoot.headers.get("Location"), "https://elielvalenca.com/");

    const resUtm = await worker.fetch(
      new Request("https://eliel.page/?utm_source=bio") as unknown as Parameters<typeof worker.fetch>[0],
      env,
      ctxMock.ctx,
    );
    assert.equal(resUtm.status, 301);
    assert.equal(
      resUtm.headers.get("Location"),
      "https://elielvalenca.com/?utm_source=bio",
    );
    assert.equal(dbMock.getSelectCount(), 0);
  });

  it("retorna 405 para métodos não suportados", async () => {
    const dbMock = createFakeDb([]);
    const assetsMock = createFakeAssets(defaultFiles);
    const env: Env = {
      ASSETS: assetsMock.assets,
      DB: dbMock.db,
      ROOT_REDIRECT_URL: "https://elielvalenca.com",
    };

    const res = await handleRequest(
      new Request("https://eliel.page/matriz", { method: "POST" }),
      env,
      undefined,
      null,
    );
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("Allow"), "GET, HEAD");
  });

  it("bloqueia acesso direto a /_pages/* e /404.html com status 404", async () => {
    const dbMock = createFakeDb([]);
    const assetsMock = createFakeAssets(defaultFiles);
    const env: Env = {
      ASSETS: assetsMock.assets,
      DB: dbMock.db,
      ROOT_REDIRECT_URL: "https://elielvalenca.com",
    };

    for (const path of ["/_pages/", "/_pages/mentoria-v1/index.html", "/404.html"]) {
      const res = await handleRequest(
        new Request(`https://eliel.page${path}`),
        env,
        undefined,
        null,
      );
      assert.equal(res.status, 404);
      assert.equal(res.headers.get("Content-Type"), "text/html; charset=UTF-8");
      assert.equal(await res.text(), "<h1>404 Custom</h1>");
    }
  });

  it("entrega assets globais de /_assets/* e retorna 404 customizado quando ausente", async () => {
    const dbMock = createFakeDb([]);
    const assetsMock = createFakeAssets(defaultFiles);
    const env: Env = {
      ASSETS: assetsMock.assets,
      DB: dbMock.db,
      ROOT_REDIRECT_URL: "https://elielvalenca.com",
    };

    const okRes = await handleRequest(
      new Request("https://eliel.page/_assets/logo.svg"),
      env,
      undefined,
      null,
    );
    assert.equal(okRes.status, 200);
    assert.equal(await okRes.text(), "<svg></svg>");

    const missingRes = await handleRequest(
      new Request("https://eliel.page/_assets/nao-existe.css"),
      env,
      undefined,
      null,
    );
    assert.equal(missingRes.status, 404);
    assert.equal(await missingRes.text(), "<h1>404 Custom</h1>");
  });

  it("retorna 404 para rota inexistente ou inativa (active = 0)", async () => {
    const dbMock = createFakeDb([
      {
        slug: "pausada",
        type: "redirect",
        target: "https://elielvalenca.com/x",
        status_code: 301,
        active: 0,
        track_hits: 0,
        hits: 0,
        last_hit_at: null,
      },
    ]);
    const assetsMock = createFakeAssets(defaultFiles);
    const cache = createFakeCache();
    const env: Env = {
      ASSETS: assetsMock.assets,
      DB: dbMock.db,
      ROOT_REDIRECT_URL: "https://elielvalenca.com",
    };

    const notFound = await handleRequest(
      new Request("https://eliel.page/inexistente"),
      env,
      undefined,
      cache,
    );
    assert.equal(notFound.status, 404);

    const inactive = await handleRequest(
      new Request("https://eliel.page/pausada"),
      env,
      undefined,
      cache,
    );
    assert.equal(inactive.status, 404);
    assert.equal(await inactive.text(), "<h1>404 Custom</h1>");
  });

  it("usa cache hit na segunda requisição sem consultar D1 novamente", async () => {
    const dbMock = createFakeDb([
      {
        slug: "matriz",
        type: "redirect",
        target: "https://elielvalenca.com/artigo?ref=bio",
        status_code: 301,
        active: 1,
        track_hits: 0,
        hits: 0,
        last_hit_at: null,
      },
    ]);
    const assetsMock = createFakeAssets(defaultFiles);
    const cache = createFakeCache();
    const env: Env = {
      ASSETS: assetsMock.assets,
      DB: dbMock.db,
      ROOT_REDIRECT_URL: "https://elielvalenca.com",
    };

    const first = await handleRequest(
      new Request("https://eliel.page/matriz?utm_source=live&ref=youtube"),
      env,
      undefined,
      cache,
    );
    assert.equal(first.status, 301);
    assert.equal(
      first.headers.get("Location"),
      "https://elielvalenca.com/artigo?ref=youtube&utm_source=live",
    );
    assert.equal(
      first.headers.get("Cache-Control"),
      "public, max-age=3600, s-maxage=86400",
    );
    assert.equal(dbMock.getSelectCount(), 1);
    assert.equal(cache.size(), 1);

    const second = await handleRequest(
      new Request("https://eliel.page/matriz?utm_source=whatsapp"),
      env,
      undefined,
      cache,
    );
    assert.equal(second.status, 301);
    assert.equal(
      second.headers.get("Location"),
      "https://elielvalenca.com/artigo?ref=bio&utm_source=whatsapp",
    );
    assert.equal(dbMock.getSelectCount(), 1);
    assert.equal(dbMock.getUpdateCount(), 0);
  });

  it("suporta redirecionamento 302 e retorna 404 em subpath de redirect", async () => {
    const dbMock = createFakeDb([
      {
        slug: "live",
        type: "redirect",
        target: "https://youtube.com/live/abc",
        status_code: 302,
        active: 1,
        track_hits: 0,
        hits: 0,
        last_hit_at: null,
      },
    ]);
    const assetsMock = createFakeAssets(defaultFiles);
    const env: Env = {
      ASSETS: assetsMock.assets,
      DB: dbMock.db,
      ROOT_REDIRECT_URL: "https://elielvalenca.com",
    };

    const ok = await handleRequest(
      new Request("https://eliel.page/live"),
      env,
      undefined,
      null,
    );
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get("Location"), "https://youtube.com/live/abc");
    assert.equal(ok.headers.get("Cache-Control"), "public, max-age=0, s-maxage=3600");

    const withSubpath = await handleRequest(
      new Request("https://eliel.page/live/extra"),
      env,
      undefined,
      null,
    );
    assert.equal(withSubpath.status, 404);
  });

  it("faz rewrite interno de páginas e sub-recursos sem expor /_pages/", async () => {
    const dbMock = createFakeDb([
      {
        slug: "mentoria",
        type: "page",
        target: "mentoria-v1",
        status_code: 301,
        active: 1,
        track_hits: 1,
        hits: 0,
        last_hit_at: null,
      },
    ]);
    const assetsMock = createFakeAssets(defaultFiles);
    const cache = createFakeCache();
    const ctxMock = createFakeContext();
    const env: Env = {
      ASSETS: assetsMock.assets,
      DB: dbMock.db,
      ROOT_REDIRECT_URL: "https://elielvalenca.com",
    };

    const pageRes = await handleRequest(
      new Request("https://eliel.page/mentoria"),
      env,
      ctxMock.ctx,
      cache,
    );
    assert.equal(pageRes.status, 200);
    assert.equal(await pageRes.text(), "<h1>Mentoria</h1>");
    assert.deepEqual(assetsMock.requestedPaths, ["/_pages/mentoria-v1/index.html"]);

    const cssRes = await handleRequest(
      new Request("https://eliel.page/mentoria/styles.css"),
      env,
      ctxMock.ctx,
      cache,
    );
    assert.equal(cssRes.status, 200);
    assert.equal(await cssRes.text(), "body { color: #fff; }");

    const headRes = await handleRequest(
      new Request("https://eliel.page/mentoria/", { method: "HEAD" }),
      env,
      ctxMock.ctx,
      cache,
    );
    assert.equal(headRes.status, 200);
    assert.equal(await headRes.text(), "");

    const missingAssetRes = await handleRequest(
      new Request("https://eliel.page/mentoria/missing.js"),
      env,
      ctxMock.ctx,
      cache,
    );
    assert.equal(missingAssetRes.status, 404);

    await ctxMock.flush();
    assert.equal(ctxMock.pendingCount(), 1);
    assert.equal(dbMock.getUpdateCount(), 1);
    assert.equal(dbMock.getRoute("mentoria")?.hits, 1);
    assert.ok(dbMock.getRoute("mentoria")?.last_hit_at);
  });

  it("resiste a falhas na Cache API com fallback para o D1", async () => {
    const dbMock = createFakeDb([
      {
        slug: "matriz",
        type: "redirect",
        target: "https://elielvalenca.com/matriz",
        status_code: 301,
        active: 1,
        track_hits: 1,
        hits: 0,
        last_hit_at: null,
      },
    ]);
    const assetsMock = createFakeAssets(defaultFiles);
    const brokenCache: RouteCacheLike = {
      async match() {
        throw new Error("cache read failed");
      },
      async put() {
        throw new Error("cache write failed");
      },
    };
    const ctxMock = createFakeContext();
    const env: Env = {
      ASSETS: assetsMock.assets,
      DB: dbMock.db,
      ROOT_REDIRECT_URL: "https://elielvalenca.com",
    };

    const res = await handleRequest(
      new Request("https://eliel.page/matriz"),
      env,
      ctxMock.ctx,
      brokenCache,
    );
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://elielvalenca.com/matriz");
    await ctxMock.flush();
    assert.equal(dbMock.getRoute("matriz")?.hits, 1);
  });
});
