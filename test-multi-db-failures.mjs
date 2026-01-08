import { spawn } from 'child_process';
import assert from 'assert';
import process from 'process';

/**
 * Smoke tests for multi-db config error paths.
 *
 * These tests do NOT require real Postgres/MySQL/Qdrant services.
 * They validate that:
 * - invalid configs fail fast
 * - error messages are explicit enough to diagnose misconfiguration
 */

async function runServerOnce({ env, args = [], timeoutMs = 6000 }) {
  const child = spawn('npx', ['-y', 'tsx', 'src/index.ts', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  const result = await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill();
      resolve({ code: null, signal: 'SIGKILL', stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal, stdout, stderr, timedOut: false });
    });
  });

  return result;
}

function assertIncludes(haystack, needle, label) {
  assert(
    haystack.includes(needle),
    `${label} should include "${needle}". Got:\n${haystack}`
  );
}

async function main() {
  // 1) CLI --env must error when env is not configured
  {
    const r = await runServerOnce({
      env: {
        LOCAL_SQLITE_PATH: '/tmp/context-whisper-local.sqlite',
        CONTEXT_WHISPER_ENV: 'LOCAL',
      },
      args: ['--env', 'DOES_NOT_EXIST'],
    });
    assert(r.code !== 0, 'Expected non-zero exit for unknown --env');
    assertIncludes(r.stderr, "Environment 'DOES_NOT_EXIST' not configured", 'unknown --env stderr');
    assertIncludes(r.stderr, 'Available environments:', 'unknown --env stderr');
  }

  // 2) MySQL without VECTOR_STORE=qdrant must fail during config parse
  {
    const r = await runServerOnce({
      env: {
        MYSQL_ONLY_MYSQL_HOST: '127.0.0.1',
        MYSQL_ONLY_MYSQL_PORT: '1',
        MYSQL_ONLY_MYSQL_USER: 'u',
        MYSQL_ONLY_MYSQL_PASSWORD: 'p',
        MYSQL_ONLY_MYSQL_DATABASE: 'db',
        CONTEXT_WHISPER_ENV: 'MYSQL_ONLY',
      },
    });
    assert(r.code !== 0, 'Expected non-zero exit for MySQL without Qdrant');
    assertIncludes(r.stderr, 'sqlite-vec requires SQLite', 'MySQL config stderr');
    assertIncludes(r.stderr, 'Use VECTOR_STORE=qdrant for MySQL', 'MySQL config stderr');
  }

  // 3) Postgres (pgvector) connection refused should fail fast
  {
    const r = await runServerOnce({
      env: {
        PG_BAD_PG_HOST: '127.0.0.1',
        PG_BAD_PG_PORT: '1',
        PG_BAD_PG_USER: 'u',
        PG_BAD_PG_PASSWORD: 'p',
        PG_BAD_PG_DATABASE: 'db',
        CONTEXT_WHISPER_ENV: 'PG_BAD',
      },
    });
    assert(r.code !== 0, 'Expected non-zero exit for Postgres connection failure');
    // message originates from adapter, keep it flexible
    assert(
      /Failed to connect to PostgreSQL|ECONNREFUSED|connect/i.test(r.stderr),
      `Expected Postgres connect error in stderr. Got:\n${r.stderr}`
    );
  }

  // 4) Forced Qdrant without QDRANT_HOST must fail with explicit message
  {
    const r = await runServerOnce({
      env: {
        CORP_PG_HOST: '127.0.0.1',
        CORP_PG_PORT: '1',
        CORP_PG_USER: 'u',
        CORP_PG_PASSWORD: 'p',
        CORP_PG_DATABASE: 'db',
        CORP_VECTOR_STORE: 'qdrant',
        CONTEXT_WHISPER_ENV: 'CORP',
      },
    });
    assert(r.code !== 0, 'Expected non-zero exit for qdrant forced without host');
    assertIncludes(r.stderr, 'QDRANT_HOST is required', 'Qdrant config stderr');
  }

  console.log('OK: multi-db failure modes look sane (fast fail + actionable errors).');
}

main().catch((e) => {
  console.error('FAIL: multi-db failure mode test failed.');
  console.error(e?.stack || e);
  process.exitCode = 1;
});


