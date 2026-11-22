# pages (`eliel.page`)

Plataforma unificada na borda (Cloudflare) para **encurtador de links / redirecionamentos** e **hospedagem isolada de landing pages estáticas** sob o mesmo namespace raiz (`https://eliel.page/<slug>`), sem prefixos de URL.

- **`GET /`**: redireciona (`301`) para `https://elielvalenca.com` (`ROOT_REDIRECT_URL` em `wrangler.jsonc`).
- **`GET /<slug>` (redirect)**: redireciona com status `301` (padrão) ou `302` configurável por rota, com merge automático de query params/UTMs.
- **`GET /<slug>` (page)**: serve internamente `public/_pages/<target>/index.html` preservando a URL limpa no navegador. Qualquer tentativa de acesso direto a `/_pages/*` ou `/404.html` retorna `404`.
- **Rotas inexistentes ou inativas (`active = 0`)**: retornam `public/404.html` com status HTTP `404`.

---

## Arquitetura e Stack

- **Edge Runtime**: **Cloudflare Workers + Static Assets** (`run_worker_first = true`, binding `ASSETS`).
- **Persistência**: **Cloudflare D1** (SQLite na borda) com tabela única `routes`.
- **Cache na Borda**: **Cloudflare Cache API (`caches.default`)** armazenando metadados da rota por slug (`s-maxage=86400`), permitindo merge dinâmico de UTMs sem fragmentar o cache.
- **Contagem de Acessos Opcional**: `track_hits = 0` por padrão (zero escritas no D1); quando `track_hits = 1`, incrementa `hits` e atualiza `last_hit_at` assincronamente via `ctx.waitUntil()`.
- **Tooling / CLI**: **Node.js 24** executando TypeScript nativamente (sem build intermediário para os scripts locais).

---

## Estrutura do Projeto

```text
.
├── AGENTS.md                        # Diretrizes arquiteturais e regras de negócio
├── SPEC.md                          # Especificação inicial do projeto
├── wrangler.jsonc                   # Configuração do Worker, D1 e Static Assets
├── package.json                     # Scripts de dev, deploy, D1, testes e CLI
├── tsconfig.json                    # Configuração TypeScript
├── migrations/
│   └── 0001_create_routes_table.sql # Schema inicial da tabela routes no D1
├── src/
│   ├── index.ts                     # Entrypoint do Cloudflare Worker
│   ├── index.test.ts                # Testes do handler HTTP com dublês de D1/ASSETS/Cache
│   ├── worker.integration.test.ts   # Testes de integração do Worker com Wrangler Test Harness
│   ├── router.ts                    # Regras puras (gatekeeper, parsing, merge de UTMs, cache headers)
│   └── router.test.ts               # Testes unitários do roteador
├── scripts/
│   ├── routes.ts                    # CLI local para gerenciar rotas no D1 via Wrangler
│   ├── routes-core.ts               # Parsing, validações e geração/escaping de SQL
│   └── routes.test.ts               # Testes unitários da CLI
├── public/
│   ├── 404.html                     # Página 404 estática minimalista
│   ├── _assets/                     # Assets globais compartilhados
│   └── _pages/
│       └── demo/                    # Landing page estática de exemplo
└── openspec/                        # Especificações e changes (OpenSpec)
```

---

## Como Rodar Localmente e Testar o Banco

### 1. Pré-requisitos e Instalação

- **Node.js `>= 24.0.0`**

Instale as dependências:

```bash
npm install
```

> [!NOTE]
> No npm 12+, scripts `postinstall` de dependências nativas podem ficar bloqueados por padrão (`esbuild` e `workerd`). Caso `npm run dev` (`wrangler dev`) reclame da ausência do binário do `workerd` ou `esbuild`, aprove os scripts de instalação e reinstale:
> ```bash
> npm install-scripts approve esbuild workerd
> npm install
> ```

### 2. Inicializar e Migrar o Banco D1 Local

O Wrangler mantém uma instância local em SQLite dentro de `.wrangler/state/v3/d1`. Aplique as migrations antes de rodar o servidor ou a CLI:

```bash
npm run db:migrate:local
```

### 3. Gerenciar e Testar Rotas no Banco Local via CLI (`npm run route`)

A CLI em `scripts/routes.ts` opera no banco D1 **local por padrão**:

```bash
# Cadastrar um redirect permanente (301) com contagem de cliques habilitada
npm run route -- add matriz --type redirect --target https://elielvalenca.com/matriz --track-hits

# Cadastrar um redirect temporário (302)
npm run route -- add live-hoje --type redirect --target https://youtube.com/live/exemplo --status 302

# Cadastrar uma landing page estática (valida se public/_pages/demo/index.html existe)
npm run route -- add demo --type page --target demo

# Listar todas as rotas (tabela ou JSON)
npm run route -- list
npm run route -- list --json

# Desativar (passa a retornar 404), reativar ou remover uma rota
npm run route -- disable live-hoje
npm run route -- enable live-hoje
npm run route -- delete live-hoje
```

> Use `npm run route -- --help` para ver todas as opções (`--inactive`, `--skip-asset-check`, `--remote`, etc.).

