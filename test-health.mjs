import { spawn } from 'child_process';
import { readFileSync } from 'fs';

// Test the health tool via MCP protocol
const server = spawn('npx', ['-y', 'tsx', 'src/index.ts'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: process.cwd()
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
      console.log('=== STDOUT ===');
      console.log(output);
      console.log('\n=== STDERR ===');
      console.log(errorOutput);
      server.kill();
      process.exit(0);
    }, 2000);
  }, 1000);
}, 1000);
