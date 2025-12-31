# context-whisper

MCP Server para repositório de notas técnicas vetorizadas usando SQLite + sqlite-vec.

## Descrição

O `context-whisper` é um servidor MCP (Model Context Protocol) que fornece um repositório de notas técnicas vetorizadas para projetos de software. Ele utiliza SQLite com a extensão `sqlite-vec` para realizar buscas por similaridade semântica (KNN) diretamente em SQL, e embeddings locais com `@xenova/transformers` para gerar vetores de documentos.

## Características

- **Busca Vetorial Semântica**: Busque notas técnicas usando similaridade semântica, não apenas palavras-chave
- **Embeddings Locais**: Gera embeddings usando modelos locais (MiniLM-L6-v2), sem necessidade de APIs externas
- **Rastreabilidade**: Links notas técnicas com código-fonte específico (repo, path, símbolos, linhas)
- **Workspace/Project Organization**: Organize notas por workspace e projeto
- **Tags e Status**: Categorize notas com tags e controle de revisão (DRAFT/APPROVED)
- **Auto-detecção de Contexto**: Detecta automaticamente workspace/project do Git, configuração ou estrutura de pastas
- **Rastreabilidade de Repositório**: Armazena informações do repositório (URL, fingerprint, provider, owner) para melhor organização

## Instalação

```bash
npm install
npm run build
```

## Uso

### Via npx

```bash
npx context-whisper --workspace personal
```

### Desenvolvimento

```bash
npm run dev
```

### Opções CLI

- `--db <path>`: Caminho para o arquivo SQLite (padrão: ~/.local/share/context-whisper/meta.sqlite no Linux)
- `--workspace <name>`: Nome do workspace (padrão: 'default')
- `--vec-lib <path>`: Caminho para a extensão sqlite-vec

### Variáveis de Ambiente

- `CONTEXT_WHISPER_DB_PATH`: Caminho do banco de dados
- `CONTEXT_WHISPER_VEC_LIB`: Caminho da extensão sqlite-vec


## Instalação do sqlite-vec (Automático)

O `sqlite-vec` é **essencial** para a funcionalidade RAG (Retrieval-Augmented Generation) e está incluído como dependência. O binário correto para sua plataforma será instalado automaticamente via npm:

```bash
npm install
```

O servidor detectará automaticamente o binário (`vec0.so` no Linux, `vec0.dylib` no macOS, `vec0.dll` no Windows) em `node_modules/sqlite-vec-<platform>-<arch>/`.

**Detecção automática:**

O servidor procura a extensão automaticamente em:
1. `node_modules/sqlite-vec-<platform>-<arch>/vector0` (se instalado via npm)
2. Paths comuns do sistema:
   - `/usr/local/lib/sqlite3/vector0`
   - `/usr/lib/x86_64-linux-gnu/sqlite3/vector0`
   - `/usr/lib/sqlite3/vector0`
   - `/opt/homebrew/lib/sqlite3/vector0`
   - `/usr/local/lib/vector0`

**Especificar caminho manualmente (se necessário):**

Use `--vec-lib <path>` ou `CONTEXT_WHISPER_VEC_LIB` se a detecção automática falhar.

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

**Nota:**
- `repo_url` é obrigatório e deve ser obtido via `git config --get remote.origin.url` no diretório do projeto
- `workspace` e `project` são derivados automaticamente da URL
- `created_by` deve ser preenchido no formato: "git_user_name (agent_name)" - ex: "John Doe (claude-sonnet)"

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

**Nota:** `repo_url` é obrigatório.

### search_notes

Busca notas usando similaridade semântica vetorial. Busca global se repo_url não for especificado.

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

**Payload:**
```json
{
  "repo_url": "https://github.com/workspace/project"
}
```

**Nota:** `repo_url` é obrigatório.

### delete_note

Remove uma nota e todos os dados associados.

**Payload:**
```json
{
  "repo_url": "https://github.com/workspace/project",
  "topic": "autenticacao",
  "subtopic": "jwt"
}
```

**Nota:** `repo_url` é obrigatório.



### health

Verifica o status do banco de dados e extensão sqlite-vec.

**Payload:** `{}`

## Estrutura do Banco de Dados

O banco de dados SQLite contém:

- **notes**: Tabela principal com notas técnicas
- **note_links**: Links para código-fonte relacionado
- **note_vectors**: Tabela virtual com embeddings (384 dimensões)

## Regras de Comportamento

O sistema inclui uma mensagem de sistema que orienta agentes a:

1. **Usar `upsert_note`** para documentação técnica em vez de criar arquivos `.md`
2. **Consultar `search_notes`** antes de analisar código para entender decisões técnicas
3. **Fornecer `repo_url`** em todas as operações (obter via `git config --get remote.origin.url`)
4. **Workspace/project são derivados automaticamente** da repo_url fornecida

## Dependências

- `better-sqlite3`: Cliente SQLite para Node.js
- `@xenova/transformers`: Embeddings locais
- `sqlite-vec`: Extensão SQLite para busca vetorial (deve ser instalada separadamente)
- `@modelcontextprotocol/sdk`: SDK do MCP
- `zod`: Validação de schemas
- `commander`: CLI parsing

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

