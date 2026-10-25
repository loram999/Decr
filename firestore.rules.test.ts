/**
 * Security Rules Verification Suite (Dirty Dozen Adversarial Payloads)
 * Validates all 12 invariants documented in security_spec.md.
 */

export interface AdversarialCase {
  id: number;
  name: string;
  path: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  expected: 'PERMISSION_DENIED';
  auth: { uid: string; email: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
}

export const DIRTY_DOZEN_CASES: AdversarialCase[] = [
  {
    id: 1,
    name: 'Shadow Role Escalation on UserProfile',
    path: '/users/user_alpha',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    auth: { uid: 'user_alpha', email: 'alpha@example.com', email_verified: true },
    payload: {
      uid: 'user_alpha',
      email: 'alpha@example.com',
      displayName: 'Alpha',
      photoURL: '',
      workspaceId: 'ws_alpha',
      role: 'admin',
    },
  },
  {
    id: 2,
    name: 'Unverified Admin Email Spoof',
    path: '/users/victim_user',
    operation: 'get',
    expected: 'PERMISSION_DENIED',
    auth: { uid: 'spoof_uid', email: 'kp7931374@gmail.com', email_verified: false },
  },
  {
    id: 3,
    name: 'Cross-Tenant Vault Workspace Read',
    path: '/vault_workspaces/ws_victim',
    operation: 'get',
    expected: 'PERMISSION_DENIED',
    auth: { uid: 'attacker_uid', email: 'attacker@example.com', email_verified: true },
  },
  {
    id: 4,
    name: 'UID Spoofing Inside Payload',
    path: '/users/attacker_uid',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    auth: { uid: 'attacker_uid', email: 'attacker@example.com', email_verified: true },
    payload: {
      uid: 'victim_user',
      email: 'attacker@example.com',
      displayName: 'Attacker',
      photoURL: '',
      workspaceId: 'ws_1',
    },
  },
  {
    id: 5,
    name: 'Plaintext State Injection into Encrypted Vault',
    path: '/vault_workspaces/ws_alpha',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    auth: { uid: 'user_alpha', email: 'alpha@example.com', email_verified: true },
    payload: {
      workspaceId: 'ws_alpha',
      ownerUid: 'user_alpha',
      encryptedState: '{"plaintext":"not_allowed"}',
    },
  },
  {
    id: 6,
    name: 'Client Timestamp Forgery',
    path: '/users/user_alpha',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    auth: { uid: 'user_alpha', email: 'alpha@example.com', email_verified: true },
    payload: {
      uid: 'user_alpha',
      email: 'alpha@example.com',
      displayName: 'Alpha',
      photoURL: '',
      workspaceId: 'ws_alpha',
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
    },
  },
  {
    id: 7,
    name: 'Immutable Owner Mutation on VaultWorkspace Update',
    path: '/vault_workspaces/ws_alpha',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    auth: { uid: 'user_alpha', email: 'alpha@example.com', email_verified: true },
    payload: {
      ownerUid: 'victim_uid',
    },
  },
  {
    id: 8,
    name: 'Oversized Value Poisoning on Update',
    path: '/users/user_alpha',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    auth: { uid: 'user_alpha', email: 'alpha@example.com', email_verified: true },
    payload: {
      displayName: 'X'.repeat(5000),
    },
  },
  {
    id: 9,
    name: 'Capability ID Poisoning (Non-HMAC ID)',
    path: '/gateway_capabilities/short_guessable_id',
    operation: 'get',
    expected: 'PERMISSION_DENIED',
    auth: null,
  },
  {
    id: 10,
    name: 'Orphaned Capability Creation Without Parent VaultWorkspace',
    path: `/gateway_capabilities/cap_${'a'.repeat(64)}`,
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    auth: { uid: 'user_alpha', email: 'alpha@example.com', email_verified: true },
    payload: {
      capId: `cap_${'a'.repeat(64)}`,
      ownerUid: 'user_alpha',
      workspaceId: 'ws_nonexistent',
      encryptedCapability: 'enc:v1:AAAA:BBBB:CCCC',
    },
  },
  {
    id: 11,
    name: 'Unauthorized List Scraping of GatewayCapabilities',
    path: '/gateway_capabilities',
    operation: 'list',
    expected: 'PERMISSION_DENIED',
    auth: { uid: 'user_alpha', email: 'alpha@example.com', email_verified: true },
  },
  {
    id: 12,
    name: 'Self-Assigned Admin Document Creation',
    path: '/admins/attacker_uid',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    auth: { uid: 'attacker_uid', email: 'attacker@example.com', email_verified: true },
    payload: {
      uid: 'attacker_uid',
    },
  },
  {
    id: 13,
    name: 'Unauthorized List Scraping of AdminVaultAccounts',
    path: '/admin_vault_accounts',
    operation: 'list',
    expected: 'PERMISSION_DENIED',
    auth: { uid: 'user_alpha', email: 'alpha@example.com', email_verified: true },
  },
  {
    id: 14,
    name: 'Deletion Attempt on Undeletable AdminVaultAccount',
    path: '/admin_vault_accounts/ws_alpha_9771234567',
    operation: 'delete',
    expected: 'PERMISSION_DENIED',
    auth: { uid: 'user_alpha', email: 'alpha@example.com', email_verified: true },
  },
];
