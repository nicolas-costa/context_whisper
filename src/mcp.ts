import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { 
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { DatabaseManager } from './db.js';
import * as notes from './notes.js';
import { detectContext, normalizeRepoUrl } from './context-detector.js';
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
        },
      },
    };
  }

  const normalized = normalizeRepoUrl(params.repo_url);
  if (!normalized) {
    return {
      valid: false,
      error: {
        ok: false,
        error: 'Invalid repo_url format',
        details: {
          provided_repo_url: params.repo_url,
          reason: 'repo_url could not be normalized.',
          solution: 'Provide a valid git repository URL obtained via: git config --get remote.origin.url',
        },
      },
    };
  }

  return {
    valid: true,
    context: {
      workspace: normalized.owner,
      project: normalized.name,
      repo_url: normalized.url,
    }
  };
}

// Zod schemas for validation
const UpsertNoteSchema = z.object({
  environment: z.string().optional(),
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
  environment: z.string().optional(),
  repo_url: z.string(),
  topic: z.string(),
  subtopic: z.string().nullable().optional(),
});

const SearchNotesSchema = z.object({
  environment: z.string().optional(),
  query: z.string(),
  /**
   * Optional repo filter. If provided, search is scoped to that repository (and workspace/project are derived from it).
   */
  repo_url: z.string().nullable().optional(),
  top_k: z.number().int().positive().optional(),
  tags: z.array(z.string()).optional(),
  review_status: z.enum(['DRAFT', 'APPROVED']).nullable().optional(),
  workspace: z.string().optional(),
  project: z.string().optional(),
});

const ListTopicsSchema = z.object({
  environment: z.string().optional(),
  repo_url: z.string(),
});

const DeleteNoteSchema = z.object({
  environment: z.string().optional(),
  repo_url: z.string(),
  topic: z.string(),
  subtopic: z.string().nullable().optional(),
});

const HealthSchema = z.object({
  environment: z.string().optional(),
});

const ServeNotesUISchema = z.object({
  environment: z.string().optional(),
});

const SYSTEM_PROMPT = `REGRAS DE DOCUMENTAÇÃO TÉCNICA:

- Para registrar decisões técnicas, arquitetura, padrões de código ou conhecimento do projeto, prefira usar a tool 'upsert_note'.
- Evite criar novos arquivos .md no sistema de arquivos do projeto.
- O repositório de notas permite busca vetorial semântica, rastreabilidade com código-fonte e compartilhamento entre membros da equipe.

AMBIENTES DE BANCO DE DADOS:

- O context-whisper suporta múltiplos ambientes de banco de dados (ex: LOCAL, ACME_CORP, STARTUP_XYZ).
- Use o parâmetro 'environment' para especificar qual ambiente consultar.
- Se não especificado, usa o ambiente padrão configurado.
- Exemplo: "verifique nas notas técnicas do ambiente ACME sobre autenticação" → use environment: "ACME"

REQUISITO OBRIGATÓRIO - REPOSITÓRIO GIT:

- **IMPORTANTE**: Todas as ferramentas operam por repositório Git específico.
- **VOCÊ DEVE sempre fornecer 'repo_url'** obtido via: git config --get remote.origin.url
- **Workspace e project são derivados automaticamente** da repo_url fornecida

Use 'upsert_note' quando:
  * Documentar decisões arquiteturais ou técnicas
  * Explicar padrões de código ou convenções do projeto
  * Registrar problemas conhecidos e soluções
  * Criar guias de uso de APIs ou módulos internos

DICAS PARA upsert_note:
- Sempre forneça 'created_by' no formato: "git_user_name (agent_name)"
- Use 'review_status: "DRAFT"' para decisões em desenvolvimento, "APPROVED" para decisões estabelecidas

REFERÊNCIAS A CÓDIGO-FONTE INLINE:

Ao documentar, adicione links para o código usando a sintaxe:
[texto descritivo](code:caminho/arquivo.ext:linha_inicial-linha_final)

CONSULTA DE CONTEXTO TÉCNICO:

- Antes de analisar bugs ou fazer refatorações, SEMPRE consulte primeiro o repositório de notas usando 'search_notes'.
- Use 'search_notes' com queries descritivas do domínio antes de examinar código-fonte.`;

