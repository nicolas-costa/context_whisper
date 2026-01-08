#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { program } from 'commander';
import { resolveConfig, getEnvironmentConfig, listEnvironments, getDbTypeDescription } from './config.js';
import { createDatabaseManager } from './db.js';
import { setupMCPServer } from './mcp.js';

const VERSION = '1.4.0';

async function main() {
  program
    .name('context-whisper')
    .description('MCP Server for vectorized technical notes repository')
    .version(VERSION)
    .option('--db <path>', 'Path to SQLite database file')
    .option('--vec-lib <path>', 'Path to sqlite-vec extension library')
    .option('--env <name>', 'Default environment name to use (e.g., LOCAL, ACME_CORP, STARTUP_XYZ)')
    .parse(process.argv);

  const options = program.opts();

  // Resolve configuration
  const config = resolveConfig(
    options.db,
    options.vecLib
  );

  // Override default environment if specified via CLI
  if (options.env) {
    if (config.environments.has(options.env)) {
      // Update the default environment
      (config as any).defaultEnvironment = options.env;
    } else {
      console.error(`[context-whisper] ERROR: Environment '${options.env}' not configured.`);
      console.error(`[context-whisper] Available environments: ${listEnvironments(config).join(', ')}`);
      process.exit(1);
    }
  }

  // Log startup information
  console.error(`[context-whisper] Starting MCP server v${VERSION}...`);
  
  // Show configured environments
  const environments = listEnvironments(config);
  console.error(`[context-whisper] Configured environments: ${environments.join(', ')}`);
  console.error(`[context-whisper] Default environment: ${config.defaultEnvironment}`);

  // Show details for each environment
  for (const envName of environments) {
    const envConfig = getEnvironmentConfig(config, envName);
    if (envConfig) {
      const dbDescription = getDbTypeDescription(envConfig);
      const isDefault = envName === config.defaultEnvironment ? ' (default)' : '';
      console.error(`[context-whisper]   ${envName}${isDefault}: ${dbDescription}`);
    }
  }

  // Check for sqlite-vec when using SQLite
  const defaultEnvConfig = getEnvironmentConfig(config, config.defaultEnvironment);
  if (defaultEnvConfig?.relational.type === 'sqlite' && defaultEnvConfig?.vector.type === 'sqlite-vec') {
    if (!config.vecLibPath) {
      console.error(`[context-whisper] ERROR: sqlite-vec extension not found.`);
      console.error(`[context-whisper] Vector search is REQUIRED for RAG functionality.`);
      console.error(`[context-whisper] Please run: npm install sqlite-vec`);
      console.error(`[context-whisper] Or specify path via --vec-lib or CONTEXT_WHISPER_VEC_LIB`);
      process.exit(1);
    }
    console.error(`[context-whisper] Vector extension: ${config.vecLibPath}`);
  }

  try {
    // Create database manager with lazy initialization
    const dbManager = createDatabaseManager(config.environments, config.defaultEnvironment);

    // Pre-initialize the default environment to catch config errors early
    console.error(`[context-whisper] Initializing default environment: ${config.defaultEnvironment}...`);
    await dbManager.getAdapter(config.defaultEnvironment);

    // Create MCP server
    const server = new Server(
      {
        name: 'context-whisper',
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
        },
      }
    );

    // Setup tools with database manager
    setupMCPServer(server, dbManager);

    // Create transport and connect
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error(`[context-whisper] MCP server ready`);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.error(`[context-whisper] Shutting down...`);
      await dbManager.closeAll();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.error(`[context-whisper] Shutting down...`);
      await dbManager.closeAll();
      process.exit(0);
    });

  } catch (error) {
    console.error(`[context-whisper] Error:`, error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[context-whisper] Fatal error:`, error);
  process.exit(1);
});
