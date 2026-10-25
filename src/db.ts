import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import type { WalletProvider } from './types.js';

export type { WalletProvider };

export function normalizeProvider(raw?: unknown): WalletProvider {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'kbz' || s === 'kbzpay' || s === 'kpay') return 'kbz';
  if (s === 'aya' || s === 'ayapay') return 'aya';
  return 'wave';
}

export const MASTER_ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'kp7931374@gmail.com').trim().toLowerCase();

// Detect writable storage directory: never crash on Vercel's read-only /var/task
function resolveWritableDir(): string {
  if (process.env.VERCEL) {
    return os.tmpdir();
  }
  const cwd = process.cwd();
  try {
    fs.accessSync(cwd, fs.constants.W_OK);
    return cwd;
  } catch {
    return os.tmpdir();
  }
}

const DATA_DIR = resolveWritableDir();
const STORE_FILE = path.join(DATA_DIR, 'gateway_store.json');
const LEGACY_SQLITE_PATH = path.join(process.cwd(), 'gateway.db');
const LEGACY_VAULT_KEY_PATH = path.join(process.cwd(), '.vault.key');
const LOG_FILE = path.join(DATA_DIR, 'gateway.log');
const ERROR_LOG_FILE = path.join(DATA_DIR, 'gateway_errors.log');

const DETERMINISTIC_PBKDF2_KEY = crypto.pbkdf2Sync(
  'payment-gateway-web:ai-studio-wavemoneypayment-2c0c1daa-22d4-403d-8bdc-503247057583',
  'wave-gateway-vault-salt-v2',
  100_000,
  32,
  'sha256'
);

// Deterministic 256-bit AES-GCM server vault key so all serverless instances share identical decryption
function deriveDeterministicVaultKey(): Buffer {
  const envKey = process.env.VAULT_SECRET_KEY;
  if (envKey && envKey.trim().length >= 16) {
    return crypto.createHash('sha256').update(envKey.trim()).digest();
  }
  return DETERMINISTIC_PBKDF2_KEY;
}

function loadLegacyDiskKey(): Buffer | null {
  try {
    if (fs.existsSync(LEGACY_VAULT_KEY_PATH)) {
      const hex = fs.readFileSync(LEGACY_VAULT_KEY_PATH, 'utf-8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(hex)) {
        return Buffer.from(hex, 'hex');
      }
    }
  } catch {
    // Ignore unreadable disk key
  }
  return null;
}

const PRIMARY_VAULT_KEY = deriveDeterministicVaultKey();
const LEGACY_VAULT_KEY = loadLegacyDiskKey();
const CAPABILITY_HMAC_KEY = crypto
  .createHash('sha256')
  .update(Buffer.concat([PRIMARY_VAULT_KEY, Buffer.from(':capability-hmac-v1', 'utf-8')]))
  .digest();

const ENC_PREFIX = 'enc:v1:';

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  if (plaintext.startsWith(ENC_PREFIX)) {
    const decPrimary = tryDecryptWithKey(plaintext, PRIMARY_VAULT_KEY);
    if (decPrimary !== null) return plaintext;
    if (LEGACY_VAULT_KEY) {
      const decLegacy = tryDecryptWithKey(plaintext, LEGACY_VAULT_KEY);
      if (decLegacy !== null) {
        return encryptWithKey(decLegacy, PRIMARY_VAULT_KEY);
      }
    }
    return plaintext;
  }
  return encryptWithKey(plaintext, PRIMARY_VAULT_KEY);
}

function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

function tryDecryptWithKey(val: string, key: Buffer): string | null {
  try {
    const parts = val.slice(ENC_PREFIX.length).split(':');
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], 'base64');
    const authTag = Buffer.from(parts[1], 'base64');
    const ciphertext = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf-8');
  } catch {
    return null;
  }
}

export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return '';
  const val = String(stored);
  if (!val.startsWith(ENC_PREFIX)) {
    return val;
  }
  const primary = tryDecryptWithKey(val, PRIMARY_VAULT_KEY);
  if (primary !== null) return primary;
  if (!PRIMARY_VAULT_KEY.equals(DETERMINISTIC_PBKDF2_KEY)) {
    const pbkdf2Dec = tryDecryptWithKey(val, DETERMINISTIC_PBKDF2_KEY);
    if (pbkdf2Dec !== null) return pbkdf2Dec;
  }
  if (LEGACY_VAULT_KEY) {
    const legacy = tryDecryptWithKey(val, LEGACY_VAULT_KEY);
    if (legacy !== null) return legacy;
  }
  return '';
}

