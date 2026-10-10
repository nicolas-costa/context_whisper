/**
 * Drop leading `--` line comments and block comments from a SQL chunk.
 *
 * Schema files start with a header comment in the same statement as the first
 * DDL. A splitter that skips any chunk starting with `--` would discard that DDL.
 */
export function stripLeadingSqlComments(sql: string): string {
  let s = sql.trim();
  for (;;) {
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = (nl === -1 ? '' : s.slice(nl + 1)).trim();
      continue;
    }
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      if (end === -1) return '';
      s = s.slice(end + 2).trim();
      continue;
    }
    return s;
  }
}
