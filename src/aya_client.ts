import crypto from 'crypto';
import {
  logGatewayEvent,
  updateAccountCredentials,
} from './db.js';
import type { TransactionHistoryItem } from './types.js';

// Server-only AYA Pay protocol constants — NEVER imported by client bundle
const AYA_HOST = (process.env.AYA_API_HOST || 'https://api.ayainnovation.com').replace(/\/+$/, '');
const AYA_BASIC_AUTH = 'Basic hQCOKs75uoYxakySqIA7qrjzdj2Z9PYn';
const AYA_APP_VERSION = '3.3.13';
const AYA_LANGUAGE = 'zh';
const AYA_SENTRY_PUBLIC_KEY = 'dc90897854163b60850b69daf43b68e6';
const AYA_SENTRY_ORG_ID = '1016539';

let cachedHttpClient: { fetch: (url: string, init?: any) => Promise<any> } | null = null;

async function getHttpClient(): Promise<{ fetch: (url: string, init?: any) => Promise<any> }> {
  if (cachedHttpClient) return cachedHttpClient;
  try {
    const { Impit } = await import('impit');
    cachedHttpClient = new Impit({
      browser: 'firefox',
      ignoreTlsErrors: true,
    });
    return cachedHttpClient;
  } catch {
    cachedHttpClient = {
      fetch: (url: string, init?: any) => fetch(url, init),
    };
    return cachedHttpClient;
  }
}

function randomAlnum(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[crypto.randomInt(0, chars.length)];
  }
  return out;
}

function generateMockFirebaseToken(): string {
  return `${randomAlnum(22)}:APA91b${randomAlnum(134)}`;
}

function sanitizeAyaMessage(msg: unknown, fallback: string): string {
  const raw = String(msg || '').trim();
  if (
    !raw ||
    raw.startsWith('<') ||
    /ayainnovation|sentry|okhttp|cloudflare|exception|stack/i.test(raw)
  ) {
    return fallback;
  }
  return raw.slice(0, 180);
}

function formatAyaDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

export class AyaWalletEngine {
  phone: string;
  phoneWithZero: string;
  workspaceId?: string;
  deviceId16: string;
  model: string;
  osVersion: string;
  bearerToken: string;
  password: string;
  firebaseToken: string;
  sentryTrace: string;
  baggage: string;
  profileName: string;
  meta: Record<string, any>;

