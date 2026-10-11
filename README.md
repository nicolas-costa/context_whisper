# context-whisper

MCP Server para repositório de notas técnicas vetorizadas com suporte a múltiplos bancos de dados.

## Descrição

O `context-whisper` é um servidor MCP (Model Context Protocol) que fornece um repositório de notas técnicas vetorizadas para projetos de software. Suporta múltiplos bancos de dados:

- **SQLite + sqlite-vec** (default, zero-config, local)
- **PostgreSQL + pgvector** (corporativo, escalável)
- **MySQL/PostgreSQL/SQLite + Qdrant** (quando preferir vector store externo ou não puder usar extensões nativas)

## Características

- **Busca Vetorial Semântica**: Busque notas técnicas usando similaridade semântica, não apenas palavras-chave
- **Embeddings Locais**: Gera embeddings usando modelos locais (MiniLM-L6-v2), sem necessidade de APIs externas
- **Multi-Database**: Suporte a SQLite, PostgreSQL, MySQL + Qdrant
- **Multi-Environment**: Configure PROD, DEV, STG via variáveis de ambiente
- **Rastreabilidade**: Links notas técnicas com código-fonte específico (repo, path, símbolos, linhas)
- **Workspace/Project Organization**: Organize notas por workspace e projeto
- **Tags e Status**: Categorize notas com tags e controle de revisão (DRAFT/APPROVED)
- **Auto-detecção de Contexto**: Detecta automaticamente workspace/project do Git

## Instalação

```bash
npm install
npm run build
```

## Uso

### Via npx

```bash
npx context-whisper
```

### Desenvolvimento

```bash
npm run dev
```

### Opções CLI

- `--db <path>`: Caminho para o arquivo SQLite (padrão: ~/.local/share/context-whisper/meta.sqlite no Linux)
- `--vec-lib <path>`: Caminho para a extensão sqlite-vec
- `--env <name>`: Nome do ambiente a usar (e.g., PROD, DEV)

## Configuração de Banco de Dados

Duas camadas distintas. Não misture as duas no `mcp.json`.

### O que é responsabilidade da config do MCP

A config do processo (variáveis de ambiente do cliente MCP, ou o shell que sobe o servidor) responde só isto:

- **Para qual ambiente conectar** (`CONTEXT_WHISPER_ENV`, `--env`)
- **Como conectar**: host, porta, database, usuário e senha da conta de banco dessa pessoa (ou, no mínimo, da conta do papel `engineer` / `tech_lead`), SSL, path do SQLite
- **Onde estão os vetores**: `sqlite-vec`, `pgvector` ou Qdrant (`{ENV}_VECTOR_STORE` e variáveis do Qdrant)
- **Quais workspaces esse ambiente aceita** (`{ENV}_WORKSPACE_WHITELIST`): roteamento de repositório, não papel de pessoa
- **Quais ambientes o processo pode selecionar** (`CONTEXT_WHISPER_ALLOWED_ENVIRONMENTS`), quando quiser um teto além do whitelist

O usuário e a senha dessa config são a conta de banco de quem sobe o processo.
O ideal é uma conta por pessoa. O mínimo é uma conta por papel: o `mcp.json` de quem escreve usa `engineer`, o de quem aprova usa `tech_lead`.
Engineer e tech-lead não podem compartilhar a mesma conta de banco. A sessão dos dois teria o mesmo `current_user`, e um trigger não consegue permitir `APPROVED` para um e recusar para o outro.

O agente não envia role, usuário de banco nem token em tool call.

`CONTEXT_WHISPER_ACCOUNT_TOKEN` identifica a pessoa. O processo `context-whisper` conecta com a conta de banco da config, calcula o hash do token e resolve a linha em `accounts` (função no banco, sem `SELECT` aberto em `token_hash`).
Quem autoriza `APPROVED` é o papel da sessão no banco, não um campo do tool call. Com conta por pessoa, esse papel é o que a conta herda. Com conta por tipo, é o próprio `current_user`.
O PostgreSQL e o MySQL não interpretam MCP. O Qdrant também não.

### Recomendação de estrutura do banco corporativo

Isto é responsabilidade de quem opera o PostgreSQL ou o MySQL da empresa.

Um database (ou schema) por ambiente corporativo. Várias pessoas no mesmo banco. Uma linha por pessoa, não um banco por pessoa.

