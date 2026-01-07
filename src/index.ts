#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { program } from 'commander';
import { resolveConfig, getEnvironmentConfig, listEnvironments, getDbTypeDescription } from './config.js';
import { openDB, initSchema } from './db.js';
import { setupMCPServer, getSystemPrompt } from './mcp.js';

const VERSION = '1.4.0';

async function main() {
  program
    .name('context-whisper')
    .description('MCP Server for vectorized technical notes repository')
    .version(VERSION)
    .option('--db <path>', 'Path to SQLite database file')
    .option('--vec-lib <path>', 'Path to sqlite-vec extension library')
    .option('--env <name>', 'Environment name to use (e.g., PROD, DEV)')
    .parse(process.argv);

  const options = program.opts();

  // Resolve configuration
  const config = resolveConfig(
    options.db,
    options.vecLib
  );

  // Override default environment if specified
  const envName = options.env || config.defaultEnvironment;

  // Log startup information
  console.error(`[context-whisper] Starting MCP server v${VERSION}...`);
  
  // Show configured environments
  const environments = listEnvironments(config);
  if (environments.length > 1 || !environments.includes('default')) {
    console.error(`[context-whisper] Configured environments: ${environments.join(', ')}`);
    console.error(`[context-whisper] Active environment: ${envName}`);
  }

  // Get environment configuration
  const envConfig = getEnvironmentConfig(config, envName);
  
  if (envConfig) {
    const dbDescription = getDbTypeDescription(envConfig);
    console.error(`[context-whisper] Database: ${dbDescription}`);
    
    // Show specific config based on type
    if (envConfig.relational.type === 'sqlite') {
      console.error(`[context-whisper] SQLite path: ${envConfig.relational.path}`);
    } else if (envConfig.relational.type === 'postgres') {
      console.error(`[context-whisper] PostgreSQL: ${envConfig.relational.host}:${envConfig.relational.port}/${envConfig.relational.database}`);
    } else if (envConfig.relational.type === 'mysql') {
      console.error(`[context-whisper] MySQL: ${envConfig.relational.host}:${envConfig.relational.port}/${envConfig.relational.database}`);
    }
    
    if (envConfig.vector.type === 'qdrant') {
      const qdrantConfig = envConfig.vector.config as any;
      console.error(`[context-whisper] Qdrant: ${qdrantConfig.host}:${qdrantConfig.port}`);
    }
  } else {
    // Fallback to legacy SQLite config
    console.error(`[context-whisper] Database: ${config.dbPath}`);
  }

  // Check for sqlite-vec when using SQLite
  if (!envConfig || envConfig.relational.type === 'sqlite') {
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
    // Open database using legacy API (backward compatible)
    // For multi-database support, the MCP handlers could be updated to use adapters
    const db = openDB(config.dbPath, config.vecLibPath);
    initSchema(db);

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

    // Setup tools
    setupMCPServer(server, db);

    // Create transport and connect
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error(`[context-whisper] MCP server ready`);
  } catch (error) {
    console.error(`[context-whisper] Error:`, error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[context-whisper] Fatal error:`, error);
  process.exit(1);
});