### 4. Inspecionar o Banco D1 Local via SQL Direto

Se quiser executar consultas SQL ad-hoc diretamente contra o SQLite local do D1:

```bash
npx wrangler d1 execute pages --local --command "SELECT * FROM routes;"
```

### 5. Subir o Servidor Local e Testar Requisições

Inicie o Worker + Static Assets localmente com o Wrangler:

```bash
npm run dev
```

Por padrão, o Wrangler sobe em `http://localhost:8787`. Em outro terminal, teste os fluxos principais com `curl`:

```bash
# 1. Raiz (/) -> 301 para https://elielvalenca.com
curl -i http://localhost:8787/

# 2. Redirect com merge automático de UTMs -> 301 com Location mesclada
curl -i "http://localhost:8787/matriz?utm_source=live&utm_medium=youtube"

# 3. Landing page isolada via alias ativo -> 200 (HTML de public/_pages/demo/index.html)
curl -i http://localhost:8787/demo

# 4. Sub-recurso da landing page -> 200 (CSS de public/_pages/demo/style.css)
curl -i http://localhost:8787/demo/style.css

# 5. Gatekeeper: acesso direto à pasta física deve ser bloqueado -> 404
curl -i http://localhost:8787/_pages/demo/index.html

# 6. Rota inexistente -> 404
curl -i http://localhost:8787/nao-existe
```

---

## Testes Automatizados e Qualidade

O projeto utiliza o test runner nativo do Node.js 24 (`node:test`) sem dependências pesadas de automação de navegador:

```bash
# Verificação de tipos TypeScript (Worker + CLI + testes)
npm run typecheck

# Suíte completa (unitários + integração)
npm test

# Executar somente testes unitários (execução em milissegundos)
npm run test:unit

# Executar testes de integração do Worker (via Wrangler Test Harness com D1 real e migrations)
npm run test:integration
```

### Qualidade de Landing Pages: Indicação do Lighthouse CI

Em vez de suites lentas e pesadas de navegador E2E (como Playwright), a recomendação arquitetural para quando tivermos as primeiras landing pages em produção é adotar **Lighthouse CI (`@lhci/cli`)**:
- **Core Web Vitals**: LCP (Largest Contentful Paint), CLS (Cumulative Layout Shift) e INP.
- **Acessibilidade & Boas Práticas**: Validação de semântica HTML, contrastes e metatags.
- **SEO**: Checagem automática de links canônicos, Open Graph e meta descriptions.

---

## Como Adicionar uma Nova Landing Page

1. Crie uma pasta em `public/_pages/<page-id>/` contendo pelo menos `index.html`:
   ```text
   public/_pages/mentoria-v1/
   ├── index.html
   └── style.css
   ```
2. Dentro do HTML, referencie assets vinculados à página usando o prefixo do slug público (ex.: `/<slug>/style.css`) ou assets compartilhados em `/_assets/...`, para funcionar corretamente mesmo quando a URL for acessada sem barra final (`/mentoria`).
3. Cadastre o alias via CLI:
   ```bash
   npm run route -- add mentoria --type page --target mentoria-v1
   ```
4. **Qualidade da Página**: Conforme diretriz do projeto, audite as novas landing pages com o **Lighthouse CI** para assegurar pontuações altas em Performance, Acessibilidade e SEO antes de campanhas de tráfego.

---

## Operação em Produção (D1 Remoto e Deploy)

### 1. Autenticação na Cloudflare (`wrangler login`)

Antes de interagir com recursos remotos na Cloudflare, autentique sua sessão local no Wrangler:

```bash
# Iniciar o fluxo de login no navegador
npx wrangler login

# Verificar se a conta e credenciais estão ativas
npx wrangler whoami
```

### 2. Criar e Vincular o Banco D1 Remoto

1. Crie o banco D1 na sua conta Cloudflare:
   ```bash
   npx wrangler d1 create pages
   ```
2. O comando retornará um bloco de configuração contendo o `database_id` criado (UUID). Copie esse valor e atualize o campo `database_id` em [wrangler.jsonc](./wrangler.jsonc):
   ```jsonc
   "d1_databases": [
     {
       "binding": "DB",
       "database_name": "pages",
       "database_id": "SEU_DATABASE_ID_AQUI",
       "migrations_dir": "migrations"
     }
   ]
   ```

### 3. Migrations, Deploy e Gestão de Rotas Remotas

1. Aplique as migrations no banco remoto da Cloudflare:
   ```bash
   npm run db:migrate:remote
   ```
2. Publique o Worker e os assets estáticos na borda:
   ```bash
   npm run deploy
   ```
3. Gerencie rotas diretamente em produção passando a flag `--remote` na CLI:
   ```bash
   npm run route -- add matriz --type redirect --target https://elielvalenca.com/matriz --remote
   npm run route -- list --remote
   ```

---

## Governança e Documentação

- [AGENTS.md](./AGENTS.md): diretrizes arquiteturais, regras de roteamento/cache, modelo de dados e fluxo com **OpenSpec** (obrigatório para novas features; chores, infra e fixes não exigem change).
