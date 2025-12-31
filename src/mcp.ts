import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { 
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import * as notes from './notes.js';
import * as db from './db.js';
import { detectContext, normalizeRepoUrl } from './context-detector.js';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { startServer, stopServer } from './web/server.js';

// Helper function to validate required parameters
function validateRequiredContext(params: {
  repo_url?: string | null;
}): { valid: boolean; error?: any; context?: { workspace: string; project: string; repo_url: string } } {
  if (!params.repo_url) {
    return {
      valid: false,
      error: {
        ok: false,
        error: 'Missing required parameter: repo_url',
        details: {
          rule: 'repo_url is required for all operations',
          provided: { repo_url: params.repo_url || null },
          solution: 'Obtain repo_url using: git config --get remote.origin.url',
          examples: {
            git_command: 'git config --get remote.origin.url',
            tool_usage: {
              upsert_note: {
                repo_url: 'https://github.com/workspace/project.git',
                topic: 'authentication',
                body_md: '## Implementation...'
              }
            }
          },
        },
      },
    };
  }

  // Validate and normalize repo_url format
  const normalized = normalizeRepoUrl(params.repo_url);
  if (!normalized) {
    return {
      valid: false,
      error: {
        ok: false,
        error: 'Invalid repo_url format',
        details: {
          provided_repo_url: params.repo_url,
          reason: 'repo_url could not be normalized. It should be a valid git repository URL.',
          solution: 'Provide a valid git repository URL obtained via: git config --get remote.origin.url',
          examples: {
            valid_formats: [
              'https://github.com/workspace/project.git',
              'https://github.com/workspace/project',
              'git@github.com:workspace/project.git',
            ],
            how_to_get: 'Run: git config --get remote.origin.url in your project directory'
          },
        },
      },
    };
  }

  // Return derived context
  return {
    valid: true,
    context: {
      workspace: normalized.owner,
      project: normalized.name,
      repo_url: normalized.url,
    }
  };
}


// Zod schemas for validation - repo_url is required, workspace/project derived automatically
const UpsertNoteSchema = z.object({
  repo_url: z.string(),
  topic: z.string(),
  subtopic: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  body_md: z.string(),
  created_by: z.string().nullable().optional(),
  review_status: z.enum(['DRAFT', 'APPROVED']).optional(),
  links: z.array(z.object({
    repo: z.string().nullable().optional(),
    path: z.string().nullable().optional(),
    symbol: z.string().nullable().optional(),
    commit_sha: z.string().nullable().optional(),
    line_start: z.number().nullable().optional(),
    line_end: z.number().nullable().optional(),
  })).optional(),
});

const GetNoteSchema = z.object({
  repo_url: z.string(),
  topic: z.string(),
  subtopic: z.string().nullable().optional(),
});

const SearchNotesSchema = z.object({
  query: z.string(),
  repo_url: z.string().optional(), // Optional for global search
  top_k: z.number().int().positive().optional(),
  tags: z.array(z.string()).optional(),
  review_status: z.string().nullable().optional(),
  workspace: z.string().optional(), // Derived from repo_url if provided
  project: z.string().optional(), // Derived from repo_url if provided
});

const ListTopicsSchema = z.object({
  repo_url: z.string(),
});

const DeleteNoteSchema = z.object({
  repo_url: z.string(),
  topic: z.string(),
  subtopic: z.string().nullable().optional(),
});

const ServeNotesUISchema = z.object({
  // No params required, but we can allow optional workspace/project to seed the UI context if desired?
  // For now, let's keep it simple.
});

const StopNotesServerSchema = z.object({});

const SYSTEM_PROMPT = `REGRAS DE DOCUMENTAÇÃO TÉCNICA:

- Para registrar decisões técnicas, arquitetura, padrões de código ou conhecimento do projeto, prefira usar a tool 'upsert_note'.
- Evite criar novos arquivos .md no sistema de arquivos do projeto. Exceções permitidas:
  * Atualizar README.md e outros arquivos .md existentes no projeto
  * Manter arquivos de changelog ou release notes quando já existem no projeto
- O repositório de notas permite busca vetorial semântica, rastreabilidade com código-fonte e compartilhamento entre membros da equipe.

REQUISITO OBRIGATÓRIO - REPOSITÓRIO GIT:

- **IMPORTANTE**: Todas as ferramentas do context-whisper operam por repositório Git específico.
- **VOCÊ DEVE sempre fornecer 'repo_url'** obtido via: git config --get remote.origin.url
- **Workspace e project são derivados automaticamente** da repo_url fornecida
- **Se você não conseguir obter a URL do repositório via Git, as ferramentas retornarão erro**

Use 'upsert_note' quando:
  * Documentar decisões arquiteturais ou técnicas
  * Explicar padrões de código ou convenções do projeto
  * Registrar problemas conhecidos e soluções
  * Criar guias de uso de APIs ou módulos internos

DICAS PARA upsert_note:
- Sempre forneça 'created_by' no formato: "git_user_name (agent_name)" - ex: "João Silva (claude-sonnet)"
- Obtenha git_user_name via: git config user.name
- Use 'review_status: "DRAFT"' para decisões em desenvolvimento, "APPROVED" para decisões estabelecidas

- Para consultar documentação existente, use 'search_notes' ou 'get_note'.

REFERÊNCIAS A CÓDIGO-FONTE INLINE:

Ao documentar funcionalidades, decisões ou problemas técnicos, SEMPRE adicione links
para o código-fonte relacionado diretamente no markdown usando a sintaxe:

[texto descritivo](code:caminho/arquivo.ext:linha_inicial-linha_final)

Exemplos de uso:
- ✅ **Autenticação JWT**: Sistema funcionando
  [implementação](code:src/auth/middleware.ts:45-78)
  
- ✅ **Smart Contract TipRouter**: Modos FORWARD/HOLD
  [contrato](code:contracts/TipRouter.sol:12-89)
  
- ❌ **Bug no SweepService**: API legada sem currency
  [código problemático](code:src/services/SweepService.php:120-145)

Variações opcionais:
- [função validateJWT](code:src/auth.ts:12-25:symbol=validateJWT)
- [commit abc123](code:src/service.php:45-120:commit=abc123)

REGRAS:
- Adicione links APÓS cada item que menciona código específico
- Use linhas aproximadas se não souber exatamente (ex: 45-60)
- Se não souber o arquivo exato, omita o link mas documente o problema
- Links são extraídos automaticamente e vinculados à nota
- Você pode também usar o campo 'links' explicitamente, mas prefira links inline no markdown

CONSULTA DE CONTEXTO TÉCNICO:

- Antes de analisar bugs, fazer refatorações ou implementar mudanças em um fluxo/funcionalidade, SEMPRE consulte primeiro o repositório de notas usando 'search_notes'.
- Priorize buscar documentação técnica sobre decisões de implementação (ex: escolha de OAuth vs JWT, padrões de autenticação, estratégias de cache) mesmo que apenas decisões técnicas tenham sido documentadas, não detalhes de implementação.
- O contexto de decisões técnicas ajuda a entender o "porquê" antes de analisar o "como" no código.
- Use 'search_notes' com queries descritivas do domínio (ex: "autenticação", "fluxo de login", "jwt refresh") antes de examinar código-fonte.
- Quando a busca retornar resultados relevantes, use 'get_note' para obter detalhes completos de uma nota específica.`;

export function setupMCPServer(server: Server, database: Database.Database): void {
  // Set system prompt
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'upsert_note',
          description: 'Cria ou atualiza uma nota técnica vetorizada. Use para registrar decisões arquiteturais, padrões de código, problemas conhecidos e soluções.',
          inputSchema: {
            type: 'object',
            properties: {
              repo_url: {
                type: 'string',
                description: 'REQUIRED. Full git repository URL (e.g., https://github.com/user/repo.git). Obtain via: git config --get remote.origin.url in your project directory. Workspace and project will be automatically derived from this URL.'
              },
              topic: { type: 'string', description: 'Tópico principal da nota' },
              subtopic: { type: 'string', description: 'Subtópico opcional', nullable: true },
              tags: { 
                type: 'array', 
                items: { type: 'string' },
                description: 'Tags para categorização'
              },
              body_md: { type: 'string', description: 'Conteúdo da nota em markdown' },
              created_by: { type: 'string', description: 'Autor da nota. Formato: "git_user_name (agent_name)" - ex: "João Silva (claude-sonnet)"', nullable: true },
              review_status: { 
                type: 'string', 
                enum: ['DRAFT', 'APPROVED'],
                description: 'Status de revisão'
              },
              links: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    repo: { type: 'string', nullable: true },
                    path: { type: 'string', nullable: true },
                    symbol: { type: 'string', nullable: true },
                    commit_sha: { type: 'string', nullable: true },
                    line_start: { type: 'number', nullable: true },
                    line_end: { type: 'number', nullable: true },
                  },
                },
                description: 'Links para código-fonte relacionado',
              },
            },
            required: ['repo_url', 'topic', 'body_md'],
            examples: [
              {
                description: 'Documenting an authentication decision',
                value: {
                  repo_url: 'https://github.com/username/repo.git',
                  topic: 'Authentication System',
                  created_by: 'João Silva (claude-sonnet)',
                  body_md: '# JWT Implementation\n\nWe chose JWT over sessions for stateless authentication...',
                },
              },
            ],
            'x-hints': {
              for_ai_agents: [
                'Always provide repo_url if possible (obtain via: git config --get remote.origin.url)',
                'If repo_url is provided, workspace and project will be derived automatically',
                'workspace is typically the GitHub username or organization',
                'project is typically the repository name',
                'repo_url should be the full HTTPS URL to the repository',
              ],
            },
          },
        },
        {
          name: 'get_note',
          description: 'Recupera uma nota técnica específica do repositório.',
          inputSchema: {
            type: 'object',
            properties: {
              repo_url: {
                type: 'string',
                description: 'REQUIRED. Full git repository URL where the note is stored.'
              },
              topic: { type: 'string', description: 'Tópico da nota' },
              subtopic: { type: 'string', description: 'Subtópico opcional', nullable: true },
            },
            required: ['repo_url', 'topic'],
          },
        },
        {
          name: 'search_notes',
          description: 'Busca notas técnicas usando similaridade semântica vetorial. Busca global se repo_url não for especificado.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Query de busca semântica' },
              repo_url: {
                type: 'string',
                description: 'OPCIONAL. Filtrar por repositório específico. Se não fornecido, busca em todos os repositórios.',
                nullable: true
              },
              top_k: { type: 'number', description: 'Número de resultados (padrão: 5)' },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filtrar por tags'
              },
              review_status: {
                type: 'string',
                enum: ['DRAFT', 'APPROVED'],
                description: 'Filtrar por status de revisão',
                nullable: true
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'list_topics',
          description: 'Lista todos os tópicos disponíveis para um repositório.',
          inputSchema: {
            type: 'object',
            properties: {
              repo_url: {
                type: 'string',
                description: 'REQUIRED. Full git repository URL para listar tópicos.'
              },
            },
            required: ['repo_url'],
          },
        },
        {
          name: 'delete_note',
          description: 'Remove uma nota técnica e todos os dados associados (vetor, links).',
          inputSchema: {
            type: 'object',
            properties: {
              repo_url: {
                type: 'string',
                description: 'REQUIRED. Full git repository URL onde a nota está armazenada.'
              },
              topic: { type: 'string', description: 'Tópico da nota a ser removida' },
              subtopic: { type: 'string', description: 'Subtópico opcional', nullable: true },
            },
            required: ['repo_url', 'topic'],
          },
        },
        {
          name: 'health',
          description: 'Verifica o status do banco de dados e extensão sqlite-vec.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'serve_notes_ui',
          description: 'Inicia um servidor web local para visualização amigável das notas técnicas. Retorna a URL para acesso. O servidor encerra automaticamente após 10 minutos de inatividade.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'stop_notes_server',
          description: 'Encerra o servidor web de visualização de notas imediatamente.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    };
  });

  // Register prompts handler to expose system prompt
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: 'system_context_whisper',
          description: 'System instructions for context-whisper MCP server - usage guidelines and auto-detection rules',
          arguments: [],
        },
      ],
    };
  });

  // Handler to get the actual prompt content
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    
    if (name === 'system_context_whisper') {
      return {
        description: 'System instructions for context-whisper MCP server',
        messages: [
          {
            role: 'system',
            content: {
              type: 'text',
              text: SYSTEM_PROMPT,
            },
          },
        ],
      };
    }
    
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: `Unknown prompt: ${name}` }, null, 2),
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Try to get cwd from environment variable first (may be set by the MCP client/IDE)
    // Fallback to process.cwd() which is the server's working directory
    const cwd = process.env.CONTEXT_WHISPER_CWD || 
                 process.env.PWD || 
                 process.env.CWD || 
                 process.cwd();

    try {
      switch (name) {
        case 'upsert_note': {
          const rawParams = UpsertNoteSchema.parse(args);

          // Validate required repo_url and derive workspace/project
          const validation = validateRequiredContext({
            repo_url: rawParams.repo_url,
          });

          if (!validation.valid) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(validation.error, null, 2),
                },
              ],
              isError: true,
            };
          }

          // Add derived context to params
          const paramsWithContext = {
            ...rawParams,
            workspace: validation.context!.workspace,
            project: validation.context!.project,
          };

          const result = await notes.upsertNote(database, paramsWithContext as notes.UpsertNoteParams, cwd);
          
          // Return with context
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  context: result.context,
                  note_id: result.note_id,
                }, null, 2),
              },
            ],
          };
        }

        case 'get_note': {
          const rawParams = GetNoteSchema.parse(args);

          // Validate required repo_url and derive workspace/project
          const validation = validateRequiredContext({
            repo_url: rawParams.repo_url,
          });

          if (!validation.valid) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(validation.error, null, 2),
                },
              ],
              isError: true,
            };
          }

          // Add derived context to params
          const paramsWithContext = {
            ...rawParams,
            workspace: validation.context!.workspace,
            project: validation.context!.project,
          };

          const result = notes.getNote(database, paramsWithContext as notes.GetNoteParams, cwd);
          
          if (!result.note) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ok: false,
                    error: 'Note not found',
                    context: result.context,
                  }, null, 2),
                },
              ],
              isError: true,
            };
          }
          
          // Parse tags_json back to array
          const noteWithParsedTags = {
            ...result.note,
            tags: result.note.tags_json ? JSON.parse(result.note.tags_json) : null,
            tags_json: undefined,
          };

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  context: result.context,
                  note: noteWithParsedTags,
                }, null, 2),
              },
            ],
          };
        }

        case 'search_notes': {
          const rawParams = SearchNotesSchema.parse(args);

          let paramsWithContext = rawParams;

          // If repo_url is provided, validate and derive workspace/project
          if (rawParams.repo_url) {
            const validation = validateRequiredContext({
              repo_url: rawParams.repo_url,
            });

            if (!validation.valid) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(validation.error, null, 2),
                  },
                ],
                isError: true,
              };
            }

            // Add derived context to params
            paramsWithContext = {
              ...rawParams,
              workspace: validation.context!.workspace,
              project: validation.context!.project,
            };
          }

          const result = await notes.searchNotes(database, paramsWithContext as notes.SearchNotesParams, cwd);
          
          // Parse tags_json for each result
          const resultsWithParsedTags = result.notes.map((r) => ({
            ...r,
            tags: r.tags_json ? JSON.parse(r.tags_json) : null,
            tags_json: undefined,
          }));

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  context: result.context,
                  notes: resultsWithParsedTags,
                }, null, 2),
              },
            ],
          };
        }

        case 'list_topics': {
          const rawParams = ListTopicsSchema.parse(args);

          // Validate required repo_url and derive workspace/project
          const validation = validateRequiredContext({
            repo_url: rawParams.repo_url,
          });

          if (!validation.valid) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(validation.error, null, 2),
                },
              ],
              isError: true,
            };
          }

          // Add derived context to params
          const paramsWithContext = {
            ...rawParams,
            workspace: validation.context!.workspace,
            project: validation.context!.project,
          };

          const result = notes.listTopics(database, paramsWithContext as notes.ListTopicsParams, cwd);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  context: result.context,
                  topics: result.topics,
                }, null, 2),
              },
            ],
          };
        }

        case 'delete_note': {
          const rawParams = DeleteNoteSchema.parse(args);

          // Validate required repo_url and derive workspace/project
          const validation = validateRequiredContext({
            repo_url: rawParams.repo_url,
          });

          if (!validation.valid) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(validation.error, null, 2),
                },
              ],
              isError: true,
            };
          }

          // Add derived context to params
          const paramsWithContext = {
            ...rawParams,
            workspace: validation.context!.workspace,
            project: validation.context!.project,
          };

          const result = notes.deleteNote(database, paramsWithContext as notes.DeleteNoteParams, cwd);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  context: result.context,
                  deleted: result.deleted,
                }, null, 2),
              },
            ],
          };
        }

        case 'health': {
          try {
            const version = db.getSchemaVersion(database);
            
            // Check if vec0 extension is loaded by attempting to use it
            let vecExtensionLoaded = false;
            let vecExtensionError: string | null = null;
            try {
              // Try to use vec0 module to verify it's loaded
              database.exec('SELECT 1 FROM (SELECT vec_version()) LIMIT 1');
              vecExtensionLoaded = true;
            } catch (vecError) {
              vecExtensionError = vecError instanceof Error ? vecError.message : String(vecError);
              // Fallback: check if note_vectors table exists and is accessible
              try {
                const tableCheck = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='note_vectors'").get();
                if (tableCheck) {
                  // Try a simple SELECT to see if table works
                  database.prepare('SELECT COUNT(*) FROM note_vectors LIMIT 1').get();
                  vecExtensionLoaded = true; // Table exists and works
                }
              } catch {
                // vec0 not properly loaded
                vecExtensionLoaded = false;
              }
            }
            
            const context = detectContext(undefined, cwd);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ok: true,
                    status: vecExtensionLoaded ? 'healthy' : 'degraded',
                    schema_version: version,
                    vec_extension_loaded: vecExtensionLoaded,
                    vec_extension_error: vecExtensionError || undefined,
                    vector_search_available: vecExtensionLoaded,
                    context,
                  }, null, 2),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ok: false,
                    status: 'unhealthy',
                    error: error instanceof Error ? error.message : String(error),
                  }, null, 2),
                },
              ],
              isError: true,
            };
          }
        }

        case 'serve_notes_ui': {
          const url = await startServer({
            database,
            cwd
          });
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  url,
                  message: 'Web UI server started. Navigate to the URL to view notes.',
                  auto_shutdown: 'Server will shutdown after 10 minutes of inactivity.'
                }, null, 2),
              },
            ],
          };
        }

        case 'stop_notes_server': {
          await stopServer();
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  message: 'Web UI server stopped.'
                }, null, 2),
              },
            ],
          };
        }

        default:
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Unknown tool: ${name}` }, null, 2),
              },
            ],
            isError: true,
          };
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Validation error',
                details: error.errors,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });
}

export function getSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