export function setupMCPServer(server: Server, dbManager: DatabaseManager): void {
  const availableEnvironments = dbManager.listEnvironments();
  const defaultEnv = dbManager.getDefaultEnvironmentName();
  const envDescription = availableEnvironments.length > 1
    ? `Database environment to use. Available: ${availableEnvironments.join(', ')}. Default: ${defaultEnv}`
    : `Database environment (default: ${defaultEnv})`;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'upsert_note',
          description: 'Cria ou atualiza uma nota técnica vetorizada. Use para registrar decisões arquiteturais, padrões de código, problemas conhecidos e soluções.',
          inputSchema: {
            type: 'object',
            properties: {
              environment: {
                type: 'string',
                description: envDescription,
              },
              repo_url: {
                type: 'string',
                description: 'REQUIRED. Full git repository URL (e.g., https://github.com/user/repo.git). Obtain via: git config --get remote.origin.url'
              },
              topic: { type: 'string', description: 'Tópico principal da nota' },
              subtopic: { type: 'string', description: 'Subtópico opcional', nullable: true },
              tags: { 
                type: 'array', 
                items: { type: 'string' },
                description: 'Tags para categorização'
              },
              body_md: { type: 'string', description: 'Conteúdo da nota em markdown' },
              created_by: { type: 'string', description: 'Autor da nota. Formato: "git_user_name (agent_name)"', nullable: true },
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
          },
        },
        {
          name: 'get_note',
          description: 'Recupera uma nota técnica específica do repositório.',
          inputSchema: {
            type: 'object',
            properties: {
              environment: {
                type: 'string',
                description: envDescription,
              },
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
              environment: {
                type: 'string',
                description: envDescription,
              },
              query: { type: 'string', description: 'Query de busca semântica' },
              repo_url: {
                type: 'string',
                description: 'OPCIONAL. Filtrar por repositório específico.',
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
              environment: {
                type: 'string',
                description: envDescription,
              },
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
              environment: {
                type: 'string',
                description: envDescription,
              },
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
          description: 'Verifica o status do banco de dados e conexões.',
          inputSchema: {
            type: 'object',
            properties: {
              environment: {
                type: 'string',
                description: envDescription,
              },
            },
          },
        },
        {
          name: 'list_environments',
          description: 'Lista todos os ambientes de banco de dados configurados.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'serve_notes_ui',
          description: 'Inicia um servidor web local para visualização amigável das notas técnicas.',
          inputSchema: {
            type: 'object',
            properties: {
              environment: {
                type: 'string',
                description: envDescription,
              },
            },
          },
        },
        {
          name: 'stop_notes_server',
          description: 'Encerra o servidor web de visualização de notas.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: 'system_context_whisper',
          description: 'System instructions for context-whisper MCP server',
          arguments: [],
        },
      ],
    };
  });

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
    const cwd = process.env.CONTEXT_WHISPER_CWD || 
                process.env.PWD || 
                process.env.CWD || 
                process.cwd();

    try {
      switch (name) {
        case 'upsert_note': {
          const rawParams = UpsertNoteSchema.parse(args);
          const adapter = await dbManager.getAdapter(rawParams.environment);

          const validation = validateRequiredContext({
            repo_url: rawParams.repo_url,
          });

          if (!validation.valid) {
            return {
              content: [{ type: 'text', text: JSON.stringify(validation.error, null, 2) }],
              isError: true,
            };
          }

          const paramsWithContext = {
            ...rawParams,
            workspace: validation.context!.workspace,
            project: validation.context!.project,
          };

          const result = await notes.upsertNote(adapter, paramsWithContext as notes.UpsertNoteParams, cwd);
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                environment: rawParams.environment || dbManager.getDefaultEnvironmentName(),
                context: result.context,
                note_id: result.note_id,
              }, null, 2),
            }],
          };
        }

        case 'get_note': {
          const rawParams = GetNoteSchema.parse(args);
          const adapter = await dbManager.getAdapter(rawParams.environment);

          const validation = validateRequiredContext({
            repo_url: rawParams.repo_url,
          });

          if (!validation.valid) {
            return {
              content: [{ type: 'text', text: JSON.stringify(validation.error, null, 2) }],
              isError: true,
            };
          }

          const paramsWithContext = {
            ...rawParams,
            workspace: validation.context!.workspace,
            project: validation.context!.project,
          };

          const result = await notes.getNote(adapter, paramsWithContext as notes.GetNoteParams, cwd);
          
          if (!result.note) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  error: 'Note not found',
                  environment: rawParams.environment || dbManager.getDefaultEnvironmentName(),
                  context: result.context,
                }, null, 2),
              }],
              isError: true,
            };
          }
          
          const noteWithParsedTags = {
            ...result.note,
            tags: result.note.tags_json ? JSON.parse(result.note.tags_json) : null,
            tags_json: undefined,
          };

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                environment: rawParams.environment || dbManager.getDefaultEnvironmentName(),
                context: result.context,
                note: noteWithParsedTags,
              }, null, 2),
            }],
          };
        }

        case 'search_notes': {
          const rawParams = SearchNotesSchema.parse(args);
          const adapter = await dbManager.getAdapter(rawParams.environment);

          let paramsWithContext = rawParams;

          if (rawParams.repo_url) {
            const validation = validateRequiredContext({
              repo_url: rawParams.repo_url,
            });

            if (!validation.valid) {
              return {
                content: [{ type: 'text', text: JSON.stringify(validation.error, null, 2) }],
                isError: true,
              };
            }

            paramsWithContext = {
              ...rawParams,
              workspace: validation.context!.workspace,
              project: validation.context!.project,
            };
          }

          const result = await notes.searchNotes(adapter, paramsWithContext as notes.SearchNotesParams, cwd);
          
          const resultsWithParsedTags = result.notes.map((r) => ({
            ...r,
            tags: r.tags_json ? JSON.parse(r.tags_json) : null,
            tags_json: undefined,
          }));

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                environment: rawParams.environment || dbManager.getDefaultEnvironmentName(),
                context: result.context,
                notes: resultsWithParsedTags,
              }, null, 2),
            }],
          };
        }

        case 'list_topics': {
          const rawParams = ListTopicsSchema.parse(args);
          const adapter = await dbManager.getAdapter(rawParams.environment);

          const validation = validateRequiredContext({
            repo_url: rawParams.repo_url,
          });

          if (!validation.valid) {
            return {
              content: [{ type: 'text', text: JSON.stringify(validation.error, null, 2) }],
              isError: true,
            };
          }

          const paramsWithContext = {
            ...rawParams,
            workspace: validation.context!.workspace,
            project: validation.context!.project,
          };

          const result = await notes.listTopics(adapter, paramsWithContext as notes.ListTopicsParams, cwd);
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                environment: rawParams.environment || dbManager.getDefaultEnvironmentName(),
                context: result.context,
                topics: result.topics,
              }, null, 2),
            }],
          };
        }

        case 'delete_note': {
          const rawParams = DeleteNoteSchema.parse(args);
          const adapter = await dbManager.getAdapter(rawParams.environment);

          const validation = validateRequiredContext({
            repo_url: rawParams.repo_url,
          });

          if (!validation.valid) {
            return {
              content: [{ type: 'text', text: JSON.stringify(validation.error, null, 2) }],
              isError: true,
            };
          }

          const paramsWithContext = {
            ...rawParams,
            workspace: validation.context!.workspace,
            project: validation.context!.project,
          };

          const result = await notes.deleteNote(adapter, paramsWithContext as notes.DeleteNoteParams, cwd);
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                environment: rawParams.environment || dbManager.getDefaultEnvironmentName(),
                context: result.context,
                deleted: result.deleted,
              }, null, 2),
            }],
          };
        }

        case 'health': {
          const rawParams = HealthSchema.parse(args);
          
          try {
            const adapter = await dbManager.getAdapter(rawParams.environment);
            const health = await adapter.isHealthy();
            const envName = rawParams.environment || dbManager.getDefaultEnvironmentName();
            const config = dbManager.getEnvironmentConfig(envName);
            
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  environment: envName,
                  status: health.relational && health.vector ? 'healthy' : 'degraded',
                  relational_healthy: health.relational,
                  vector_healthy: health.vector,
                  database_type: config?.relational.type,
                  vector_type: config?.vector.type,
                }, null, 2),
              }],
            };
          } catch (error) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  status: 'unhealthy',
                  error: error instanceof Error ? error.message : String(error),
                }, null, 2),
              }],
              isError: true,
            };
          }
        }

        case 'list_environments': {
          const environments = dbManager.listEnvironments();
          const defaultEnv = dbManager.getDefaultEnvironmentName();
          
          const envDetails = environments.map(env => {
            const config = dbManager.getEnvironmentConfig(env);
            return {
              name: env,
              is_default: env === defaultEnv,
              relational_type: config?.relational.type,
              vector_type: config?.vector.type,
            };
          });

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                environments: envDetails,
                default_environment: defaultEnv,
              }, null, 2),
            }],
          };
        }

        case 'serve_notes_ui': {
          const rawParams = ServeNotesUISchema.parse(args);
          const adapter = await dbManager.getAdapter(rawParams.environment);
          
          const url = await startServer({
            adapter,
            cwd
          });
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                environment: rawParams.environment || dbManager.getDefaultEnvironmentName(),
                url,
                message: 'Web UI server started. Navigate to the URL to view notes.',
                auto_shutdown: 'Server will shutdown after 10 minutes of inactivity.'
              }, null, 2),
            }],
          };
        }

        case 'stop_notes_server': {
          await stopServer();
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                message: 'Web UI server stopped.'
              }, null, 2),
            }],
          };
        }

        default:
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: `Unknown tool: ${name}` }, null, 2),
            }],
            isError: true,
          };
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Validation error',
              details: error.errors,
            }, null, 2),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }, null, 2),
        }],
        isError: true,
      };
    }
  });
}

export function getSystemPrompt(): string {
  return SYSTEM_PROMPT;
}
