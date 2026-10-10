/**
 * Apply numbered SQL migrations once.
 *
 * Files live in sql/<dialect>/migrations/NNN_name.sql.
 * Statements are separated by a line that starts with `-- @split`.
 * Semicolons inside triggers and functions stay inside one statement.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { stripLeadingSqlComments } from './sql-script.js';

export function splitMigrationScript(sql: string): string[] {
  return sql
    .split(/\n-- @split\b[^\n]*\n/)
    .map((part) => stripLeadingSqlComments(part))
    .filter((part) => part.length > 0);
}

export function listMigrationFiles(dir: string): Array<{ version: number; sql: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort()
    .map((name) => ({
      version: parseInt(name.split('_')[0], 10),
      sql: readFileSync(join(dir, name), 'utf8'),
    }))
    .filter((migration) => Number.isFinite(migration.version));
}

export async function applyMigrations(options: {
  dir: string;
  currentVersion: number;
  execute: (sql: string) => Promise<void>;
  recordVersion: (version: number) => Promise<void>;
}): Promise<void> {
  for (const migration of listMigrationFiles(options.dir)) {
    if (migration.version <= options.currentVersion) continue;
    for (const statement of splitMigrationScript(migration.sql)) {
      await options.execute(statement);
    }
    await options.recordVersion(migration.version);
  }
}
