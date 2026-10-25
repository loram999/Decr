import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import os from 'os';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  MASTER_ADMIN_EMAIL,
  WalletProvider,
  clearGatewayLogs,
  computeCapabilityId,
  createAccount,
  createMerchant,
  decodeStatelessToken,
  deleteAccountFromStore,
  deleteMerchant,
  encodeStatelessToken,
  ensureUserWorkspace,
  getAccountByPhone,
  getAccountsByWorkspace,
  getAuthToken,
  getMerchantByToken,
  getScopedAccount,
  getWorkspaceByApiKey,
  getWorkspaceStats,
  initDatabase,
  isTrxUsed,
  listAllAccountsWithWorkspace,
  listAllAuthTokens,
  listAuthTokensByWorkspace,
  listGatewayLogs,
  listMerchants,
  listUsedTrx,
  listWorkspaces,
  logGatewayEvent,
  markTrxUsed,
  normalizeProvider,
  readDecryptedAccount,
  rotateWorkspaceApiKey,
  unblockTrx,
  upsertAuthToken,
  WorkspaceRow,
} from './db.js';
import {
  hydrateAllWorkspacesForAdmin,
  hydrateCapabilityByApiKey,
  hydrateCapabilityByCapId,
  hydrateWorkspaceFromCloud,
  persistWorkspaceToCloud,
  searchCloudDatabaseForAdmin,
} from './firestore_vault.js';
import { WaveWalletEngine } from './wave_client.js';
import { KbzWalletEngine } from './kbz_client.js';
import { AyaWalletEngine } from './aya_client.js';
import { createWalletEngineForAccount } from './wallet_router.js';
import { extractWaveReceiptInfo } from './receipt_parser.js';
import { formatProviderLabel } from './types.js';

const FIREBASE_PROJECT_ID = 'payment-gateway-web';
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

export interface AuthenticatedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  name: string;
  isAdmin: boolean;
  idToken: string;
  workspace: WorkspaceRow;
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUser;
    }
  }
}

export const app = express();
app.disable('x-powered-by');

initDatabase();

// =============================================================================
// 1. Security Firewall: Block sensitive file extensions & set strict headers
// =============================================================================
const BLOCKED_PATH_REGEX = /(\/\.(env|vault\.key|git))|(gateway_store\.json)|(\.(py|db|sqlite|sqlite3|log|key|env|rules)$)/i;

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (BLOCKED_PATH_REGEX.test(req.path)) {
    res.status(404).end('Not Found');
    return;
  }

  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }

  next();
});

// Per-IP Sliding Window Rate Limiter for API Protection
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
  const now = Date.now();
  const windowMs = 60_000;
  const maxReq = 120;

  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    next();
    return;
  }

  entry.count += 1;
  if (entry.count > maxReq) {
    res.status(429).json({
      status: 'error',
      message: 'တောင်းဆိုမှု များပြားနေပါသည်။ ခေတ္တစောင့်ဆိုင်းပြီးမှ ပြန်လည်ကြိုးစားပါ။',
    });
    return;
  }
  next();
});

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// =============================================================================
// 2. Cryptographic Firebase Auth Middleware + Cloud Vault Hydration
// =============================================================================
async function parseBearerUser(req: Request): Promise<AuthenticatedUser | null> {
  const authHeader = String(req.headers.authorization || '');
  if (!authHeader.startsWith('Bearer ')) return null;
  const idToken = authHeader.slice(7).trim();
  if (!idToken) return null;

  const { payload } = await jwtVerify(idToken, FIREBASE_JWKS, {
    issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
    audience: FIREBASE_PROJECT_ID,
  });

  const uid = String(payload.sub || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  const emailVerified = payload.email_verified === true;
  const name = String(payload.name || email.split('@')[0] || 'User');

  if (!uid || !email || !emailVerified) return null;

  const isAdmin = email === MASTER_ADMIN_EMAIL;
  const expectedWsId = isAdmin
    ? 'default'
    : `ws_${crypto.createHash('sha256').update(uid).digest('hex').slice(0, 12)}`;

  // Hydrate encrypted workspace state from Firestore on serverless cold starts
  const cloudStatus = await hydrateWorkspaceFromCloud(expectedWsId, uid, idToken);
  const workspace = ensureUserWorkspace(uid, email, name);

  if (cloudStatus === 'not_found') {
    const hasLocalAccounts = getAccountsByWorkspace(workspace.id).length > 0;
    await persistWorkspaceToCloud(workspace.id, uid, idToken, {
      isAdmin,
      createOnly: !hasLocalAccounts,
    });
  }

  return {
    uid,
    email,
    emailVerified,
    name,
    isAdmin,
    idToken,
    workspace,
  };
}

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = String(req.headers.authorization || '');
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ status: 'error', message: 'Google အကောင့်ဖြင့် ဦးစွာ Sign in ဝင်ရောက်ပါ။' });
      return;
    }

    const user = await parseBearerUser(req);
    if (!user) {
      res.status(401).json({ status: 'error', message: 'အတည်ပြုပြီးသား Google အကောင့် လိုအပ်ပါသည်။' });
      return;
    }

    req.authUser = user;
    next();
  } catch {
    res.status(401).json({
      status: 'error',
      message: 'Session သက်တမ်းကုန်ဆုံးသွားပါပြီ။ Google ဖြင့် ပြန်လည် Sign in ဝင်ပါ။',
    });
  }
}

// Stealth Admin Guard: Returns 404 Not Found to non-admins so admin routes remain completely invisible
async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  await requireAuth(req, res, async () => {
    if (!req.authUser?.isAdmin) {
      res.status(404).json({ status: 'error', message: 'Not found' });
      return;
    }
    await hydrateAllWorkspacesForAdmin(req.authUser.idToken);
    next();
  });
}

function translateMyanmarDigits(text: string): string {
  const mmDigits = '၀၁၂၃၄၅၆၇၈၉';
  const enDigits = '0123456789';
  let result = '';
  for (const char of text) {
    const idx = mmDigits.indexOf(char);
    result += idx !== -1 ? enDigits[idx] : char;
  }
  return result;
}

function cleanMsisdn(raw: string): string {
  return translateMyanmarDigits(String(raw || ''))
    .trim()
    .replace(/[\s-]+/g, '')
    .replace(/^\+?95/, '')
    .replace(/^0+/, '');
}

// Strip all internal credentials (wmt_mfs, device_id, raw pin, nrc_id, provider_meta) before sending to browser
function sanitizeAccountForClient(rawRow: any, includeMaskedPin: boolean = false) {
  const dec = readDecryptedAccount(rawRow);
  const provider: WalletProvider = normalizeProvider(dec.provider);
  return {
    phone: dec.phone,
    provider,
    workspace_id: dec.workspace_id,
    workspace_name: dec.workspace_name || undefined,
    owner_email: includeMaskedPin ? dec.owner_email || undefined : undefined,
    owner_name: includeMaskedPin ? dec.owner_name || undefined : undefined,
    model: dec.model,
    os_version: dec.os_version,
    has_session: Boolean(dec.wmt_mfs),
    has_pin: Boolean(dec.pin),
    has_nrc: Boolean(dec.nrc_id),
    ...(includeMaskedPin
      ? {
          masked_pin: dec.pin ? '••••••' : '',
          user_removed: Boolean(dec.user_removed),
          removed_at: dec.removed_at || undefined,
        }
      : {}),
    balance: Number(dec.balance) || 0,
    name: dec.name || '',
    status: dec.wmt_mfs ? 'active' : 'offline',
    created_at: dec.created_at,
    updated_at: dec.updated_at,
  };
}

function getScopedDecryptedAccount(
  phone: string,
  user: AuthenticatedUser,
  rawProvider?: unknown
): any | null {
  const cleanPhone = cleanMsisdn(phone);
  const prov = rawProvider ? normalizeProvider(rawProvider) : undefined;
  const row = getScopedAccount(cleanPhone, user.workspace.id, prov);
  if (!row || row.user_removed) return null;
  return readDecryptedAccount(row);
}

