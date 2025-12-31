#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { program } from 'commander';
import { resolveConfig } from './config.js';
import { openDB, initSchema } from './db.js';
import { setupMCPServer, getSystemPrompt } from './mcp.js';

async function main() {
  program
    .name('context-whisper')
    .description('MCP Server for vectorized technical notes repository')
    .version('1.3.0')
    .option('--db <path>', 'Path to SQLite database file')
    .option('--vec-lib <path>', 'Path to sqlite-vec extension library')
    .parse(process.argv);

  const options = program.opts();

  // Resolve configuration
  const config = resolveConfig(
    options.db,
    options.vecLib
  );

  // Log configuration to stderr
  console.error(`[context-whisper] Starting MCP server v1.3.0...`);
  console.error(`[context-whisper] Database: ${config.dbPath}`);
  if (!config.vecLibPath) {
    console.error(`[context-whisper] ERROR: sqlite-vec extension not found.`);
    console.error(`[context-whisper] Vector search is REQUIRED for RAG functionality.`);
    console.error(`[context-whisper] Please run: npm install sqlite-vec`);
    console.error(`[context-whisper] Or specify path via --vec-lib or CONTEXT_WHISPER_VEC_LIB`);
    process.exit(1);
  }
  console.error(`[context-whisper] Vector extension: ${config.vecLibPath}`);

  try {
    // Open database
    const db = openDB(config.dbPath, config.vecLibPath);
    initSchema(db);

    // Create MCP server
    const server = new Server(
      {
        name: 'context-whisper',
        version: '1.3.0',
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

