import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildInternalPageAssetPath,
  buildRedirectResult,
  classifyPathname,
  getRedirectCacheControl,
  getRouteCacheKey,
  hasUnsafePathSegment,
  mergeRedirectUrl,
} from "./router.ts";

describe("hasUnsafePathSegment", () => {
  it("rejeita traversal direto, codificado e barras invertidas", () => {
    assert.equal(hasUnsafePathSegment("/demo/../secret"), true);
    assert.equal(hasUnsafePathSegment("/demo/%2e%2e/secret"), true);
    assert.equal(hasUnsafePathSegment("/demo/%2E/secret"), true);
    assert.equal(hasUnsafePathSegment("/demo/foo%2fbar"), true);
    assert.equal(hasUnsafePathSegment("/demo\\secret"), true);
    assert.equal(hasUnsafePathSegment("/demo//sub"), true);
    assert.equal(hasUnsafePathSegment("/demo/%ZZ"), true);
    assert.equal(hasUnsafePathSegment("/demo/\u0000"), true);
  });

  it("aceita caminhos válidos", () => {
    assert.equal(hasUnsafePathSegment("/"), false);
    assert.equal(hasUnsafePathSegment("/matriz"), false);
    assert.equal(hasUnsafePathSegment("/mentoria/"), false);
    assert.equal(hasUnsafePathSegment("/mentoria/assets/hero.png"), false);
  });
});

describe("classifyPathname", () => {
  it("classifica raiz corretamente", () => {
    assert.deepEqual(classifyPathname("/"), { kind: "root" });
    assert.deepEqual(classifyPathname(""), { kind: "root" });
  });

  it("bloqueia caminhos internos, /404.html e traversal", () => {
    assert.deepEqual(classifyPathname("/_pages"), { kind: "blocked" });
    assert.deepEqual(classifyPathname("/_pages/"), { kind: "blocked" });
    assert.deepEqual(classifyPathname("/_pages/mentoria/index.html"), {
      kind: "blocked",
    });
    assert.deepEqual(classifyPathname("/404.html"), { kind: "blocked" });
    assert.deepEqual(classifyPathname("/_assets"), { kind: "blocked" });
    assert.deepEqual(classifyPathname("/_assets/"), { kind: "blocked" });
    assert.deepEqual(classifyPathname("/mentoria/../_pages/x"), {
      kind: "blocked",
    });
  });

  it("classifica assets globais em /_assets/", () => {
    assert.deepEqual(classifyPathname("/_assets/logo.svg"), {
      kind: "global_asset",
      assetPath: "/_assets/logo.svg",
    });
  });

  it("extrai slug e subpath de rotas dinâmicas", () => {
    assert.deepEqual(classifyPathname("/matriz"), {
      kind: "route",
      slug: "matriz",
      subpath: "",
    });
    assert.deepEqual(classifyPathname("/mentoria/"), {
      kind: "route",
      slug: "mentoria",
      subpath: "",
    });
    assert.deepEqual(classifyPathname("/mentoria/styles.css"), {
      kind: "route",
      slug: "mentoria",
      subpath: "styles.css",
    });
    assert.deepEqual(classifyPathname("/mentoria/assets/hero.png"), {
      kind: "route",
      slug: "mentoria",
      subpath: "assets/hero.png",
    });
  });
});

describe("mergeRedirectUrl", () => {
  it("mantém URL intacta quando não há query na requisição", () => {
    assert.equal(
      mergeRedirectUrl("https://elielvalenca.com/artigo?ref=bio", ""),
      "https://elielvalenca.com/artigo?ref=bio",
    );
  });

  it("mescla UTMs dando precedência aos parâmetros recebidos na requisição", () => {
    assert.equal(
      mergeRedirectUrl(
        "https://elielvalenca.com/artigo?ref=bio",
        "?utm_source=live&ref=youtube",
      ),
      "https://elielvalenca.com/artigo?ref=youtube&utm_source=live",
    );
  });

  it("suporta múltiplos valores para o mesmo parâmetro na requisição", () => {
    assert.equal(
      mergeRedirectUrl(
        "https://elielvalenca.com/?tag=old",
        "?tag=a&tag=b&utm_medium=social",
      ),
      "https://elielvalenca.com/?tag=a&tag=b&utm_medium=social",
    );
  });
});

describe("helpers de cache, redirect e paths internos", () => {
  it("gera headers Cache-Control diferenciados para 301 e 302", () => {
    assert.equal(
      getRedirectCacheControl(301),
      "public, max-age=3600, s-maxage=86400",
    );
    assert.equal(
      getRedirectCacheControl(302),
      "public, max-age=0, s-maxage=3600",
    );
  });

  it("constrói RedirectResult completo", () => {
    assert.deepEqual(
      buildRedirectResult(
        "https://youtube.com/live/abc",
        302,
        "?utm_source=whatsapp",
      ),
      {
        location: "https://youtube.com/live/abc?utm_source=whatsapp",
        status: 302,
        cacheControl: "public, max-age=0, s-maxage=3600",
      },
    );
  });

  it("resolve caminhos internos dentro de /_pages/<target>", () => {
    assert.equal(
      buildInternalPageAssetPath("mentoria-v1", ""),
      "/_pages/mentoria-v1/index.html",
    );
    assert.equal(
      buildInternalPageAssetPath("mentoria-v1", "styles.css"),
      "/_pages/mentoria-v1/styles.css",
    );
    assert.equal(
      buildInternalPageAssetPath("mentoria-v1", "docs/"),
      "/_pages/mentoria-v1/docs/index.html",
    );
  });

  it("gera chave sintética de cache por slug", () => {
    assert.equal(
      getRouteCacheKey("meu slug"),
      "https://cache.eliel.page/_routes/meu%20slug",
    );
  });
});