async function resolveWorkspaceOrMerchantAsync(apiKey: string): Promise<{
  type: 'workspace' | 'merchant';
  id: string;
  name: string;
  apiKey: string;
  capId: string;
  domain?: string;
} | null> {
  if (!apiKey) return null;
  const cleanKey = apiKey.trim();
  const capId = computeCapabilityId(cleanKey);

  const ws = getWorkspaceByApiKey(cleanKey);
  if (ws) {
    return { type: 'workspace', id: ws.id, name: ws.name, apiKey: ws.api_key, capId };
  }

  const merch = getMerchantByToken(cleanKey);
  if (merch) {
    return {
      type: 'merchant',
      id: 'default',
      name: merch.merchant_name,
      apiKey: merch.token,
      capId,
      domain: merch.domain,
    };
  }

  // Serverless cold-start hydration via 256-bit HMAC capability lookup in Firestore
  const cloudCap = await hydrateCapabilityByApiKey(cleanKey);
  if (cloudCap) {
    return {
      type: 'workspace',
      id: cloudCap.workspaceId,
      name: cloudCap.name,
      apiKey: cloudCap.apiKey,
      capId,
    };
  }

  return null;
}

// =============================================================================
// 3. Authenticated User Session & Workspace Endpoints
// =============================================================================
app.get('/api/me', requireAuth, (req: Request, res: Response) => {
  const u = req.authUser!;
  const stats = getWorkspaceStats(u.workspace.id);

  res.json({
    status: 'success',
    uid: u.uid,
    email: u.email,
    name: u.name,
    is_admin: u.isAdmin,
    workspace: {
      id: u.workspace.id,
      name: u.workspace.name,
      api_key: u.workspace.api_key,
      owner_name: u.workspace.owner_name,
      created_at: u.workspace.created_at,
      accounts_count: stats.count,
      total_balance: stats.total_bal,
    },
  });
});

