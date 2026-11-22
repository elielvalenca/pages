import assert from "node:assert/strict";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type { TestHarness } from "wrangler";

// Garantir caminhos graváveis e silenciar logs desnecessários na suíte de testes
process.env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || "/tmp/.config";
process.env.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME || "/tmp/.cache";
process.env.WRANGLER_LOG = process.env.WRANGLER_LOG || "none";

describe("Worker Integration Tests (Wrangler Test Harness)", () => {
  let server: TestHarness;
  let env: {
    DB: D1Database;
    ROOT_REDIRECT_URL: string;
  };
  let createdTempConfig = false;

  before(async () => {
    // Se wrangler.jsonc não existir (ex: clone limpo de template), gerar temporariamente a partir de wrangler.jsonc.example
    if (!existsSync("./wrangler.jsonc") && existsSync("./wrangler.jsonc.example")) {
      copyFileSync("./wrangler.jsonc.example", "./wrangler.jsonc");
      createdTempConfig = true;
    }

    const { createTestHarness } = await import("wrangler");

    server = createTestHarness({
      workers: [{ configPath: "./wrangler.jsonc" }],
    });
    await server.listen();

    const worker = server.getWorker("eliel-pages");
    await worker.applyD1Migrations("DB");

    env = (await worker.getEnv()) as unknown as typeof env;

    // Seed das rotas de teste diretamente no D1 da instância local
    await env.DB.prepare(
      `INSERT INTO routes (slug, type, target, status_code, active, track_hits)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind("matriz", "redirect", "https://viabilityengineering.com", 301, 1, 1)
      .run();

    await env.DB.prepare(
      `INSERT INTO routes (slug, type, target, status_code, active, track_hits)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind("demo", "page", "demo", 301, 1, 0)
      .run();

    await env.DB.prepare(
      `INSERT INTO routes (slug, type, target, status_code, active, track_hits)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind("inativa", "redirect", "https://example.com", 301, 0, 0)
      .run();
  });

  after(async () => {
    if (server) {
      await server.close();
    }
    if (createdTempConfig && existsSync("./wrangler.jsonc")) {
      try {
        unlinkSync("./wrangler.jsonc");
      } catch {
        // Ignorar se já removido
      }
    }
  });

  it("redireciona a rota raiz (301) para o destino configurado preservando query params", async () => {
    const response = await server.fetch("http://eliel.page/?origem=newsletter", {
      redirect: "manual",
    });

    assert.equal(response.status, 301);
    assert.equal(
      response.headers.get("Location"),
      "https://elielvalenca.com/?origem=newsletter"
    );
  });

  it("executa redirect cadastrado no D1 com merge de parâmetros UTM", async () => {
    const response = await server.fetch(
      "http://eliel.page/matriz?utm_source=campaign&utm_medium=email",
      { redirect: "manual" }
    );

    assert.equal(response.status, 301);
    assert.equal(
      response.headers.get("Location"),
      "https://viabilityengineering.com/?utm_source=campaign&utm_medium=email"
    );
    assert.ok(response.headers.get("Cache-Control")?.includes("s-maxage=86400"));
  });

  it("serve a landing page estática em public/_pages/demo/index.html preservando a URL amigável", async () => {
    const response = await server.fetch("http://eliel.page/demo", {
      redirect: "manual",
    });

    assert.equal(response.status, 200);
    const contentType = response.headers.get("Content-Type") || "";
    assert.ok(contentType.includes("text/html"));

    const html = await response.text();
    assert.ok(html.includes("Página de demonstração"));
    assert.ok(html.includes("Demo — eliel.page"));
  });

  it("resolve sub-recursos da landing page (como style.css)", async () => {
    const response = await server.fetch("http://eliel.page/demo/style.css", {
      redirect: "manual",
    });

    assert.equal(response.status, 200);
    const contentType = response.headers.get("Content-Type") || "";
    assert.ok(contentType.includes("text/css"));

    const css = await response.text();
    assert.ok(css.includes("--bg"));
  });

  it("bloqueia o acesso direto à estrutura interna public/_pages/ retornando 404", async () => {
    const response = await server.fetch(
      "http://eliel.page/_pages/demo/index.html",
      { redirect: "manual" }
    );

    assert.equal(response.status, 404);
  });

  it("retorna 404 estilizado para rota inexistente ou rota inativa", async () => {
    const resUnknown = await server.fetch("http://eliel.page/slug-inexistente", {
      redirect: "manual",
    });
    assert.equal(resUnknown.status, 404);

    const resInactive = await server.fetch("http://eliel.page/inativa", {
      redirect: "manual",
    });
    assert.equal(resInactive.status, 404);

    const body = await resInactive.text();
    assert.ok(body.includes("404"));
  });

  it("contabiliza acessos de forma assíncrona quando track_hits = 1", async () => {
    const beforeRow = await env.DB.prepare(
      "SELECT hits, last_hit_at FROM routes WHERE slug = ?"
    )
      .bind("matriz")
      .first<{ hits: number; last_hit_at: string | null }>();

    const initialHits = beforeRow?.hits ?? 0;

    const response = await server.fetch("http://eliel.page/matriz", {
      redirect: "manual",
    });
    assert.equal(response.status, 301);

    // Aguardar ciclo de background (waitUntil)
    await new Promise((resolve) => setTimeout(resolve, 150));

    const afterRow = await env.DB.prepare(
      "SELECT hits, last_hit_at FROM routes WHERE slug = ?"
    )
      .bind("matriz")
      .first<{ hits: number; last_hit_at: string | null }>();

    assert.equal((afterRow?.hits ?? 0), initialHits + 1);
    assert.ok(afterRow?.last_hit_at !== null);
  });
});
