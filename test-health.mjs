import { spawn } from 'child_process';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

function repoOwnerFromUrl(url) {
  const s = String(url || '').trim();
  // https://github.com/owner/repo(.git) or git+https://github.com/owner/repo.git
  let m = s.match(/github\.com\/([^\/\s]+)\/([^\/\s]+?)(?:\.git)?$/);
  if (m) return m[1];
  // git@github.com:owner/repo.git
  m = s.match(/git@github\.com:([^\/\s]+)\/([^\/\s]+?)(?:\.git)?$/);
  if (m) return m[1];
  return null;
}

// Test the health tool via MCP protocol
// Prefer running the built CLI (dist/) to match real npx usage; fall back to tsx for dev.
const distEntry = path.join(process.cwd(), 'dist', 'index.js');
const useDist = existsSync(distEntry);

const repoUrlForWhitelist = execSync('git config --get remote.origin.url', { cwd: process.cwd(), encoding: 'utf8' }).trim();
const owner = repoOwnerFromUrl(repoUrlForWhitelist);
if (!owner) {
  console.error('FAIL: could not parse repo owner from git remote.origin.url:', repoUrlForWhitelist);
  process.exit(1);
}

const server = useDist
  ? spawn('node', [distEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
      env: { ...process.env, DEFAULT_WORKSPACE_WHITELIST: owner },
    })
  : spawn('npx', ['-y', 'tsx', 'src/index.ts'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: process.cwd(),
  env: { ...process.env, DEFAULT_WORKSPACE_WHITELIST: owner },
    });

let output = '';
let errorOutput = '';

server.stdout.on('data', (data) => {
  output += data.toString();
});

server.stderr.on('data', (data) => {
  errorOutput += data.toString();
});

// Send MCP initialize request
const initRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: {}
    },
    clientInfo: {
      name: 'test-client',
      version: '1.0.0'
    }
  }
};

server.stdin.write(JSON.stringify(initRequest) + '\n');

setTimeout(() => {
  // Send list tools request
  const listToolsRequest = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list'
  };
  
  server.stdin.write(JSON.stringify(listToolsRequest) + '\n');
  
  setTimeout(() => {
    // Send health tool call
    const healthRequest = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'health',
        arguments: {}
      }
    };
    
    server.stdin.write(JSON.stringify(healthRequest) + '\n');
    
    setTimeout(() => {
      // Also sanity-check search_notes contract: allow global search without repo_url
      const repoUrl = execSync('git config --get remote.origin.url', { cwd: process.cwd(), encoding: 'utf8' }).trim();
      const globalSearchRequest = {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'search_notes',
          arguments: {
            cwd: process.cwd(),
            repo_url: repoUrl,
            query: 'health check global search',
          }
        }
      };
      server.stdin.write(JSON.stringify(globalSearchRequest) + '\n');

      setTimeout(() => {
      console.log('=== STDOUT ===');
      console.log(output);
      console.log('\n=== STDERR ===');
      console.log(errorOutput);
      server.kill();
      process.exit(0);
      }, 1500);
    }, 2000);
  }, 1000);
}, 1000);