app.get('/api/workspaces', requireAuth, (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const stats = getWorkspaceStats(u.workspace.id);

    res.json({
      status: 'success',
      workspaces: [
        {
          id: u.workspace.id,
          name: u.workspace.name,
          api_key: u.workspace.api_key,
          owner_name: u.workspace.owner_name,
          created_at: u.workspace.created_at,
          accounts_count: stats.count,
          total_balance: stats.total_bal,
        },
      ],
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/workspaces/:id/rotate-key', requireAuth, async (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    if (req.params.id !== u.workspace.id) {
      res.status(403).json({ status: 'error', message: 'ခွင့်ပြုချက် မရှိပါ။' });
      return;
    }
    const rotated = rotateWorkspaceApiKey(u.workspace.id);
    if (!rotated) {
      res.status(404).json({ status: 'error', message: 'Workspace ရှာမတွေ့ပါ။' });
      return;
    }

    await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, {
      isAdmin: u.isAdmin,
      oldApiKeyToRevoke: rotated.oldKey,
    });

    logGatewayEvent('api_key_rotated', 'WARN', `API Key rotated for workspace ${u.workspace.id}`);
    res.json({ status: 'success', api_key: rotated.newKey });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// =============================================================================
// 4. Multi-Provider Wallet Accounts (WavePay, KBZPay, AYA Pay) & Multi-Step Login
// =============================================================================
app.get('/api/accounts', requireAuth, (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const rows = getAccountsByWorkspace(u.workspace.id);
    res.json(rows.map((r) => sanitizeAccountForClient(r, false)));
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/accounts', requireAuth, async (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const { phone, provider, model, os_version, name, nrc_id } = req.body;
    const prov = normalizeProvider(provider);
    const provLabel = formatProviderLabel(prov);
    const cleanPhone = cleanMsisdn(phone);

    if (!cleanPhone || !/^\d{7,12}$/.test(cleanPhone)) {
      res.status(400).json({
        status: 'error',
        message: `မှန်ကန်သော ${provLabel} ဖုန်းနံပါတ် ထည့်သွင်းပါ (ဥပမာ 09xxxxxxxxx)။`,
      });
      return;
    }

    const useModel = String(model || 'Pixel 6').trim().slice(0, 60);
    const useOs = String(os_version || '14').trim().slice(0, 20);

    const exists = getScopedAccount(cleanPhone, u.workspace.id, prov);
    if (exists && !exists.user_removed) {
      res.status(400).json({
        status: 'error',
        message: `${provLabel} ဖုန်းနံပါတ် 0${cleanPhone} သည် ထည့်သွင်းပြီးသား ဖြစ်ပါသည်။`,
      });
      return;
    }

    const generatedDeviceId = crypto.randomBytes(20).toString('hex');
    createAccount({
      phone: cleanPhone,
      provider: prov,
      workspace_id: u.workspace.id,
      owner_uid: u.uid,
      device_id: generatedDeviceId,
      model: useModel,
      os_version: useOs,
      name: name ? String(name).trim().slice(0, 80) : '',
      nrc_id: nrc_id ? String(nrc_id).trim().toUpperCase().slice(0, 60) : undefined,
    });

    await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, { isAdmin: u.isAdmin });

    logGatewayEvent(
      'account_added',
      'SUCCESS',
      `Registered ${provLabel} SIM 0${cleanPhone} in workspace ${u.workspace.id}`,
      {
        phone: cleanPhone,
        provider: prov,
        workspace_id: u.workspace.id,
      }
    );

    res.status(201).json({
      status: 'success',
      phone: cleanPhone,
      provider: prov,
      workspace_id: u.workspace.id,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.delete('/api/accounts/:phone', requireAuth, async (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const cleanPhone = cleanMsisdn(req.params.phone);
    const provider = normalizeProvider(req.query.provider || req.body?.provider);
    const provLabel = formatProviderLabel(provider);
    const removed = deleteAccountFromStore(cleanPhone, u.workspace.id, provider);

    if (!removed) {
      res.status(404).json({ status: 'error', message: 'အကောင့် ရှာမတွေ့ပါ။' });
      return;
    }

    await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, { isAdmin: u.isAdmin });

    logGatewayEvent('account_deleted', 'WARN', `Removed ${provLabel} SIM 0${cleanPhone}`, {
      phone: cleanPhone,
      provider,
    });
    res.json({ status: 'success', message: `${provLabel} အကောင့် 0${cleanPhone} ကို ဖယ်ရှားလိုက်ပါပြီ။` });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post(['/api/accounts/request-otp', '/api/accounts/login-otp'], requireAuth, async (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const acc = getScopedDecryptedAccount(req.body.phone, u, req.body.provider);
    if (!acc) {
      res.status(404).json({ status: 'error', message: 'အကောင့် ရှာမတွေ့ပါ။' });
      return;
    }

    const provider: WalletProvider = normalizeProvider(acc.provider);

    if (provider === 'kbz') {
      const engine = new KbzWalletEngine({
        phone: acc.phone,
        workspaceId: acc.workspace_id,
        deviceId: acc.device_id,
        model: acc.model,
        osVersion: acc.os_version,
        wmtMfs: acc.wmt_mfs,
        pin: acc.pin,
        nrcId: acc.nrc_id,
        name: acc.name,
        meta: acc.meta,
      });

      const otpRes = await engine.requestOtp();
      await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, { isAdmin: u.isAdmin });

      res.json({
        status: 'success',
        provider: 'kbz',
        next_step: 'kbz_credentials',
        message: otpRes.message,
      });
      return;
    }

    if (provider === 'aya') {
      const rawPwd = req.body.password || req.body.pin || acc.pin || '';
      const cleanPwd = translateMyanmarDigits(String(rawPwd).trim());

      const engine = new AyaWalletEngine({
        phone: acc.phone,
        workspaceId: acc.workspace_id,
        deviceId: acc.device_id,
        model: acc.model,
        osVersion: acc.os_version,
        wmtMfs: acc.wmt_mfs,
        pin: cleanPwd || acc.pin,
        name: acc.name,
        meta: acc.meta,
      });

      const otpRes = await engine.requestOtpWithPassword(cleanPwd);
      await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, { isAdmin: u.isAdmin });

      if (otpRes.already_authenticated) {
        const updatedAcc = getAccountByPhone(acc.phone, u.workspace.id, 'aya');
        res.json({
          status: 'success',
          provider: 'aya',
          authenticated: true,
          balance: updatedAcc?.balance ?? otpRes.balance ?? 0,
          name: updatedAcc?.name || '',
          message: otpRes.message,
        });
        return;
      }

      res.json({
        status: 'success',
        provider: 'aya',
        authenticated: false,
        next_step: 'aya_otp',
        message: otpRes.message,
      });
      return;
    }

    const engine = new WaveWalletEngine({
      phone: acc.phone,
      workspaceId: acc.workspace_id,
      deviceId: acc.device_id,
      model: acc.model,
      osVersion: acc.os_version,
      wmtMfs: acc.wmt_mfs,
      pin: acc.pin,
    });

    const otpResult = await engine.requestOtp();
    if (engine.wmtMfs && engine.wmtMfs !== acc.wmt_mfs) {
      await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, { isAdmin: u.isAdmin });
    }

    res.json({
      status: 'success',
      provider: 'wave',
      next_step: 'enter_otp',
      message: otpResult.message,
    });
  } catch (err: any) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

app.post('/api/accounts/verify-otp', requireAuth, async (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const otp = translateMyanmarDigits(String(req.body.otp || '').trim());
    if (!otp) {
      res.status(400).json({ status: 'error', message: 'ဖုန်းထဲသို့ SMS ဝင်လာသော OTP ကုဒ်ကို ရိုက်ထည့်ပါ။' });
      return;
    }

    const acc = getScopedDecryptedAccount(req.body.phone, u, req.body.provider);
    if (!acc) {
      res.status(404).json({ status: 'error', message: 'အကောင့် ရှာမတွေ့ပါ။' });
      return;
    }

    const provider: WalletProvider = normalizeProvider(acc.provider);

    if (provider === 'kbz') {
      const pin = translateMyanmarDigits(String(req.body.pin || acc.pin || '').trim());
      const nrc = String(req.body.nrc_id || req.body.nrc || acc.nrc_id || '').trim().toUpperCase();

      const engine = new KbzWalletEngine({
        phone: acc.phone,
        workspaceId: acc.workspace_id,
        deviceId: acc.device_id,
        model: acc.model,
        osVersion: acc.os_version,
        wmtMfs: acc.wmt_mfs,
        pin: pin || acc.pin,
        nrcId: nrc || acc.nrc_id,
        name: acc.name,
        meta: acc.meta,
      });

      const kbzRes = await engine.loginWithOtpPinNrc({
        otp,
        pin,
        nrc,
      });

      await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, { isAdmin: u.isAdmin });
      const updatedAcc = getAccountByPhone(acc.phone, u.workspace.id, 'kbz');

      res.json({
        status: 'success',
        provider: 'kbz',
        authenticated: kbzRes.authenticated,
        requires_qr: Boolean(kbzRes.requires_qr),
        qr_data_url: kbzRes.qr_data_url || undefined,
        balance: updatedAcc?.balance ?? 0,
        name: updatedAcc?.name || '',
        message: kbzRes.message,
      });
      return;
    }

    if (provider === 'aya') {
      const rawPwd = req.body.password || req.body.pin || acc.pin || '';
      const cleanPwd = translateMyanmarDigits(String(rawPwd).trim());

      const engine = new AyaWalletEngine({
        phone: acc.phone,
        workspaceId: acc.workspace_id,
        deviceId: acc.device_id,
        model: acc.model,
        osVersion: acc.os_version,
        wmtMfs: acc.wmt_mfs,
        pin: cleanPwd || acc.pin,
        name: acc.name,
        meta: acc.meta,
      });

      const ayaRes = await engine.verifyOtpAndLogin(otp, cleanPwd);
      await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, { isAdmin: u.isAdmin });
      const updatedAcc = getAccountByPhone(acc.phone, u.workspace.id, 'aya');

      res.json({
        status: 'success',
        provider: 'aya',
        authenticated: ayaRes.authenticated,
        awaiting_old_device: Boolean(ayaRes.awaiting_old_device),
        old_device_name: ayaRes.old_device_name || undefined,
        balance: updatedAcc?.balance ?? ayaRes.balance ?? 0,
        name: updatedAcc?.name || '',
        message: ayaRes.message,
      });
      return;
    }

    const engine = new WaveWalletEngine({
      phone: acc.phone,
      workspaceId: acc.workspace_id,
      deviceId: acc.device_id,
      model: acc.model,
      osVersion: acc.os_version,
      wmtMfs: acc.wmt_mfs,
      pin: acc.pin,
    });

    const result = await engine.confirmOtp(otp);
    await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, { isAdmin: u.isAdmin });

    res.json({
      status: 'success',
      provider: 'wave',
      message: 'OTP အတည်ပြုပြီးပါပြီ။ ဆက်လက်၍ Wave PIN ဖြင့် Login ဝင်ပါ။',
      verified: result.verified,
    });
  } catch (err: any) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

// Dedicated endpoint to complete KBZPay QR Scan or AYA Pay Old-Device Approval
app.post('/api/accounts/complete-device-auth', requireAuth, async (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const acc = getScopedDecryptedAccount(req.body.phone, u, req.body.provider);
    if (!acc) {
      res.status(404).json({ status: 'error', message: 'အကောင့် ရှာမတွေ့ပါ။' });
      return;
    }

    const provider: WalletProvider = normalizeProvider(acc.provider);

    if (provider === 'kbz') {
      const nrc = String(req.body.nrc_id || req.body.nrc || acc.nrc_id || '').trim().toUpperCase();
      const engine = new KbzWalletEngine({
        phone: acc.phone,
        workspaceId: acc.workspace_id,
        deviceId: acc.device_id,
        model: acc.model,
        osVersion: acc.os_version,
        wmtMfs: acc.wmt_mfs,
        pin: acc.pin,
        nrcId: nrc || acc.nrc_id,
        name: acc.name,
        meta: acc.meta,
      });

      const qrRes = await engine.completeQrVerification(nrc);
      await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, { isAdmin: u.isAdmin });
      const updatedAcc = getAccountByPhone(acc.phone, u.workspace.id, 'kbz');

      res.json({
        status: 'success',
        provider: 'kbz',
        authenticated: qrRes.authenticated,
        balance: updatedAcc?.balance ?? 0,
        name: updatedAcc?.name || '',
        message: qrRes.message,
      });
      return;
    }

    if (provider === 'aya') {
      const rawPwd = req.body.password || req.body.pin || acc.pin || '';
      const cleanPwd = translateMyanmarDigits(String(rawPwd).trim());

      const engine = new AyaWalletEngine({
        phone: acc.phone,
        workspaceId: acc.workspace_id,
        deviceId: acc.device_id,
        model: acc.model,
        osVersion: acc.os_version,
        wmtMfs: acc.wmt_mfs,
        pin: cleanPwd || acc.pin,
        name: acc.name,
        meta: acc.meta,
      });

      const ayaDone = await engine.completeOldDeviceLogin(cleanPwd);
      await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, { isAdmin: u.isAdmin });
      const updatedAcc = getAccountByPhone(acc.phone, u.workspace.id, 'aya');

      res.json({
        status: 'success',
        provider: 'aya',
        authenticated: ayaDone.authenticated,
        balance: updatedAcc?.balance ?? ayaDone.balance ?? 0,
        name: updatedAcc?.name || '',
        message: ayaDone.message,
      });
      return;
    }

    res.status(400).json({ status: 'error', message: 'WavePay အတွက် /api/accounts/login-pin ကို အသုံးပြုပါ။' });
  } catch (err: any) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

app.post('/api/accounts/login-pin', requireAuth, async (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const pin = translateMyanmarDigits(String(req.body.pin || '').trim());
    const otp = req.body.otp ? translateMyanmarDigits(String(req.body.otp).trim()) : '';

    const acc = getScopedDecryptedAccount(req.body.phone, u, req.body.provider);
    if (!acc) {
      res.status(404).json({ status: 'error', message: 'အကောင့် ရှာမတွေ့ပါ။' });
      return;
    }

    const provider: WalletProvider = normalizeProvider(acc.provider);

    if (provider === 'kbz') {
      const engine = new KbzWalletEngine({
        phone: acc.phone,
        workspaceId: acc.workspace_id,
        deviceId: acc.device_id,
        model: acc.model,
        osVersion: acc.os_version,
        wmtMfs: acc.wmt_mfs,
        pin: pin || acc.pin,
        nrcId: String(req.body.nrc_id || acc.nrc_id || '').trim().toUpperCase(),
        name: acc.name,
        meta: acc.meta,
      });

      const resKbz = req.body.complete_qr
        ? await engine.completeQrVerification(req.body.nrc_id)
        : await engine.loginWithOtpPinNrc({
            otp,
            pin: pin || acc.pin,
            nrc: String(req.body.nrc_id || acc.nrc_id || '').trim(),
          });

      await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, { isAdmin: u.isAdmin });
      const updated = getAccountByPhone(acc.phone, u.workspace.id, 'kbz');

      res.json({
        status: 'success',
        provider: 'kbz',
        phone: acc.phone,
        balance: updated?.balance ?? 0,
        name: updated?.name || '',
        has_session: resKbz.authenticated,
        requires_qr: Boolean((resKbz as any).requires_qr),
        qr_data_url: (resKbz as any).qr_data_url,
        message: resKbz.message,
      });
      return;
    }

    if (provider === 'aya') {
      const engine = new AyaWalletEngine({
        phone: acc.phone,
        workspaceId: acc.workspace_id,
        deviceId: acc.device_id,
        model: acc.model,
        osVersion: acc.os_version,
        wmtMfs: acc.wmt_mfs,
        pin: pin || acc.pin,
        name: acc.name,
        meta: acc.meta,
      });

      const resAya = await engine.completeOldDeviceLogin(pin || acc.pin);
      await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, { isAdmin: u.isAdmin });
      const updated = getAccountByPhone(acc.phone, u.workspace.id, 'aya');

      res.json({
        status: 'success',
        provider: 'aya',
        phone: acc.phone,
        balance: updated?.balance ?? resAya.balance,
        name: updated?.name || '',
        has_session: resAya.authenticated,
        message: resAya.message,
      });
      return;
    }

    const usePin = pin || acc.pin;
    if (!usePin) {
      res.status(400).json({ status: 'error', message: 'Wave PIN ထည့်သွင်းရန် လိုအပ်ပါသည်။' });
      return;
    }

    const engine = new WaveWalletEngine({
      phone: acc.phone,
      workspaceId: acc.workspace_id,
      deviceId: acc.device_id,
      model: acc.model,
      osVersion: acc.os_version,
      wmtMfs: acc.wmt_mfs,
      pin: usePin,
    });

    if (otp) {
      await engine.confirmOtp(otp);
    }

    const loginRes = await engine.loginWithPin(usePin);
    await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, { isAdmin: u.isAdmin });

    const updatedAcc = getAccountByPhone(acc.phone, u.workspace.id, 'wave');

    res.json({
      status: 'success',
      provider: 'wave',
      message: `WavePay အကောင့် 0${acc.phone} Login အောင်မြင်ပါသည်။`,
      phone: acc.phone,
      balance: updatedAcc?.balance ?? 0,
      name: updatedAcc?.name || '',
      has_session: loginRes.authenticated,
    });
  } catch (err: any) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

