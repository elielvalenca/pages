# Design

## Context

O projeto já possui o bootstrap configurado com Cloudflare Workers + Static Assets (`run_worker_first = true` e binding `ASSETS`), D1 (`DB`) com a tabela `routes` (`migrations/0001_create_routes_table.sql`), Node.js 24 e `wrangler.jsonc`. Veja `proposal.md` para a motivação e `specs/edge-router/spec.md` e `specs/route-cli/spec.md` para o contrato de comportamento observável.

O desafio técnico central é atender redirecionamentos dinâmicos e landing pages estáticas sob o mesmo namespace raiz (`/<slug>`) sem expor arquivos internos de `public/_pages/`, mantendo latência `< 1ms` em hits na borda e permitindo merge dinâmico de UTMs e contagem assíncrona opcional sem fragmentar o cache.

## Goals / Non-Goals

**Goals:**
- Separar a lógica pura de roteamento (parsing de caminhos, gatekeeper, merge de query params e headers) do runtime do Worker para permitir testes unitários rápidos com `node --test`.
- Cachear metadados da rota na borda via `caches.default` com chave sintética desacoplada da query string da requisição.
- Isolar `public/_pages/*` e `/404.html` contra acesso direto enquanto sub-recursos `/<slug>/<subpath>` são reescritos de forma transparente.
- Disponibilizar uma CLI local em Node.js 24 sem build intermediário para gerenciar rotas no D1 (`--local` e `--remote`).

**Non-Goals:**
- Interface web/admin para gerenciamento de links.
- Invalidação automática global de cache CDN entre PoPs via API da Cloudflare dentro da CLI nesta primeira entrega (o cache de metadados usa `s-maxage` limitado e rotas temporárias usam `302`).
- Suporte a rotas aninhadas multi-nível com barras no `slug` (o `slug` representa sempre o primeiro segmento do caminho).

## Decisions

### 1. Modularização entre helpers puros e entrypoint do Worker
- **Decisão:** Extrair o núcleo de parsing e transformação de respostas para `src/router.ts` (tipos de rota, parsing de `pathname` em `slug`/`subpath`, verificação de caminhos bloqueados, merge de UTMs/query params e definição de headers de cache), deixando `src/index.ts` responsável apenas pela orquestração de I/O (`caches.default`, `env.DB`, `env.ASSETS` e `ctx.waitUntil`).
- **Alternativa considerada:** Concentrar tudo dentro de `src/index.ts`. Rejeitada porque acopla regras puras (como precedência de UTMs e normalização de paths) ao runtime `workerd`, dificultando testes unitários nativos com `node --test`.
- **Nota de compatibilidade Node 24 / TS:** Utilizar sintaxe TypeScript compatível com *type stripping* nativo do Node 24 (sem `enum` ou `parameter properties`) e imports relativos explícitos com `.ts` (com `allowImportingTsExtensions: true` no `tsconfig.json`, mantido seguro por `noEmit: true`), garantindo execução direta tanto no `workerd`/Wrangler quanto no `node --test`.

### 2. Estratégia de Cache API (`caches.default`) para metadados da rota
- **Decisão:** Cachear o registro JSON da rota (`slug`, `type`, `target`, `status_code`, `active`, `track_hits`) em `caches.default` sob uma chave sintética canônica (`https://cache.eliel.page/_routes/<slug>`), com `Cache-Control: public, s-maxage=86400`, em vez de cachear a resposta HTTP final.
- **Racional:**
  1. Evita fragmentação do cache por query strings arbitrárias (`?utm_source=live`, `?fbclid=...`): independente dos parâmetros de marketing recebidos, todos acertam a mesma entrada no cache local da borda.
  2. Permite executar o merge de query params dinamicamente a cada requisição em memória.
  3. Permite que `track_hits = 1` dispare `ctx.waitUntil()` mesmo quando a rota veio do cache da borda, sem que o Worker deixe de contabilizar cliques.
- **Alternativa considerada:** Cachear diretamente a resposta `301`/`302` completa pela URL da requisição. Rejeitada porque impediria o merge dinâmico sem cache miss para cada UTM e bloquearia o incremento de `hits` quando servido pelo cache do Worker.
- **Observação sobre `caches.default` em ambiente local/testes:** No runtime real da Cloudflare o `caches.default` existe; em ambientes locais sem cache disponível ou em testes isolados, o código trata falhas de cache de forma resiliente com fallback direto no D1.