function parseMetaSafe(rawEncryptedOrPlain?: string): Record<string, any> {
  if (!rawEncryptedOrPlain) return {};
  const plain = decryptSecret(rawEncryptedOrPlain);
  if (!plain) return {};
  try {
    const parsed = JSON.parse(plain);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function computeCapabilityId(apiKey: string): string {
  const clean = String(apiKey || '').trim();
  const hex = crypto.createHmac('sha256', CAPABILITY_HMAC_KEY).update(clean).digest('hex');
  return `cap_${hex}`;
}

// Stateless AES-256-GCM URL-safe token encoding for Deposit auth_token and Withdraw withdraw_token
export interface StatelessPaymentTokenPayload {
  id: string;
  type: 'deposit' | 'withdraw';
  provider?: WalletProvider;
  workspace_id: string;
  cap_id: string;
  merchant_token: string;
  merchant_name: string;
  domain?: string;
  amount: number;
  phone_number?: string;
  receiver?: string;
  created_at: number;
  expires_at: number;
}

export function encodeStatelessToken(prefix: 'wtok_' | 'wd_', payload: StatelessPaymentTokenPayload): string {
  const json = JSON.stringify(payload);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', PRIMARY_VAULT_KEY, iv);
  const enc = Buffer.concat([cipher.update(json, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, enc]).toString('base64url');
  return `${prefix}${packed}`;
}

export function decodeStatelessToken(token: string): StatelessPaymentTokenPayload | null {
  const clean = String(token || '').trim();
  let b64 = '';
  if (clean.startsWith('wtok_')) b64 = clean.slice(5);
  else if (clean.startsWith('wd_') && clean.length > 44) b64 = clean.slice(3);
  else return null;

  try {
    const buf = Buffer.from(b64, 'base64url');
    if (buf.length < 29) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', PRIMARY_VAULT_KEY, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8');
    return JSON.parse(json) as StatelessPaymentTokenPayload;
  } catch {
    return null;
  }
}

export interface WorkspaceRow {
  id: string;
  name: string;
  api_key: string;
  owner_uid: string;
  owner_email: string;
  owner_name: string;
  photo_url?: string;
  created_at: string;
}

export interface AccountRow {
  phone: string;
  provider?: WalletProvider;
  workspace_id: string;
  owner_uid: string;
  device_id: string;
  model: string;
  os_version: string;
  wmt_mfs: string;
  pin: string;
  nrc_id?: string;
  provider_meta?: string;
  balance: number;
  name: string;
  status: string;
  user_removed?: boolean;
  removed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface MerchantRow {
  token: string;
  merchant_name: string;
  domain: string;
  active: number;
  created_at: string;
}

export interface AuthTokenRow {
  token: string;
  type: 'deposit' | 'withdraw';
  provider?: WalletProvider;
  workspace_id: string;
  merchant_token: string;
  merchant_name: string;
  domain: string;
  amount: number;
  phone_number?: string;
  receiver?: string;
  created_at: number;
  expires_at: number;
  status: string;
  trx_id?: string;
  executed_from?: string;
  verified_at?: number;
  last5_digits?: string;
}

export interface UsedTrxRow {
  trx_id: string;
  used_at: number;
  auth_token: string;
  amount: number;
  source: string;
}

export interface GatewayLogRow {
  id: number;
  event_type: string;
  level: string;
  message: string;
  details: string;
  forwarded_to_bot: number;
  created_at: string;
}

interface GatewayStoreShape {
  workspaces: Record<string, WorkspaceRow>;
  accounts: Record<string, AccountRow>;
  deleted_accounts: Record<string, string>;
  merchants: Record<string, MerchantRow>;
  auth_tokens: Record<string, AuthTokenRow>;
  used_trx: Record<string, UsedTrxRow>;
  gateway_logs: GatewayLogRow[];
  next_log_id: number;
}

const store: GatewayStoreShape = {
  workspaces: {},
  accounts: {},
  deleted_accounts: {},
  merchants: {},
  auth_tokens: {},
  used_trx: {},
  gateway_logs: [],
  next_log_id: 1,
};

export function makeAccountKey(
  workspaceId: string,
  phone: string,
  provider: WalletProvider = 'wave'
): string {
  const ws = String(workspaceId || 'default').trim();
  const ph = String(phone || '').trim().replace(/^0+/, '');
  const prov = normalizeProvider(provider);
  if (prov === 'wave') {
    return `${ws}:${ph}`;
  }
  return `${ws}:${prov}:${ph}`;
}

export function makeAdminVaultId(
  workspaceId: string,
  phone: string,
  provider: WalletProvider = 'wave'
): string {
  const ws = String(workspaceId || 'default')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  const ph = String(phone || '')
    .trim()
    .replace(/^0+/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '');
  const prov = normalizeProvider(provider);
  if (prov === 'wave') {
    return `${ws}_${ph}`.slice(0, 128);
  }
  return `${ws}_${prov}_${ph}`.slice(0, 128);
}

let initialized = false;

function persistLocalStore() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store), { mode: 0o600 });
  } catch {
    // Non-fatal on ephemeral/constrained environments
  }
}

function loadLocalStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      if (raw && typeof raw === 'object') {
        if (raw.workspaces) Object.assign(store.workspaces, raw.workspaces);
        if (raw.deleted_accounts && typeof raw.deleted_accounts === 'object') {
          Object.assign(store.deleted_accounts, raw.deleted_accounts);
        }
        if (raw.accounts && typeof raw.accounts === 'object') {
          for (const [, v] of Object.entries(raw.accounts as Record<string, AccountRow>)) {
            if (v && v.phone) {
              const wsId = v.workspace_id || 'default';
              const prov = normalizeProvider(v.provider);
              const cleanPh = String(v.phone).trim().replace(/^0+/, '');
              const compositeKey = makeAccountKey(wsId, cleanPh, prov);
              store.accounts[compositeKey] = {
                ...v,
                phone: cleanPh,
                provider: prov,
                workspace_id: wsId,
              };
            }
          }
        }
        if (raw.merchants) Object.assign(store.merchants, raw.merchants);
        if (raw.auth_tokens) Object.assign(store.auth_tokens, raw.auth_tokens);
        if (raw.used_trx) Object.assign(store.used_trx, raw.used_trx);
        if (Array.isArray(raw.gateway_logs)) store.gateway_logs = raw.gateway_logs.slice(-150);
        if (typeof raw.next_log_id === 'number') store.next_log_id = raw.next_log_id;
      }
    }
  } catch {
    // Start fresh if corrupted
  }
}

async function migrateLegacySqliteIfPresent() {
  if (process.env.VERCEL) return;
  try {
    if (!fs.existsSync(LEGACY_SQLITE_PATH)) return;
    if (Object.keys(store.accounts).length > 0 && Object.keys(store.workspaces).length > 0) return;

    const sqliteMod: any = await import('node:sqlite');
    if (!sqliteMod?.DatabaseSync) return;
    const legacyDb = new sqliteMod.DatabaseSync(LEGACY_SQLITE_PATH);

    try {
      const wsRows = legacyDb.prepare('SELECT * FROM workspaces').all() as any[];
      for (const w of wsRows) {
        if (w?.id) {
          store.workspaces[w.id] = {
            id: String(w.id),
            name: String(w.name || 'Workspace'),
            api_key: String(w.api_key || 'wk_live_' + crypto.randomBytes(16).toString('hex')),
            owner_uid: String(w.owner_uid || ''),
            owner_email: String(w.owner_email || ''),
            owner_name: String(w.owner_name || 'User'),
            created_at: String(w.created_at || new Date().toISOString()),
          };
        }
      }

      const accRows = legacyDb.prepare('SELECT * FROM accounts').all() as any[];
      for (const a of accRows) {
        if (a?.phone) {
          const decWmt = decryptSecret(a.wmt_mfs);
          const decPin = decryptSecret(a.pin);
          const decDev = decryptSecret(a.device_id);
          const wsId = String(a.workspace_id || 'default');
          const ph = String(a.phone).trim().replace(/^0+/, '');
          store.accounts[makeAccountKey(wsId, ph, 'wave')] = {
            phone: ph,
            provider: 'wave',
            workspace_id: wsId,
            owner_uid: String(a.owner_uid || ''),
            device_id: encryptSecret(decDev || String(a.device_id || '')),
            model: String(a.model || 'Android'),
            os_version: String(a.os_version || '13'),
            wmt_mfs: decWmt ? encryptSecret(decWmt) : '',
            pin: decPin ? encryptSecret(decPin) : '',
            balance: Number(a.balance) || 0,
            name: String(a.name || ''),
            status: String(a.status || (decWmt ? 'active' : 'offline')),
            created_at: String(a.created_at || new Date().toISOString()),
            updated_at: String(a.updated_at || new Date().toISOString()),
          };
        }
      }

      const merchRows = legacyDb.prepare('SELECT * FROM merchants').all() as any[];
      for (const m of merchRows) {
        if (m?.token) {
          store.merchants[m.token] = {
            token: String(m.token),
            merchant_name: String(m.merchant_name || 'Merchant'),
            domain: String(m.domain || '*'),
            active: Number(m.active ?? 1),
            created_at: String(m.created_at || new Date().toISOString()),
          };
        }
      }

      const trxRows = legacyDb.prepare('SELECT * FROM used_trx').all() as any[];
      for (const t of trxRows) {
        if (t?.trx_id) {
          store.used_trx[t.trx_id] = {
            trx_id: String(t.trx_id),
            used_at: Number(t.used_at || Date.now()),
            auth_token: String(t.auth_token || ''),
            amount: Number(t.amount || 0),
            source: String(t.source || 'legacy'),
          };
        }
      }

      persistLocalStore();
    } finally {
      try {
        legacyDb.close?.();
      } catch {
        // Ignore close error
      }
    }
  } catch {
    // node:sqlite unavailable on older Node runtimes — safe no-op
  }
}

