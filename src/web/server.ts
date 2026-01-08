import { fork, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { DatabaseAdapter } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let child: ChildProcess | null = null;
let currentUrl: string | null = null;

export const WEB_UI_SERVER_VERSION = '1.4.0';

export interface ServerOptions {
  adapter: DatabaseAdapter;
  cwd: string;
}

export async function startServer(options: ServerOptions): Promise<string> {
  if (child && currentUrl) {
    return currentUrl;
  }

  const scriptName = 'standalone.js';
  const scriptPath = path.join(__dirname, scriptName);
  
  return new Promise((resolve, reject) => {
    // Pass environment name to the child process
    const envName = options.adapter.environmentName;
    
    child = fork(scriptPath, [process.env.CONTEXT_WHISPER_DB_PATH || '', options.cwd, envName], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
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
      if (code !== 0 && !currentUrl) {
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
    setTimeout(() => {
      if (child) child.kill();
      child = null;
      currentUrl = null;
    }, 1000);
  }
}