  constructor(params: {
    phone: string;
    workspaceId?: string;
    deviceId: string;
    model: string;
    osVersion: string;
    wmtMfs?: string;
    pin?: string;
    name?: string;
    meta?: Record<string, any>;
  }) {
    this.phone = params.phone.trim().replace(/^0+/, '');
    this.phoneWithZero = `0${this.phone}`;
    this.workspaceId = params.workspaceId;
    this.meta = { ...(params.meta || {}) };

    const rawHex = String(params.deviceId || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    this.deviceId16 =
      this.meta.ayaDeviceId ||
      (rawHex.length >= 16 ? rawHex.slice(0, 16) : crypto.randomBytes(8).toString('hex'));
    this.model = params.model || 'Pixel 6';
    this.osVersion = String(params.osVersion || '14').replace(/\D/g, '') || '14';
    this.bearerToken = params.wmtMfs || '';
    this.password = params.pin || '';
    this.profileName = params.name || '';

    this.firebaseToken = String(this.meta.firebaseToken || generateMockFirebaseToken());
    const traceId = String(this.meta.traceId || crypto.randomBytes(16).toString('hex'));
    const spanId = String(this.meta.spanId || crypto.randomBytes(8).toString('hex'));
    this.sentryTrace = `${traceId}-${spanId}-1`;
    this.baggage = `sentry-environment=production,sentry-public_key=${AYA_SENTRY_PUBLIC_KEY},sentry-trace_id=${traceId},sentry-org_id=${AYA_SENTRY_ORG_ID}`;
    this.meta.traceId = traceId;
    this.meta.spanId = spanId;
  }

  private persistState(credUpdates: Record<string, any> = {}, extraMeta: Record<string, any> = {}) {
    this.meta = {
      ...this.meta,
      ayaDeviceId: this.deviceId16,
      firebaseToken: this.firebaseToken,
      ...extraMeta,
    };

    updateAccountCredentials(
      this.phone,
      {
        ...credUpdates,
        provider_meta: this.meta,
      },
      this.workspaceId,
      'aya'
    );
  }

  private getHeaders(useBearer: boolean): Record<string, string> {
    const authValue =
      useBearer && this.bearerToken
        ? this.bearerToken.startsWith('Bearer ')
          ? this.bearerToken
          : `Bearer ${this.bearerToken}`
        : AYA_BASIC_AUTH;

    return {
      'Content-Type': 'application/json;charset=utf-8',
      Version: AYA_APP_VERSION,
      'Accept-Language': AYA_LANGUAGE,
      Authorization: authValue,
      'Sentry-Trace': this.sentryTrace,
      Baggage: this.baggage,
      'User-Agent': 'okhttp/4.12.0',
    };
  }

  private async postJson(
    address: string,
    body: Record<string, any>,
    useBearer: boolean
  ): Promise<{ ok: boolean; status: number; data: any }> {
    const url = `${AYA_HOST}/${address.replace(/^\/+/, '')}`;
    try {
      const client = await getHttpClient();
      const response = await client.fetch(url, {
        method: 'POST',
        headers: this.getHeaders(useBearer),
        body: JSON.stringify(body),
      });

      const rawText = await response.text();
      let data: any = null;
      try {
        data = JSON.parse(rawText);
      } catch {
        data = null;
      }

      return {
        ok: response.ok,
        status: response.status,
        data,
      };
    } catch {
      throw new Error('AYA Pay ဆာဗာနှင့် ချိတ်ဆက်ရာတွင် ခေတ္တအခက်အခဲ ဖြစ်ပေါ်နေပါသည်။ ထပ်မံကြိုးစားပါ။');
    }
  }

  async requestOtpWithPassword(passwordInput?: string): Promise<{
    already_authenticated: boolean;
    message: string;
    balance?: number;
  }> {
    const usePassword = (passwordInput || this.password || '').trim();
    if (!usePassword || usePassword.length < 4) {
      throw new Error('AYA Pay PIN / Password (အနည်းဆုံး ၄ လုံး) ဦးစွာ ထည့်သွင်းပါ။');
    }
    this.password = usePassword;

    // 1. sendDeviceInfo
    const devRes = await this.postJson(
      '/api/user/sendDeviceInfo',
      {
        deviceId: this.deviceId16,
        deviceName: this.model,
        os: 'android',
        osVersion: this.osVersion,
        appVersion: AYA_APP_VERSION,
        firebaseToken: this.firebaseToken,
        lat: 0,
        long: 0,
      },
      false
    );

    if (devRes.data?.err !== 200) {
      throw new Error(
        sanitizeAyaMessage(devRes.data?.message, 'AYA Pay Device စာရင်းသွင်းမှု မအောင်မြင်ပါ။')
      );
    }

    // 2. checkPhone
    const phoneRes = await this.postJson(
      '/api/user/checkPhone',
      { phone: this.phoneWithZero },
      false
    );
    const phoneErr = Number(phoneRes.data?.err);
    if (phoneErr !== 200 && phoneErr !== 8004) {
      throw new Error(
        sanitizeAyaMessage(
          phoneRes.data?.message,
          `ဖုန်းနံပါတ် ${this.phoneWithZero} သည် AYA Pay အကောင့် မဟုတ်ပါ သို့မဟုတ် စစ်ဆေး၍ မရပါ။`
        )
      );
    }

    // 3. login (check PIN/password & check if device is already authorized)
    const loginRes = await this.postJson(
      '/api/user/login',
      {
        deviceId: this.deviceId16,
        phone: this.phoneWithZero,
        password: usePassword,
      },
      false
    );

    if (loginRes.data?.err !== 200) {
      throw new Error(
        sanitizeAyaMessage(loginRes.data?.message, 'AYA Pay PIN / Password မှားယွင်းနေပါသည်။')
      );
    }

    const immediateToken = loginRes.data?.token?.token;
    if (immediateToken) {
      this.bearerToken = String(immediateToken);
      const userName = String(
        loginRes.data?.profile?.name ||
          loginRes.data?.user?.name ||
          loginRes.data?.data?.name ||
          this.profileName ||
          ''
      );
      if (userName) this.profileName = userName;

      this.persistState({
        wmt_mfs: this.bearerToken,
        pin: usePassword,
        name: this.profileName || undefined,
        status: 'active',
      });

      const bal = await this.getWalletBalance().catch(() => 0);
      logGatewayEvent('aya_login_success', 'SUCCESS', `AYA Pay ${this.phoneWithZero} authenticated`);

      return {
        already_authenticated: true,
        balance: bal,
        message: `AYA Pay အကောင့် ${this.phoneWithZero} တိုက်ရိုက် Login အောင်မြင်ပါသည်။`,
      };
    }

    // 4. getDefaultSMS
    const smsRes = await this.postJson(
      '/api/user/getDefaultSMS',
      { phone: this.phoneWithZero },
      false
    );

    this.persistState({ pin: usePassword });

    if (smsRes.data?.err !== 200) {
      throw new Error(
        sanitizeAyaMessage(smsRes.data?.message, 'AYA Pay SMS OTP ပေးပို့၍ မရပါ။')
      );
    }

    logGatewayEvent('aya_otp_dispatched', 'SUCCESS', `AYA Pay SMS OTP dispatched to ${this.phoneWithZero}`);

    return {
      already_authenticated: false,
      message: `${this.phoneWithZero} သို့ AYA Pay SMS OTP ပေးပို့လိုက်ပါပြီ။ SMS ကုဒ်ကို ရိုက်ထည့်ပါ။`,
    };
  }

  async verifyOtpAndLogin(
    otpInput: string,
    passwordOverride?: string
  ): Promise<{
    authenticated: boolean;
    awaiting_old_device?: boolean;
    old_device_name?: string;
    balance?: number;
    message: string;
  }> {
    const cleanOtp = otpInput.trim();
    const usePassword = (passwordOverride || this.password || '').trim();

    if (!cleanOtp) {
      throw new Error('AYA Pay SMS OTP ကုဒ် ထည့်သွင်းပါ။');
    }
    if (!usePassword) {
      throw new Error('AYA Pay PIN / Password မတွေ့ပါ။ အစမှ ပြန်လည်ဝင်ရောက်ပါ။');
    }

    const verifyRes = await this.postJson(
      '/api/user/v2/loginVerifyOTP',
      {
        phone: this.phoneWithZero,
        otp: cleanOtp,
        deviceId: this.deviceId16,
        firebaseToken: this.firebaseToken,
      },
      false
    );

    if (verifyRes.data?.err !== 200) {
      throw new Error(
        sanitizeAyaMessage(verifyRes.data?.message, 'AYA Pay SMS OTP ကုဒ် မှားယွင်းနေပါသည်။')
      );
    }

    const profileName = String(verifyRes.data?.profile?.name || this.profileName || '');
    if (profileName) {
      this.profileName = profileName;
    }
    const oldDeviceName = String(verifyRes.data?.oldDeviceInfo?.deviceName || '');

    // Immediately attempt token login
    const loginRes = await this.postJson(
      '/api/user/login',
      {
        deviceId: this.deviceId16,
        phone: this.phoneWithZero,
        password: usePassword,
      },
      false
    );

    const tokenStr = loginRes.data?.token?.token;
    if (loginRes.data?.err === 200 && tokenStr) {
      this.bearerToken = String(tokenStr);
      this.password = usePassword;
      this.persistState({
        wmt_mfs: this.bearerToken,
        pin: usePassword,
        name: this.profileName || undefined,
        status: 'active',
      });

      const bal = await this.getWalletBalance().catch(() => 0);
      logGatewayEvent('aya_login_success', 'SUCCESS', `AYA Pay ${this.phoneWithZero} authenticated`);

      return {
        authenticated: true,
        balance: bal,
        message: `AYA Pay အကောင့် ${this.phoneWithZero} Login အောင်မြင်ပါသည်။`,
      };
    }

    this.persistState({
      pin: usePassword,
      name: this.profileName || undefined,
    });

    return {
      authenticated: false,
      awaiting_old_device: true,
      old_device_name: oldDeviceName || undefined,
      message: oldDeviceName
        ? `သင်၏ ဖုန်းအဟောင်း (${oldDeviceName}) ပေါ်ရှိ AYA Pay Notification တွင် New Device Login ကို Approve နှိပ်ပေးပြီးနောက် အောက်ပါ "Complete Login" ခလုတ်ကို နှိပ်ပါ။`
        : 'သင်၏ AYA Pay ဖုန်းအဟောင်းတွင် New Device Login Notification ကို Approve နှိပ်ပေးပြီးနောက် "Complete Login" ကိုနှိပ်ပါ။',
    };
  }

  async completeOldDeviceLogin(passwordOverride?: string): Promise<{
    authenticated: boolean;
    balance: number;
    message: string;
  }> {
    const usePassword = (passwordOverride || this.password || '').trim();
    if (!usePassword) {
      throw new Error('AYA Pay PIN / Password လိုအပ်ပါသည်။');
    }

    const loginRes = await this.postJson(
      '/api/user/login',
      {
        deviceId: this.deviceId16,
        phone: this.phoneWithZero,
        password: usePassword,
      },
      false
    );

    const tokenStr = loginRes.data?.token?.token;
    if (loginRes.data?.err !== 200 || !tokenStr) {
      throw new Error(
        sanitizeAyaMessage(
          loginRes.data?.message,
          'ဖုန်းအဟောင်းတွင် Approve မနှိပ်ရသေးပါ။ AYA Pay App ထဲတွင် ခွင့်ပြုချက် (Approve) ပေးပြီးမှ ထပ်နှိပ်ပါ။'
        )
      );
    }

    this.bearerToken = String(tokenStr);
    this.password = usePassword;
    this.persistState({
      wmt_mfs: this.bearerToken,
      pin: usePassword,
      name: this.profileName || undefined,
      status: 'active',
    });

    const bal = await this.getWalletBalance().catch(() => 0);
    logGatewayEvent('aya_login_success', 'SUCCESS', `AYA Pay ${this.phoneWithZero} device-approved`);

    return {
      authenticated: true,
      balance: bal,
      message: `AYA Pay အကောင့် ${this.phoneWithZero} Login အောင်မြင်ပါသည်။`,
    };
  }

  private async refreshBearerTokenSilently(): Promise<boolean> {
    if (!this.password) return false;
    try {
      const loginRes = await this.postJson(
        '/api/user/login',
        {
          deviceId: this.deviceId16,
          phone: this.phoneWithZero,
          password: this.password,
        },
        false
      );
      const tok = loginRes.data?.token?.token;
      if (loginRes.data?.err === 200 && tok) {
        this.bearerToken = String(tok);
        this.persistState({ wmt_mfs: this.bearerToken, status: 'active' });
        return true;
      }
    } catch {
      // Ignore silent refresh error
    }
    return false;
  }

  async getWalletBalance(): Promise<number> {
    if (!this.bearerToken) {
      throw new Error(`AYA Pay အကောင့် ${this.phoneWithZero} သည် Login မဝင်ရသေးပါ။`);
    }

    let res = await this.postJson('/api/user/getBalance', {}, true);
    if (res.data?.err !== 200 && (await this.refreshBearerTokenSilently())) {
      res = await this.postJson('/api/user/getBalance', {}, true);
    }

    if (res.data?.err !== 200) {
      updateAccountCredentials(this.phone, { status: 'expired' }, this.workspaceId, 'aya');
      throw new Error(
        sanitizeAyaMessage(res.data?.message, 'AYA Pay လက်ကျန်ငွေ စစ်ဆေး၍ မရပါ။')
      );
    }

    const balRaw = res.data?.data?.balance ?? 0;
    const parsedBal = parseFloat(String(balRaw));
    const safeBalance = Number.isFinite(parsedBal) ? parsedBal : 0;

    updateAccountCredentials(
      this.phone,
      { balance: safeBalance, status: 'active' },
      this.workspaceId,
      'aya'
    );

    return safeBalance;
  }

  async getTransactionHistory(limit: number = 20, offset: number = 0): Promise<{
    status: number;
    items: TransactionHistoryItem[];
  }> {
    if (!this.bearerToken) {
      throw new Error(`AYA Pay အကောင့် ${this.phoneWithZero} သည် Login မဝင်ရသေးပါ။`);
    }

    const clampedLimit = Math.max(1, Math.min(Math.floor(limit), 30));
    const clampedOffset = Math.max(0, Math.floor(offset));

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const payload = {
      pageParam: 0,
      start: clampedOffset,
      number: clampedLimit,
      startDate: formatAyaDate(sevenDaysAgo),
      endDate: formatAyaDate(tomorrow),
    };

    let res = await this.postJson('/api/transaction/transHistory', payload, true);
    if (res.data?.err !== 200 && (await this.refreshBearerTokenSilently())) {
      res = await this.postJson('/api/transaction/transHistory', payload, true);
    }

    if (res.data?.err !== 200) {
      throw new Error(
        sanitizeAyaMessage(res.data?.message, 'AYA Pay ငွေလွှဲမှတ်တမ်း ရယူ၍ မရပါ။')
      );
    }

    const rawList: any[] = Array.isArray(res.data?.data)
      ? res.data.data
      : Array.isArray(res.data?.data?.docs)
      ? res.data.data.docs
      : Array.isArray(res.data?.data?.list)
      ? res.data.data.list
      : Array.isArray(res.data?.transRecordList)
      ? res.data.transRecordList
      : [];

    const items: TransactionHistoryItem[] = [];
    for (const rec of rawList) {
      if (!rec || typeof rec !== 'object') continue;
      if (rec.status && String(rec.status).toLowerCase() !== 'done' && String(rec.status).toLowerCase() !== 'success') {
        continue;
      }

      const transId = String(rec.code || rec.orderId || rec._id || '');
      const credit = Number(rec.totalCredit || 0);
      const debit = Number(rec.totalDebit || 0);
      const rawAmt = Number(rec.amount ?? rec.origAmount ?? 0);
      const isCredit = credit > 0 || (credit === 0 && debit === 0 && String(rec.debitOrCredit || '').toUpperCase() === 'C');
      const direction: 'CR' | 'DR' = isCredit ? 'CR' : 'DR';
      const absAmt = Math.abs(credit > 0 ? credit : debit > 0 ? debit : rawAmt);

      const senderName = String(rec.sender?.name || rec.senderName || '').trim();
      const senderPhone = String(rec.sender?.phone || rec.senderPhone || '').trim();
      const receiverName = String(rec.receiver?.name || rec.receiverName || '').trim();
      const receiverPhone = String(rec.receiver?.phone || rec.receiverPhone || '').trim();

      const counterparty = isCredit
        ? [senderName, senderPhone].filter(Boolean).join(' ')
        : [receiverName, receiverPhone].filter(Boolean).join(' ');
      const baseTitle = String(rec.name || rec.tradeType || rec.historyTitle || 'AYA Pay Transaction');
      const rawTime = String(rec.processedAt || rec.createdAt || '');
      const formattedTime = rawTime ? rawTime.replace('T', ' ').replace(/\.\d+Z$/, '') : '';

      items.push({
        transId,
        amount: absAmt,
        direction,
        title: counterparty ? `${baseTitle} (${counterparty})` : baseTitle,
        time: formattedTime,
        senderPhone: senderPhone || undefined,
        receiverPhone: receiverPhone || undefined,
      });
    }

    return {
      status: 200,
      items,
    };
  }

  async checkBeneficiary(_msisdn: string): Promise<string> {
    throw new Error(
      'AYA Pay API တွင် အကောင့်အမည် ကြိုတင်စစ်ဆေးခြင်း နှင့် အလိုအလျောက် ငွေထုတ်လွှဲပြောင်းခြင်း မပါဝင်ပါ (Deposit/Verify နှင့် Balance/History သာ အသုံးပြုနိုင်ပါသည်)။'
    );
  }

  async transfer(
    _receiver: string,
    _amount: number | string,
    _pin?: string,
    _note: string = ''
  ): Promise<{ trxId: string; receiverName: string; senderName: string }> {
    throw new Error(
      'AYA Pay API သည် ငွေလက်ခံစစ်ဆေးခြင်း (Auto-Deposit / Receipt Verify) နှင့် Balance/History စစ်ဆေးခြင်းအတွက်သာ ဖြစ်ပါသည်။ Auto-Withdraw / P2P ငွေလွှဲရန် WavePay သို့မဟုတ် KBZPay အကောင့်ကို ရွေးချယ်ပါ။'
    );
  }
}
