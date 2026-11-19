# edge-router Specification

## Purpose

Define o comportamento de roteamento na borda do serviço `eliel.page`, unificando redirecionamentos curtos e entrega isolada de landing pages estáticas sob o mesmo namespace raiz sem prefixos.

## Requirements

### Requirement: Redirecionamento da rota raiz
O sistema MUST redirecionar requisições para a rota raiz (`/`) com status HTTP `301` para a URL configurada de destino principal (`ROOT_REDIRECT_URL`), sem consulta ao banco de dados de rotas.

#### Scenario: Acesso à raiz sem query parameters
- **WHEN** um cliente envia uma requisição `GET /`
- **THEN** o sistema responde com status `301` e header `Location` igual ao valor configurado em `ROOT_REDIRECT_URL`

#### Scenario: Acesso à raiz com query parameters
- **WHEN** um cliente envia uma requisição `GET /?utm_source=bio`
- **THEN** o sistema responde com status `301` e header `Location` para `ROOT_REDIRECT_URL` preservando ou mesclando os parâmetros recebidos

### Requirement: Isolamento de páginas estáticas e página 404 direta
O sistema MUST bloquear o acesso direto a qualquer caminho interno sob `/_pages/` ou `/404.html`, respondendo sempre com status HTTP `404` e o conteúdo da página estática de erro.

#### Scenario: Tentativa de acesso direto ao diretório interno de páginas
- **WHEN** um cliente solicita `GET /_pages/mentoria/index.html` ou `GET /_pages/`
- **THEN** o sistema responde com status `404`, `Content-Type: text/html; charset=UTF-8` e o HTML da página `404`

#### Scenario: Tentativa de acesso direto à página 404 física
- **WHEN** um cliente solicita `GET /404.html`
- **THEN** o sistema responde com status `404` e o HTML da página `404`

### Requirement: Entrega de assets globais compartilhados
O sistema MUST servir diretamente arquivos estáticos solicitados sob o prefixo `/_assets/` sem exigir cadastro de rota no banco de dados.

#### Scenario: Asset global existente
- **WHEN** um cliente solicita `GET /_assets/logo.svg` e o arquivo existe nos assets públicos
- **THEN** o sistema responde com status `200` e o conteúdo do arquivo solicitado

#### Scenario: Asset global inexistente
- **WHEN** um cliente solicita `GET /_assets/nao-existe.css` e o arquivo não existe
- **THEN** o sistema responde com status `404` e o HTML da página `404`

### Requirement: Resolução de rotas com cache na borda e tratamento de 404
O sistema MUST consultar os metadados da rota pelo primeiro segmento do caminho (`slug`) priorizando o cache local da borda antes de consultar o banco de dados, retornando `404` quando a rota não existir ou estiver inativa (`active = 0`).

#### Scenario: Rota inexistente ou desativada
- **WHEN** um cliente solicita `GET /slug-inexistente` ou um slug cadastrado com `active = 0`
- **THEN** o sistema responde com status `404`, `Content-Type: text/html; charset=UTF-8` e o conteúdo da página `404`

#### Scenario: Cache miss seguido de cache hit na borda
- **WHEN** uma rota ativa é acessada pela primeira vez na região de borda e depois acessada novamente
- **THEN** o primeiro acesso consulta o banco de dados e armazena os metadados da rota no cache da borda, e o acesso seguinte resolve a rota diretamente pelo cache sem nova leitura no banco

#### Scenario: Requisição com método HTTP não suportado para leitura
- **WHEN** um cliente envia uma requisição com método diferente de `GET` ou `HEAD` para um slug
- **THEN** o sistema responde com status `405` e header `Allow: GET, HEAD`

### Requirement: Redirecionamento de links curtos e merge de query params
Para rotas ativas do tipo `redirect`, o sistema SHALL responder com redirecionamento HTTP usando o `status_code` configurado (`301` ou `302`), headers `Cache-Control` adequados e merge automático de query parameters na URL de destino, onde parâmetros recebidos na requisição têm precedência sobre parâmetros de mesmo nome no `target`.

#### Scenario: Redirecionamento permanente 301 com merge de UTMs
- **WHEN** uma rota `matriz` (`type = 'redirect'`, `status_code = 301`, `target = 'https://elielvalenca.com/artigo?ref=bio'`) é acessada via `GET /matriz?utm_source=live&ref=youtube`
- **THEN** o sistema responde com status `301`, `Location: https://elielvalenca.com/artigo?ref=youtube&utm_source=live` e `Cache-Control: public, max-age=3600, s-maxage=86400`

#### Scenario: Redirecionamento temporário 302
- **WHEN** uma rota `live` (`type = 'redirect'`, `status_code = 302`, `target = 'https://youtube.com/live/abc'`) é acessada via `GET /live`
- **THEN** o sistema responde com status `302`, `Location: https://youtube.com/live/abc` e `Cache-Control: public, max-age=0, s-maxage=3600`

### Requirement: Rewrite interno para landing pages estáticas
Para rotas ativas do tipo `page`, o sistema MUST servir internamente o arquivo `index.html` de `_pages/<target>/` na raiz do slug (`/<slug>` ou `/<slug>/`) e mapear sub-recursos (`/<slug>/<subpath>`) para `_pages/<target>/<subpath>`, preservando a URL limpa sem redirecionar o cliente.

#### Scenario: Acesso à página principal do slug
- **WHEN** uma rota ativa `mentoria` (`type = 'page'`, `target = 'mentoria-v1'`) é acessada via `GET /mentoria` ou `GET /mentoria/`
- **THEN** o sistema entrega com status `200` o conteúdo de `/_pages/mentoria-v1/index.html` sem redirecionamento HTTP

#### Scenario: Acesso a sub-recurso relativo ou asset da página
- **WHEN** o cliente solicita `GET /mentoria/styles.css` ou `GET /mentoria/assets/hero.png`
- **THEN** o sistema resolve internamente `/_pages/mentoria-v1/styles.css` ou `/_pages/mentoria-v1/assets/hero.png` e responde com status `200` (ou `404` caso o arquivo não exista na pasta da página)

### Requirement: Contagem opcional e assíncrona de acessos
O sistema SHALL contabilizar acessos somente em rotas cadastradas com `track_hits = 1`, executando o incremento de `hits` e atualização de `last_hit_at` de forma assíncrona sem bloquear a resposta e sem gravar no banco quando `track_hits = 0` ou em requisições de sub-recursos estáticos.

#### Scenario: Rota sem contagem habilitada
- **WHEN** uma rota com `track_hits = 0` é acessada
- **THEN** o sistema entrega o redirecionamento ou página sem executar escrita no banco de dados

#### Scenario: Rota com contagem habilitada
- **WHEN** uma rota ativa com `track_hits = 1` é acessada em seu caminho principal (`/<slug>` ou `/<slug>/`) via `GET`
- **THEN** o sistema agenda assincronamente a atualização incrementando `hits = hits + 1` e definindo `last_hit_at` com timestamp ISO atual, sem atrasar a resposta ao cliente

#### Scenario: Sub-recurso de página não infla contagem
- **WHEN** um sub-recurso estático `/<slug>/styles.css` de uma página com `track_hits = 1` é solicitado
- **THEN** o sistema serve o asset normalmente sem incrementar o contador `hits` da rota
