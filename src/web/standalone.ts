import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openSQLiteDatabase } from '../db.js';
import * as notes from '../notes.js';
import { resolveConfig, getEnvironmentConfig } from '../config.js';
import { createDatabaseAdapter } from '../db/factory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get arguments
const args = process.argv.slice(2);
const dbPath = args[0];
const cwd = args[1] || process.cwd();
const envName = args[2] || undefined;

// Initialize DB using adapter system
const config = resolveConfig(dbPath, process.env.CONTEXT_WHISPER_VEC_LIB);

// Determine which environment to use
const targetEnv = envName || config.defaultEnvironment;
const envConfig = getEnvironmentConfig(config, targetEnv);

let adapterPromise: Promise<any>;

if (envConfig) {
  // Use the configured environment
  adapterPromise = createDatabaseAdapter(envConfig);
} else {
  // Fallback to default SQLite
  adapterPromise = Promise.resolve(
    openSQLiteDatabase({ type: 'sqlite', path: config.dbPath, vecLibPath: config.vecLibPath }, 'default').adapter
  );
}

const PUBLIC_DIR = path.join(__dirname, 'public');

// Mime types
const MIMES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // Get adapter (wait for initialization)
    const adapter = await adapterPromise;
    
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    
    // API Routes
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      
      if (url.pathname === '/api/topics') {
        const workspace = url.searchParams.get('workspace') || undefined;
        const project = url.searchParams.get('project') || undefined;
        
        const result = await notes.listTopics(adapter, { workspace, project }, cwd);
        res.end(JSON.stringify({ ok: true, ...result }));
        return;
      }
      
      if (url.pathname === '/api/search') {
        const q = url.searchParams.get('q');
        if (!q) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'Missing query parameter "q"' }));
          return;
        }
        
        const workspace = url.searchParams.get('workspace') || undefined;
        const project = url.searchParams.get('project') || undefined;
        const global = url.searchParams.get('global') === 'true';
        
        const result = await notes.searchNotes(
          adapter,
          { query: q, workspace, project, global },
          cwd
        );
        res.end(JSON.stringify({ ok: true, ...result }));
        return;
      }
      
      if (url.pathname === '/api/note' && req.method === 'PUT') {
        // Update note metadata (topic/subtopic/status) by note_id
        let body = '';
        for await (const chunk of req) body += chunk;
        let payload: any;
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
          return;
        }

        const note_id = Number(payload.note_id);
        const topic = typeof payload.topic === 'string' ? payload.topic.trim() : '';
        const subtopic =
          payload.subtopic === null || payload.subtopic === undefined
            ? null
            : String(payload.subtopic).trim();
        const review_status = String(payload.review_status || '').toUpperCase();
        const workspace = payload.workspace ? String(payload.workspace) : undefined;
        const project = payload.project ? String(payload.project) : undefined;

        if (!Number.isFinite(note_id) || note_id <= 0) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'Invalid note_id' }));
          return;
        }
        if (!topic) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'Missing/empty topic' }));
          return;
        }
        if (review_status !== 'DRAFT' && review_status !== 'APPROVED') {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'Invalid review_status (expected DRAFT|APPROVED)' }));
          return;
        }

        try {
          const result = await notes.updateNoteMeta(
            adapter,
            {
              note_id,
              topic,
              subtopic: subtopic ? subtopic : null,
              review_status: review_status as 'DRAFT' | 'APPROVED',
              workspace,
              project,
            },
            cwd
          );

          if (!result.note) {
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: 'Note not found', ...result }));
            return;
          }

          res.end(JSON.stringify({ ok: true, ...result }));
          return;
        } catch (e: any) {
          const msg = e?.message ? String(e.message) : String(e);
          // UNIQUE(workspace, project, topic, subtopic) conflicts
          if (msg.includes('UNIQUE') || msg.includes('constraint failed')) {
            res.statusCode = 409;
            res.end(JSON.stringify({ ok: false, error: 'Conflict: a note with the same topic/subtopic already exists' }));
            return;
          }
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: 'Internal Server Error' }));
          return;
        }
      }

      if (url.pathname === '/api/note') {
        const topic = url.searchParams.get('topic');
        if (!topic) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'Missing topic parameter' }));
          return;
        }
        
        const subtopic = url.searchParams.get('subtopic') || null;
        const workspace = url.searchParams.get('workspace') || undefined;
        const project = url.searchParams.get('project') || undefined;
        
        const result = await notes.getNote(
          adapter,
          { topic, subtopic, workspace, project },
          cwd
        );
        
        if (!result.note) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: 'Note not found', ...result }));
          return;
        }

        if (result.note && result.note.tags_json) {
          (result.note as any).tags = JSON.parse(result.note.tags_json);
        }
        
        res.end(JSON.stringify({ ok: true, ...result }));
        return;
      }
      
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'Endpoint not found' }));
      return;
    }

    // Static Files
    let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    
    // Prevent directory traversal
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader('Content-Type', MIMES[ext] || 'application/octet-stream');
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.statusCode = 404;
      res.end('Not found');
    }

  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: 'Internal Server Error' }));
  }
});

// Auto-shutdown
let inactivityTimeout: NodeJS.Timeout;
const resetInactivity = () => {
  if (inactivityTimeout) clearTimeout(inactivityTimeout);
  inactivityTimeout = setTimeout(() => process.exit(0), 10 * 60 * 1000);
};

server.on('request', resetInactivity);
resetInactivity();

// Handle parent shutdown
process.on('message', (msg) => {
  if (msg === 'shutdown') {
    process.exit(0);
  }
});

// Start server after adapter is ready
adapterPromise.then(() => {
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as any;
    const port = addr.port;
    if (process.send) {
      process.send({ type: 'ready', port, url: `http://127.0.0.1:${port}` });
    } else {
      console.log(`Server listening on http://127.0.0.1:${port}`);
    }
  });
}).catch(err => {
  console.error('Failed to initialize adapter:', err);
  process.exit(1);
});