| Objeto                | Função                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conta por pessoa      | Modelo ideal. Cada um entra com a própria senha e herda o papel `engineer` ou `tech_lead`. Revogar uma pessoa não troca a senha das outras. O trigger vê o papel herdado, não o nome do usuário.                                                                                                                                                              |
| Conta por papel       | Mínimo aceitável. Uma conta `engineer` e uma `tech_lead`, compartilhadas por quem tem aquele papel. No PostgreSQL o trigger usa `current_user`. No MySQL usa `USER()` (a sessão). `CURRENT_USER()` dentro de função `DEFINER` é o criador da função, não a pessoa. Vazar um `mcp.json` entrega o papel inteiro.                                               |
| Login administrativo  | Fora do MCP. Cria accounts, troca role, revoga token.                                                                                                                                                                                                                                                                                                         |
| `accounts`            | `id`, `name`, `token_hash`, `role` (`engineer` \| `tech_lead`), workspaces permitidos, `revoked_at`. O lookup do token passa por uma função que devolve a linha correspondente, sem conceder `SELECT` na coluna do hash.                                                                                                                                      |
| `notes.review_status` | `DRAFT` ou `APPROVED`. Trigger recusa `APPROVED` para sessão `engineer`. No PostgreSQL o papel herdado entra via `pg_has_role`. No MySQL, conta por tipo entra via `USER()`; conta por pessoa só entra se o definer ler `mysql.role_edges`. Sem essa leitura, a trava da conta por pessoa no MySQL é o `GRANT` de coluna. O MCP também recusa `approve_note`. |
| Soft-delete           | `deleted_at` / `deleted_by`. A nota some da busca e o vetor sai do índice. A linha fica para auditoria. Purge é operação à parte, privilegiada.                                                                                                                                                                                                               |
| Unicidade             | O escopo `(workspace, project, topic, subtopic)` é único entre notas vivas. Nota apagada não bloqueia recriar o mesmo tópico. No MySQL o índice único cabe numa coluna gerada (`NULL` quando `deleted_at` está preenchido), porque um índice das quatro colunas em `utf8mb4` estoura o limite do InnoDB.                                                      |

`engineer` escreve e mantém rascunho. `tech_lead` aprova. Os dois papéis apontam para o mesmo host e o mesmo database. Nenhum dos dois escreve em `accounts` / `roles` nem lê `token_hash`. A senha no `mcp.json` escolhe a conta (a pessoa, ou o papel). O token identifica a pessoa para o MCP.

Busca ignora nota apagada. Com `CONTEXT_WHISPER_ACCOUNT_TOKEN`, o default é `review_status=APPROVED`; rascunho só com filtro explícito. Sem token (SQLite local), a busca inclui rascunho salvo filtro. Conta com `workspaces` preenchido não faz busca global.

Qdrant, quando usado, guarda vetor. A nota relacional é a fonte. Apagar ou ocultar a nota tem que tirar o ponto do Qdrant.
O vector store não é o cadastro de pessoas nem de roles.

SSL termina no servidor do banco. A config do MCP só liga `PG_SSL` / `MYSQL_SSL` e, se preciso, desliga a validação do certificado em dev.

### SQLite + sqlite-vec (Default)

**Breaking change em 1.4.0.** O ambiente implícito `default` só sobe se `DEFAULT_WORKSPACE_WHITELIST` estiver definido. É a lista de owners de repositório que esse processo aceita, separada por vírgula. Sem ela o processo recusa a subida:

```text
DEFAULT_WORKSPACE_WHITELIST is required when using the implicit 'default' environment
```

```bash
export DEFAULT_WORKSPACE_WHITELIST=nicolas-costa
```

Quem usava `npx context-whisper` sem variável de ambiente em 1.3.0 precisa setar isso no 1.4.0. Ambiente nomeado continua exigindo `{ENV}_WORKSPACE_WHITELIST`. O whitelist roteia repositório. Não é papel de pessoa.

O banco é criado automaticamente em:

- **Linux**: `~/.local/share/context-whisper/meta.sqlite`
- **macOS**: `~/Library/Application Support/context-whisper/meta.sqlite`
- **Windows**: `%AppData%/context-whisper/meta.sqlite`

### Variáveis de Ambiente

#### Estrutura: `{AMBIENTE}_{DB}_{PARAM}`

Use prefixos de ambiente para configurar múltiplos bancos. Ambientes representam **bancos locais ou corporativos**:

- `LOCAL_*` - Desenvolvimento local
- `ACME_CORP_*` - Cliente/empresa específica
- `STARTUP_XYZ_*` - Outro cliente