### 3. Resolução de rotas, Gatekeeper e Sub-recursos de páginas
- **Decisão:** O Worker avalia o `pathname` nesta ordem:
  1. `GET`/`HEAD` diferente → `405 Method Not Allowed` (`Allow: GET, HEAD`).
  2. `/` → redirect `301` para `env.ROOT_REDIRECT_URL` preservando/mesclando query params se presentes.
  3. `/_pages`, `/_pages/*` ou `/404.html` → resposta `404` imediata servindo `public/404.html`.
  4. `/_assets/*` → proxy direto para `env.ASSETS.fetch(request)`; se `404`, devolve a página `404` customizada.
  5. Demais caminhos `/<slug>` ou `/<slug>/<subpath>`: extrai `slug` (primeiro segmento) e `subpath` (restante). Se a rota não existir ou `active === 0`, retorna `404` customizado.
- **Rewrite de Landing Pages (`type = 'page'`):**
  - Se `subpath` for vazio (`/<slug>` ou `/<slug>/`), reescreve internamente para `/_pages/<target>/index.html`.
  - Se `subpath` estiver presente (`/<slug>/<subpath>`), reescreve para `/_pages/<target>/<subpath>` preservando a URL original do navegador e sem incrementar `hits`.
  - Para garantir que assets relativos (ex.: `styles.css`, `./app.js`, `assets/hero.png`) funcionem em `/<slug>` mesmo sem barra final, landing pages devem preferir caminhos relativos com prefixo explícito `/<slug>/...` ou caminhos em `/_assets/...`; adicionalmente, quando `/<slug>` tem `index.html` servido diretamente, o Worker entrega a resposta HTML com `200` (sem redirect de trailing slash que quebraria a URL limpa, a menos que o autor use `/_assets/` ou `/<slug>/...`).
  - Se `env.ASSETS.fetch()` retornar `404` para um sub-recurso ou página ausente, o Worker devolve a página `public/404.html` com status `404`.
- **Prevenção de Path Traversal:** Rejeitar segmentos contendo `..`, `\` ou caracteres de controle antes de montar caminhos internos em `/_pages/`.

### 4. Contagem assíncrona opcional (`track_hits`)
- **Decisão:** Somente quando `route.track_hits === 1`, método for `GET` e o acesso for à rota principal (para `page`, apenas quando `subpath === ""`; para `redirect`, sempre no acesso ao slug), agendar via `ctx.waitUntil()`:
  ```sql
  UPDATE routes
  SET hits = hits + 1, last_hit_at = ?
  WHERE slug = ?
  ```
  com timestamp ISO gerado no Worker (`new Date().toISOString()`). Erros na atualização assíncrona são capturados e logados via `console.error` sem afetar a resposta entregue ao cliente.

### 5. Design da CLI local (`scripts/routes.ts`)
- **Decisão:** Implementar `scripts/routes.ts` em TypeScript compatível com Node.js 24 (`node scripts/routes.ts <subcommand> ...`), expondo via `"route": "node scripts/routes.ts"` no `package.json`.
- **Integração com D1:** Invocar `npx wrangler d1 execute eliel-pages-db` (ou binário local `./node_modules/.bin/wrangler`) passando `--local` por padrão ou `--remote` quando especificado, usando `--json` para parsear resultados de `list` e confirmações de `changes` em `enable`/`disable`/`delete`.
- **Segurança contra SQL Injection:** Como `wrangler d1 execute --command` recebe SQL textual (ou `--file`), validar estritamente `slug`, `type`, `status_code` e `target` e aplicar escaping seguro de aspas simples SQL (`value.replace(/'/g, "''")`) em todos os literais de string.
- **Comandos suportados:**
  - `add <slug> --type <redirect|page> --target <url|folder> [--status 301|302] [--track-hits] [--inactive] [--skip-asset-check] [--remote]`
  - `list [--json] [--remote]`
  - `enable <slug> [--remote]`
  - `disable <slug> [--remote]`
  - `delete <slug> [--remote]`

## Risks / Trade-offs

- **[Alteração de rota enquanto cache de borda (`s-maxage=86400`) está ativo]** → O cache na `Cache API` do Worker retém os metadados da rota por até 24h na PoP onde foi acessado; para rotas mutáveis ou campanhas temporárias, usar `status_code = 302` e, se necessário, implementar futuramente um comando de purge/TTL reduzido (`s-maxage`) conforme evolução do projeto.
- **[Assets relativos sem trailing slash em `/<slug>`]** → Quando o navegador abre `https://eliel.page/mentoria` (sem `/` no final) e o HTML referencia `<link href="style.css">`, o browser solicita `/style.css` na raiz (que não existe como slug) em vez de `/mentoria/style.css` → Documentar que landing pages em `public/_pages/<id>/` devem referenciar assets via `/_assets/...` ou `/<slug>/...` (ou usar `<base href="/<slug>/">`).
- **[Execução local com `workerd` / `wrangler dev`]** → Conforme observado no bootstrap, o npm bloqueou scripts de pós-instalação de `esbuild` e `workerd`; antes de testar `wrangler dev` ou `wrangler d1 execute` localmente caso haja falha de binário, pode ser necessário aprovar os scripts no npm ou validar o comportamento de `wrangler d1 execute` durante o apply.