app.post('/api/accounts/sync-all', requireAuth, async (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const rawRows = getAccountsByWorkspace(u.workspace.id);
    const results: Array<{ phone: string; provider: WalletProvider; balance?: number; error?: string }> = [];

    for (const raw of rawRows) {
      const acc = readDecryptedAccount(raw);
      if (!acc?.wmt_mfs) continue;
      const engine = createWalletEngineForAccount(acc);
      try {
        const bal = await engine.getWalletBalance();
        results.push({ phone: acc.phone, provider: engine.provider, balance: bal });
      } catch (err: any) {
        results.push({ phone: acc.phone, provider: engine.provider, error: err.message });
      }
    }

    await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, { isAdmin: u.isAdmin });
    res.json({ status: 'success', results });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/accounts/:phone/sync', requireAuth, async (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const cleanPhone = cleanMsisdn(req.params.phone);
    const requestedWsId = String(req.query.workspace_id || req.body?.workspace_id || '').trim();
    const rawProv = req.query.provider || req.body?.provider;
    const prov = rawProv ? normalizeProvider(rawProv) : undefined;

    if (u.isAdmin) {
      await hydrateAllWorkspacesForAdmin(u.idToken);
    }

    const raw = u.isAdmin
      ? getAccountByPhone(cleanPhone, requestedWsId || undefined, prov)
      : getScopedAccount(cleanPhone, u.workspace.id, prov);

    if (!raw || (!u.isAdmin && raw.user_removed)) {
      res.status(404).json({ status: 'error', message: 'အကောင့် ရှာမတွေ့ပါ။' });
      return;
    }

    const acc = readDecryptedAccount(raw);
    const engine = createWalletEngineForAccount(acc);

    const balance = await engine.getWalletBalance();
    await persistWorkspaceToCloud(acc.workspace_id, acc.owner_uid || u.uid, u.idToken, { isAdmin: u.isAdmin });

    res.json({
      status: 'success',
      phone: acc.phone,
      provider: engine.provider,
      workspace_id: acc.workspace_id,
      balance,
    });
  } catch (err: any) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