#### SQLite Local (Desenvolvimento)

```bash
# SQLite em path customizado
export LOCAL_SQLITE_PATH=/home/dev/notes.sqlite
```

#### PostgreSQL + pgvector (Empresa com infra própria)

```bash
# Cliente que usa PostgreSQL com pgvector
export ACME_CORP_PG_HOST=db.acme-corp.internal
export ACME_CORP_PG_PORT=5432
export ACME_CORP_PG_USER=engineer
export ACME_CORP_PG_PASSWORD=secret123
export ACME_CORP_PG_DATABASE=context_whisper
export ACME_CORP_PG_SSL=true  # opcional
# Workspaces (owners de repo) que este ambiente aceita. Não é role de pessoa.
export ACME_CORP_WORKSPACE_WHITELIST=acme-corp

# Ativar esse ambiente por padrão
export CONTEXT_WHISPER_ENV=ACME_CORP
```

#### Qualquer Banco + Qdrant (Vector Store Externo)

Você pode usar **qualquer banco relacional** (MySQL, PostgreSQL, SQLite) com **Qdrant** como vector store externo. Útil quando:

- MySQL (não tem vetores nativos)
- PostgreSQL sem permissão para instalar pgvector
- Prefere Qdrant Cloud gerenciado
- Quer escalar vector search independentemente

```bash
# Exemplo: MySQL + Qdrant
export BIGCLIENT_MYSQL_HOST=mysql.bigclient.com
export BIGCLIENT_MYSQL_PORT=3306
export BIGCLIENT_MYSQL_USER=app_user
export BIGCLIENT_MYSQL_PASSWORD=secure_pass
export BIGCLIENT_MYSQL_DATABASE=tech_docs
export BIGCLIENT_QDRANT_HOST=qdrant.bigclient.com
export BIGCLIENT_QDRANT_PORT=6333
export BIGCLIENT_QDRANT_API_KEY=optional_api_key

# Exemplo: PostgreSQL + Qdrant (forçando Qdrant ao invés de pgvector)
export CORP_PG_HOST=db.corp.com
export CORP_PG_USER=user
export CORP_PG_PASSWORD=pass
export CORP_PG_DATABASE=whisper
export CORP_QDRANT_HOST=qdrant.corp.com
export CORP_VECTOR_STORE=qdrant  # força Qdrant ao invés de pgvector

# Exemplo: SQLite local + Qdrant Cloud
export LOCAL_SQLITE_PATH=~/.local/share/context-whisper/notes.sqlite
export LOCAL_QDRANT_HOST=abc123.qdrant.cloud
export LOCAL_QDRANT_API_KEY=your_cloud_api_key
export LOCAL_QDRANT_HTTPS=true
export LOCAL_VECTOR_STORE=qdrant  # força Qdrant ao invés de sqlite-vec
```

#### Múltiplos Ambientes Simultâneos

```bash
# Ambiente local (SQLite)
export LOCAL_SQLITE_PATH=~/.local/share/context-whisper/local.sqlite

# Cliente 1 - PostgreSQL + pgvector
export ACME_PG_HOST=db.acme.com
export ACME_PG_USER=user
export ACME_PG_PASSWORD=pass
export ACME_PG_DATABASE=whisper

# Cliente 2 - MySQL + Qdrant
export STARTUP_MYSQL_HOST=mysql.startup.io
export STARTUP_MYSQL_USER=admin
export STARTUP_MYSQL_PASSWORD=pwd
export STARTUP_MYSQL_DATABASE=docs
export STARTUP_QDRANT_HOST=vector.startup.io

# Selecionar ambiente ativo
export CONTEXT_WHISPER_ENV=LOCAL  # ou ACME, STARTUP
```

### Variáveis Legadas (Compatibilidade)

As variáveis antigas continuam funcionando para backward compatibility:

```bash
export CONTEXT_WHISPER_DB_PATH=/custom/path/meta.sqlite
export CONTEXT_WHISPER_VEC_LIB=/path/to/vec0.so
```

### Seleção de Ambiente em Runtime

```bash
# Via CLI
context-whisper --env ACME_CORP

# Via variável de ambiente
CONTEXT_WHISPER_ENV=BIGCLIENT context-whisper
```

### Exemplo: MCP Client Config (Cursor/Claude Desktop)