export function initDatabase() {
  if (initialized) return;
  initialized = true;
  loadLocalStore();

  // Ensure default Master Admin workspace exists locally
  if (!store.workspaces['default']) {
    const deterministicAdminKey =
      'wk_live_' +
      crypto
        .createHmac('sha256', PRIMARY_VAULT_KEY)
        .update(`default-workspace:${MASTER_ADMIN_EMAIL}`)
        .digest('hex')
        .slice(0, 32);

    store.workspaces['default'] = {
      id: 'default',
      name: 'Primary Workspace',
      api_key: deterministicAdminKey,
      owner_uid: '',
      owner_email: MASTER_ADMIN_EMAIL,
      owner_name: 'Administrator',
      created_at: new Date().toISOString(),
    };
  }

  // Normalize any unencrypted secrets & migrate keys
  for (const [k, acc] of Object.entries(store.accounts)) {
    const prov = normalizeProvider(acc.provider);
    acc.provider = prov;
    if (acc.device_id && !acc.device_id.startsWith(ENC_PREFIX)) {
      acc.device_id = encryptSecret(acc.device_id);
    }
    if (acc.wmt_mfs && !acc.wmt_mfs.startsWith(ENC_PREFIX)) {
      acc.wmt_mfs = encryptSecret(acc.wmt_mfs);
    }
    if (acc.pin && !acc.pin.startsWith(ENC_PREFIX)) {
      acc.pin = encryptSecret(acc.pin);
    }
    if (acc.nrc_id && !acc.nrc_id.startsWith(ENC_PREFIX)) {
      acc.nrc_id = encryptSecret(acc.nrc_id);
    }
    if (acc.provider_meta && !acc.provider_meta.startsWith(ENC_PREFIX)) {
      acc.provider_meta = encryptSecret(acc.provider_meta);
    }
    const expectedKey = makeAccountKey(acc.workspace_id || 'default', acc.phone, prov);
    if (k !== expectedKey) {
      store.accounts[expectedKey] = acc;
      delete store.accounts[k];
    }
  }

  persistLocalStore();
  void migrateLegacySqliteIfPresent();
}

export function readDecryptedAccount(row: AccountRow | null | undefined): any {
  if (!row) return null;
  const prov = normalizeProvider(row.provider);
  const meta = parseMetaSafe(row.provider_meta);
  return {
    ...row,
    provider: prov,
    device_id: decryptSecret(row.device_id),
    wmt_mfs: decryptSecret(row.wmt_mfs),
    pin: decryptSecret(row.pin),
    nrc_id: decryptSecret(row.nrc_id),
    meta,
  };
}

export function ensureUserWorkspace(uid: string, email: string, displayName: string): WorkspaceRow {
  initDatabase();
  const normalizedEmail = (email || '').trim().toLowerCase();
  const isMasterAdmin = Boolean(normalizedEmail && normalizedEmail === MASTER_ADMIN_EMAIL);

  if (isMasterAdmin) {
    let defaultWs = store.workspaces['default'];
    if (!defaultWs) {
      const apiKey =
        'wk_live_' +
        crypto
          .createHmac('sha256', PRIMARY_VAULT_KEY)
          .update(`default-workspace:${MASTER_ADMIN_EMAIL}`)
          .digest('hex')
          .slice(0, 32);
      defaultWs = {
        id: 'default',
        name: 'Primary Workspace',
        api_key: apiKey,
        owner_uid: uid,
        owner_email: normalizedEmail,
        owner_name: displayName || 'Master Admin',
        created_at: new Date().toISOString(),
      };
      store.workspaces['default'] = defaultWs;
    } else if (defaultWs.owner_uid !== uid) {
      defaultWs.owner_uid = uid;
      defaultWs.owner_email = normalizedEmail;
      defaultWs.owner_name = displayName || defaultWs.owner_name || 'Administrator';
    }

    for (const acc of Object.values(store.accounts)) {
      if (acc.workspace_id === 'default' && !acc.owner_uid) {
        acc.owner_uid = uid;
      }
    }
    persistLocalStore();
    return defaultWs;
  }

  const wsHash = crypto.createHash('sha256').update(uid).digest('hex').slice(0, 12);
  const wsId = `ws_${wsHash}`;
  let userWs = store.workspaces[wsId] || Object.values(store.workspaces).find((w) => w.owner_uid === uid);

  if (!userWs) {
    const deterministicKey =
      'wk_live_' +
      crypto.createHmac('sha256', PRIMARY_VAULT_KEY).update(`workspace-key:${uid}`).digest('hex').slice(0, 32);
    userWs = {
      id: wsId,
      name: displayName ? `${displayName.slice(0, 40)} Gateway` : 'Personal Gateway',
      api_key: deterministicKey,
      owner_uid: uid,
      owner_email: normalizedEmail,
      owner_name: displayName || 'Merchant',
      created_at: new Date().toISOString(),
    };
    store.workspaces[wsId] = userWs;
    persistLocalStore();
  } else {
    let changed = false;
    if (normalizedEmail && userWs.owner_email !== normalizedEmail) {
      userWs.owner_email = normalizedEmail;
      changed = true;
    }
    if (displayName && (!userWs.owner_name || userWs.owner_name === 'Merchant' || userWs.owner_name === 'User')) {
      userWs.owner_name = displayName;
      changed = true;
    }
    if (changed) persistLocalStore();
  }

  return userWs;
}

