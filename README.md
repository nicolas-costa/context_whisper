# context-whisper

MCP Server para repositório de notas técnicas vetorizadas com suporte a múltiplos bancos de dados.

## Descrição

O `context-whisper` é um servidor MCP (Model Context Protocol) que fornece um repositório de notas técnicas vetorizadas para projetos de software. Suporta múltiplos bancos de dados:

- **SQLite + sqlite-vec** (default, zero-config)
- **PostgreSQL + pgvector** (produção, escalável)
- **MySQL + Qdrant** (MySQL para dados relacionais, Qdrant para vetores)
- **SQLite/PostgreSQL + Qdrant** (separação de responsabilidades)

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

#### Estrutura: `{ENV}_{DB}_{PARAM}`

Use prefixos de ambiente (PROD, DEV, STG, etc.) para configurar múltiplos bancos:

#### PostgreSQL + pgvector

```bash
# PostgreSQL como banco relacional + pgvector para vetores
export PROD_PG_HOST=db.example.com
export PROD_PG_PORT=5432
export PROD_PG_USER=myuser
export PROD_PG_PASSWORD=mypassword
export PROD_PG_DATABASE=context_whisper
export PROD_PG_SSL=true  # opcional

# Ativar ambiente PROD por padrão
export CONTEXT_WHISPER_ENV=PROD
```

#### MySQL + Qdrant

MySQL não tem suporte nativo a vetores, então usa Qdrant:

```bash
# MySQL como banco relacional
export DEV_MYSQL_HOST=mysql.example.com
export DEV_MYSQL_PORT=3306
export DEV_MYSQL_USER=dev_user
export DEV_MYSQL_PASSWORD=dev_password
export DEV_MYSQL_DATABASE=context_whisper

# Qdrant para busca vetorial
export DEV_QDRANT_HOST=qdrant.example.com
export DEV_QDRANT_PORT=6333
export DEV_QDRANT_API_KEY=optional_api_key
export DEV_QDRANT_COLLECTION=context_whisper_notes
export DEV_QDRANT_HTTPS=false
```

#### SQLite + Qdrant

SQLite local com Qdrant remoto para vetores:

```bash
export TEST_SQLITE_PATH=/path/to/test.db
export TEST_QDRANT_HOST=localhost
export TEST_QDRANT_PORT=6333
export TEST_VECTOR_STORE=qdrant  # força uso do Qdrant
```

#### Seleção Explícita do Vector Store

```bash
# Força pgvector mesmo quando há Qdrant configurado
export PROD_VECTOR_STORE=pgvector

# Força Qdrant mesmo com PostgreSQL
export PROD_VECTOR_STORE=qdrant
```

### Variáveis Legadas (Compatibilidade)

As variáveis antigas continuam funcionando:

```bash
export CONTEXT_WHISPER_DB_PATH=/custom/path/meta.sqlite
export CONTEXT_WHISPER_VEC_LIB=/path/to/vec0.so
```

### Seleção de Ambiente em Runtime

```bash
# Via CLI
context-whisper --env PROD

# Via variável de ambiente
CONTEXT_WHISPER_ENV=DEV context-whisper
```

### Exemplo: MCP Client Config

```json
{
  "mcpServers": {
    "context-whisper": {
      "command": "npx",
      "args": ["context-whisper"],
      "env": {
        "PROD_PG_HOST": "prod.db.example.com",
        "PROD_PG_USER": "app_user",
        "PROD_PG_PASSWORD": "secret",
        "PROD_PG_DATABASE": "context_whisper",
        "DEV_MYSQL_HOST": "dev.db.example.com",
        "DEV_MYSQL_USER": "dev_user",
        "DEV_MYSQL_PASSWORD": "dev_secret",
        "DEV_MYSQL_DATABASE": "context_whisper_dev",
        "DEV_QDRANT_HOST": "qdrant.dev.example.com",
        "CONTEXT_WHISPER_ENV": "PROD"
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
