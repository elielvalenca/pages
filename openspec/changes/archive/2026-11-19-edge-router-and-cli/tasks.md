# Tasks

## 1. Lógica pura de roteamento e merge de UTMs

- [x] 1.1 Atualizar `tsconfig.json` para habilitar `allowImportingTsExtensions` (compatível com `noEmit: true` e execução direta de arquivos `.ts` no Node.js 24) e verificar que `npm run typecheck` passa sem erros.
- [x] 1.2 Criar `src/router.ts` com os tipos de domínio (`RouteRecord`, `ParsedPath`, `RedirectResult`), classificação de caminhos reservados/gatekeeper (`/_pages`, `/_pages/*`, `/404.html`, `/_assets/*`), extração segura de `slug` e `subpath` (rejeitando path traversal com `..` ou `\`), geração de `Cache-Control` para `301`/`302` e função de merge de query params/UTMs (incluindo precedência dos parâmetros da requisição e raiz `/`); verificar exportação tipada via `npm run typecheck`.
- [x] 1.3 Criar `src/router.test.ts` usando `node:test` e `node:assert/strict` cobrindo normalização de `slug`/`subpath`, bloqueio de caminhos internos e traversal, headers de cache `301`/`302` e precedência no merge de UTMs; verificar que `npm test` executa e aprova todos os casos.

## 2. Edge Router no Cloudflare Worker (`src/index.ts`)

- [x] 2.1 Implementar o handler completo em `src/index.ts` integrando `caches.default` (chave sintética `https://cache.eliel.page/_routes/<slug>` com fallback resiliente), consulta ao D1 (`env.DB`), bloqueio `405` para métodos diferentes de `GET`/`HEAD`, gatekeeper `404` para `/_pages/*` e `/404.html`, entrega direta de `/_assets/*`, redirects `301`/`302`, rewrite interno de páginas (`/_pages/<target>/index.html` e sub-recursos `/_pages/<target>/<subpath>`) e incremento assíncrono opcional de `hits` e `last_hit_at` via `ctx.waitUntil()` apenas quando `track_hits === 1` e `GET` no slug principal; verificar compilação com `npm run typecheck`.
- [x] 2.2 Criar `src/index.test.ts` testando o entrypoint `fetch` com dublês leves de `DB`, `ASSETS`, `ExecutionContext` (`waitUntil`) e `ROOT_REDIRECT_URL`, cobrindo raiz `/`, bloqueio `/_pages/*`, `/_assets/*`, cache hit/miss, `active = 0`, redirects `301`/`302` com UTMs, rewrite de página e sub-recurso, e disparo condicional de `track_hits`; verificar aprovação com `npm test`.

## 3. CLI local de gestão de rotas (`scripts/routes.ts`)

- [x] 3.1 Criar `scripts/routes.ts` (e helper testável de parsing/validação/SQL) em TypeScript compatível com Node.js 24, implementando os subcomandos `add`, `list` (tabular e `--json`), `enable`, `disable` e `delete`, validação de slugs reservados/URLs, verificação de `public/_pages/<target>/index.html` para `type=page` (com opção `--skip-asset-check`), escaping seguro de literais SQL e suporte a `--local` (padrão) e `--remote`; adicionar `"route": "node scripts/routes.ts"` ao `package.json` e verificar tipagem via `npm run typecheck`.
- [x] 3.2 Criar `scripts/routes.test.ts` cobrindo parsing de argumentos da CLI, rejeição de slugs reservados e targets inválidos, validação de existência de pasta em `public/_pages/`, geração/escaping de SQL e comportamento de erro para comandos inválidos; verificar aprovação via `npm test`.
- [x] 3.3 Criar página estática mínima de exemplo em `public/_pages/demo/index.html` (com link/referência demonstrando `/_assets/` ou `/demo/...`) e validar o cadastro via `npm run route -- add demo --type page --target demo` e listagem via `npm run route -- list`.

## 4. Validação integrada local

- [x] 4.1 Executar a suíte completa (`npm run typecheck` e `npm test`) e verificar que todos os testes unitários e verificações de tipo passam sem avisos ou falhas.
- [x] 4.2 Validar o ciclo completo na CLI contra o D1 local (`add` de `redirect` com `301`/`302` e `--track-hits`, `add` de `page`, `list`, `disable`, `enable` e `delete` para limpar dados temporários se desejado) e confirmar persistência correta no banco local via `npm run route -- list --json`.

## Workflow follow-up

- Após revisão e aprovação da implementação, executar `/opsx-archive` para sincronizar as specs em `openspec/specs/` e arquivar a change `edge-router-and-cli`.