export function upsertCloudUserProfile(profile: {
  uid: string;
  email: string;
  displayName?: string;
  photoURL?: string;
  workspaceId?: string;
  createdAt?: string;
}) {
  const uid = String(profile.uid || '').trim();
  const email = String(profile.email || '').trim().toLowerCase();
  if (!uid || !email) return;

  const isMaster = email === MASTER_ADMIN_EMAIL;
  const wsId = isMaster
    ? 'default'
    : String(
        profile.workspaceId ||
          `ws_${crypto.createHash('sha256').update(uid).digest('hex').slice(0, 12)}`
      );

  const existing = store.workspaces[wsId];
  if (!existing) {
    const deterministicKey = isMaster
      ? 'wk_live_' +
        crypto
          .createHmac('sha256', PRIMARY_VAULT_KEY)
          .update(`default-workspace:${MASTER_ADMIN_EMAIL}`)
          .digest('hex')
          .slice(0, 32)
      : 'wk_live_' +
        crypto.createHmac('sha256', PRIMARY_VAULT_KEY).update(`workspace-key:${uid}`).digest('hex').slice(0, 32);

    store.workspaces[wsId] = {
      id: wsId,
      name: isMaster
        ? 'Primary Workspace'
        : profile.displayName
        ? `${profile.displayName.slice(0, 40)} Gateway`
        : 'Personal Gateway',
      api_key: deterministicKey,
      owner_uid: uid,
      owner_email: email,
      owner_name: profile.displayName || email.split('@')[0] || 'User',
      photo_url: profile.photoURL || '',
      created_at: profile.createdAt || new Date().toISOString(),
    };
  } else {
    if (!existing.owner_uid) existing.owner_uid = uid;
    if (!existing.owner_email || existing.owner_email !== email) existing.owner_email = email;
    if (profile.displayName && (!existing.owner_name || existing.owner_name === 'Administrator' || existing.owner_name === 'Merchant')) {
      existing.owner_name = profile.displayName;
    }
    if (profile.photoURL) existing.photo_url = profile.photoURL;
  }
  persistLocalStore();
  return wsId;
}

export function recoverHistoricalAccountFromEvent(params: {
  phone: string;
  provider?: WalletProvider;
  workspace_id: string;
  owner_uid: string;
  created_at: string;
  removed_at?: string;
}) {
  const cleanPh = String(params.phone || '').trim().replace(/^0+/, '');
  const wsId = String(params.workspace_id || 'default').trim();
  const prov = normalizeProvider(params.provider);
  if (!cleanPh || !wsId) return;
  const key = makeAccountKey(wsId, cleanPh, prov);
  const existing = store.accounts[key];
  const wasRemoved = Boolean(params.removed_at && (!params.created_at || params.removed_at >= params.created_at));

  if (!existing) {
    store.accounts[key] = {
      phone: cleanPh,
      provider: prov,
      workspace_id: wsId,
      owner_uid: params.owner_uid || store.workspaces[wsId]?.owner_uid || '',
      device_id: '',
      model: 'Recorded in Cloud Activity',
      os_version: '-',
      wmt_mfs: '',
      pin: '',
      balance: 0,
      name: '',
      status: 'offline',
      user_removed: wasRemoved,
      removed_at: wasRemoved ? params.removed_at : undefined,
      created_at: params.created_at || new Date().toISOString(),
      updated_at: params.removed_at || params.created_at || new Date().toISOString(),
    };
    persistLocalStore();
  }
}

// =============================================================================
// Structured Store Accessors & Mutators
// =============================================================================
export function getWorkspaceById(id: string): WorkspaceRow | null {
  return store.workspaces[id] || null;
}

export function getWorkspaceByApiKey(apiKey: string): WorkspaceRow | null {
  const clean = String(apiKey || '').trim();
  return Object.values(store.workspaces).find((w) => w.api_key === clean) || null;
}

export function rotateWorkspaceApiKey(workspaceId: string): { oldKey: string; newKey: string } | null {
  const ws = store.workspaces[workspaceId];
  if (!ws) return null;
  const oldKey = ws.api_key;
  const newKey = 'wk_live_' + crypto.randomBytes(16).toString('hex');
  ws.api_key = newKey;
  persistLocalStore();
  return { oldKey, newKey };
}

