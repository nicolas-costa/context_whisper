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

### SQLite + sqlite-vec (Default)

Sem configuração necessária. O banco é criado automaticamente em:
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
export ACME_CORP_PG_USER=whisper_user
export ACME_CORP_PG_PASSWORD=secret123
export ACME_CORP_PG_DATABASE=context_whisper
export ACME_CORP_PG_SSL=true  # opcional

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
        
        "ACME_CORP_PG_HOST": "db.acme-corp.internal",
        "ACME_CORP_PG_USER": "whisper",
        "ACME_CORP_PG_PASSWORD": "secret",
        "ACME_CORP_PG_DATABASE": "context_whisper",
        
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
  "query": "refresh token expiração",
  "top_k": 5,
  "tags": ["backend"],
  "review_status": "APPROVED",
  "repo_url": "https://github.com/workspace/project"
}
```

**Nota:** `repo_url` é opcional - se não fornecido, busca em todos os repositórios.

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
