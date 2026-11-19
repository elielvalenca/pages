# Proposal

## Why

O projeto `eliel.page` precisa unificar, sob o mesmo namespace raiz sem prefixos de URL (`https://eliel.page/<slug>`), dois serviços definidos na especificação: o encurtador de links com redirecionamento na borda e a hospedagem isolada de landing pages estáticas. Atualmente existe apenas o bootstrap inicial com redirecionamento da raiz e fallback `404`; falta implementar o roteador dinâmico na borda apoiado no D1/Cache API e uma CLI local em Node.js 24 para cadastrar e manter essas rotas com agilidade.

## What Changes

- Implementar o roteador na borda (`src/index.ts` e módulo auxiliar de lógica pura) no Cloudflare Worker com lookup em `caches.default` + fallback no Cloudflare D1 (`routes`), merge automático de query parameters/UTMs em redirecionamentos (`301` e `302`), isolamento (gatekeeper) de `public/_pages/*` e `/404.html`, rewrite interno via `env.ASSETS.fetch()` para landing pages e sub-recursos, resolução de assets compartilhados em `/_assets/*` e contagem assíncrona opcional de acessos (`track_hits = 1`) via `ctx.waitUntil()`.
- Implementar uma CLI local em Node.js 24 (`scripts/routes.ts`) com script `npm run route` para criar/atualizar (`add` / `upsert`), listar (`list`), ativar/desativar (`enable` / `disable`) e remover (`delete`) rotas no D1 (`--local` ou `--remote`), incluindo validação local da existência de `public/_pages/<target>/index.html` para rotas do tipo `page`.
- Adicionar testes unitários executáveis com `node --test` cobrindo parsing de caminhos, merge de UTMs/query params e regras de cache/roteamento, além de uma landing page estática mínima de exemplo para validação local do rewrite.

## Capabilities

### New Capabilities
- `edge-router`: Roteamento na borda via Cloudflare Worker + D1 + Cache API (`caches.default`), redirecionamentos `301`/`302` com merge de query params/UTMs, gatekeeper e rewrite interno de landing pages estáticas (`public/_pages/<target>/`) e sub-recursos, assets compartilhados (`/_assets/*`) e contagem assíncrona opcional de acessos (`track_hits`).
- `route-cli`: CLI local em Node.js 24 (`scripts/routes.ts`) para cadastrar, atualizar, listar, ativar/desativar e remover rotas na tabela `routes` do D1 (`--local` e `--remote`), validando páginas estáticas locais.

### Modified Capabilities
<!-- Nenhuma capability existente é modificada nesta change inicial. -->

## Impact

- **Worker (`src/index.ts` e novos módulos em `src/`)**: substituição do stub atual pelo roteador completo, passando a ler e atualizar a tabela `routes` no binding `env.DB` e usar `caches.default` e `env.ASSETS`.
- **CLI e Tooling (`scripts/routes.ts`, `package.json`)**: novo script `route` no `package.json` executando TypeScript diretamente no Node.js 24 e delegando queries SQL ao `wrangler d1 execute`.
- **Assets Estáticos (`public/_pages/`)**: inclusão de uma landing page mínima de exemplo para verificação local do isolamento e do rewrite interno.
- **Testes (`src/**/*.test.ts` ou `tests/`)**: cobertura unitária via `node --test` sem dependências externas adicionais.