app.post('/api/accounts/:phone/beneficiary', requireAuth, async (req: Request, res: Response) => {
  try {
    const targetMsisdn = cleanMsisdn(req.body.target_phone || req.body.msisdn);
    if (!targetMsisdn) {
      res.status(400).json({ status: 'error', message: 'စစ်ဆေးမည့် ဖုန်းနံပါတ် ထည့်သွင်းပါ။' });
      return;
    }

    const rawProv = req.body.provider || req.query.provider;
    const acc = getScopedDecryptedAccount(req.params.phone, req.authUser!, rawProv);
    if (!acc) {
      res.status(404).json({ status: 'error', message: 'အကောင့် ရှာမတွေ့ပါ။' });
      return;
    }

    const engine = createWalletEngineForAccount(acc);
    const beneficiaryName = await engine.checkBeneficiary(targetMsisdn);
    res.json({
      status: 'success',
      provider: engine.provider,
      msisdn: targetMsisdn,
      beneficiary_name: beneficiaryName,
    });
  } catch (err: any) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

app.get('/api/accounts/:phone/history', requireAuth, async (req: Request, res: Response) => {
  try {
    const limit = parseInt(String(req.query.limit || '15'), 10) || 15;
    const offset = parseInt(String(req.query.offset || '0'), 10) || 0;

    const acc = getScopedDecryptedAccount(req.params.phone, req.authUser!, req.query.provider);
    if (!acc) {
      res.status(404).json({ status: 'error', message: 'အကောင့် ရှာမတွေ့ပါ။' });
      return;
    }

    const engine = createWalletEngineForAccount(acc);
    const historyRes = await engine.getTransactionHistory(limit, offset);
    res.json({
      status: 'success',
      phone: acc.phone,
      provider: engine.provider,
      history: historyRes.items,
    });
  } catch (err: any) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

app.post(['/api/accounts/transfer', '/api/accounts/manual-transfer'], requireAuth, async (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const cleanRecv = cleanMsisdn(req.body.receiver_phone);
    const numAmount = Math.floor(Number(req.body.amount));
    const customPin = req.body.pin ? translateMyanmarDigits(String(req.body.pin).trim()) : undefined;
    const note = String(req.body.note || '').slice(0, 100);
    const rawProv = req.body.sender_provider || req.body.provider;

    if (!req.body.sender_phone || !cleanRecv || !Number.isFinite(numAmount) || numAmount <= 0) {
      res.status(400).json({ status: 'error', message: 'ပေးပို့သူ၊ လက်ခံသူ နှင့် ငွေပမာဏ မှန်ကန်စွာ ထည့်သွင်းပါ။' });
      return;
    }

    const sender = getScopedDecryptedAccount(req.body.sender_phone, u, rawProv);
    if (!sender) {
      res.status(404).json({ status: 'error', message: 'ပေးပို့မည့် အကောင့် မတွေ့ပါ။' });
      return;
    }

    const engine = createWalletEngineForAccount(sender, customPin);
    const transferResult = await engine.transfer(cleanRecv, numAmount, customPin || sender.pin, note);
    const updatedSender = getAccountByPhone(sender.phone, u.workspace.id, engine.provider);

    markTrxUsed({
      trx_id: transferResult.trxId,
      used_at: Date.now(),
      auth_token: 'manual_transfer',
      amount: numAmount,
      source: `p2p_transfer_${engine.provider}`,
    });

    await persistWorkspaceToCloud(u.workspace.id, u.uid, u.idToken, { isAdmin: u.isAdmin });

    logGatewayEvent(
      'transfer_executed',
      'SUCCESS',
      `${formatProviderLabel(engine.provider)} Transfer: ${numAmount.toLocaleString()} Ks from 0${sender.phone} to 0${cleanRecv}`,
      {
        provider: engine.provider,
        sender: sender.phone,
        receiver: cleanRecv,
        amount: numAmount,
        trx_id: transferResult.trxId,
      }
    );

    res.json({
      status: 'success',
      provider: engine.provider,
      trx_id: transferResult.trxId,
      receiver_name: transferResult.receiverName,
      sender_name: transferResult.senderName,
      amount: numAmount,
      sender: sender.phone,
      receiver: cleanRecv,
      sender_remaining: updatedSender?.balance ?? 0,
    });
  } catch (err: any) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

app.get('/api/transactions', requireAuth, (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const tokens = listAuthTokensByWorkspace(u.workspace.id, 50);
    res.json({ status: 'success', transactions: tokens });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Singleton warm Tesseract worker for fast server-side OCR fallback
let serverOcrWorkerPromise: Promise<any> | null = null;
let serverOcrQueue: Promise<unknown> = Promise.resolve();

async function recognizeReceiptBufferFast(imgBuffer: Buffer): Promise<string> {
  const execute = async () => {
    if (!serverOcrWorkerPromise) {
      serverOcrWorkerPromise = (async () => {
        try {
          const mod: any = await import('tesseract.js');
          const createWorkerFn = mod.createWorker || mod.default?.createWorker;
          const singleBlockPsm = mod.PSM?.SINGLE_BLOCK || mod.default?.PSM?.SINGLE_BLOCK || '6';
          const worker = await createWorkerFn(
            'eng',
            1,
            {
              cachePath: process.env.VERCEL ? os.tmpdir() : process.cwd(),
            },
            {
              load_system_dawg: '0',
              load_freq_dawg: '0',
            }
          );
          await worker.setParameters({
            tessedit_pageseg_mode: singleBlockPsm,
            preserve_interword_spaces: '1',
          });
          return worker;
        } catch (err) {
          serverOcrWorkerPromise = null;
          throw err;
        }
      })();
    }

    try {
      const worker = await serverOcrWorkerPromise;
      const result = await worker.recognize(
        imgBuffer,
        {},
        {
          text: true,
          blocks: false,
          hocr: false,
          tsv: false,
        }
      );
      return result?.data?.text || '';
    } catch (err) {
      serverOcrWorkerPromise = null;
      throw err;
    }
  };

  const next = serverOcrQueue.then(execute, execute);
  serverOcrQueue = next.catch(() => {});
  return next;
}

app.post('/api/ocr/receipt', requireAuth, async (req: Request, res: Response) => {
  try {
    const { image_base64, raw_text, exclude_phone } = req.body;
    let extractedRaw = String(raw_text || '');

    if (image_base64) {
      const base64Clean = String(image_base64).replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
      const imgBuffer = Buffer.from(base64Clean, 'base64');
      extractedRaw = await recognizeReceiptBufferFast(imgBuffer);
    }

    if (!extractedRaw.trim()) {
      res.status(400).json({
        status: 'error',
        message: 'ပြေစာပုံမှ စာသား ဖတ်ရှု၍မရပါ။ Transaction ID ကို ကိုယ်တိုင် ရိုက်ထည့်ပေးပါ။',
      });
      return;
    }

    const parsed = extractWaveReceiptInfo(extractedRaw, exclude_phone);

    res.json({
      status: 'success',
      trx_id: parsed.trx_id,
      last5_digits: parsed.last5_digits,
      extracted_amount: parsed.extracted_amount,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: `OCR Error: ${err.message}` });
  }
});

// =============================================================================
// 5. Public Merchant Payment Gateway REST API (WavePay, KBZPay, AYA Pay)
// =============================================================================
app.post(['/api/v1/deposit', '/api/request-deposit'], async (req: Request, res: Response) => {
  try {
    const optionalUser = await parseBearerUser(req).catch(() => null);
    const { amount, api_key, merchant_token, domain, provider: requestedProviderRaw } = req.body;
    const token = api_key || merchant_token;

    if (!amount || !token) {
      res.status(400).json({ status: 'error', message: 'amount နှင့် api_key လိုအပ်ပါသည်။' });
      return;
    }

    const numAmount = parseFloat(String(amount));
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      res.status(400).json({ status: 'error', message: 'ငွေပမာဏသည် 0 ထက် ကြီးရပါမည်။' });
      return;
    }

    const resolved = await resolveWorkspaceOrMerchantAsync(String(token));
    if (!resolved) {
      res.status(403).json({ status: 'error', message: 'API Key မမှန်ကန်ပါ။' });
      return;
    }

    const rawAccs = getAccountsByWorkspace(resolved.id);
    const allActiveAccs = rawAccs.map(readDecryptedAccount).filter((a) => Boolean(a?.wmt_mfs));

    const hasExplicitProvider =
      requestedProviderRaw !== undefined &&
      requestedProviderRaw !== null &&
      String(requestedProviderRaw).trim() !== '';
    const targetProv: WalletProvider | null = hasExplicitProvider
      ? normalizeProvider(requestedProviderRaw)
      : null;

    const validAccs = targetProv
      ? allActiveAccs.filter((a) => normalizeProvider(a.provider) === targetProv)
      : allActiveAccs;

    if (validAccs.length === 0) {
      const label = targetProv ? formatProviderLabel(targetProv) : 'Wallet';
      res.status(503).json({
        status: 'error',
        message: `ဤ Workspace တွင် Login ဝင်ထားသော ${label} အကောင့် မရှိသေးပါ။`,
      });
      return;
    }

    const assigned = validAccs[Math.floor(Math.random() * validAccs.length)];
    const assignedProv = normalizeProvider(assigned.provider);
    const now = Date.now();
    const expirySeconds = 15 * 60;
    const expiresAt = now + expirySeconds * 1000;

    // Issue stateless AES-256-GCM encrypted token so /api/v1/verify works across serverless cold starts
    const authToken = encodeStatelessToken('wtok_', {
      id: crypto.randomUUID(),
      type: 'deposit',
      provider: assignedProv,
      workspace_id: resolved.id,
      cap_id: resolved.capId,
      merchant_token: String(token),
      merchant_name: resolved.name,
      domain: domain || '*',
      amount: numAmount,
      phone_number: assigned.phone,
      created_at: now,
      expires_at: expiresAt,
    });

    upsertAuthToken({
      token: authToken,
      type: 'deposit',
      provider: assignedProv,
      workspace_id: resolved.id,
      merchant_token: String(token),
      merchant_name: resolved.name,
      domain: domain || '*',
      amount: numAmount,
      phone_number: assigned.phone,
      created_at: now,
      expires_at: expiresAt,
      status: 'pending',
    });

    if (optionalUser && optionalUser.workspace.id === resolved.id) {
      await persistWorkspaceToCloud(optionalUser.workspace.id, optionalUser.uid, optionalUser.idToken, {
        isAdmin: optionalUser.isAdmin,
      });
    }

    logGatewayEvent(
      'deposit_request',
      'INFO',
      `${formatProviderLabel(assignedProv)} Deposit initialized: ${numAmount.toLocaleString()} Ks -> 0${assigned.phone}`,
      {
        provider: assignedProv,
        amount: numAmount,
        workspace_id: resolved.id,
      }
    );

    res.json({
      status: 'success',
      provider: assignedProv,
      provider_label: formatProviderLabel(assignedProv),
      auth_token: authToken,
      phone_number: `0${assigned.phone}`,
      account_name: assigned.name || '',
      amount: numAmount,
      expires_in_seconds: expirySeconds,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post(['/api/v1/verify', '/api/verify-deposit'], async (req: Request, res: Response) => {
  try {
    const optionalUser = await parseBearerUser(req).catch(() => null);
    const { auth_token, trx_id, last5_digits, trx_id_last5 } = req.body;
    if (!auth_token) {
      res.status(400).json({ status: 'error', message: 'auth_token လိုအပ်ပါသည်။' });
      return;
    }

    const statelessMeta = decodeStatelessToken(String(auth_token));
    const statelessProv = normalizeProvider(statelessMeta?.provider);
    if (
      statelessMeta?.cap_id &&
      !getAccountByPhone(statelessMeta.phone_number || '', statelessMeta.workspace_id, statelessProv)
    ) {
      await hydrateCapabilityByCapId(statelessMeta.cap_id);
    }

    const tokenRecord = getAuthToken(String(auth_token), 'deposit');
    if (!tokenRecord) {
      res.status(404).json({ status: 'error', message: 'auth_token မမှန်ကန်ပါ။' });
      return;
    }

    const recordProvider = normalizeProvider(tokenRecord.provider);

    if (tokenRecord.status === 'success') {
      res.json({
        status: 'success',
        provider: recordProvider,
        amount: tokenRecord.amount,
        trx_id: tokenRecord.trx_id,
        already_verified: true,
      });
      return;
    }

    if (Date.now() > tokenRecord.expires_at) {
      upsertAuthToken({ ...tokenRecord, status: 'expired' });
      res.status(400).json({ status: 'error', message: 'Auth token သက်တမ်း (၁၅ မိနစ်) ကုန်ဆုံးသွားပါပြီ။' });
      return;
    }

    const fullTrxInput = trx_id ? translateMyanmarDigits(String(trx_id).trim()) : '';
    const rawLast5 = last5_digits || trx_id_last5 || (fullTrxInput ? fullTrxInput.slice(-5) : '');
    const normalizedLast5 = rawLast5 ? translateMyanmarDigits(String(rawLast5).trim()) : '';

    if (!fullTrxInput && !normalizedLast5) {
      res.status(400).json({
        status: 'error',
        message: 'Transaction ID သို့မဟုတ် နောက်ဆုံး ဂဏန်း ၅ လုံး ထည့်သွင်းပါ။',
      });
      return;
    }

    const rawAcc = getAccountByPhone(
      tokenRecord.phone_number || '',
      tokenRecord.workspace_id,
      recordProvider
    );
    const acc = readDecryptedAccount(rawAcc);
    if (!acc || !acc.wmt_mfs) {
      res.status(400).json({
        status: 'error',
        message: `လက်ခံအကောင့် (${formatProviderLabel(recordProvider)} 0${tokenRecord.phone_number}) Session သက်တမ်းကုန်နေပါသည်။`,
      });
      return;
    }

    const engine = createWalletEngineForAccount(acc);
    const historyRes = await engine.getTransactionHistory(20, 0);

    let matchedItem: any = null;
    for (const item of historyRes.items) {
      if (!item.transId) continue;

      const idMatches = fullTrxInput
        ? item.transId === fullTrxInput
        : item.transId.endsWith(normalizedLast5);

      const amountMatches = Math.abs(item.amount - tokenRecord.amount) < 0.01;
      const isIncoming = item.direction === 'CR';

      if (idMatches && amountMatches && isIncoming) {
        if (isTrxUsed(item.transId)) {
          res.status(400).json({
            status: 'error',
            message: `Transaction ID (${item.transId}) သည် အသုံးပြုပြီးသား ပြေစာဖြစ်နေပါသည်။ ထပ်မံအသုံးပြု၍ မရပါ။`,
          });
          return;
        }
        matchedItem = item;
        break;
      }
    }

    if (!matchedItem) {
      res.status(404).json({
        status: 'error',
        message: `${formatProviderLabel(engine.provider)} ငွေလက်ခံမှတ်တမ်းတွင် ပမာဏ ${tokenRecord.amount.toLocaleString()} Ks နှင့် Transaction ID (${fullTrxInput || normalizedLast5}) ကို ရှာမတွေ့ပါ။`,
      });
      return;
    }

    const now = Date.now();
    markTrxUsed({
      trx_id: matchedItem.transId,
      used_at: now,
      auth_token: String(auth_token),
      amount: tokenRecord.amount,
      source: `verify_deposit_${engine.provider}`,
    });

    upsertAuthToken({
      ...tokenRecord,
      provider: engine.provider,
      status: 'success',
      trx_id: matchedItem.transId,
      verified_at: now,
      last5_digits: matchedItem.transId.slice(-5),
    });

    try {
      await engine.getWalletBalance();
    } catch {
      // Non-fatal
    }

    if (optionalUser && optionalUser.workspace.id === tokenRecord.workspace_id) {
      await persistWorkspaceToCloud(optionalUser.workspace.id, optionalUser.uid, optionalUser.idToken, {
        isAdmin: optionalUser.isAdmin,
      });
    }

    logGatewayEvent(
      'deposit_verified',
      'SUCCESS',
      `${formatProviderLabel(engine.provider)} Deposit Verified: ${tokenRecord.amount.toLocaleString()} Ks (Trx: ${matchedItem.transId})`,
      {
        provider: engine.provider,
        trx_id: matchedItem.transId,
        amount: tokenRecord.amount,
      }
    );

    res.json({
      status: 'success',
      provider: engine.provider,
      amount: tokenRecord.amount,
      trx_id: matchedItem.transId,
      verified_at: new Date(now).toISOString(),
    });
  } catch (err: any) {
    logGatewayEvent('verify_error', 'ERROR', `Deposit verify error: ${err.message}`);
    res.status(400).json({ status: 'error', message: err.message });
  }
});

app.post('/api/request-withdraw', async (req: Request, res: Response) => {
  try {
    const optionalUser = await parseBearerUser(req).catch(() => null);
    const { amount, phone, merchant_token, api_key, provider: rawProv } = req.body;
    const token = api_key || merchant_token;
    if (!amount || !token) {
      res.status(400).json({ status: 'error', message: 'amount နှင့် api_key လိုအပ်ပါသည်။' });
      return;
    }

    const prov = normalizeProvider(rawProv);
    if (prov === 'aya') {
      res.status(400).json({
        status: 'error',
        message: 'AYA Pay သည် Auto-Withdraw (ငွေထုတ်လွှဲခြင်း) မပံ့ပိုးပါ။ WavePay သို့မဟုတ် KBZPay ကို ရွေးချယ်ပါ။',
      });
      return;
    }

    const numAmount = Math.floor(Number(amount));
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      res.status(400).json({ status: 'error', message: 'မှန်ကန်သော ငွေပမာဏ ထည့်သွင်းပါ။' });
      return;
    }

    const resolved = await resolveWorkspaceOrMerchantAsync(String(token));
    if (!resolved) {
      res.status(403).json({ status: 'error', message: 'Invalid API Key' });
      return;
    }

    const now = Date.now();
    const expirySeconds = 5 * 60;
    const expiresAt = now + expirySeconds * 1000;

    const withdrawToken = encodeStatelessToken('wd_', {
      id: crypto.randomUUID(),
      type: 'withdraw',
      provider: prov,
      workspace_id: resolved.id,
      cap_id: resolved.capId,
      merchant_token: String(token),
      merchant_name: resolved.name,
      amount: numAmount,
      receiver: phone || '',
      created_at: now,
      expires_at: expiresAt,
    });

    upsertAuthToken({
      token: withdrawToken,
      type: 'withdraw',
      provider: prov,
      workspace_id: resolved.id,
      merchant_token: String(token),
      merchant_name: resolved.name,
      domain: '*',
      amount: numAmount,
      receiver: phone || '',
      created_at: now,
      expires_at: expiresAt,
      status: 'authorized',
    });

    if (optionalUser && optionalUser.workspace.id === resolved.id) {
      await persistWorkspaceToCloud(optionalUser.workspace.id, optionalUser.uid, optionalUser.idToken, {
        isAdmin: optionalUser.isAdmin,
      });
    }

    res.json({
      status: 'success',
      provider: prov,
      withdraw_token: withdrawToken,
      amount: numAmount,
      expires_in_seconds: expirySeconds,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post(['/api/v1/withdraw', '/api/confirm-withdraw'], async (req: Request, res: Response) => {
  try {
    const optionalUser = await parseBearerUser(req).catch(() => null);
    const {
      api_key,
      merchant_token,
      amount,
      receiver_phone,
      receiver,
      withdraw_token,
      provider: rawProv,
    } = req.body;
    const token = api_key || merchant_token;
    let targetReceiver = cleanMsisdn(receiver_phone || receiver || '');
    let amountVal = Math.floor(Number(amount));
    let targetProvider: WalletProvider = normalizeProvider(rawProv);
    let resolved = token ? await resolveWorkspaceOrMerchantAsync(String(token)) : null;

    if (withdraw_token) {
      const statelessMeta = decodeStatelessToken(String(withdraw_token));
      if (statelessMeta?.cap_id && getAccountsByWorkspace(statelessMeta.workspace_id).length === 0) {
        await hydrateCapabilityByCapId(statelessMeta.cap_id);
      }

      const rec = getAuthToken(String(withdraw_token), 'withdraw');
      if (!rec) {
        res.status(404).json({ status: 'error', message: 'withdraw_token မမှန်ကန်ပါ။' });
        return;
      }
      if (Date.now() > rec.expires_at) {
        upsertAuthToken({ ...rec, status: 'expired' });
        res.status(400).json({ status: 'error', message: 'withdraw_token သက်တမ်း (၅ မိနစ်) ကုန်ဆုံးသွားပါပြီ။' });
        return;
      }
      if (rec.status === 'executed') {
        res.status(400).json({ status: 'error', message: 'ဤ withdraw_token ကို အသုံးပြုပြီးသား ဖြစ်ပါသည်။' });
        return;
      }
      amountVal = Math.floor(Number(rec.amount));
      if (!rawProv && rec.provider) {
        targetProvider = normalizeProvider(rec.provider);
      }
      if (!targetReceiver && rec.receiver) {
        targetReceiver = cleanMsisdn(rec.receiver);
      }
      if (!resolved) {
        resolved = {
          type: 'workspace',
          id: rec.workspace_id || 'default',
          name: rec.merchant_name || 'Gateway',
          apiKey: rec.merchant_token,
          capId: statelessMeta?.cap_id || computeCapabilityId(rec.merchant_token),
        };
      }
    } else if (!resolved) {
      res.status(403).json({ status: 'error', message: 'မှန်ကန်သော API Key လိုအပ်ပါသည်။' });
      return;
    }

    if (targetProvider === 'aya') {
      res.status(400).json({
        status: 'error',
        message: 'AYA Pay သည် Auto-Withdraw (ငွေထုတ်လွှဲခြင်း) မပံ့ပိုးပါ။ WavePay သို့မဟုတ် KBZPay ကို ရွေးချယ်ပါ။',
      });
      return;
    }

    if (!Number.isFinite(amountVal) || amountVal <= 0 || !targetReceiver) {
      res.status(400).json({ status: 'error', message: 'လက်ခံမည့် ဖုန်းနံပါတ် နှင့် ငွေပမာဏ လိုအပ်ပါသည်။' });
      return;
    }

    const provLabel = formatProviderLabel(targetProvider);
    const rawCandidates = getAccountsByWorkspace(resolved.id);
    const candidates = rawCandidates
      .map(readDecryptedAccount)
      .filter((a) => Boolean(a?.wmt_mfs && a?.pin && normalizeProvider(a.provider) === targetProvider));

    if (candidates.length === 0) {
      res.status(400).json({
        status: 'error',
        message: `ဤ Workspace တွင် Login နှင့် PIN သိမ်းဆည်းထားသော ${provLabel} အကောင့် မရှိသေးပါ။`,
      });
      return;
    }

    let bestAcc: any = null;
    let maxBalance = -1;

    for (const acc of candidates) {
      const engine = createWalletEngineForAccount(acc);
      try {
        const liveBal = await engine.getWalletBalance();
        if (liveBal > maxBalance) {
          maxBalance = liveBal;
          bestAcc = { ...acc, balance: liveBal };
        }
      } catch {
        // Skip expired accounts
      }
    }

    if (!bestAcc || maxBalance < amountVal) {
      res.status(400).json({
        status: 'error',
        message: `လက်ကျန်ငွေ လုံလောက်သော ${provLabel} အကောင့် မရှိပါ (လိုအပ်ငွေ: ${amountVal.toLocaleString()} Ks, အများဆုံးရှိငွေ: ${Math.max(0, maxBalance).toLocaleString()} Ks)။`,
      });
      return;
    }

    const disburseEngine = createWalletEngineForAccount(bestAcc);
    const transferRes = await disburseEngine.transfer(targetReceiver, amountVal, bestAcc.pin, 'Withdraw');
    const now = Date.now();
    const outToken = withdraw_token || 'wd_' + crypto.randomBytes(16).toString('hex');

    upsertAuthToken({
      token: outToken,
      type: 'withdraw',
      provider: targetProvider,
      workspace_id: resolved.id,
      merchant_token: resolved.apiKey,
      merchant_name: resolved.name,
      domain: '*',
      amount: amountVal,
      phone_number: bestAcc.phone,
      receiver: `0${targetReceiver}`,
      created_at: now,
      expires_at: now + 300_000,
      status: 'executed',
      trx_id: transferRes.trxId,
      executed_from: bestAcc.phone,
      verified_at: now,
    });

    markTrxUsed({
      trx_id: transferRes.trxId,
      used_at: now,
      auth_token: outToken,
      amount: amountVal,
      source: `auto_withdraw_${targetProvider}`,
    });

    if (optionalUser && optionalUser.workspace.id === resolved.id) {
      await persistWorkspaceToCloud(optionalUser.workspace.id, optionalUser.uid, optionalUser.idToken, {
        isAdmin: optionalUser.isAdmin,
      });
    }

    logGatewayEvent(
      'withdraw_disbursed',
      'SUCCESS',
      `${provLabel} Auto-Withdraw Disbursed: ${amountVal.toLocaleString()} Ks to 0${targetReceiver}`,
      {
        provider: targetProvider,
        trx_id: transferRes.trxId,
        amount: amountVal,
        receiver: targetReceiver,
      }
    );

    res.json({
      status: 'success',
      provider: targetProvider,
      amount: amountVal,
      receiver: `0${targetReceiver}`,
      receiver_name: transferRes.receiverName,
      disbursed_from: `0${bestAcc.phone}`,
      trx_id: transferRes.trxId,
    });
  } catch (err: any) {
    logGatewayEvent('withdraw_error', 'ERROR', `Withdraw failed: ${err.message}`);
    res.status(400).json({ status: 'error', message: err.message });
  }
});

// =============================================================================
// 6. Stealth Master Admin Endpoints (404 Not Found for all non-admins!)
// =============================================================================
app.get('/api/merchants', requireAdmin, (_req: Request, res: Response) => {
  try {
    res.json(listMerchants());
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/merchants', requireAdmin, async (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const { merchant_name, domain } = req.body;
    if (!merchant_name || !merchant_name.trim()) {
      res.status(400).json({ status: 'error', message: 'Merchant အမည် ထည့်သွင်းရန် လိုအပ်ပါသည်။' });
      return;
    }

    const merchant = createMerchant(merchant_name.trim(), domain?.trim() || '*');
    await persistWorkspaceToCloud('default', u.uid, u.idToken, { isAdmin: true });

    res.status(201).json({
      status: 'success',
      merchant,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.delete('/api/merchants/:token', requireAdmin, async (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const revokedToken = String(req.params.token || '').trim();
    deleteMerchant(revokedToken);
    await persistWorkspaceToCloud('default', u.uid, u.idToken, {
      isAdmin: true,
      oldApiKeyToRevoke: revokedToken,
    });
    res.json({ status: 'success', message: 'Merchant token revoked' });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/admin/overview', requireAdmin, (_req: Request, res: Response) => {
  try {
    const rawAccounts = listAllAccountsWithWorkspace();
    const accounts = rawAccounts.map((r) => sanitizeAccountForClient(r, true));
    const workspaces = listWorkspaces().map((w) => {
      const st = getWorkspaceStats(w.id, true);
      return {
        id: w.id,
        name: w.name,
        owner_uid: w.owner_uid,
        owner_email: w.owner_email,
        owner_name: w.owner_name,
        photo_url: w.photo_url || '',
        accounts_count: st.count,
        active_accounts_count: st.active_count,
        total_balance: st.total_bal,
        created_at: w.created_at,
      };
    });
    const merchants = listMerchants();
    const tokens = listAllAuthTokens(50);
    const logs = listGatewayLogs(80);
    const usedTrx = listUsedTrx(50);
    const totalBal = accounts.reduce((sum, a) => sum + (Number(a.balance) || 0), 0);

    res.json({
      status: 'success',
      overview: {
        total_balance: totalBal,
        total_accounts: accounts.length,
        active_accounts: accounts.filter((a) => Boolean(a.has_session)).length,
        total_workspaces: workspaces.length,
        total_merchants: merchants.length,
        total_transactions: tokens.length,
      },
      accounts,
      workspaces,
      merchants,
      tokens,
      logs,
      usedTrx,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/admin/db-search', requireAdmin, async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    const result = await searchCloudDatabaseForAdmin(req.authUser!.idToken, q);
    res.json({
      status: 'success',
      ...result,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/admin/transfer', requireAdmin, async (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const cleanSender = cleanMsisdn(req.body.sender_phone);
    const senderWsId = String(req.body.sender_workspace_id || '').trim() || undefined;
    const senderProvider = req.body.sender_provider
      ? normalizeProvider(req.body.sender_provider)
      : undefined;
    const cleanRecv = cleanMsisdn(req.body.receiver_phone);
    const numAmount = Math.floor(Number(req.body.amount));

    if (!cleanSender || !cleanRecv || !Number.isFinite(numAmount) || numAmount <= 0) {
      res.status(400).json({ status: 'error', message: 'Sender, receiver, နှင့် amount မှန်ကန်စွာ ထည့်သွင်းပါ။' });
      return;
    }

    const rawSender = getAccountByPhone(cleanSender, senderWsId, senderProvider);
    const sender = readDecryptedAccount(rawSender);
    if (!sender) {
      res.status(404).json({ status: 'error', message: 'ပေးပို့မည့် SIM အကောင့် ရှာမတွေ့ပါ။' });
      return;
    }
    const provLabel = formatProviderLabel(sender.provider);
    if (!sender.wmt_mfs || !sender.pin) {
      res.status(400).json({
        status: 'error',
        message: `${provLabel} SIM 0${cleanSender} သည် Session နှင့် PIN သိမ်းဆည်းထားခြင်း မရှိသေးပါ။`,
      });
      return;
    }

    const engine = createWalletEngineForAccount(sender);
    const transferResult = await engine.transfer(cleanRecv, numAmount, sender.pin, 'Transfer');
    const updatedSender = getAccountByPhone(cleanSender, sender.workspace_id, engine.provider);

    markTrxUsed({
      trx_id: transferResult.trxId,
      used_at: Date.now(),
      auth_token: 'admin_transfer',
      amount: numAmount,
      source: `admin_transfer_${engine.provider}`,
    });

    await persistWorkspaceToCloud(sender.workspace_id, sender.owner_uid || u.uid, u.idToken, { isAdmin: true });

    res.json({
      status: 'success',
      provider: engine.provider,
      trx_id: transferResult.trxId,
      receiver_name: transferResult.receiverName,
      amount: numAmount,
      sender: cleanSender,
      receiver: cleanRecv,
      sender_remaining: updatedSender?.balance ?? 0,
    });
  } catch (err: any) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

app.get('/api/admin/accounts/:phone/history', requireAdmin, async (req: Request, res: Response) => {
  try {
    const cleanPhone = cleanMsisdn(req.params.phone);
    const wsId = String(req.query.workspace_id || '').trim() || undefined;
    const prov = req.query.provider ? normalizeProvider(req.query.provider) : undefined;
    const limit = parseInt(String(req.query.limit || '15'), 10) || 15;
    const rawAcc = getAccountByPhone(cleanPhone, wsId, prov);
    const acc = readDecryptedAccount(rawAcc);
    if (!acc) {
      res.status(404).json({ status: 'error', message: 'အကောင့် ရှာမတွေ့ပါ။' });
      return;
    }

    const engine = createWalletEngineForAccount(acc);
    const historyRes = await engine.getTransactionHistory(limit, 0);
    res.json({
      status: 'success',
      phone: cleanPhone,
      provider: engine.provider,
      history: historyRes.items,
    });
  } catch (err: any) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

app.post('/api/admin/unblock-trx', requireAdmin, async (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    const { trx_id } = req.body;
    if (!trx_id) {
      res.status(400).json({ status: 'error', message: 'trx_id is required' });
      return;
    }
    unblockTrx(String(trx_id).trim());
    await persistWorkspaceToCloud('default', u.uid, u.idToken, { isAdmin: true });
    res.json({ status: 'success', message: `Transaction ID ${trx_id} unblocked` });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.delete('/api/admin/logs', requireAdmin, async (req: Request, res: Response) => {
  try {
    const u = req.authUser!;
    clearGatewayLogs();
    await persistWorkspaceToCloud('default', u.uid, u.idToken, { isAdmin: true });
    res.json({ status: 'success', message: 'Logs cleared' });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'online' });
});

app.all('/api/*', (_req: Request, res: Response) => {
  res.status(404).json({ status: 'error', message: 'Not found' });
});

export default app;
