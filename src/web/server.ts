import { fork, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let child: ChildProcess | null = null;
let currentUrl: string | null = null;

export interface ServerOptions {
  database: Database.Database; // We actually just need the path for the child
  cwd: string;
}

export async function startServer(options: ServerOptions): Promise<string> {
  if (child && currentUrl) {
    return currentUrl;
  }

  // Extract DB path from the database object object if possible, 
  // or assume it's available via the same config resolution as the main process
  // For better reliability, we should pass the resolved dbPath from config
  // But since we don't have easy access to filename from the database object,
  // we rely on the child process re-resolving the config.
  
  // Path to compiled standalone script
  // In production: dist/web/standalone.js
  // In dev: use tsx to run src/web/standalone.ts (but we usually run compiled)
  
  // Let's try to find the script relative to this file
  const scriptName = 'standalone.js';
  const scriptPath = path.join(__dirname, scriptName);
  
  return new Promise((resolve, reject) => {
    // Pass dbPath is tricky if we only have the object.
    // We'll pass empty string and let child resolve default or env var
    // If the main process was started with custom DB path arg, we might miss it here
    // unless we stored it globally. 
    // FIX: We will pass 'undefined' and let resolveConfig in child handle it same as parent.
    
    child = fork(scriptPath, [process.env.CONTEXT_WHISPER_DB_PATH || '', options.cwd], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], // Totally detach IO, only IPC
      env: { ...process.env }
    });

    child.on('message', (msg: any) => {
      if (msg.type === 'ready') {
        currentUrl = msg.url;
        resolve(msg.url);
      }
    });

    child.on('error', (err) => {
      console.error('Web server process error:', err);
      child = null;
      currentUrl = null;
      reject(err);
    });

    child.on('exit', (code) => {
      if (code !== 0 && !currentUrl) { // If exited before ready
        reject(new Error(`Web server exited with code ${code}`));
      }
      child = null;
      currentUrl = null;
    });
  });
}

export async function stopServer() {
  if (child) {
    child.send('shutdown');
    // Give it a moment to close gracefully, then kill
    setTimeout(() => {
      if (child) child.kill();
      child = null;
      currentUrl = null;
    }, 1000);
  }
}