```json
{
  "mcpServers": {
    "context-whisper": {
      "command": "npx",
      "args": ["context-whisper"],
      "env": {
        "LOCAL_SQLITE_PATH": "/home/user/.local/share/context-whisper/local.sqlite",
        "LOCAL_WORKSPACE_WHITELIST": "local-owner",

        "ACME_CORP_PG_HOST": "db.acme-corp.internal",
        "ACME_CORP_PG_USER": "whisper",
        "ACME_CORP_PG_PASSWORD": "secret",
        "ACME_CORP_PG_DATABASE": "context_whisper",
        "ACME_CORP_WORKSPACE_WHITELIST": "acme-corp",

        "STARTUP_XYZ_MYSQL_HOST": "mysql.startup-xyz.com",
        "STARTUP_XYZ_MYSQL_USER": "app",
        "STARTUP_XYZ_MYSQL_PASSWORD": "pass",
        "STARTUP_XYZ_MYSQL_DATABASE": "tech_notes",
        "STARTUP_XYZ_QDRANT_HOST": "qdrant.startup-xyz.com",

        "CONTEXT_WHISPER_ENV": "LOCAL"
      }
    }
  }
}
```

A senha nesse JSON é a conta de banco da pessoa ou, no mínimo, a do papel (`engineer` ou `tech_lead`). Não é uma conta compartilhada pelos dois papéis. O token da pessoa é outro segredo. Role não vai em campo de tool. Veja a seção de banco corporativo acima.

Se o JSON não declarar nenhum ambiente `{ENV}_*`, o processo cai no SQLite implícito e exige `DEFAULT_WORKSPACE_WHITELIST` (owners, separados por vírgula). Com ambiente nomeado, a variável é `{ENV}_WORKSPACE_WHITELIST`, como `LOCAL_WORKSPACE_WHITELIST` acima. Sem uma das duas, a subida falha. Isso é breaking change em relação ao 1.3.0, que subia sem whitelist.

## Instalação do sqlite-vec (Para SQLite)

O `sqlite-vec` é **essencial** quando usando SQLite e está incluído como dependência:

```bash
npm install
```

O binário correto para sua plataforma será instalado automaticamente.

## Tools MCP

### upsert_note

Cria ou atualiza uma nota técnica vetorizada.

**Payload:**

```json
{
  "repo_url": "https://github.com/workspace/project",
  "topic": "autenticacao",
  "subtopic": "jwt",
  "tags": ["backend", "seguranca", "auth"],
  "body_md": "## Decisão\nImplementado JWT com refresh token...",
  "created_by": "John Doe (claude-sonnet)",
  "review_status": "DRAFT",
  "links": [
    {
      "repo": "softec-app",
      "path": "src/auth/jwt.ts",
      "line_start": 5,
      "line_end": 120,
      "commit_sha": "abc123"
    }
  ]
}
```

### get_note

Recupera uma nota específica do repositório.

**Payload:**

```json
{
  "repo_url": "https://github.com/workspace/project",
  "topic": "autenticacao",
  "subtopic": "jwt"
}
```

### search_notes

Busca notas usando similaridade semântica vetorial.

**Payload:**

```json
{
  "environment": "LOCAL",
  "query": "refresh token expiração",
  "top_k": 5,
  "tags": ["backend"],
  "review_status": "APPROVED",
  "repo_url": "https://github.com/workspace/project"
}
```

**Nota:** `repo_url` é opcional. Se `repo_url` não for fornecido, a busca é **global** (todos os repositórios).

### list_topics

Lista todos os tópicos disponíveis para um repositório.

### delete_note

Remove uma nota e todos os dados associados.

### health

Verifica o status do banco de dados e extensões.

### serve_notes_ui

Inicia servidor web local para visualização das notas.

### stop_notes_server

Encerra o servidor web de visualização.

## Dependências

- `better-sqlite3`: Cliente SQLite para Node.js
- `pg`: Cliente PostgreSQL para Node.js
- `mysql2`: Cliente MySQL para Node.js
- `@xenova/transformers`: Embeddings locais
- `sqlite-vec`: Extensão SQLite para busca vetorial
- `@modelcontextprotocol/sdk`: SDK do MCP
- `zod`: Validação de schemas
- `fastify`: Servidor web para UI

## Desenvolvimento

```bash
# Instalar dependências
npm install

# Desenvolvimento com hot reload
npm run dev

# Compilar TypeScript
npm run build

# Executar versão compilada
npm start
```

## Licença

MIT
