# AGENTS.md

Instruções mínimas e diretrizes arquiteturais para desenvolvimento do projeto **pages** (`eliel.page`).

---

## 1. Visão Geral do Projeto (`eliel.page`)

Plataforma unificada de **encurtador de links / redirecionamentos** e **hospedagem de landing pages estáticas** sob o mesmo namespace raiz (`https://eliel.page/<slug>`), sem prefixos de URL.

- **Raiz (`GET /`)**: Redireciona (`301`) para `https://elielvalenca.com`.
- **Rotas inexistentes ou inativas (`active = 0`)**: Retornam a página `404` minimalista estática (`public/404.html`) com status HTTP `404`.
- **Especificação inicial**: Consultar [SPEC.md](./SPEC.md) para contexto de negócio e objetivos originais.

---

## 2. Arquitetura e Stack Tecnológica

- **Serviço Único na Borda**: **Cloudflare Workers + Static Assets** com `run_worker_first = true` e binding `env.ASSETS`.
- **Runtime e Linguagem**:
  - **Worker**: TypeScript executado no `workerd` (com `nodejs_compat`).
  - **Tooling / CLI local**: **Node.js 24** (`v24.x`) com suporte nativo a TypeScript para scripts de automação e gestão.
- **Banco de Dados e Cache**:
  - **Cloudflare D1 (SQLite na borda)** como fonte de verdade das rotas.
  - **Cloudflare Cache API (`caches.default`)** no Worker para servir hits com latência `< 1ms` e minimizar leituras no D1.
- **Landing Pages Estáticas**: Pastas independentes em HTML/CSS/JS puro dentro de `public/_pages/<page-id>/index.html`.

---

## 3. Regras de Roteamento, Visibilidade e Cache

### Isolamento de Páginas (Gatekeeper)
- Nenhuma página em `public/_pages/<page-id>/` pode ser acessada diretamente pela URL física. Qualquer acesso direto a `/_pages/*` ou a pastas sem alias ativo deve retornar `404`.
- As páginas só ficam públicas sob o `slug` cadastrado e ativo (`active = 1`) no D1, servidas via rewrite interno (`env.ASSETS.fetch()`) preservando a URL limpa no navegador.

### Sub-recursos de Páginas
- Assets vinculados a uma página (ex.: `/<slug>/assets/...` ou arquivos relativos dentro de `public/_pages/<page-id>/`) e assets globais (`public/_assets/`) devem ser resolvidos internamente pelo Worker quando o alias estiver ativo.

### Semântica de Redirecionamento (`type = 'redirect'`)
- **Status HTTP**: `301` (Permanente) por padrão, com opção de `302` (Temporário) configurável por rota no cadastro.
- **Headers de Cache**:
  - Para `301`: `Cache-Control: public, max-age=3600, s-maxage=86400` (1h no browser para evitar travamento eterno caso o destino mude; 24h na borda da CDN).
  - Para `302`: `Cache-Control: public, max-age=0, s-maxage=3600`.
- **Merge de Query Params / UTMs**: Parâmetros de query recebidos na requisição (ex.: `?utm_source=live`) devem ser mesclados automaticamente na URL de destino (`target`), tendo precedência sobre parâmetros de mesmo nome já existentes no `target`.

### Contagem de Acessos Opcional (`track_hits`)
- **Padrão (`track_hits = 0`)**: Nenhuma escrita é feita no D1 durante os acessos para economizar recursos e custo.
- **Habilitada (`track_hits = 1`)**: O Worker incrementa `hits = hits + 1` e atualiza `last_hit_at` de forma assíncrona via `ctx.waitUntil()`, sem impactar a latência da resposta.

---

## 4. Modelo de Dados (Cloudflare D1)

Tabela única `routes`:

```sql
CREATE TABLE routes (
  slug TEXT PRIMARY KEY,                              -- Caminho sem barra inicial (ex: 'matriz', 'mentoria')
  type TEXT NOT NULL CHECK (type IN ('redirect', 'page')),
  target TEXT NOT NULL,                               -- URL completa de destino ou pasta em public/_pages/<target>
  status_code INTEGER NOT NULL DEFAULT 301,           -- 301 ou 302 (usado quando type = 'redirect')
  active INTEGER NOT NULL DEFAULT 1,                  -- 1 = ativo/público, 0 = inativo (retorna 404)
  track_hits INTEGER NOT NULL DEFAULT 0,              -- 1 = contabiliza acessos, 0 = não contabiliza
  hits INTEGER NOT NULL DEFAULT 0,                    -- Contador de acessos
  last_hit_at TEXT,                                   -- Timestamp ISO do último acesso contabilizado
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 5. Estrutura de Diretórios Esperada

```text
.
├── AGENTS.md                  # Este arquivo de diretrizes
├── SPEC.md                    # Especificação inicial do projeto
├── wrangler.jsonc             # Configuração do Worker, D1 e Static Assets (run_worker_first = true)
├── src/
│   ├── index.ts               # Entrypoint do Cloudflare Worker (roteamento, cache, merge de UTMs, rewrite)
│   ├── index.test.ts          # Testes unitários com dublês rápidos de D1/ASSETS/Cache
│   ├── worker.integration.test.ts # Testes de integração do Worker via Wrangler Test Harness
│   ├── router.ts              # Regras puras de parsing e decisão de rotas
│   └── router.test.ts         # Testes unitários do router
├── public/
│   ├── 404.html               # Página 404 minimalista
│   ├── _assets/               # Assets globais compartilhados (opcional)
│   └── _pages/
│       └── <page-id>/         # Landing pages estáticas isoladas (index.html, CSS, JS, imagens)
├── migrations/                # Migrations SQL do Cloudflare D1
└── scripts/                   # CLI local em Node.js 24 para gerenciar rotas no D1 e invalidar cache
                               # (pronta para integração futura via Skill/MCP)
```

---

## 6. Fluxo de Trabalho e Governança (OpenSpec)

- **Features**: Devem obrigatoriamente seguir o fluxo do **OpenSpec** (`openspec` CLI já instalada) — criar proposta/change e especificar antes de implementar.
- **Chores, Infra e Fixes**: Não precisam de change no OpenSpec; podem ser executados diretamente.

---

## 7. Estratégia de Testes e Qualidade

- **Testes Unitários (`npm run test:unit`)**:
  - Test runner nativo do Node.js 24 (`node:test`) sem dependências externas pesadas.
  - Testam regras puras de roteamento, classificação de URLs, sanitização contra path traversal, merge de UTMs e CLI local com execução em milissegundos.
- **Testes de Integração do Worker (`npm run test:integration`)**:
  - Utilizam o `createTestHarness` oficial do próprio Wrangler para subir o Worker local com bindings reais do D1 (aplicando migrations automaticamente) e Static Assets.
  - Validam ponta a ponta: redirects `301`/`302` com UTMs, rewrite limpo de páginas estáticas, bloqueio do gatekeeper (`/_pages/*`), sub-recursos e incremento assíncrono de acessos (`track_hits`).
- **Indicação Futura de Auditoria: Lighthouse CI**:
  - Para landing pages em `public/_pages/`, **não utilizar frameworks de browser E2E pesados como Playwright** a menos que surjam fluxos transacionais complexos no cliente.
  - Quando as primeiras landing pages forem publicadas, a recomendação arquitetural para garantir qualidade e taxa de conversão é adotar o **Lighthouse CI (`@lhci/cli`)**, automatizando auditorias de:
    - **Core Web Vitals** (LCP < 2.5s, CLS < 0.1, INP < 200ms).
    - **SEO e Metatags** (Open Graph, Twitter Cards, canonical).
    - **Acessibilidade** (contraste, landmarks, hierarquia de tags).
    - **Performance e Peso de Assets** (compressão de imagens, CSS enxuto).
