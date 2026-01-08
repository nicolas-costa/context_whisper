import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import process from 'process';
import assert from 'assert';

/**
 * End-to-end smoke test for multi-environment support.
 *
 * What it verifies:
 * - `list_environments` returns configured envs and default env
 * - `upsert_note` scoped to env A does not appear in env B
 * - `search_notes` and `list_topics` honor the `environment` parameter per call
 */

function createJsonRpcClient(child) {
  let buf = '';
  const pending = new Map();

  child.stdout.on('data', (data) => {
    buf += data.toString();
    while (true) {
      const nl = buf.indexOf('\n');
      if (nl === -1) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && typeof msg.id !== 'undefined' && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
      }
    }
  });

  let nextId = 1;
  async function rpc(method, params) {
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    const p = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // Fail fast if server dies
      const onExit = () => {
        if (pending.has(id)) {
          pending.get(id).reject(new Error(`Server exited before responding to ${method}`));
          pending.delete(id);
        }
      };
      child.once('exit', onExit);
    });
    child.stdin.write(JSON.stringify(payload) + '\n');
    return p;
  }

  return { rpc };
}

function parseToolTextResult(msg) {
  const text = msg?.result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const tempRoot = mkdtempSync(path.join(tmpdir(), 'context-whisper-multi-env-'));
const dbA = path.join(tempRoot, 'env_a.sqlite');
const dbB = path.join(tempRoot, 'env_b.sqlite');

const ENV_A = 'ACME_CORP';
const ENV_B = 'STARTUP_XYZ';
const REPO_URL = 'https://github.com/example-org/example-repo';

const child = spawn('npx', ['-y', 'tsx', 'src/index.ts'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: process.cwd(),
  env: {
    ...process.env,
    // Configure two environments, both using SQLite + sqlite-vec, but different db files
    [`${ENV_A}_SQLITE_PATH`]: dbA,
    [`${ENV_B}_SQLITE_PATH`]: dbB,
    // Make env A the default
    CONTEXT_WHISPER_ENV: ENV_A,
  },
});

let stderr = '';
child.stderr.on('data', (d) => (stderr += d.toString()));

const { rpc } = createJsonRpcClient(child);

try {
  // Initialize MCP session
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {}, prompts: {} },
    clientInfo: { name: 'test-multi-env', version: '1.0.0' },
  });

  await rpc('tools/list');

  // Verify environments are exposed
  const envsMsg = await rpc('tools/call', {
    name: 'list_environments',
    arguments: {},
  });
  const envs = parseToolTextResult(envsMsg);
  assert(envs?.ok === true, 'list_environments should return ok=true');
  assert(envs?.default_environment === ENV_A, `default_environment should be ${ENV_A}`);
  const names = (envs?.environments || []).map((e) => e.name);
  assert(names.includes(ENV_A), `environments should include ${ENV_A}`);
  assert(names.includes(ENV_B), `environments should include ${ENV_B}`);

  // Upsert note in ENV_A
  const upsertMsg = await rpc('tools/call', {
    name: 'upsert_note',
    arguments: {
      environment: ENV_A,
      repo_url: REPO_URL,
      topic: 'multi-env-isolation',
      subtopic: null,
      tags: ['test', 'multi-env'],
      body_md: `This note exists ONLY in ${ENV_A}.`,
      review_status: 'DRAFT',
      created_by: 'test-multi-env',
    },
  });
  const upsert = parseToolTextResult(upsertMsg);
  assert(upsert?.ok === true, 'upsert_note should succeed');
  assert(typeof upsert?.note_id === 'number' && upsert.note_id > 0, 'upsert_note should return note_id');

  // ENV_A should list the topic
  const topicsAmsg = await rpc('tools/call', {
    name: 'list_topics',
    arguments: {
      environment: ENV_A,
      repo_url: REPO_URL,
    },
  });
  const topicsA = parseToolTextResult(topicsAmsg);
  assert(topicsA?.ok === true, 'list_topics should succeed for ENV_A');
  const topicsAkeys = (topicsA?.topics || []).map((t) => `${t.topic}::${t.subtopic ?? ''}`);
  assert(topicsAkeys.includes('multi-env-isolation::'), 'ENV_A should contain inserted topic');

  // ENV_B must NOT list the topic
  const topicsBmsg = await rpc('tools/call', {
    name: 'list_topics',
    arguments: {
      environment: ENV_B,
      repo_url: REPO_URL,
    },
  });
  const topicsB = parseToolTextResult(topicsBmsg);
  assert(topicsB?.ok === true, 'list_topics should succeed for ENV_B');
  const topicsBkeys = (topicsB?.topics || []).map((t) => `${t.topic}::${t.subtopic ?? ''}`);
  assert(!topicsBkeys.includes('multi-env-isolation::'), 'ENV_B should NOT contain ENV_A topic');

  // Search: ENV_A should find it, ENV_B should not
  const searchAmsg = await rpc('tools/call', {
    name: 'search_notes',
    arguments: {
      environment: ENV_A,
      query: `ONLY in ${ENV_A}`,
      repo_url: REPO_URL,
      top_k: 5,
    },
  });
  const searchA = parseToolTextResult(searchAmsg);
  assert(searchA?.ok === true, 'search_notes should succeed for ENV_A');
  assert((searchA?.notes || []).length >= 1, 'ENV_A search should return at least 1 note');

  const searchBmsg = await rpc('tools/call', {
    name: 'search_notes',
    arguments: {
      environment: ENV_B,
      query: `ONLY in ${ENV_A}`,
      repo_url: REPO_URL,
      top_k: 5,
    },
  });
  const searchB = parseToolTextResult(searchBmsg);
  assert(searchB?.ok === true, 'search_notes should succeed for ENV_B');
  assert((searchB?.notes || []).length === 0, 'ENV_B search should return 0 notes');

  console.log('OK: multi-environment isolation verified.');
} catch (e) {
  console.error('FAIL: multi-environment isolation test failed.');
  console.error('Error:', e?.stack || e);
  console.error('\n=== server stderr ===\n' + stderr);
  process.exitCode = 1;
} finally {
  child.kill();
  rmSync(tempRoot, { recursive: true, force: true });
}


