import { createHash } from 'crypto';
import type { Account, DatabaseAdapter } from './db/adapters/interface.js';

export function hashAccountToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Resolve the person behind CONTEXT_WHISPER_ACCOUNT_TOKEN.
 * No token means local mode: approve_note and purge_note stay available.
 * A token that matches nothing is a hard failure.
 */
export async function resolveActingAccount(adapter: DatabaseAdapter): Promise<Account | null> {
  const token = process.env.CONTEXT_WHISPER_ACCOUNT_TOKEN;
  if (!token || token.trim().length === 0) return null;
  const account = await adapter.relational.resolveAccount(hashAccountToken(token.trim()));
  if (!account) {
    throw new Error('CONTEXT_WHISPER_ACCOUNT_TOKEN does not match an active account');
  }
  return account;
}

export function assertAccountWorkspace(account: Account | null, workspace: string): void {
  if (!account?.workspaces || account.workspaces.length === 0) return;
  if (!account.workspaces.includes(workspace)) {
    throw new Error(`Account '${account.name}' cannot access workspace '${workspace}'`);
  }
}

/** Upsert never approves. Approval is approve_note. */
export function reviewStatusForUpsert(
  _account: Account | null,
  requested?: 'DRAFT' | 'APPROVED'
): 'DRAFT' | 'APPROVED' {
  if (requested === 'APPROVED') {
    throw new Error('use approve_note to set review_status APPROVED');
  }
  return requested || 'DRAFT';
}

export function assertCanApprove(account: Account | null): void {
  if (account && account.role !== 'tech_lead') {
    throw new Error(`Role '${account.role}' cannot approve notes`);
  }
}

export function assertCanPurge(account: Account | null): void {
  if (account && account.role !== 'tech_lead') {
    throw new Error(`Role '${account.role}' cannot purge notes`);
  }
}