export function listWorkspaces(): WorkspaceRow[] {
  return Object.values(store.workspaces).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function getAccountsByWorkspace(workspaceId: string, includeRemoved: boolean = false): AccountRow[] {
  return Object.values(store.accounts)
    .filter((a) => a.workspace_id === workspaceId && (includeRemoved || !a.user_removed))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function getWorkspaceStats(
  workspaceId: string,
  includeRemoved: boolean = false
): {
  count: number;
  active_count: number;
  total_bal: number;
} {
  const accs = getAccountsByWorkspace(workspaceId, includeRemoved);
  return {
    count: accs.length,
    active_count: accs.filter((a) => Boolean(decryptSecret(a.wmt_mfs))).length,
    total_bal: accs.reduce((sum, a) => sum + (Number(a.balance) || 0), 0),
  };
}

export function getAccountByPhone(
  phone: string,
  workspaceId?: string,
  provider?: WalletProvider
): AccountRow | null {
  const cleanPhone = String(phone || '').trim().replace(/^0+/, '');
  if (!cleanPhone) return null;

  if (workspaceId && provider) {
    return store.accounts[makeAccountKey(workspaceId, cleanPhone, provider)] || null;
  }

  if (workspaceId) {
    const waveMatch = store.accounts[makeAccountKey(workspaceId, cleanPhone, 'wave')];
    if (waveMatch) return waveMatch;
    const wsMatches = Object.values(store.accounts).filter(
      (a) => a.workspace_id === workspaceId && a.phone === cleanPhone
    );
    if (wsMatches.length === 0) return null;
    return wsMatches.find((a) => Boolean(decryptSecret(a.wmt_mfs))) || wsMatches[0];
  }

  const matches = Object.values(store.accounts).filter(
    (a) => a.phone === cleanPhone && (!provider || normalizeProvider(a.provider) === normalizeProvider(provider))
  );
  if (matches.length === 0) return null;
  return matches.find((a) => Boolean(decryptSecret(a.wmt_mfs))) || matches[0];
}

export function getScopedAccount(
  phone: string,
  workspaceId: string,
  provider?: WalletProvider
): AccountRow | null {
  const cleanPhone = String(phone || '').trim().replace(/^0+/, '');
  if (provider) {
    return store.accounts[makeAccountKey(workspaceId, cleanPhone, provider)] || null;
  }
  const waveMatch = store.accounts[makeAccountKey(workspaceId, cleanPhone, 'wave')];
  if (waveMatch) return waveMatch;
  const anyMatch = Object.values(store.accounts).find(
    (a) => a.workspace_id === workspaceId && a.phone === cleanPhone && !a.user_removed
  );
  return anyMatch || null;
}

export function listAllAccountsWithWorkspace(): Array<
  AccountRow & { workspace_name?: string; owner_email?: string; owner_name?: string }
> {
  return Object.values(store.accounts)
    .map((a) => {
      const ws = store.workspaces[a.workspace_id];
      return {
        ...a,
        provider: normalizeProvider(a.provider),
        workspace_name: ws?.name || a.workspace_id,
        owner_email: ws?.owner_email || '',
        owner_name: ws?.owner_name || '',
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function mergeAccountRowNonDestructive(
  existing: AccountRow | undefined,
  incomingRaw: Partial<AccountRow> & { phone: string; workspace_id: string }
): AccountRow {
  const cleanPh = String(incomingRaw.phone).trim().replace(/^0+/, '');
  const wsId = String(incomingRaw.workspace_id || 'default').trim();
  const prov = normalizeProvider(incomingRaw.provider || existing?.provider);
  const now = new Date().toISOString();

  const incWmtPlain = decryptSecret(incomingRaw.wmt_mfs);
  const incPinPlain = decryptSecret(incomingRaw.pin);
  const incDevPlain = decryptSecret(incomingRaw.device_id);
  const incNrcPlain = decryptSecret(incomingRaw.nrc_id);
  const incMetaObj = parseMetaSafe(incomingRaw.provider_meta);

  if (!existing) {
    const metaStr = Object.keys(incMetaObj).length > 0 ? encryptSecret(JSON.stringify(incMetaObj)) : '';
    return {
      phone: cleanPh,
      provider: prov,
      workspace_id: wsId,
      owner_uid: String(incomingRaw.owner_uid || ''),
      device_id: incDevPlain ? encryptSecret(incDevPlain) : '',
      model: String(incomingRaw.model || 'Android'),
      os_version: String(incomingRaw.os_version || '13'),
      wmt_mfs: incWmtPlain ? encryptSecret(incWmtPlain) : '',
      pin: incPinPlain ? encryptSecret(incPinPlain) : '',
      nrc_id: incNrcPlain ? encryptSecret(incNrcPlain) : undefined,
      provider_meta: metaStr || undefined,
      balance: Number(incomingRaw.balance) || 0,
      name: String(incomingRaw.name || ''),
      status: String(incomingRaw.status || (incWmtPlain ? 'active' : 'offline')),
      user_removed: Boolean(incomingRaw.user_removed),
      removed_at: incomingRaw.removed_at ? String(incomingRaw.removed_at) : undefined,
      created_at: String(incomingRaw.created_at || now),
      updated_at: String(incomingRaw.updated_at || incomingRaw.created_at || now),
    };
  }

  const exWmtPlain = decryptSecret(existing.wmt_mfs);
  const exPinPlain = decryptSecret(existing.pin);
  const exDevPlain = decryptSecret(existing.device_id);
  const exNrcPlain = decryptSecret(existing.nrc_id);
  const exMetaObj = parseMetaSafe(existing.provider_meta);

  const exUpdated = String(existing.updated_at || existing.created_at || '');
  const incUpdated = String(incomingRaw.updated_at || incomingRaw.created_at || '');
  const incomingIsNewer = !exUpdated || incUpdated >= exUpdated;

  // Never erase a valid session token or its paired device_id
  let chosenWmt = exWmtPlain;
  let chosenDev = exDevPlain;
  if (incWmtPlain && !exWmtPlain) {
    chosenWmt = incWmtPlain;
    chosenDev = incDevPlain || exDevPlain;
  } else if (incWmtPlain && exWmtPlain && incomingIsNewer) {
    chosenWmt = incWmtPlain;
    chosenDev = incDevPlain || exDevPlain;
  } else if (!chosenDev && incDevPlain) {
    chosenDev = incDevPlain;
  }

  // Never erase a saved PIN or NRC
  let chosenPin = exPinPlain;
  if (incPinPlain && !exPinPlain) {
    chosenPin = incPinPlain;
  } else if (incPinPlain && exPinPlain && incomingIsNewer) {
    chosenPin = incPinPlain;
  }

  let chosenNrc = exNrcPlain;
  if (incNrcPlain && !exNrcPlain) {
    chosenNrc = incNrcPlain;
  } else if (incNrcPlain && exNrcPlain && incomingIsNewer) {
    chosenNrc = incNrcPlain;
  }

  const mergedMeta = incomingIsNewer
    ? { ...exMetaObj, ...incMetaObj }
    : { ...incMetaObj, ...exMetaObj };
  const mergedMetaStr =
    Object.keys(mergedMeta).length > 0 ? encryptSecret(JSON.stringify(mergedMeta)) : undefined;

  const primary = incomingIsNewer ? incomingRaw : existing;
  const secondary = incomingIsNewer ? existing : incomingRaw;

  const chosenName = String(primary.name || secondary.name || '');
  const chosenOwnerUid = String(primary.owner_uid || secondary.owner_uid || '');
  const chosenBalance =
    incomingIsNewer && incomingRaw.balance !== undefined
      ? Number(incomingRaw.balance) || 0
      : Number(existing.balance) || Number(incomingRaw.balance) || 0;

  return {
    phone: cleanPh,
    provider: prov,
    workspace_id: wsId,
    owner_uid: chosenOwnerUid,
    device_id: chosenDev ? encryptSecret(chosenDev) : '',
    model: String(primary.model || secondary.model || 'Android'),
    os_version: String(primary.os_version || secondary.os_version || '13'),
    wmt_mfs: chosenWmt ? encryptSecret(chosenWmt) : '',
    pin: chosenPin ? encryptSecret(chosenPin) : '',
    nrc_id: chosenNrc ? encryptSecret(chosenNrc) : undefined,
    provider_meta: mergedMetaStr,
    balance: chosenBalance,
    name: chosenName,
    status: chosenWmt
      ? String((incomingIsNewer ? incomingRaw.status : existing.status) || 'active')
      : 'offline',
    user_removed: incomingIsNewer
      ? Boolean(incomingRaw.user_removed)
      : Boolean(existing.user_removed),
    removed_at: incomingIsNewer
      ? incomingRaw.removed_at
        ? String(incomingRaw.removed_at)
        : undefined
      : existing.removed_at,
    created_at: String(existing.created_at || incomingRaw.created_at || now),
    updated_at: incomingIsNewer ? incUpdated || now : exUpdated || now,
  };
}

export function createAccount(params: {
  phone: string;
  provider?: WalletProvider;
  workspace_id: string;
  owner_uid: string;
  device_id: string;
  model: string;
  os_version: string;
  name: string;
  nrc_id?: string;
  provider_meta?: Record<string, any>;
}): AccountRow {
  const now = new Date().toISOString();
  const cleanPhone = String(params.phone).trim().replace(/^0+/, '');
  const prov = normalizeProvider(params.provider);
  const key = makeAccountKey(params.workspace_id, cleanPhone, prov);
  delete store.deleted_accounts[key];

  const existing = store.accounts[key];
  if (existing) {
    existing.provider = prov;
    existing.user_removed = false;
    existing.removed_at = undefined;
    existing.owner_uid = params.owner_uid || existing.owner_uid;
    existing.model = params.model || existing.model;
    existing.os_version = params.os_version || existing.os_version;
    if (params.name) {
      existing.name = params.name;
    }
    if (params.nrc_id) {
      existing.nrc_id = encryptSecret(params.nrc_id.trim());
    }
    if (params.provider_meta && Object.keys(params.provider_meta).length > 0) {
      const curMeta = parseMetaSafe(existing.provider_meta);
      existing.provider_meta = encryptSecret(JSON.stringify({ ...curMeta, ...params.provider_meta }));
    }
    if (!decryptSecret(existing.device_id)) {
      existing.device_id = encryptSecret(params.device_id);
    }
    existing.updated_at = now;
    persistLocalStore();
    return existing;
  }

  const row: AccountRow = {
    phone: cleanPhone,
    provider: prov,
    workspace_id: params.workspace_id,
    owner_uid: params.owner_uid,
    device_id: encryptSecret(params.device_id),
    model: params.model,
    os_version: params.os_version,
    wmt_mfs: '',
    pin: '',
    nrc_id: params.nrc_id ? encryptSecret(params.nrc_id.trim()) : undefined,
    provider_meta:
      params.provider_meta && Object.keys(params.provider_meta).length > 0
        ? encryptSecret(JSON.stringify(params.provider_meta))
        : undefined,
    balance: 0,
    name: params.name,
    status: 'offline',
    user_removed: false,
    created_at: now,
    updated_at: now,
  };
  store.accounts[key] = row;
  persistLocalStore();
  return row;
}

export function updateAccountCredentials(
  phone: string,
  updates: {
    wmt_mfs?: string;
    pin?: string;
    nrc_id?: string;
    provider_meta?: Record<string, any>;
    balance?: number;
    name?: string;
    status?: string;
  },
  workspaceId?: string,
  provider?: WalletProvider
) {
  const acc = getAccountByPhone(phone, workspaceId, provider);
  if (!acc) return;
  // Never blank out an existing wmt_mfs, pin, or nrc_id once captured
  if (updates.wmt_mfs !== undefined && updates.wmt_mfs) {
    acc.wmt_mfs = encryptSecret(updates.wmt_mfs);
  }
  if (updates.pin !== undefined && updates.pin) {
    acc.pin = encryptSecret(updates.pin);
  }
  if (updates.nrc_id !== undefined && updates.nrc_id) {
    acc.nrc_id = encryptSecret(updates.nrc_id.trim());
  }
  if (updates.provider_meta !== undefined && updates.provider_meta) {
    const curMeta = parseMetaSafe(acc.provider_meta);
    acc.provider_meta = encryptSecret(JSON.stringify({ ...curMeta, ...updates.provider_meta }));
  }
  if (updates.balance !== undefined) {
    acc.balance = Number(updates.balance) || 0;
  }
  if (updates.name !== undefined && updates.name) {
    acc.name = updates.name;
  }
  if (updates.status !== undefined) {
    acc.status = updates.status;
  }
  acc.updated_at = new Date().toISOString();
  persistLocalStore();
}

// Soft-remove for User dashboard ONLY: hides from User & Merchant API pool, NEVER deletes from Admin Vault!
export function deleteAccountFromStore(
  phone: string,
  workspaceId: string,
  provider: WalletProvider = 'wave'
): boolean {
  const cleanPhone = String(phone || '').trim().replace(/^0+/, '');
  const key = makeAccountKey(workspaceId, cleanPhone, provider);
  const acc = store.accounts[key];
  if (!acc || acc.user_removed) return false;
  const now = new Date().toISOString();
  acc.user_removed = true;
  acc.removed_at = now;
  acc.updated_at = now;
  persistLocalStore();
  return true;
}

export function getMerchantByToken(token: string): MerchantRow | null {
  const m = store.merchants[String(token || '').trim()];
  if (!m || !m.active) return null;
  return m;
}

export function listMerchants(): MerchantRow[] {
  return Object.values(store.merchants).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function createMerchant(merchantName: string, domain: string): MerchantRow {
  const token = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString();
  const row: MerchantRow = {
    token,
    merchant_name: merchantName,
    domain: domain || '*',
    active: 1,
    created_at: now,
  };
  store.merchants[token] = row;
  persistLocalStore();
  return row;
}

export function deleteMerchant(token: string) {
  delete store.merchants[token];
  persistLocalStore();
}

export function upsertAuthToken(row: AuthTokenRow) {
  store.auth_tokens[row.token] = row;
  const keys = Object.keys(store.auth_tokens);
  if (keys.length > 300) {
    const sorted = Object.values(store.auth_tokens).sort((a, b) => a.created_at - b.created_at);
    for (const old of sorted.slice(0, keys.length - 300)) {
      delete store.auth_tokens[old.token];
    }
  }
  persistLocalStore();
}

export function getAuthToken(token: string, expectedType?: 'deposit' | 'withdraw'): AuthTokenRow | null {
  const existing = store.auth_tokens[token];
  if (existing) {
    if (expectedType && existing.type !== expectedType) return null;
    return existing;
  }
  const decoded = decodeStatelessToken(token);
  if (!decoded) return null;
  if (expectedType && decoded.type !== expectedType) return null;
  const reconstructed: AuthTokenRow = {
    token,
    type: decoded.type,
    provider: normalizeProvider(decoded.provider),
    workspace_id: decoded.workspace_id,
    merchant_token: decoded.merchant_token,
    merchant_name: decoded.merchant_name,
    domain: decoded.domain || '*',
    amount: decoded.amount,
    phone_number: decoded.phone_number,
    receiver: decoded.receiver,
    created_at: decoded.created_at,
    expires_at: decoded.expires_at,
    status: decoded.type === 'deposit' ? 'pending' : 'authorized',
  };
  store.auth_tokens[token] = reconstructed;
  return reconstructed;
}

export function listAuthTokensByWorkspace(workspaceId: string, limitCount: number = 50): AuthTokenRow[] {
  return Object.values(store.auth_tokens)
    .filter((t) => t.workspace_id === workspaceId)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limitCount);
}

export function listAllAuthTokens(limitCount: number = 50): AuthTokenRow[] {
  return Object.values(store.auth_tokens)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limitCount);
}

export function isTrxUsed(trxId: string): boolean {
  return Boolean(store.used_trx[String(trxId || '').trim()]);
}

export function markTrxUsed(row: UsedTrxRow) {
  store.used_trx[row.trx_id] = row;
  persistLocalStore();
}

export function unblockTrx(trxId: string) {
  delete store.used_trx[String(trxId || '').trim()];
  persistLocalStore();
}

export function listUsedTrx(limitCount: number = 50): UsedTrxRow[] {
  return Object.values(store.used_trx)
    .sort((a, b) => b.used_at - a.used_at)
    .slice(0, limitCount);
}

export function listGatewayLogs(limitCount: number = 80): GatewayLogRow[] {
  return [...store.gateway_logs].sort((a, b) => b.id - a.id).slice(0, limitCount);
}

export function clearGatewayLogs() {
  store.gateway_logs = [];
  persistLocalStore();
}

// =============================================================================
// Encrypted Snapshots for Firestore Cloud Persistence
// =============================================================================
export function exportWorkspaceEncryptedState(workspaceId: string, includeAdminGlobals: boolean = false): string {
  const ws = store.workspaces[workspaceId];
  const accounts = getAccountsByWorkspace(workspaceId, true);
  const tokens = listAuthTokensByWorkspace(workspaceId, 40);
  const usedTrx = listUsedTrx(100);

  const payload: Record<string, any> = {
    v: 4,
    workspace: ws,
    accounts,
    tokens,
    used_trx: usedTrx,
  };

  if (includeAdminGlobals) {
    payload.merchants = listMerchants();
    payload.logs = listGatewayLogs(60);
  }

  return encryptSecret(JSON.stringify(payload));
}

export function importWorkspaceEncryptedState(encryptedState: string) {
  const json = decryptSecret(encryptedState);
  if (!json) return;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return;

    const wsId = String(parsed.workspace?.id || '').trim();
    if (wsId && parsed.workspace) {
      const curWs = store.workspaces[wsId];
      store.workspaces[wsId] = {
        ...curWs,
        ...parsed.workspace,
        photo_url: parsed.workspace.photo_url || curWs?.photo_url || '',
      };
    }

    if (parsed.deleted_accounts && typeof parsed.deleted_accounts === 'object') {
      for (const [k, ts] of Object.entries(parsed.deleted_accounts as Record<string, string>)) {
        const existingAcc = store.accounts[k];
        if (existingAcc && String(ts) >= String(existingAcc.updated_at || '')) {
          existingAcc.user_removed = true;
          existingAcc.removed_at = existingAcc.removed_at || String(ts);
        } else if (!existingAcc && wsId) {
          const parts = k.split(':');
          let prov: WalletProvider = 'wave';
          let rawPh = k;
          if (parts.length >= 3) {
            prov = normalizeProvider(parts[1]);
            rawPh = parts.slice(2).join(':');
          } else if (parts.length === 2) {
            rawPh = parts[1];
          }
          const cleanPh = String(rawPh || '').trim().replace(/^0+/, '');
          if (/^\d{7,12}$/.test(cleanPh)) {
            const compKey = makeAccountKey(wsId, cleanPh, prov);
            if (!store.accounts[compKey]) {
              store.accounts[compKey] = {
                phone: cleanPh,
                provider: prov,
                workspace_id: wsId,
                owner_uid: String(parsed.workspace?.owner_uid || ''),
                device_id: '',
                model: 'Removed Prior to Permanent Vault',
                os_version: '-',
                wmt_mfs: '',
                pin: '',
                balance: 0,
                name: '',
                status: 'offline',
                user_removed: true,
                removed_at: String(ts),
                created_at: String(ts),
                updated_at: String(ts),
              };
            }
          }
        }
      }
    }

    if (Array.isArray(parsed.accounts) && wsId) {
      for (const acc of parsed.accounts) {
        if (!acc?.phone) continue;
        const cleanPh = String(acc.phone).trim().replace(/^0+/, '');
        const prov = normalizeProvider(acc.provider);
        const key = makeAccountKey(wsId, cleanPh, prov);
        store.accounts[key] = mergeAccountRowNonDestructive(store.accounts[key], {
          ...acc,
          phone: cleanPh,
          provider: prov,
          workspace_id: wsId,
        });
      }
    }

    if (Array.isArray(parsed.tokens)) {
      for (const t of parsed.tokens) {
        if (t?.token) {
          const cur = store.auth_tokens[t.token];
          if (!cur || (t.verified_at && !cur.verified_at) || t.status !== 'pending') {
            store.auth_tokens[t.token] = t;
          }
        }
      }
    }

    if (Array.isArray(parsed.used_trx)) {
      for (const u of parsed.used_trx) {
        if (u?.trx_id) {
          store.used_trx[u.trx_id] = u;
        }
      }
    }

    if (Array.isArray(parsed.merchants)) {
      for (const m of parsed.merchants) {
        if (m?.token) {
          store.merchants[m.token] = m;
        }
      }
    }

    if (Array.isArray(parsed.logs) && store.gateway_logs.length === 0) {
      store.gateway_logs = parsed.logs;
      const maxId = store.gateway_logs.reduce((mx, l) => Math.max(mx, Number(l.id) || 0), 0);
      store.next_log_id = maxId + 1;
    }

    persistLocalStore();
  } catch {
    // Ignore malformed snapshot
  }
}

export function exportSingleAccountEncryptedBlob(acc: AccountRow): string {
  const ws = store.workspaces[acc.workspace_id];
  const payload = {
    v: 2,
    account: acc,
    workspace_meta: ws
      ? {
          id: ws.id,
          name: ws.name,
          owner_uid: ws.owner_uid,
          owner_email: ws.owner_email,
          owner_name: ws.owner_name,
          photo_url: ws.photo_url || '',
          created_at: ws.created_at,
        }
      : undefined,
  };
  return encryptSecret(JSON.stringify(payload));
}

export function importSingleAccountEncryptedBlob(encryptedAccount: string): void {
  const json = decryptSecret(encryptedAccount);
  if (!json) return;
  try {
    const parsed = JSON.parse(json);
    const acc = parsed?.account;
    if (!acc?.phone) return;
    const wsId = String(acc.workspace_id || parsed?.workspace_meta?.id || 'default').trim();
    const cleanPh = String(acc.phone).trim().replace(/^0+/, '');
    const prov = normalizeProvider(acc.provider);

    if (parsed?.workspace_meta?.id && !store.workspaces[wsId]) {
      const wm = parsed.workspace_meta;
      const fallbackKey =
        'wk_live_' +
        crypto
          .createHmac('sha256', PRIMARY_VAULT_KEY)
          .update(`workspace-key:${wm.owner_uid || wsId}`)
          .digest('hex')
          .slice(0, 32);
      store.workspaces[wsId] = {
        id: wsId,
        name: String(wm.name || 'Workspace'),
        api_key: fallbackKey,
        owner_uid: String(wm.owner_uid || acc.owner_uid || ''),
        owner_email: String(wm.owner_email || ''),
        owner_name: String(wm.owner_name || 'User'),
        photo_url: String(wm.photo_url || ''),
        created_at: String(wm.created_at || acc.created_at || new Date().toISOString()),
      };
    }

    const key = makeAccountKey(wsId, cleanPh, prov);
    store.accounts[key] = mergeAccountRowNonDestructive(store.accounts[key], {
      ...acc,
      phone: cleanPh,
      provider: prov,
      workspace_id: wsId,
    });
    persistLocalStore();
  } catch {
    // Ignore malformed record
  }
}

export function exportCapabilityEncryptedBlob(workspaceId: string, apiKey: string, merchantName?: string): string {
  const ws = store.workspaces[workspaceId];
  const accounts = getAccountsByWorkspace(workspaceId, false);
  const usedTrx = listUsedTrx(100);

  const payload = {
    v: 4,
    workspace: ws,
    api_key: apiKey,
    merchant_name: merchantName || ws?.name || 'Gateway',
    accounts,
    used_trx: usedTrx,
  };

  return encryptSecret(JSON.stringify(payload));
}

export function importCapabilityEncryptedBlob(encryptedCapability: string): {
  workspaceId: string;
  name: string;
  apiKey: string;
} | null {
  const json = decryptSecret(encryptedCapability);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    const wsId = String(parsed?.workspace?.id || '').trim();
    if (!wsId) return null;

    store.workspaces[wsId] = {
      ...store.workspaces[wsId],
      ...parsed.workspace,
    };
    if (Array.isArray(parsed.accounts)) {
      for (const acc of parsed.accounts) {
        if (acc?.phone) {
          const cleanPh = String(acc.phone).trim().replace(/^0+/, '');
          const prov = normalizeProvider(acc.provider);
          const key = makeAccountKey(wsId, cleanPh, prov);
          store.accounts[key] = mergeAccountRowNonDestructive(store.accounts[key], {
            ...acc,
            phone: cleanPh,
            provider: prov,
            workspace_id: wsId,
          });
        }
      }
    }
    if (Array.isArray(parsed.used_trx)) {
      for (const u of parsed.used_trx) {
        if (u?.trx_id && !store.used_trx[u.trx_id]) {
          store.used_trx[u.trx_id] = u;
        }
      }
    }
    persistLocalStore();
    return {
      workspaceId: wsId,
      name: parsed.merchant_name || parsed.workspace.name,
      apiKey: parsed.api_key || parsed.workspace.api_key,
    };
  } catch {
    return null;
  }
}

export interface EncryptedBlobInspection {
  decrypt_ok: boolean;
  version?: number;
  workspace_id?: string;
  workspace_name?: string;
  owner_email?: string;
  owner_name?: string;
  accounts: Array<{
    phone: string;
    provider: WalletProvider;
    name: string;
    model: string;
    os_version: string;
    balance: number;
    has_session: boolean;
    has_pin: boolean;
    user_removed: boolean;
    updated_at: string;
  }>;
  deleted_tombstones: string[];
}

export function inspectEncryptedBlobForAdmin(ciphertext: string): EncryptedBlobInspection {
  if (!ciphertext) {
    return { decrypt_ok: false, accounts: [], deleted_tombstones: [] };
  }
  const json = decryptSecret(ciphertext);
  if (!json) {
    return { decrypt_ok: false, accounts: [], deleted_tombstones: [] };
  }
  try {
    const parsed = JSON.parse(json);
    const ws = parsed?.workspace || parsed?.workspace_meta;
    const rawAccs: any[] = Array.isArray(parsed?.accounts)
      ? parsed.accounts
      : parsed?.account
      ? [parsed.account]
      : [];
    const accounts = rawAccs
      .filter((a) => Boolean(a?.phone))
      .map((a) => ({
        phone: String(a.phone).trim().replace(/^0+/, ''),
        provider: normalizeProvider(a.provider),
        name: String(a.name || ''),
        model: String(a.model || ''),
        os_version: String(a.os_version || ''),
        balance: Number(a.balance) || 0,
        has_session: Boolean(decryptSecret(a.wmt_mfs)),
        has_pin: Boolean(decryptSecret(a.pin)),
        user_removed: Boolean(a.user_removed),
        updated_at: String(a.updated_at || a.created_at || ''),
      }));
    const deleted_tombstones =
      parsed?.deleted_accounts && typeof parsed.deleted_accounts === 'object'
        ? Object.entries(parsed.deleted_accounts).map(([k, ts]) => `${k} @ ${String(ts)}`)
        : [];
    return {
      decrypt_ok: true,
      version: Number(parsed?.v) || 1,
      workspace_id: String(ws?.id || parsed?.account?.workspace_id || ''),
      workspace_name: String(ws?.name || parsed?.merchant_name || ''),
      owner_email: String(ws?.owner_email || ''),
      owner_name: String(ws?.owner_name || ''),
      accounts,
      deleted_tombstones,
    };
  } catch {
    return { decrypt_ok: false, accounts: [], deleted_tombstones: [] };
  }
}

export function logGatewayEvent(
  eventType: string,
  level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS',
  message: string,
  details?: Record<string, any>
) {
  const timestamp = new Date().toISOString();
  const detailsStr = details ? JSON.stringify(details) : '';
  const logLine = `[${timestamp}] [${level}] [${eventType}] ${message} ${detailsStr}\n`;

  try {
    fs.appendFileSync(LOG_FILE, logLine, 'utf-8');
    if (level === 'ERROR') {
      fs.appendFileSync(ERROR_LOG_FILE, logLine, 'utf-8');
    }
  } catch {
    // Non-fatal on serverless tmpfs
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const forwarded = botToken && botToken.trim() !== '' ? 1 : 0;

  store.gateway_logs.push({
    id: store.next_log_id++,
    event_type: eventType,
    level,
    message,
    details: detailsStr,
    forwarded_to_bot: forwarded,
    created_at: timestamp,
  });

  if (store.gateway_logs.length > 120) {
    store.gateway_logs = store.gateway_logs.slice(-120);
  }
  persistLocalStore();

  if (forwarded) {
    void forwardLogToTelegram(eventType, level, message, details);
  }
}

async function forwardLogToTelegram(
  eventType: string,
  level: string,
  message: string,
  details?: Record<string, any>
) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const adminId = process.env.ADMIN_ID || '';

  if (!botToken || !adminId) return;

  let formatted = `*GATEWAY LOG - ${eventType.toUpperCase()}*\n`;
  formatted += `*Level:* ${level}\n`;
  formatted += `*Message:* ${message}\n`;
  if (details) {
    formatted += `*Details:*\n\`\`\`json\n${JSON.stringify(details, null, 2).slice(0, 500)}\n\`\`\`\n`;
  }
  formatted += `_Time: ${new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Yangon' })} MMT_`;

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: adminId,
        text: formatted,
        parse_mode: 'Markdown',
      }),
    });
  } catch {
    // Non-blocking
  }
}
