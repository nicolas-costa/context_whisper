import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execFileSync } from 'child_process';
import { z } from 'zod';
import type { DatabaseManager } from './db.js';
import * as notes from './notes.js';
import { normalizeRepoUrl } from './context-detector.js';
import { startServer, stopServer } from './web/server.js';
import { resolveActingAccount } from './accounts.js';

function getGitRemoteOriginUrl(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const v = String(out).trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function errorResponse(error: string, details?: any) {
  return {
    ok: false,
    error,
    ...(details ? { details } : {}),
  };
}

function resolveRepoContextStrict(params: { repo_url: string; cwd: string }):
  | {
    workspace: string;
    project: string;
    repo_url: string;
  }
  | { error: any } {
  const normalizedPayload = normalizeRepoUrl(params.repo_url);
  if (!normalizedPayload) {
    return {
      error: errorResponse('Invalid repo_url format', { provided_repo_url: params.repo_url }),
    };
  }

  const remote = getGitRemoteOriginUrl(params.cwd);
  if (!remote) {
    return {
      error: errorResponse('Could not resolve git remote from cwd', {
        cwd: params.cwd,
        rule: 'cwd must be a git worktree with remote.origin.url configured',
      }),
    };
  }

  const normalizedRemote = normalizeRepoUrl(remote);
  if (!normalizedRemote) {
    return {
      error: errorResponse('Invalid git remote URL in cwd', {
        cwd: params.cwd,
        remote_origin_url: remote,
      }),
    };
  }

  if (normalizedRemote.url !== normalizedPayload.url) {
    return {
      error: errorResponse('repo_url does not match git remote of cwd', {
        cwd: params.cwd,
        repo_url: params.repo_url,
        git_remote_origin_url: remote,
        normalized_repo_url: normalizedPayload.url,
        normalized_git_remote_origin_url: normalizedRemote.url,
      }),
    };
  }

  return {
    workspace: normalizedPayload.owner,
    project: normalizedPayload.name,
    repo_url: normalizedPayload.url,
  };
}

function resolveEnvironmentForWorkspace(
  dbManager: DatabaseManager,
  repoWorkspace: string,
  requestedEnv?: string
): { envName: string } | { error: any } {
  const defaultEnv = dbManager.getDefaultEnvironmentName();

  if (requestedEnv) {
    const cfg = dbManager.getEnvironmentConfig(requestedEnv);
    if (!cfg) {
      return { error: errorResponse(`Environment '${requestedEnv}' not configured`) };
    }
    if (
      cfg.allowedWorkspaces &&
      cfg.allowedWorkspaces.length > 0 &&
      !cfg.allowedWorkspaces.includes(repoWorkspace)
    ) {
      return {
        error: errorResponse(
          `Workspace '${repoWorkspace}' is not allowed for environment '${requestedEnv}'`,
          {
            environment: requestedEnv,
            workspace: repoWorkspace,
            allowed_workspaces: cfg.allowedWorkspaces,
          }
        ),
      };
    }
    return { envName: requestedEnv };
  }

  const matches: string[] = [];
  for (const envName of dbManager.listEnvironments()) {
    const cfg = dbManager.getEnvironmentConfig(envName);
    if (!cfg?.allowedWorkspaces || cfg.allowedWorkspaces.length === 0) continue;
    if (cfg.allowedWorkspaces.includes(repoWorkspace)) matches.push(envName);
  }

  if (matches.length === 1) return { envName: matches[0] };
  if (matches.length > 1) {
    return {
      error: errorResponse(`Workspace '${repoWorkspace}' matches multiple environments`, {
        workspace: repoWorkspace,
        matching_environments: matches,
      }),
    };
  }

  // No explicit routing rule: fall back to default only if it allows (when allowlist is present)
  const defCfg = dbManager.getEnvironmentConfig(defaultEnv);
  if (
    defCfg?.allowedWorkspaces &&
    defCfg.allowedWorkspaces.length > 0 &&
    !defCfg.allowedWorkspaces.includes(repoWorkspace)
  ) {
    return {
      error: errorResponse(
        `Workspace '${repoWorkspace}' is not allowed for default environment '${defaultEnv}'`,
        {
          workspace: repoWorkspace,
          default_environment: defaultEnv,
          allowed_workspaces: defCfg.allowedWorkspaces,
        }
      ),
    };
  }
  return { envName: defaultEnv };
}

// Zod schemas for validation
const UpsertNoteSchema = z.object({
  environment: z.string().optional(),
  cwd: z.string().min(1),
  repo_url: z.string(),
  topic: z.string().max(500),
  subtopic: z.string().max(500).nullable().optional(),
  tags: z.array(z.string()).optional(),
  // Prevent trivial DoS by sending massive payloads.
  body_md: z.string().max(1_000_000),
  created_by: z.string().nullable().optional(),
  review_status: z.enum(['DRAFT']).optional(),
  links: z
    .array(
      z.object({
        repo: z.string().nullable().optional(),
        path: z.string().nullable().optional(),
        symbol: z.string().nullable().optional(),
        commit_sha: z.string().nullable().optional(),
        line_start: z.number().nullable().optional(),
        line_end: z.number().nullable().optional(),
      })
    )
    .optional(),
});

const GetNoteSchema = z.object({
  environment: z.string().optional(),
  cwd: z.string().min(1),
  repo_url: z.string(),
  topic: z.string().max(500),
  subtopic: z.string().max(500).nullable().optional(),
});

const SearchNotesSchema = z
  .object({
    environment: z.string().optional(),
    cwd: z.string().min(1).optional(),
    query: z.string(),
    repo_url: z.string().optional(),
    top_k: z.number().int().positive().optional(),
    tags: z.array(z.string()).optional(),
    review_status: z.enum(['DRAFT', 'APPROVED']).nullable().optional(),
  })
  .refine((data) => !data.repo_url || data.cwd, {
    message: 'cwd is required when repo_url is provided',
    path: ['cwd'],
  });

const ListTopicsSchema = z.object({
  environment: z.string().optional(),
  cwd: z.string().min(1),
  repo_url: z.string(),
});

const DeleteNoteSchema = z.object({
  environment: z.string().optional(),
  cwd: z.string().min(1),
  repo_url: z.string(),
  topic: z.string().max(500),
  subtopic: z.string().max(500).nullable().optional(),
});

const HealthSchema = z.object({
  environment: z.string().optional(),
});

const ServeNotesUISchema = z.object({
  environment: z.string().optional(),
  cwd: z.string().min(1),
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
- upsert_note grava DRAFT. Nota estabelecida só entra por approve_note

REFERÊNCIAS A CÓDIGO-FONTE INLINE:

Ao documentar, adicione links para o código usando a sintaxe:
[texto descritivo](code:caminho/arquivo.ext:linha_inicial-linha_final)

CONSULTA DE CONTEXTO TÉCNICO:

- Antes de analisar bugs ou fazer refatorações, SEMPRE consulte primeiro o repositório de notas usando 'search_notes'.
- Use 'search_notes' com queries descritivas do domínio antes de examinar código-fonte.`;

export function setupMCPServer(server: Server, dbManager: DatabaseManager): void {
  const availableEnvironments = dbManager.listEnvironments();
  const defaultEnv = dbManager.getDefaultEnvironmentName();
  const envDescription =
    availableEnvironments.length > 1
      ? `Database environment to use. Available: ${availableEnvironments.join(', ')}. Default: ${defaultEnv}`
      : `Database environment (default: ${defaultEnv})`;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'upsert_note',
          description:
            'Cria ou atualiza uma nota técnica vetorizada. Use para registrar decisões arquiteturais, padrões de código, problemas conhecidos e soluções.',
          inputSchema: {
            type: 'object',
            properties: {
              cwd: {
                type: 'string',
                description:
                  'REQUIRED. Local working directory of the git repository. Used to verify repo_url via git remote.',
              },
              environment: {
                type: 'string',
                description: envDescription,
              },
              repo_url: {
                type: 'string',
                description:
                  'REQUIRED. Full git repository URL (e.g., https://github.com/user/repo.git). Obtain via: git config --get remote.origin.url',
              },
              topic: { type: 'string', description: 'Tópico principal da nota' },
              subtopic: { type: 'string', description: 'Subtópico opcional', nullable: true },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tags para categorização',
              },
              body_md: { type: 'string', description: 'Conteúdo da nota em markdown' },
              created_by: {
                type: 'string',
                description: 'Autor da nota. Formato: "git_user_name (agent_name)"',
                nullable: true,
              },
              review_status: {
                type: 'string',
                enum: ['DRAFT'],
                description: 'Somente DRAFT. Aprovação é a tool approve_note.',
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
            required: ['cwd', 'repo_url', 'topic', 'body_md'],
          },
        },
        {
          name: 'get_note',
          description: 'Recupera uma nota técnica específica do repositório.',
          inputSchema: {
            type: 'object',
            properties: {
              cwd: {
                type: 'string',
                description:
                  'REQUIRED. Local working directory of the git repository. Used to verify repo_url via git remote.',
              },
              environment: {
                type: 'string',
                description: envDescription,
              },
              repo_url: {
                type: 'string',
                description: 'REQUIRED. Full git repository URL where the note is stored.',
              },
              topic: { type: 'string', description: 'Tópico da nota' },
              subtopic: { type: 'string', description: 'Subtópico opcional', nullable: true },
            },
            required: ['cwd', 'repo_url', 'topic'],
          },
        },
        {
          name: 'search_notes',
          description:
            'Busca notas técnicas usando similaridade semântica vetorial. Se repo_url não for fornecido, busca em todos os repositórios (busca global).',
          inputSchema: {
            type: 'object',
            properties: {
              cwd: {
                type: 'string',
                description:
                  'REQUIRED when repo_url is provided. Local working directory of the git repository. Used to verify repo_url via git remote. Optional for global search (when repo_url is not provided).',
              },
              environment: {
                type: 'string',
                description: envDescription,
              },
              query: { type: 'string', description: 'Query de busca semântica' },
              repo_url: {
                type: 'string',
                description:
                  'OPTIONAL. Filtrar por repositório específico. Se não fornecido, busca em todos os repositórios (busca global).',
              },
              top_k: { type: 'number', description: 'Número de resultados (padrão: 5)' },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filtrar por tags',
              },
              review_status: {
                type: 'string',
                enum: ['DRAFT', 'APPROVED'],
                description: 'Filtrar por status de revisão',
                nullable: true,
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
              cwd: {
                type: 'string',
                description:
                  'REQUIRED. Local working directory of the git repository. Used to verify repo_url via git remote.',
              },
              environment: {
                type: 'string',
                description: envDescription,
              },
              repo_url: {
                type: 'string',
                description: 'REQUIRED. Full git repository URL para listar tópicos.',
              },
            },
            required: ['cwd', 'repo_url'],
          },
        },
        {
          name: 'delete_note',
          description:
            'Soft-delete de uma nota. A linha fica para auditoria, some da busca e o vetor é removido.',
          inputSchema: {
            type: 'object',
            properties: {
              cwd: {
                type: 'string',
                description:
                  'REQUIRED. Local working directory of the git repository. Used to verify repo_url via git remote.',
              },
              environment: {
                type: 'string',
                description: envDescription,
              },
              repo_url: {
                type: 'string',
                description: 'REQUIRED. Full git repository URL onde a nota está armazenada.',
              },
              topic: { type: 'string', description: 'Tópico da nota a ser removida' },
              subtopic: { type: 'string', description: 'Subtópico opcional', nullable: true },
            },
            required: ['cwd', 'repo_url', 'topic'],
          },
        },
        {
          name: 'approve_note',
          description:
            'Marca uma nota viva como APPROVED. Exige conta tech_lead quando CONTEXT_WHISPER_ACCOUNT_TOKEN está definido.',
          inputSchema: {
            type: 'object',
            properties: {
              cwd: {
                type: 'string',
                description:
                  'REQUIRED. Local working directory of the git repository. Used to verify repo_url via git remote.',
              },
              environment: {
                type: 'string',
                description: envDescription,
              },
              repo_url: {
                type: 'string',
                description: 'REQUIRED. Full git repository URL onde a nota está armazenada.',
              },
              topic: { type: 'string', description: 'Tópico da nota a aprovar' },
              subtopic: { type: 'string', description: 'Subtópico opcional', nullable: true },
            },
            required: ['cwd', 'repo_url', 'topic'],
          },
        },
        {
          name: 'purge_note',
          description:
            'Apaga de vez uma nota já soft-deleted. Exige conta tech_lead quando CONTEXT_WHISPER_ACCOUNT_TOKEN está definido.',
          inputSchema: {
            type: 'object',
            properties: {
              cwd: {
                type: 'string',
                description:
                  'REQUIRED. Local working directory of the git repository. Used to verify repo_url via git remote.',
              },
              environment: {
                type: 'string',
                description: envDescription,
              },
              repo_url: {
                type: 'string',
                description: 'REQUIRED. Full git repository URL onde a nota está armazenada.',
              },
              topic: { type: 'string', description: 'Tópico da nota já removida' },
              subtopic: { type: 'string', description: 'Subtópico opcional', nullable: true },
            },
            required: ['cwd', 'repo_url', 'topic'],
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
          description:
            'Inicia um servidor web local para visualização amigável das notas técnicas.',
          inputSchema: {
            type: 'object',
            properties: {
              cwd: {
                type: 'string',
                description:
                  'REQUIRED. Local working directory of the git repository (used for repo path context).',
              },
              environment: {
                type: 'string',
                description: envDescription,
              },
            },
            required: ['cwd'],
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

    try {
      switch (name) {
        case 'upsert_note': {
          const rawParams = UpsertNoteSchema.parse(args);
          const repoContext = resolveRepoContextStrict({
            repo_url: rawParams.repo_url,
            cwd: rawParams.cwd,
          });
          if ('error' in repoContext) {
            return {
              content: [{ type: 'text', text: JSON.stringify(repoContext.error, null, 2) }],
              isError: true,
            };
          }
          const envResolved = resolveEnvironmentForWorkspace(
            dbManager,
            repoContext.workspace,
            rawParams.environment
          );
          if ('error' in envResolved) {
            return {
              content: [{ type: 'text', text: JSON.stringify(envResolved.error, null, 2) }],
              isError: true,
            };
          }
          const adapter = await dbManager.getAdapter(envResolved.envName);

          const paramsWithContext = {
            ...rawParams,
            repo_url: repoContext.repo_url,
            workspace: repoContext.workspace,
            project: repoContext.project,
          };

          const result = await notes.upsertNote(
            adapter,
            paramsWithContext as notes.UpsertNoteParams,
            rawParams.cwd,
            await resolveActingAccount(adapter)
          );

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok: true,
                    environment: envResolved.envName,
                    context: result.context,
                    note_id: result.note_id,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'get_note': {
          const rawParams = GetNoteSchema.parse(args);
          const repoContext = resolveRepoContextStrict({
            repo_url: rawParams.repo_url,
            cwd: rawParams.cwd,
          });
          if ('error' in repoContext) {
            return {
              content: [{ type: 'text', text: JSON.stringify(repoContext.error, null, 2) }],
              isError: true,
            };
          }
          const envResolved = resolveEnvironmentForWorkspace(
            dbManager,
            repoContext.workspace,
            rawParams.environment
          );
          if ('error' in envResolved) {
            return {
              content: [{ type: 'text', text: JSON.stringify(envResolved.error, null, 2) }],
              isError: true,
            };
          }
          const adapter = await dbManager.getAdapter(envResolved.envName);

          const paramsWithContext = {
            ...rawParams,
            repo_url: repoContext.repo_url,
            workspace: repoContext.workspace,
            project: repoContext.project,
          };

          const result = await notes.getNote(
            adapter,
            paramsWithContext as notes.GetNoteParams,
            rawParams.cwd,
            await resolveActingAccount(adapter)
          );

          if (!result.note) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      ok: false,
                      error: 'Note not found',
                      environment: envResolved.envName,
                      context: result.context,
                    },
                    null,
                    2
                  ),
                },
              ],
              isError: true,
            };
          }

          const noteWithParsedTags = {
            ...result.note,
            tags: result.note.tags_json ? JSON.parse(result.note.tags_json) : null,
            tags_json: undefined,
          };

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok: true,
                    environment: envResolved.envName,
                    context: result.context,
                    note: noteWithParsedTags,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'search_notes': {
          const rawParams = SearchNotesSchema.parse(args);

          if (rawParams.repo_url) {
            // repo_url fornecido: busca no repositório específico
            // cwd é obrigatório neste caso (validado pelo schema refine)
            const repoContext = resolveRepoContextStrict({
              repo_url: rawParams.repo_url,
              cwd: rawParams.cwd!,
            });
            if ('error' in repoContext) {
              return {
                content: [{ type: 'text', text: JSON.stringify(repoContext.error, null, 2) }],
                isError: true,
              };
            }

            const envResolved = resolveEnvironmentForWorkspace(
              dbManager,
              repoContext.workspace,
              rawParams.environment
            );
            if ('error' in envResolved) {
              return {
                content: [{ type: 'text', text: JSON.stringify(envResolved.error, null, 2) }],
                isError: true,
              };
            }
            const adapter = await dbManager.getAdapter(envResolved.envName);

            const paramsWithContext = {
              ...rawParams,
              global: false,
              repo_url: repoContext.repo_url,
              workspace: repoContext.workspace,
              project: repoContext.project,
            };

            const result = await notes.searchNotes(
              adapter,
              paramsWithContext as notes.SearchNotesParams,
              rawParams.cwd!,
              await resolveActingAccount(adapter)
            );

            const resultsWithParsedTags = result.notes.map((r) => ({
              ...r,
              tags: r.tags_json ? JSON.parse(r.tags_json) : null,
              tags_json: undefined,
            }));

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      ok: true,
                      environment: envResolved.envName,
                      context: result.context,
                      notes: resultsWithParsedTags,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } else {
            // repo_url ausente: busca global (todos os repositórios)
            // Resolver ambiente: se especificado, validar que existe; senão usar padrão
            const envName = rawParams.environment || dbManager.getDefaultEnvironmentName();
            if (rawParams.environment) {
              const cfg = dbManager.getEnvironmentConfig(rawParams.environment);
              if (!cfg) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        errorResponse(`Environment '${rawParams.environment}' not configured`),
                        null,
                        2
                      ),
                    },
                  ],
                  isError: true,
                };
              }
            }

            const adapter = await dbManager.getAdapter(envName);

            const paramsWithContext = {
              ...rawParams,
              global: true,
              repo_url: undefined,
              workspace: undefined,
              project: undefined,
            };

            const result = await notes.searchNotes(
              adapter,
              paramsWithContext as notes.SearchNotesParams,
              rawParams.cwd || undefined,
              await resolveActingAccount(adapter)
            );

            const resultsWithParsedTags = result.notes.map((r) => ({
              ...r,
              tags: r.tags_json ? JSON.parse(r.tags_json) : null,
              tags_json: undefined,
            }));

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      ok: true,
                      environment: envName,
                      context: result.context,
                      notes: resultsWithParsedTags,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }

        case 'list_topics': {
          const rawParams = ListTopicsSchema.parse(args);
          const repoContext = resolveRepoContextStrict({
            repo_url: rawParams.repo_url,
            cwd: rawParams.cwd,
          });
          if ('error' in repoContext) {
            return {
              content: [{ type: 'text', text: JSON.stringify(repoContext.error, null, 2) }],
              isError: true,
            };
          }
          const envResolved = resolveEnvironmentForWorkspace(
            dbManager,
            repoContext.workspace,
            rawParams.environment
          );
          if ('error' in envResolved) {
            return {
              content: [{ type: 'text', text: JSON.stringify(envResolved.error, null, 2) }],
              isError: true,
            };
          }
          const adapter = await dbManager.getAdapter(envResolved.envName);

          const paramsWithContext = {
            ...rawParams,
            repo_url: repoContext.repo_url,
            workspace: repoContext.workspace,
            project: repoContext.project,
          };

          const result = await notes.listTopics(
            adapter,
            paramsWithContext as notes.ListTopicsParams,
            rawParams.cwd,
            await resolveActingAccount(adapter)
          );

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok: true,
                    environment: envResolved.envName,
                    context: result.context,
                    topics: result.topics,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'delete_note': {
          const rawParams = DeleteNoteSchema.parse(args);
          const repoContext = resolveRepoContextStrict({
            repo_url: rawParams.repo_url,
            cwd: rawParams.cwd,
          });
          if ('error' in repoContext) {
            return {
              content: [{ type: 'text', text: JSON.stringify(repoContext.error, null, 2) }],
              isError: true,
            };
          }
          const envResolved = resolveEnvironmentForWorkspace(
            dbManager,
            repoContext.workspace,
            rawParams.environment
          );
          if ('error' in envResolved) {
            return {
              content: [{ type: 'text', text: JSON.stringify(envResolved.error, null, 2) }],
              isError: true,
            };
          }
          const adapter = await dbManager.getAdapter(envResolved.envName);

          const paramsWithContext = {
            ...rawParams,
            repo_url: repoContext.repo_url,
            workspace: repoContext.workspace,
            project: repoContext.project,
          };

          const result = await notes.deleteNote(
            adapter,
            paramsWithContext as notes.DeleteNoteParams,
            rawParams.cwd,
            await resolveActingAccount(adapter)
          );

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok: true,
                    environment: envResolved.envName,
                    context: result.context,
                    deleted: result.deleted,
                    ...(result.vector_deleted === undefined
                      ? {}
                      : { vector_deleted: result.vector_deleted }),
                    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'approve_note': {
          const rawParams = DeleteNoteSchema.parse(args);
          const repoContext = resolveRepoContextStrict({
            repo_url: rawParams.repo_url,
            cwd: rawParams.cwd,
          });
          if ('error' in repoContext) {
            return {
              content: [{ type: 'text', text: JSON.stringify(repoContext.error, null, 2) }],
              isError: true,
            };
          }
          const envResolved = resolveEnvironmentForWorkspace(
            dbManager,
            repoContext.workspace,
            rawParams.environment
          );
          if ('error' in envResolved) {
            return {
              content: [{ type: 'text', text: JSON.stringify(envResolved.error, null, 2) }],
              isError: true,
            };
          }
          const adapter = await dbManager.getAdapter(envResolved.envName);
          const result = await notes.approveNote(
            adapter,
            {
              ...rawParams,
              repo_url: repoContext.repo_url,
              workspace: repoContext.workspace,
              project: repoContext.project,
            } as notes.DeleteNoteParams,
            rawParams.cwd,
            await resolveActingAccount(adapter)
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok: result.note !== null,
                    environment: envResolved.envName,
                    context: result.context,
                    note_id: result.note?.note_id ?? null,
                    review_status: result.note?.review_status ?? null,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'purge_note': {
          const rawParams = DeleteNoteSchema.parse(args);
          const repoContext = resolveRepoContextStrict({
            repo_url: rawParams.repo_url,
            cwd: rawParams.cwd,
          });
          if ('error' in repoContext) {
            return {
              content: [{ type: 'text', text: JSON.stringify(repoContext.error, null, 2) }],
              isError: true,
            };
          }
          const envResolved = resolveEnvironmentForWorkspace(
            dbManager,
            repoContext.workspace,
            rawParams.environment
          );
          if ('error' in envResolved) {
            return {
              content: [{ type: 'text', text: JSON.stringify(envResolved.error, null, 2) }],
              isError: true,
            };
          }
          const adapter = await dbManager.getAdapter(envResolved.envName);
          const result = await notes.purgeNote(
            adapter,
            {
              ...rawParams,
              repo_url: repoContext.repo_url,
              workspace: repoContext.workspace,
              project: repoContext.project,
            } as notes.DeleteNoteParams,
            rawParams.cwd,
            await resolveActingAccount(adapter)
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok: true,
                    environment: envResolved.envName,
                    context: result.context,
                    purged: result.deleted,
                  },
                  null,
                  2
                ),
              },
            ],
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
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      ok: true,
                      environment: envName,
                      status: health.relational && health.vector ? 'healthy' : 'degraded',
                      relational_healthy: health.relational,
                      vector_healthy: health.vector,
                      database_type: config?.relational.type,
                      vector_type: config?.vector.type,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      ok: false,
                      status: 'unhealthy',
                      error: error instanceof Error ? error.message : String(error),
                    },
                    null,
                    2
                  ),
                },
              ],
              isError: true,
            };
          }
        }

        case 'list_environments': {
          const environments = dbManager.listEnvironments();
          const defaultEnv = dbManager.getDefaultEnvironmentName();

          const envDetails = environments.map((env) => {
            const config = dbManager.getEnvironmentConfig(env);
            return {
              name: env,
              is_default: env === defaultEnv,
              relational_type: config?.relational.type,
              vector_type: config?.vector.type,
            };
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok: true,
                    environments: envDetails,
                    default_environment: defaultEnv,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'serve_notes_ui': {
          const rawParams = ServeNotesUISchema.parse(args);
          // Environment-scoped UI: infer routing from the repo at cwd (git remote owner -> workspace).
          const remote = getGitRemoteOriginUrl(rawParams.cwd);
          if (!remote) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    errorResponse('Could not resolve git remote from cwd', {
                      cwd: rawParams.cwd,
                      rule: 'cwd must be a git worktree with remote.origin.url configured',
                    }),
                    null,
                    2
                  ),
                },
              ],
              isError: true,
            };
          }
          const normalizedRemote = normalizeRepoUrl(remote);
          if (!normalizedRemote) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    errorResponse('Invalid git remote URL in cwd', {
                      cwd: rawParams.cwd,
                      remote_origin_url: remote,
                    }),
                    null,
                    2
                  ),
                },
              ],
              isError: true,
            };
          }

          const envResolved = resolveEnvironmentForWorkspace(
            dbManager,
            normalizedRemote.owner,
            rawParams.environment
          );
          if ('error' in envResolved) {
            return {
              content: [{ type: 'text', text: JSON.stringify(envResolved.error, null, 2) }],
              isError: true,
            };
          }

          const adapter = await dbManager.getAdapter(envResolved.envName);

          const url = await startServer({
            adapter,
            cwd: rawParams.cwd,
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok: true,
                    environment: envResolved.envName,
                    url,
                    message: 'Web UI server started. Navigate to the URL to view notes.',
                    auto_shutdown: 'Server will shutdown after 10 minutes of inactivity.',
                  },
                  null,
                  2
                ),
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
                text: JSON.stringify(
                  {
                    ok: true,
                    message: 'Web UI server stopped.',
                  },
                  null,
                  2
                ),
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
              text: JSON.stringify(
                {
                  error: 'Validation error',
                  details: error.errors,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2
            ),
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
