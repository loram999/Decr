import crypto from 'crypto';
import {
  getAccountByPhone,
  logGatewayEvent,
  updateAccountCredentials,
} from './db.js';
import type { TransactionHistoryItem } from './types.js';

// Server-only upstream constants — NEVER imported by client bundle
const WAVE_HOST = (process.env.WAVE_API_HOST || 'https://api.wavemoney.io:8100').replace(/\/+$/, '');
const WMT_MFS_HEADER = 'wmt-mfs';
const FINGERPRINT = '87EC104C0FFBB8E749CD59D9C64851441B38D1C13C9746DC124BB9E71E66DCB9';
const APP_ID = 'mm.com.wavemoney.wavepay';
const USER_LANGUAGE = 'en';
const ACCEPT_ENCODING = 'gzip, deflate, br';
const VERSION_CODE = '1470';
const APP_VERSION = '2.6.1';
const DEFAULT_PRODUCT = 'redfin';
const DEFAULT_CPU_ABI = 'arm64-v8a,armeabi-v7a,armeabi';
const DEFAULT_MANUFACTURER = 'Google';

const RSA_PUBLIC_KEY_1 = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4fV3EhdFo6O6ujXcji4y
6GmhX8eXP6Of0SJSVp4AVQXj9Bbb5UKW0smu/wVhqBOSBpF9dfaJcCAhXOr9XDm5
aGZVEMQIJ1UM89MgYcvZ11zQ6z8mbq775X/8TUPun1L2Z+2oIc6fu5v0VKfjFo1J
2tuK+abF9C7EOcWClyAZFpo2GB+AYk3AcGTLJ8PcbH5A8KZesBVIitYb1uSASREJ
mvbeBSOyITpnLppXOui6RIba7Kc5KPvSJxJ270+SJxrg2t6CehoDAx1JW17q1VfC
OMVWewfwge8EkQ0DVwNy7p5z6a+1BoIEdweJn83/XluyMx6sWlbnwIJvc0i6vPTX
lwIDAQAB
-----END PUBLIC KEY-----`;

export function rsaEncryptPkcs1v15(plaintext: string, publicPem: string = RSA_PUBLIC_KEY_1): string {
  const encrypted = crypto.publicEncrypt(
    {
      key: publicPem,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(plaintext, 'utf-8')
  );
  return encrypted.toString('base64');
}

// Lazy-loaded Impit Firefox TLS client with graceful native fetch fallback for maximum serverless compatibility
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

function sanitizeUpstreamMessage(msg: unknown, fallback: string): string {
  const raw = String(msg || '').trim();
  if (!raw || raw.startsWith('<') || /wavemoney|8100|wmt-mfs|tnx-histories|cloudflare/i.test(raw)) {
    return fallback;
  }
  return raw.slice(0, 180);
}

function parseCounterpartyFromAction(actionRaw: any): string {
  if (!actionRaw) return '';
  try {
    const arr = typeof actionRaw === 'string' ? JSON.parse(actionRaw) : actionRaw;
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0];
      if (first?.value) {
        const prefix = first.label ? `${first.label} ` : '';
        return `${prefix}${first.value}`;
      }
    }
  } catch {
    // Ignore malformed action JSON
  }
  return '';
}

export class WaveWalletEngine {
  phone: string;
  workspaceId?: string;
  deviceId: string;
  model: string;
  osVersion: string;
  wmtMfs: string;
  pin: string;

  constructor(params: {
    phone: string;
    workspaceId?: string;
    deviceId: string;
    model: string;
    osVersion: string;
    wmtMfs?: string;
    pin?: string;
  }) {
    this.phone = params.phone.trim().replace(/^0+/, '');
    this.workspaceId = params.workspaceId;
    this.deviceId = params.deviceId;
    this.model = params.model;
    this.osVersion = String(params.osVersion);
    this.wmtMfs = params.wmtMfs || '';
    this.pin = params.pin || '';
  }

  private getHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    return {
      fingerprint: FINGERPRINT,
      appId: APP_ID,
      userLanguage: USER_LANGUAGE,
      'accept-encoding': ACCEPT_ENCODING,
      versionCode: VERSION_CODE,
      appVersion: APP_VERSION,
      deviceId: this.deviceId,
      device: `${this.model}(${this.model})`,
      product: DEFAULT_PRODUCT,
      cpuAbi: DEFAULT_CPU_ABI,
      manufacturer: DEFAULT_MANUFACTURER,
      model: this.model,
      osVersion: this.osVersion,
      [WMT_MFS_HEADER]: this.wmtMfs,
      ...extraHeaders,
    };
  }

  private async request(
    method: 'GET' | 'POST',
    endpoint: string,
    options: {
      params?: Record<string, string>;
      formBody?: Record<string, string>;
      jsonBody?: Record<string, any>;
      headers?: Record<string, string>;
    } = {}
  ): Promise<{ status: number; ok: boolean; headers: any; data: any; rawText: string }> {
    let url = `${WAVE_HOST}/${endpoint.replace(/^\/+/, '')}`;
    if (options.params) {
      const qs = new URLSearchParams(options.params).toString();
      if (qs) url += `?${qs}`;
    }

    const reqHeaders = this.getHeaders(options.headers || {});
    let body: string | undefined;

    if (options.formBody) {
      reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(options.formBody).toString();
    } else if (options.jsonBody) {
      reqHeaders['Content-Type'] = 'application/json';
      body = JSON.stringify(options.jsonBody);
    }

    try {
      const client = await getHttpClient();
      const response = await client.fetch(url, {
        method,
        headers: reqHeaders,
        body,
      });

      const newToken = response.headers.get(WMT_MFS_HEADER);
      if (newToken && newToken !== this.wmtMfs) {
        this.wmtMfs = newToken;
        this.saveTokenToDb(newToken);
      }

      const rawText = await response.text();
      let data: any = null;
      try {
        data = JSON.parse(rawText);
      } catch {
        data = null;
      }

      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        data,
        rawText,
      };
    } catch {
      throw new Error('ငွေပေးချေမှု ဆာဗာနှင့် ချိတ်ဆက်ရာတွင် ခေတ္တအခက်အခဲ ဖြစ်ပေါ်နေပါသည်။ ထပ်မံကြိုးစားပါ။');
    }
  }

  async requestOtp(): Promise<{ status: number; message: string }> {
    const res = await this.request('GET', 'v3/wmt-mfs-otp/generate-otp', {
      params: { msisdn: this.phone },
    });

    if (!res.ok) {
      const safeErr = sanitizeUpstreamMessage(
        res.data?.message,
        `SMS OTP တောင်းဆိုမှု မအောင်မြင်ပါ (Code ${res.status})`
      );
      logGatewayEvent('otp_request_failed', 'ERROR', `OTP request rejected for 0${this.phone}`, {
        phone: this.phone,
        status: res.status,
      });
      throw new Error(safeErr);
    }

    logGatewayEvent('otp_dispatched', 'SUCCESS', `SMS OTP dispatched to 0${this.phone}`, {
      phone: this.phone,
    });

    return {
      status: res.status,
      message: `0${this.phone} သို့ SMS OTP ပေးပို့လိုက်ပါပြီ။ ဖုန်းထဲသို့ ဝင်လာသော OTP ကုဒ်ကို ရိုက်ထည့်ပါ။`,
    };
  }

  async confirmOtp(otp: string): Promise<{ status: number; verified: boolean }> {
    const cleanOtp = otp.trim();
    if (!cleanOtp) {
      throw new Error('SMS OTP ကုဒ် ထည့်သွင်းရန် လိုအပ်ပါသည်။');
    }

    const res = await this.request('POST', 'v3/wmt-mfs-otp/confirm-otp', {
      formBody: {
        msisdn: this.phone,
        otp: cleanOtp,
      },
    });

    const headerTok = res.headers.get(WMT_MFS_HEADER);
    const bodyTok = res.data?.responseMap?.wmtMfs || res.data?.responseMap?.token || '';
    if (headerTok) {
      this.wmtMfs = headerTok;
      this.saveTokenToDb(headerTok);
    } else if (bodyTok) {
      this.wmtMfs = bodyTok;
      this.saveTokenToDb(bodyTok);
    }

    if (!res.ok) {
      const errMsg = sanitizeUpstreamMessage(
        res.data?.message,
        `OTP အတည်ပြုခြင်း မအောင်မြင်ပါ (Code ${res.status})`
      );
      logGatewayEvent('otp_confirm_failed', 'ERROR', `OTP confirm failed for 0${this.phone}`, {
        phone: this.phone,
        status: res.status,
      });
      throw new Error(errMsg);
    }

    logGatewayEvent('otp_confirmed', 'SUCCESS', `SMS OTP verified for 0${this.phone}`, {
      phone: this.phone,
    });

    return {
      status: res.status,
      verified: Boolean(this.wmtMfs),
    };
  }

  private async getSecurityToken(): Promise<string> {
    const res = await this.request('GET', 'v3/wmt-mfs-otp/security-token', {
      params: { msisdn: this.phone },
    });

    const counter = res.data?.responseMap?.securityCounter;
    if (!res.ok || !counter) {
      const errMsg = sanitizeUpstreamMessage(
        res.data?.message,
        `လုံခြုံရေး အတည်ပြုချက် ရယူ၍ မရပါ (Code ${res.status})`
      );
      throw new Error(errMsg);
    }
    return String(counter);
  }

  async loginWithPin(pin: string): Promise<{ status: number; authenticated: boolean }> {
    const cleanPin = pin.trim();
    if (!/^\d{4,6}$/.test(cleanPin)) {
      throw new Error('မှန်ကန်သော PIN နံပါတ် (၄ လုံး သို့မဟုတ် ၆ လုံး) ထည့်သွင်းပါ။');
    }

    const passwordCounter = await this.getSecurityToken();
    const pinCounter = await this.getSecurityToken();

    const encryptedPassword = rsaEncryptPkcs1v15(`${cleanPin}:${passwordCounter}`, RSA_PUBLIC_KEY_1);
    const encryptedPin = rsaEncryptPkcs1v15(`${cleanPin}:${pinCounter}`, RSA_PUBLIC_KEY_1);

    const res = await this.request('POST', 'v3/mfs-customer/login', {
      formBody: {
        msisdn: this.phone,
        password: encryptedPassword,
        pin: encryptedPin,
      },
    });

    const headerTok = res.headers.get(WMT_MFS_HEADER);
    const bodyTok = res.data?.responseMap?.wmtMfs || res.data?.responseMap?.token || '';
    if (headerTok) {
      this.wmtMfs = headerTok;
    } else if (bodyTok) {
      this.wmtMfs = bodyTok;
    }

    if (!res.ok) {
      const errMsg = sanitizeUpstreamMessage(
        res.data?.message,
        `PIN Login မအောင်မြင်ပါ (Code ${res.status})`
      );
      logGatewayEvent('pin_login_failed', 'ERROR', `PIN Login failed for 0${this.phone}`, {
        phone: this.phone,
        status: res.status,
      });
      throw new Error(errMsg);
    }

    this.pin = cleanPin;
    updateAccountCredentials(
      this.phone,
      {
        pin: cleanPin,
        wmt_mfs: this.wmtMfs,
        status: 'active',
      },
      this.workspaceId,
      'wave'
    );

    try {
      await this.getWalletBalance();
    } catch {
      // Optional immediate sync
    }

    try {
      const ownName = await this.checkBeneficiary(this.phone);
      if (ownName) {
        updateAccountCredentials(this.phone, { name: ownName }, this.workspaceId, 'wave');
      }
    } catch {
      // Optional name lookup
    }

    logGatewayEvent('account_login', 'SUCCESS', `Account 0${this.phone} authenticated`, {
      phone: this.phone,
    });

    return {
      status: res.status,
      authenticated: Boolean(this.wmtMfs),
    };
  }

  async getWalletBalance(): Promise<number> {
    if (!this.wmtMfs) {
      throw new Error(`အကောင့် 0${this.phone} သည် Login မဝင်ရသေးပါ။`);
    }

    const res = await this.request('GET', 'v2/mfs-customer/wallet-balance');
    if (!res.ok) {
      if (res.status === 401) {
        updateAccountCredentials(this.phone, { status: 'expired' }, this.workspaceId, 'wave');
      }
      throw new Error(
        sanitizeUpstreamMessage(res.data?.message, `လက်ကျန်ငွေ စစ်ဆေး၍ မရပါ (Code ${res.status})`)
      );
    }

    const balance = parseFloat(String(res.data?.responseMap?.balance ?? 0));
    const safeBalance = Number.isFinite(balance) ? balance : 0;
    this.updateBalanceInDb(safeBalance);
    return safeBalance;
  }

  async checkBeneficiary(msisdn: string): Promise<string> {
    if (!this.wmtMfs) {
      throw new Error(`အကောင့် 0${this.phone} သည် Login မဝင်ရသေးပါ။`);
    }

    const cleanMsisdn = msisdn.trim().replace(/^0+/, '');
    const res = await this.request('POST', 'v2/mfs-customer/check-mfs-beneficiary', {
      jsonBody: { msisdn: cleanMsisdn },
    });

    if (!res.ok) {
      throw new Error(
        sanitizeUpstreamMessage(res.data?.message, `အကောင့်အမည် စစ်ဆေး၍ မရပါ (Code ${res.status})`)
      );
    }

    const name = res.data?.responseMap?.name || '';
    if (!name) {
      throw new Error(`ဖုန်းနံပါတ် 0${cleanMsisdn} ၏ အကောင့်အမည်ကို ရှာမတွေ့ပါ။`);
    }
    return String(name);
  }

  async transfer(
    receiver: string,
    amount: number | string,
    pin?: string,
    note: string = ''
  ): Promise<{ trxId: string; receiverName: string; senderName: string }> {
    const usePin = (pin || this.pin || '').trim();
    if (!usePin) {
      throw new Error(`အကောင့် 0${this.phone} တွင် PIN သိမ်းဆည်းထားခြင်း မရှိပါ။`);
    }
    if (!this.wmtMfs) {
      throw new Error(`အကောင့် 0${this.phone} သည် Login မဝင်ရသေးပါ။`);
    }

    const cleanReceiver = receiver.trim().replace(/^0+/, '');
    const numericAmount = Math.floor(Number(amount));
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      throw new Error('မှန်ကန်သော ငွေပမာဏ ထည့်သွင်းပါ။');
    }

    const receiverName = await this.checkBeneficiary(cleanReceiver);
    const senderName = await this.checkBeneficiary(this.phone);
    const secToken = await this.getSecurityToken();
    const encPin = rsaEncryptPkcs1v15(`${usePin}:${secToken}`, RSA_PUBLIC_KEY_1);

    const res = await this.request('POST', 'v2/mfs-customer/send-money-ma', {
      formBody: {
        receiverName,
        senderName,
        receiverMsisdn: cleanReceiver,
        amount: String(numericAmount),
        pin: encPin,
        note,
      },
    });

    if (!res.ok) {
      const errMsg = sanitizeUpstreamMessage(
        res.data?.message,
        `ငွေလွှဲခြင်း မအောင်မြင်ပါ (Code ${res.status})`
      );
      logGatewayEvent('transfer_failed', 'ERROR', `Transfer failed from 0${this.phone} to 0${cleanReceiver}`, {
        sender: this.phone,
        receiver: cleanReceiver,
        amount: numericAmount,
        status: res.status,
      });
      throw new Error(errMsg);
    }

    const trxId = String(
      res.data?.responseMap?.transId ||
      res.data?.responseMap?.transactionId ||
      res.data?.transId ||
      `WM${Date.now()}`
    );

    try {
      await this.getWalletBalance();
    } catch {
      const current = getAccountByPhone(this.phone, this.workspaceId, 'wave');
      const nextBal = Math.max(0, (Number(current?.balance) || 0) - numericAmount);
      updateAccountCredentials(this.phone, { balance: nextBal }, this.workspaceId, 'wave');
    }

    return {
      trxId,
      receiverName,
      senderName,
    };
  }

  async getTransactionHistory(limit: number = 20, offset: number = 0): Promise<{
    status: number;
    items: TransactionHistoryItem[];
  }> {
    if (!this.wmtMfs) {
      throw new Error(`အကောင့် 0${this.phone} သည် Login မဝင်ရသေးပါ။`);
    }

    const clampedLimit = Math.max(1, Math.min(Math.floor(limit), 20));
    const clampedOffset = Math.max(0, Math.floor(offset));
    const referer = `${WAVE_HOST}/v2/wave-tnx-history/?mixpanel_source=Home+Screen`;

    const historyHeaders: Record<string, string> = {
      accept: '*/*',
      'content-type': 'application/json',
      referer,
      'accept-encoding': ACCEPT_ENCODING,
      origin: WAVE_HOST,
      'x-requested-with': APP_ID,
      [WMT_MFS_HEADER]: this.wmtMfs,
      fingerprint: FINGERPRINT,
      appId: APP_ID,
      deviceId: this.deviceId,
      model: this.model,
      osVersion: this.osVersion,
    };

    try {
      const client = await getHttpClient();
      const splashRes = await client.fetch(`${WAVE_HOST}/v2/wave-tnx-history/splash`, {
        method: 'GET',
        headers: historyHeaders,
      });

      const setCookieHeader = splashRes.headers.get('set-cookie') || '';
      const cfCookie = setCookieHeader
        .split(';')
        .map((part: string) => part.trim())
        .find((part: string) => part.startsWith('__cf_bm='));

      const historyUrl = `${WAVE_HOST}/merchant-app/tnxhistory-utility/v2/tnx-histories?limit=${clampedLimit}&offset=${clampedOffset}`;
      const response = await client.fetch(historyUrl, {
        method: 'GET',
        headers: {
          ...historyHeaders,
          ...(cfCookie ? { cookie: cfCookie } : {}),
        },
      });

      const rotatedToken = response.headers.get(WMT_MFS_HEADER);
      if (rotatedToken && rotatedToken !== this.wmtMfs) {
        this.wmtMfs = rotatedToken;
        this.saveTokenToDb(rotatedToken);
      }

      const rawText = await response.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = null;
      }

      if (!response.ok || !parsed) {
        if (response.status === 401) {
          updateAccountCredentials(this.phone, { status: 'expired' }, this.workspaceId, 'wave');
        }
        throw new Error(
          sanitizeUpstreamMessage(parsed?.message, `မှတ်တမ်း ရယူ၍ မရပါ (Code ${response.status})`)
        );
      }

      const rawList: any[] = parsed?.responseMap?.tnxHistoryList || [];
      const seenKeys = new Set<string>();
      const items: TransactionHistoryItem[] = [];

      for (const entry of rawList) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.status !== undefined && entry.status !== null && String(entry.status) !== '2') {
          continue;
        }

        const transId = String(entry.transId || entry.transactionId || entry.id || '');
        const signedAmt = parseFloat(String(entry.amount ?? entry.txnAmount ?? 0)) || 0;
        const absAmt = Math.abs(signedAmt);
        const isCredit =
          entry.perspective === 'RECEIVER' ||
          entry.direction === 'CR' ||
          signedAmt > 0;
        const direction: 'CR' | 'DR' = isCredit ? 'CR' : 'DR';

        const dedupeKey = `${transId}:${direction}:${absAmt}`;
        if (transId && seenKeys.has(dedupeKey)) continue;
        if (transId) seenKeys.add(dedupeKey);

        const counterparty = parseCounterpartyFromAction(entry.action);
        const baseTitle = entry.title || entry.serviceType || entry.transType || 'Transaction';

        items.push({
          transId,
          amount: absAmt,
          direction,
          title: counterparty ? `${baseTitle} (${counterparty})` : baseTitle,
          time: String(entry.transDate || entry.time || entry.txnDate || '').replace(/\.\d+$/, ''),
        });
      }

      return {
        status: response.status,
        items,
      };
    } catch (err: any) {
      throw new Error(
        sanitizeUpstreamMessage(err?.message, 'မှတ်တမ်း ရယူရာတွင် ခေတ္တအခက်အခဲ ဖြစ်ပေါ်နေပါသည်။')
      );
    }
  }

  private saveTokenToDb(token: string) {
    updateAccountCredentials(
      this.phone,
      {
        wmt_mfs: token,
        status: 'active',
      },
      this.workspaceId,
      'wave'
    );
  }

  private updateBalanceInDb(balance: number) {
    updateAccountCredentials(
      this.phone,
      {
        balance,
        status: 'active',
      },
      this.workspaceId,
      'wave'
    );
  }
}
