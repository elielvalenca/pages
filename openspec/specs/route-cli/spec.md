# route-cli Specification

## Purpose

Fornece uma interface de linha de comando local em Node.js 24 para cadastrar, validar, listar, ativar, desativar e remover rotas na tabela `routes` do Cloudflare D1, operando tanto no banco local quanto no remoto.

## Requirements

### Requirement: Cadastro e atualização de rotas via CLI
A CLI MUST permitir cadastrar uma nova rota ou atualizar uma rota existente (`upsert`) informando `slug`, `type` (`redirect` ou `page`), `target`, e opções `status_code` (`301` ou `302`), `track_hits` (`0` ou `1`) e `active` (`0` ou `1`), rejeitando entradas inválidas com código de saída diferente de zero.

#### Scenario: Cadastro de novo redirecionamento com padrões
- **WHEN** o usuário executa o comando de criação para `slug=matriz`, `type=redirect` e `target=https://elielvalenca.com/matriz`
- **THEN** a CLI valida que o slug não contém prefixos reservados (`_pages`, `_assets`) ou barras inválidas e grava a rota no D1 com `status_code = 301`, `active = 1` e `track_hits = 0`

#### Scenario: Cadastro de redirecionamento temporário com contagem de hits
- **WHEN** o usuário executa o comando de criação informando `status=302` e `track-hits`
- **THEN** a CLI persiste a rota com `status_code = 302`, `track_hits = 1` e atualiza `updated_at` caso o slug já exista

#### Scenario: Rejeição de slug reservado ou target inválido
- **WHEN** o usuário tenta cadastrar uma rota com slug reservado (`_pages`, `_assets`, `404.html`), `status_code` diferente de `301`/`302` ou URL inválida para `type=redirect`
- **THEN** a CLI exibe mensagem de erro explicativa em `stderr` e encerra com código de saída diferente de zero sem alterar o banco

### Requirement: Validação de página estática local antes do cadastro
Para rotas do tipo `page`, a CLI MUST verificar a existência do arquivo `public/_pages/<target>/index.html` antes de persistir a rota no D1, salvo quando explicitamente ignorado por flag.

#### Scenario: Página estática existente no diretório local
- **WHEN** o usuário cadastra uma rota com `type=page` e `target=mentoria-v1` existindo `public/_pages/mentoria-v1/index.html`
- **THEN** a CLI conclui a validação e persiste a rota no D1

#### Scenario: Página estática ausente no diretório local
- **WHEN** o usuário cadastra uma rota com `type=page` e `target=inexistente` sem o arquivo `public/_pages/inexistente/index.html`
- **THEN** a CLI aborta a operação exibindo o caminho esperado ausente e encerra com código de saída diferente de zero

### Requirement: Listagem de rotas cadastradas
A CLI MUST oferecer um comando de listagem que consulte a tabela `routes` e exiba `slug`, `type`, `target`, `status_code`, `active`, `track_hits`, `hits` e `last_hit_at`.

#### Scenario: Listagem tabular padrão e saída JSON
- **WHEN** o usuário executa o comando `list` (com ou sem `--json`)
- **THEN** a CLI consulta todas as rotas ordenadas por `slug` e imprime a tabela formatada ou um array JSON válido no `stdout`

### Requirement: Ativação e desativação de rotas
A CLI MUST permitir alternar o estado `active` de uma rota existente para `1` (`enable`) ou `0` (`disable`) informando o `slug`, atualizando `updated_at` e falhando caso o `slug` não exista.

#### Scenario: Desativação de rota existente
- **WHEN** o usuário executa `disable` para um `slug` existente
- **THEN** a CLI atualiza `active = 0` e `updated_at = datetime('now')` no D1 para aquele `slug`

#### Scenario: Alteração de status para slug inexistente
- **WHEN** o usuário executa `enable` ou `disable` para um `slug` não cadastrado
- **THEN** a CLI informa que o `slug` não foi encontrado e encerra com código de saída diferente de zero

### Requirement: Remoção de rotas
A CLI MUST permitir remover definitivamente uma rota da tabela `routes` pelo `slug`, retornando erro caso o `slug` não esteja cadastrado.

#### Scenario: Remoção de rota existente
- **WHEN** o usuário executa `delete` para um `slug` existente
- **THEN** a CLI remove o registro correspondente do D1 e confirma a remoção no `stdout`

### Requirement: Seleção de ambiente local ou remoto do D1
Todos os comandos da CLI MUST operar no banco D1 local por padrão e suportar a flag `--remote` para executar as mesmas operações no banco D1 de produção na Cloudflare.

#### Scenario: Execução padrão no banco local
- **WHEN** o usuário executa qualquer comando da CLI sem `--remote`
- **THEN** a CLI direciona a execução ao banco local do Wrangler

#### Scenario: Execução explícita no banco remoto
- **WHEN** o usuário informa a flag `--remote` em qualquer comando da CLI
- **THEN** a CLI direciona a execução ao banco D1 remoto configurado no `wrangler.jsonc`
