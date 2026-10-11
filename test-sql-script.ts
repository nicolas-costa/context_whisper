import assert from 'assert';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { stripLeadingSqlComments } from './src/db/sql-script.ts';
import { SQLiteRelationalAdapter } from './src/db/adapters/sqlite.ts';
import { reviewStatusForUpsert } from './src/accounts.ts';

const header = `-- header
/* block */
CREATE TABLE schema_version (version INT);`;
assert.equal(
  stripLeadingSqlComments(header),
  'CREATE TABLE schema_version (version INT);'
);
assert.equal(stripLeadingSqlComments('-- only a comment'), '');
assert.equal(stripLeadingSqlComments('SELECT 1'), 'SELECT 1');

const dir = mkdtempSync(join(tmpdir(), 'cw-schema-'));
const db = new Database(join(dir, 'notes.sqlite'));
const relational = new SQLiteRelationalAdapter(db);
await relational.initSchema();

const version = db.prepare(`SELECT MAX(version) AS version FROM schema_version`).get() as {
  version: number;
};
assert.equal(version.version, 3, 'migration 3 must run after the v2 baseline');
assert.ok(db.prepare(`SELECT 1 FROM accounts LIMIT 1`).get() === undefined);

const noteId = await relational.upsertNote({
  workspace: 'acme',
  project: 'api',
  topic: 'auth',
  subtopic: null,
  tagsJson: '["backend"]',
  bodyMd: 'body',
  createdBy: null,
  reviewStatus: 'DRAFT',
});
assert.ok(noteId > 0);

const ids = relational.getFilteredNoteIds({ workspace: 'acme', project: 'api' });
assert.deepEqual(ids, [noteId]);
assert.deepEqual(relational.getFilteredNoteIds({ workspace: 'other' }), []);

const deleted = await relational.deleteNote('acme', 'api', 'auth', null);
assert.equal(deleted, true);
assert.equal(
  db.prepare('SELECT COUNT(*) AS c FROM notes WHERE deleted_at IS NULL').get().c,
  0
);
assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notes').get().c, 1);

const recreated = await relational.upsertNote({
  workspace: 'acme',
  project: 'api',
  topic: 'auth',
  subtopic: null,
  tagsJson: null,
  bodyMd: 'again',
  createdBy: null,
  reviewStatus: 'DRAFT',
});
assert.notEqual(recreated, noteId);

assert.throws(() => reviewStatusForUpsert(null, 'APPROVED'));
assert.throws(() =>
  reviewStatusForUpsert(
    { account_id: 1, name: 'ada', role: 'engineer', workspaces: null },
    'APPROVED'
  )
);
assert.equal(reviewStatusForUpsert(null, 'DRAFT'), 'DRAFT');
const purged = await relational.purgeNote('acme', 'api', 'auth', null);
assert.equal(purged, true);

db.close();
console.log('OK: migrations, soft-delete, live uniqueness, approve guard');
