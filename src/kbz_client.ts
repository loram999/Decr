import crypto from 'crypto';
import QRCode from 'qrcode';
import { KBZ_KEY_PAIRS, KBZ_IV_PAIRS } from './kbz_keys.js';
import {
  getAccountByPhone,
  logGatewayEvent,
  updateAccountCredentials,
} from './db.js';
import type { TransactionHistoryItem } from './types.js';

// Server-only KBZPay protocol constants — NEVER imported by client bundle
const KBZ_HOST = (process.env.KBZ_API_HOST || 'https://app.kbzpay.com:9002').replace(/\/+$/, '');
const KBZ_PATH = '/api/interface/version1.3/customer';
const KBZ_APP_VERSION = '5.9.0';
const KBZ_OS_TYPE = 'Android';
const KBZ_LANGUAGE = 'zh';
const KBZ_DEVICE_VERSION = '30';

const KBZ_PIN_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAt/6qX9qc24RSBab/2t9K
8g2UXhxznT7OMH22WNENWULL4NO8zJtjk2dwekNgNGb57az62x3RPiPn1ontVp6r
wkAEBKdYcJfo3uEV1UVM/0OOJ3uqZJykXFIQlDGiPrBJShXeP2MYWRY6unE15BtX
dRA+Iq1GEuBYkaMjR5OD+KjgNtTXXkzhJNEyChJ+0my9hwGqm2bLvnDTMeoqRej/
6UOr5kDDyuY1MzDZiQCB3I6IAM30ycU65NGbWTgJSkRllzNR0+3bXYRK1PCKwceC
+fZJnSIuF2zRP4rU8/k6i0wOJRpy+lloHNgTUO1tLRKElg0pCAb7aeIZIDzmfVEg
YQIDAQAB
-----END PUBLIC KEY-----`;

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

function sanitizeKbzMessage(msg: unknown, fallback: string): string {
  const raw = String(msg || '').trim();
  if (
    !raw ||
    raw.startsWith('<') ||
    /kbzpay|9002|okhttp|cloudflare|exception|stack/i.test(raw)
  ) {
    return fallback;
  }
  return raw.slice(0, 180);
}

function sortTopLevelKeys(obj: Record<string, any>): Record<string, any> {
  const sorted: Record<string, any> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}

function encryptAesGcmBase64(plaintext: string, aesKeyB64: string, ivUtf8: string): string {
  const keyBuf = Buffer.from(aesKeyB64, 'base64');
  const ivBuf = Buffer.from(ivUtf8, 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, ivBuf);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([enc, authTag]).toString('base64');
}

function decryptAesGcmBase64(cipherB64: string, aesKeyB64: string, ivUtf8: string): string {
  const rawBuf = Buffer.from(cipherB64.trim(), 'base64');
  if (rawBuf.length < 16) {
    throw new Error('Invalid encrypted payload');
  }
  const tag = rawBuf.subarray(rawBuf.length - 16);
  const ct = rawBuf.subarray(0, rawBuf.length - 16);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(aesKeyB64, 'base64'),
    Buffer.from(ivUtf8, 'utf8')
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export class KbzWalletEngine {
  phone: string;
  phoneWithZero: string;
  workspaceId?: string;
  deviceId16: string;
  uuid: string;
  model: string;
  osVersion: string;
  token: string;
  guestToken: string;
  pin: string;
  nrcId: string;
  fullName: string;
  timeDiff: number;
  keyIdx: number;
  ivIdx: number;
  aesKey: string;
  aesKeyRSA: string;
  ivKey: string;
  ivKeyRSA: string;
  meta: Record<string, any>;

  constructor(params: {
    phone: string;
    workspaceId?: string;
    deviceId: string;
    model: string;
    osVersion: string;
    wmtMfs?: string;
    pin?: string;
    nrcId?: string;
    name?: string;
    meta?: Record<string, any>;
  }) {
    this.phone = params.phone.trim().replace(/^0+/, '');
    this.phoneWithZero = `0${this.phone}`;
    this.workspaceId = params.workspaceId;
    this.meta = { ...(params.meta || {}) };

    const rawHex = String(params.deviceId || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    this.deviceId16 =
      this.meta.deviceId16 ||
      (rawHex.length >= 16 ? rawHex.slice(0, 16) : crypto.randomBytes(8).toString('hex'));
    this.uuid = this.meta.uuid || crypto.randomUUID();
    this.model = params.model || 'Pixel 6';
    this.osVersion = String(params.osVersion || '13');

    this.token = params.wmtMfs || '';
    this.guestToken = String(this.meta.guestToken || '');
    this.pin = params.pin || '';
    this.nrcId = params.nrcId || '';
    this.fullName = params.name || String(this.meta.fullName || '');
    this.timeDiff = Number(this.meta.timeDiff) || 0;

    this.keyIdx =
      typeof this.meta.keyIdx === 'number' && this.meta.keyIdx >= 0 && this.meta.keyIdx < KBZ_KEY_PAIRS.length
        ? this.meta.keyIdx
        : crypto.randomInt(0, KBZ_KEY_PAIRS.length);
    this.ivIdx =
      typeof this.meta.ivIdx === 'number' && this.meta.ivIdx >= 0 && this.meta.ivIdx < KBZ_IV_PAIRS.length
        ? this.meta.ivIdx
        : crypto.randomInt(0, KBZ_IV_PAIRS.length);

    this.aesKey = KBZ_KEY_PAIRS[this.keyIdx].aesKey;
    this.aesKeyRSA = KBZ_KEY_PAIRS[this.keyIdx].aesKeyRSA;
    this.ivKey = KBZ_IV_PAIRS[this.ivIdx].ivKey;
    this.ivKeyRSA = KBZ_IV_PAIRS[this.ivIdx].ivKeyRSA;
  }

  private persistMeta(extraMeta: Record<string, any> = {}, credUpdates: Record<string, any> = {}) {
    this.meta = {
      ...this.meta,
      deviceId16: this.deviceId16,
      uuid: this.uuid,
      keyIdx: this.keyIdx,
      ivIdx: this.ivIdx,
      timeDiff: this.timeDiff,
      guestToken: this.guestToken,
      fullName: this.fullName,
      ...extraMeta,
    };

    updateAccountCredentials(
      this.phone,
      {
        ...credUpdates,
        provider_meta: this.meta,
      },
      this.workspaceId,
      'kbz'
    );
  }

  private encryptPin(pin: string, timestamp: string): string {
    const rand4 = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const rand2 = String(crypto.randomInt(0, 100)).padStart(2, '0');
    const pinUuid = crypto.randomUUID();
    const vaguePin = `01${rand4}06${timestamp}${pin}${pinUuid}${rand2}`;
    return crypto
      .publicEncrypt(
        {
          key: KBZ_PIN_PUBLIC_KEY,
          padding: crypto.constants.RSA_PKCS1_PADDING,
        },
        Buffer.from(vaguePin, 'utf8')
      )
      .toString('base64');
  }

  private getTemplateHeader(commandId: string, needNew: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'KBZPay-App-Type': 'customer',
      'KBZPay-Device-Type': 'Android',
      'KBZPay-Version': KBZ_APP_VERSION,
      'KBZPay-Command-Id': commandId,
      'User-Agent': 'okhttp/4.12.0',
    };
    if (needNew) {
      headers['MessageType'] = 'NEW';
    }
    return headers;
  }

  private getActiveToken(): string {
    return this.token || this.guestToken || '';
  }

  private getBodyTemplate1(overrideTimestamp?: string): { timestamp: string; [key: string]: any } {
    const timestamp = overrideTimestamp || String(Date.now() + this.timeDiff);
    return {
      deviceID: '',
      imei: this.deviceId16,
      encoding: 'unicode',
      language: KBZ_LANGUAGE,
      originatorConversationID: crypto.randomUUID(),
      platform: 'Android',
      token: this.getActiveToken(),
      version: KBZ_APP_VERSION,
      timestamp,
    };
  }

  private getBodyTemplate(overrideTimestamp?: string): { timestamp: string; [key: string]: any } {
    return {
      ...this.getBodyTemplate1(overrideTimestamp),
      brand: 'google',
      deviceModel: this.model,
      deviceToken: '',
      miPushRegisterId: '',
      networkMode: 'wifi',
      osVersion: `Android${this.osVersion.replace(/\D/g, '') || '13'}`,
      resolution: '2160x1080',
      supportGoogleService: 'false',
    };
  }

  private getBodyTemplateContainsHeaders(params: {
    commandId: string;
    body: Record<string, any>;
    timestamp?: string;
    useDynamicCaller?: boolean;
  }): Record<string, any> {
    const timestamp = params.timestamp || String(Date.now() + this.timeDiff);
    return {
      Request: {
        Header: {
          CommandID: params.commandId,
          ClientType: KBZ_OS_TYPE,
          Language: KBZ_LANGUAGE,
          Version: KBZ_APP_VERSION,
          OriginatorConversationID: crypto.randomUUID(),
          DeviceID: this.deviceId16,
          Imei: this.deviceId16,
          UseDynamicCaller: Boolean(params.useDynamicCaller),
          Token: this.getActiveToken(),
          DeviceVersion: KBZ_DEVICE_VERSION,
          KeyOwner: '',
          Timestamp: timestamp,
          Caller: {
            CallerType: '2',
            ThirdPartyID: '1',
            Password: '',
          },
        },
        Body: params.body,
      },
    };
  }

  private async post(params: {
    body: Record<string, any>;
    header: Record<string, string>;
    timestamp?: string;
  }): Promise<{ ok: boolean; status: number; isEncrypted: boolean; data: any }> {
    const timestamp = params.timestamp || String(Date.now() + this.timeDiff);
    const sortedBody = sortTopLevelKeys(params.body);
    const bodyContent = JSON.stringify(sortedBody);
    const signContent = timestamp + this.ivKey + bodyContent;
    const sign = crypto
      .createHmac('sha256', Buffer.from(this.aesKey, 'utf8'))
      .update(signContent, 'utf8')
      .digest('hex');
    const encryptBody = encryptAesGcmBase64(bodyContent, this.aesKey, this.ivKey);

    const headers: Record<string, string> = {
      ...params.header,
      Authorization: this.aesKeyRSA,
      IvKey: this.ivKeyRSA,
      Sign: sign,
      Timestamp: timestamp,
    };

    try {
      const client = await getHttpClient();
      const response = await client.fetch(`${KBZ_HOST}${KBZ_PATH}`, {
        method: 'POST',
        headers,
        body: encryptBody,
      });

      const isEncrypted =
        String(response.headers.get('isencrypt') || '').toLowerCase() === 'true';
      const rawText = await response.text();

      if (isEncrypted && rawText) {
        const decryptedStr = decryptAesGcmBase64(rawText, this.aesKey, this.ivKey);
        const data = JSON.parse(decryptedStr);
        return { ok: response.ok, status: response.status, isEncrypted: true, data };
      }

      let plainData: any = null;
      try {
        plainData = JSON.parse(rawText);
      } catch {
        plainData = null;
      }

      const errCode = plainData?.Response?.Body?.ResponseCode;
      if (errCode === 'AS403' || errCode === 'AS402') {
        updateAccountCredentials(this.phone, { status: 'expired' }, this.workspaceId, 'kbz');
      }

      return { ok: response.ok, status: response.status, isEncrypted: false, data: plainData };
    } catch {
      throw new Error('KBZPay ဆာဗာနှင့် ချိတ်ဆက်ရာတွင် ခေတ္တအခက်အခဲ ဖြစ်ပေါ်နေပါသည်။ ထပ်မံကြိုးစားပါ။');
    }
  }

  async requestOtp(): Promise<{ status: number; message: string }> {
    // 1. GuestLogin
    const ts1 = String(Date.now() + this.timeDiff);
    const guestRes = await this.post({
      body: {
        commandId: 'GuestLogin',
        deviceID: this.deviceId16,
        encoding: 'unicode',
        initiatorMSISDN: `Guest_${this.deviceId16}`,
        language: KBZ_LANGUAGE,
        originatorConversationID: this.uuid,
        platform: KBZ_OS_TYPE,
        timestamp: ts1,
        token: '',
        version: KBZ_APP_VERSION,
      },
      header: this.getTemplateHeader('GuestLogin', true),
      timestamp: ts1,
    });

    if (!guestRes.isEncrypted || guestRes.data?.responseCode !== '0' || !guestRes.data?.guestToken) {
      const desc = sanitizeKbzMessage(
        guestRes.data?.responseDesc || guestRes.data?.Response?.Body?.ResponseDesc,
        'KBZPay Guest Session ရယူ၍ မရပါ။ ထပ်မံကြိုးစားပါ။'
      );
      throw new Error(desc);
    }

    this.guestToken = String(guestRes.data.guestToken);
    if (guestRes.data.serverTimestamp) {
      this.timeDiff = Number(guestRes.data.serverTimestamp) - Date.now();
    }

    // 2. QueryLoginMode
    const qBody = {
      ...this.getBodyTemplate(),
      commandId: 'QueryLoginMode',
      initiatorMSISDN: this.phoneWithZero,
    };
    await this.post({
      body: qBody,
      header: this.getTemplateHeader('QueryLoginMode', true),
      timestamp: qBody.timestamp,
    });

    // 3. SMSVerificationCode
    const smsTs = String(Date.now() + this.timeDiff);
    const smsRes = await this.post({
      body: this.getBodyTemplateContainsHeaders({
        commandId: 'SMSVerificationCode',
        timestamp: smsTs,
        body: {
          Identity: {
            Initiator: {
              Identifier: this.phoneWithZero,
              IdentifierType: '1',
            },
            ReceiverParty: {
              Identifier: this.phoneWithZero,
              IdentifierType: '1',
            },
          },
        },
      }),
      header: this.getTemplateHeader('SMSVerificationCode', false),
      timestamp: smsTs,
    });

    const smsCode = smsRes.data?.Response?.Body?.ResponseCode;
    const serverTs = smsRes.data?.Response?.Body?.ResponseDetail?.ServerTimestamp;
    if (serverTs) {
      this.timeDiff = Number(serverTs) - Date.now();
    }

    this.persistMeta();

    if (smsCode !== '0') {
      const desc = sanitizeKbzMessage(
        smsRes.data?.Response?.Body?.ResponseDesc,
        'KBZPay SMS OTP တောင်းဆိုမှု မအောင်မြင်ပါ။'
      );
      logGatewayEvent('kbz_otp_failed', 'ERROR', `KBZPay OTP request failed for ${this.phoneWithZero}`);
      throw new Error(desc);
    }

    logGatewayEvent('kbz_otp_dispatched', 'SUCCESS', `KBZPay SMS OTP dispatched to ${this.phoneWithZero}`);

    return {
      status: 200,
      message: `${this.phoneWithZero} သို့ KBZPay SMS OTP ပေးပို့လိုက်ပါပြီ။ OTP, PIN နှင့် မှတ်ပုံတင် (NRC) တို့ကို ရိုက်ထည့်ပါ။`,
    };
  }

  private async callLoginForSmsCode(otp: string, businessUniqueId?: string): Promise<any> {
    const body: Record<string, any> = {
      ...this.getBodyTemplate(),
      commandId: 'LoginForSmsCode',
      homeConfigVersion: '',
      myServiceVersion: '',
      smsCode: otp,
      initiatorMSISDN: this.phoneWithZero,
      useLiveDB: false,
    };
    if (businessUniqueId) {
      body.businessUniqueId = businessUniqueId;
    }

    const res = await this.post({
      body,
      header: this.getTemplateHeader('LoginForSmsCode', true),
      timestamp: body.timestamp,
    });

    if (!res.isEncrypted || !res.data) {
      const desc = sanitizeKbzMessage(
        res.data?.Response?.Body?.ResponseDesc,
        'KBZPay Login အတည်ပြု၍ မရပါ။'
      );
      throw new Error(desc);
    }

    return res.data;
  }

  private async callRiskVerifyPin(businessUniqueId: string, pin: string): Promise<any> {
    const bodyTemp = this.getBodyTemplate1();
    const ts = bodyTemp.timestamp;
    const encryptedPin = this.encryptPin(pin, ts);

    const res = await this.post({
      body: {
        ...bodyTemp,
        commandId: 'RiskControlCheckVerifyPin',
        businessUniqueId,
        initiatorMSISDN: this.phoneWithZero,
        initiatorPin: encryptedPin,
        useDynamicCaller: 'true',
      },
      header: this.getTemplateHeader('RiskControlCheckVerifyPin', true),
      timestamp: ts,
    });

    if (!res.isEncrypted || !res.data) {
      throw new Error('KBZPay PIN စစ်ဆေးမှု မအောင်မြင်ပါ။');
    }
    return res.data;
  }

  private async callRiskVerifyNrc(businessUniqueId: string, nrc: string): Promise<any> {
    const bodyTemp = this.getBodyTemplate1();
    const res = await this.post({
      body: {
        ...bodyTemp,
        commandId: 'RiskControlCheckVerifyNrc',
        businessUniqueId,
        initiatorMSISDN: this.phoneWithZero,
        idNumber: nrc.trim().toUpperCase(),
        idType: '01',
      },
      header: this.getTemplateHeader('RiskControlCheckVerifyNrc', true),
      timestamp: bodyTemp.timestamp,
    });

    if (!res.isEncrypted || !res.data) {
      throw new Error('KBZPay မှတ်ပုံတင် (NRC) စစ်ဆေးမှု မအောင်မြင်ပါ။');
    }
    return res.data;
  }

  private async callIdentityVerification(nrc: string): Promise<void> {
    if (!nrc.trim()) return;
    const ts = String(Date.now() + this.timeDiff);
    await this.post({
      body: this.getBodyTemplateContainsHeaders({
        commandId: 'IdentityVerification',
        timestamp: ts,
        body: {
          RequestDetail: {
            Encoding: 'unicode',
            IDType: '01',
            IdNo: nrc.trim().toUpperCase(),
            isLiveDb: false,
          },
          Identity: {
            Initiator: {
              Identifier: this.phoneWithZero,
              IdentifierType: '1',
            },
            ReceiverParty: {
              Identifier: this.phoneWithZero,
              IdentifierType: '1',
            },
          },
        },
      }),
      header: this.getTemplateHeader('IdentityVerification', false),
      timestamp: ts,
    }).catch(() => {});
  }

  async loginWithOtpPinNrc(params: {
    otp: string;
    pin: string;
    nrc?: string;
  }): Promise<{
    authenticated: boolean;
    requires_qr?: boolean;
    qr_data_url?: string;
    qr_raw?: string;
    message: string;
  }> {
    const cleanOtp = params.otp.trim();
    const cleanPin = params.pin.trim();
    const cleanNrc = (params.nrc || this.nrcId || '').trim().toUpperCase();

    if (!cleanOtp) {
      throw new Error('KBZPay SMS OTP ကုဒ် ထည့်သွင်းပါ။');
    }
    if (!/^\d{6}$/.test(cleanPin)) {
      throw new Error('KBZPay 6-digit PIN နံပါတ် မှန်ကန်စွာ ထည့်သွင်းပါ။');
    }

    const firstLogin = await this.callLoginForSmsCode(cleanOtp);
    if (firstLogin.responseCode !== '0') {
      throw new Error(
        sanitizeKbzMessage(firstLogin.responseDesc, 'KBZPay OTP ကုဒ် မှားယွင်းနေပါသည်။')
      );
    }

    const directTok = firstLogin.token || firstLogin.userInfo?.token || '';
    const businessUniqueId = String(firstLogin.businessUniqueId || '');

    // Fast path: already trusted device, token issued immediately
    if (directTok && !businessUniqueId) {
      this.token = String(directTok);
      this.pin = cleanPin;
      if (cleanNrc) this.nrcId = cleanNrc;
      const fetchedName = String(firstLogin.userInfo?.fullName || firstLogin.fullName || this.fullName || '');
      if (fetchedName) this.fullName = fetchedName;

      this.persistMeta(
        { businessUniqueId: '', qrSerialNo: '', pendingOtp: '' },
        {
          wmt_mfs: this.token,
          pin: this.pin,
          nrc_id: cleanNrc || undefined,
          name: this.fullName || undefined,
          status: 'active',
        }
      );

      if (cleanNrc) {
        await this.callIdentityVerification(cleanNrc);
      }
      await this.getWalletBalance().catch(() => {});

      logGatewayEvent('kbz_login_success', 'SUCCESS', `KBZPay ${this.phoneWithZero} authenticated`);
      return {
        authenticated: true,
        message: `KBZPay အကောင့် ${this.phoneWithZero} Login အောင်မြင်ပါသည်။`,
      };
    }

    if (!businessUniqueId) {
      throw new Error('KBZPay Login Session မရရှိပါ။ SMS OTP အသစ်ပြန်တောင်း၍ ကြိုးစားပါ။');
    }

    // Risk Control Step 1: Verify PIN
    const pinData = await this.callRiskVerifyPin(businessUniqueId, cleanPin);
    if (pinData.responseCode !== '0' || String(pinData.isCorrect) !== 'true') {
      throw new Error(
        sanitizeKbzMessage(pinData.responseDesc, 'KBZPay PIN နံပါတ် မှားယွင်းနေပါသည်။')
      );
    }

    let isFinish = String(pinData.isFinish || '') === 'true';
    const nextVerifyType = String(pinData.nextVerifyType || '').toUpperCase();

    // Risk Control Step 2: Verify NRC if requested
    if (!isFinish && (nextVerifyType === 'NRC' || cleanNrc)) {
      if (!cleanNrc && nextVerifyType === 'NRC') {
        throw new Error(
          'KBZPay Device အသစ်အတည်ပြုရန် မှတ်ပုံတင်အမှတ် (NRC — ဥပမာ 12/OUKAMA(N)123456) ထည့်သွင်းပေးပါ။'
        );
      }
      if (cleanNrc) {
        const nrcData = await this.callRiskVerifyNrc(businessUniqueId, cleanNrc);
        if (nrcData.responseCode === '0') {
          if (String(nrcData.isFinish || '') === 'true') {
            isFinish = true;
          }
        } else if (nextVerifyType === 'NRC') {
          throw new Error(
            sanitizeKbzMessage(nrcData.responseDesc, 'မှတ်ပုံတင်အမှတ် (NRC) မှားယွင်းနေပါသည်။')
          );
        }
      }
    }

    // If Risk Control finished after PIN (+ NRC), finalize LoginForSmsCode with businessUniqueId
    if (isFinish) {
      const finalLogin = await this.callLoginForSmsCode(cleanOtp, businessUniqueId);
      const issuedTok = finalLogin.token || finalLogin.userInfo?.token || '';
      if (finalLogin.responseCode !== '0' || !issuedTok) {
        throw new Error(
          sanitizeKbzMessage(finalLogin.responseDesc, 'KBZPay Token ထုတ်ယူ၍ မရပါ။')
        );
      }

      this.token = String(issuedTok);
      this.pin = cleanPin;
      if (cleanNrc) this.nrcId = cleanNrc;
      const fetchedName = String(finalLogin.userInfo?.fullName || finalLogin.fullName || this.fullName || '');
      if (fetchedName) this.fullName = fetchedName;

      this.persistMeta(
        { businessUniqueId: '', qrSerialNo: '', pendingOtp: '' },
        {
          wmt_mfs: this.token,
          pin: this.pin,
          nrc_id: cleanNrc || undefined,
          name: this.fullName || undefined,
          status: 'active',
        }
      );

      if (cleanNrc) {
        await this.callIdentityVerification(cleanNrc);
      }
      await this.getWalletBalance().catch(() => {});

      logGatewayEvent('kbz_login_success', 'SUCCESS', `KBZPay ${this.phoneWithZero} authenticated`);
      return {
        authenticated: true,
        message: `KBZPay အကောင့် ${this.phoneWithZero} Login အောင်မြင်ပါသည်။`,
      };
    }

    // Risk Control Step 3: Device Verification QR Code required (RiskGetVerifyQRCodes)
    const qrBody = {
      ...this.getBodyTemplate1(),
      commandId: 'RiskGetVerifyQRCodes',
      businessUniqueId,
      initiatorMSISDN: this.phoneWithZero,
      serialNo: '',
    };
    const qrRes = await this.post({
      body: qrBody,
      header: this.getTemplateHeader('RiskGetVerifyQRCodes', true),
      timestamp: qrBody.timestamp,
    });

    const qrData = qrRes.data;
    const qrRaw = String(qrData?.qrCodes?.[0]?.qrCode || '');
    const serialNo = String(qrData?.serialNo || '');

    if (!qrRes.isEncrypted || qrData?.responseCode !== '0' || !qrRaw) {
      throw new Error(
        sanitizeKbzMessage(
          qrData?.responseDesc,
          'KBZPay Device Verification လိုအပ်နေပါသည်။ NRC အမှတ်အပြည့်အစုံ ထည့်သွင်း၍ ထပ်မံကြိုးစားပါ။'
        )
      );
    }

    const qrDataUrl = await QRCode.toDataURL(qrRaw, {
      margin: 2,
      width: 240,
      color: { dark: '#000000', light: '#FFFFFF' },
    });

    this.pin = cleanPin;
    if (cleanNrc) this.nrcId = cleanNrc;
    this.persistMeta(
      {
        businessUniqueId,
        qrSerialNo: serialNo,
        pendingOtp: cleanOtp,
      },
      {
        pin: cleanPin,
        nrc_id: cleanNrc || undefined,
      }
    );

    return {
      authenticated: false,
      requires_qr: true,
      qr_data_url: qrDataUrl,
      qr_raw: qrRaw,
      message:
        'KBZPay App ဖွင့်ထားသော ဖုန်းအဟောင်းဖြင့် ဤ QR Code ကို Scan ဖတ်၍ အတည်ပြုပြီးနောက် "Complete QR Verification" ကိုနှိပ်ပါ။',
    };
  }

  async completeQrVerification(nrcOverride?: string): Promise<{ authenticated: boolean; message: string }> {
    const businessUniqueId = String(this.meta.businessUniqueId || '');
    const serialNo = String(this.meta.qrSerialNo || '');
    const pendingOtp = String(this.meta.pendingOtp || '');
    const cleanNrc = (nrcOverride || this.nrcId || '').trim().toUpperCase();

    if (!businessUniqueId || !pendingOtp) {
      throw new Error('QR Verification Session မတွေ့ပါ။ OTP အသစ်ပြန်တောင်း၍ ကြိုးစားပါ။');
    }

    const finishBody = {
      ...this.getBodyTemplate1(),
      commandId: 'RiskFinishVerifyQRCode',
      businessUniqueId,
      initiatorMSISDN: this.phoneWithZero,
      serialNo,
    };
    const finishRes = await this.post({
      body: finishBody,
      header: this.getTemplateHeader('RiskFinishVerifyQRCode', true),
      timestamp: finishBody.timestamp,
    });

    if (!finishRes.isEncrypted || finishRes.data?.responseCode !== '0') {
      throw new Error(
        sanitizeKbzMessage(
          finishRes.data?.responseDesc,
          'QR Code Scan အတည်ပြုချက် မပြီးမြောက်သေးပါ။ ဖုန်းအဟောင်းတွင် Scan ဖတ်ပြီးမှ ထပ်နှိပ်ပါ။'
        )
      );
    }

    if (String(finishRes.data?.nextVerifyType || '').toUpperCase() === 'NRC' && cleanNrc) {
      const nrcData = await this.callRiskVerifyNrc(businessUniqueId, cleanNrc);
      if (nrcData.responseCode !== '0') {
        throw new Error(
          sanitizeKbzMessage(nrcData.responseDesc, 'မှတ်ပုံတင်အမှတ် (NRC) အတည်ပြု၍ မရပါ။')
        );
      }
    }

    const finalLogin = await this.callLoginForSmsCode(pendingOtp, businessUniqueId);
    const issuedTok = finalLogin.token || finalLogin.userInfo?.token || '';
    if (finalLogin.responseCode !== '0' || !issuedTok) {
      throw new Error(
        sanitizeKbzMessage(finalLogin.responseDesc, 'KBZPay Login Token ရယူ၍ မရပါ။')
      );
    }

    this.token = String(issuedTok);
    const fetchedName = String(finalLogin.userInfo?.fullName || finalLogin.fullName || this.fullName || '');
    if (fetchedName) this.fullName = fetchedName;

    this.persistMeta(
      { businessUniqueId: '', qrSerialNo: '', pendingOtp: '' },
      {
        wmt_mfs: this.token,
        nrc_id: cleanNrc || undefined,
        name: this.fullName || undefined,
        status: 'active',
      }
    );

    if (cleanNrc) {
      await this.callIdentityVerification(cleanNrc);
    }
    await this.getWalletBalance().catch(() => {});

    logGatewayEvent('kbz_login_success', 'SUCCESS', `KBZPay ${this.phoneWithZero} QR-authenticated`);

    return {
      authenticated: true,
      message: `KBZPay အကောင့် ${this.phoneWithZero} Login အောင်မြင်ပါသည်။`,
    };
  }

  async getWalletBalance(): Promise<number> {
    if (!this.token) {
      throw new Error(`KBZPay အကောင့် ${this.phoneWithZero} သည် Login မဝင်ရသေးပါ။`);
    }

    const ts = String(Date.now() + this.timeDiff);
    const res = await this.post({
      body: this.getBodyTemplateContainsHeaders({
        commandId: 'QueryCustomerBalance',
        timestamp: ts,
        body: {
          RequestDetail: {
            Encoding: 'unicode',
            QueryBalanceFlag: 'false',
            isLiveDb: false,
          },
          Identity: {
            Initiator: {
              Identifier: this.phoneWithZero,
              IdentifierType: '1',
            },
            ReceiverParty: {
              Identifier: this.phoneWithZero,
              IdentifierType: '1',
            },
          },
        },
      }),
      header: this.getTemplateHeader('QueryCustomerBalance', false),
      timestamp: ts,
    });

    const respCode = res.data?.Response?.Body?.ResponseCode;
    if (!res.isEncrypted || respCode !== '0') {
      throw new Error(
        sanitizeKbzMessage(
          res.data?.Response?.Body?.ResponseDesc,
          'KBZPay လက်ကျန်ငွေ စစ်ဆေး၍ မရပါ (Session သက်တမ်းကုန်နေနိုင်ပါသည်)။'
        )
      );
    }

    const rawBal = res.data?.Response?.Body?.ResponseDetail?.Balance ?? 0;
    const parsedBal = parseFloat(String(rawBal));
    const safeBalance = Number.isFinite(parsedBal) ? parsedBal : 0;

    updateAccountCredentials(
      this.phone,
      { balance: safeBalance, status: 'active' },
      this.workspaceId,
      'kbz'
    );

    return safeBalance;
  }

  async checkBeneficiary(msisdn: string): Promise<string> {
    if (!this.token) {
      throw new Error(`KBZPay အကောင့် ${this.phoneWithZero} သည် Login မဝင်ရသေးပါ။`);
    }

    const cleanTarget = `0${msisdn.trim().replace(/^\+?95/, '').replace(/^0+/, '')}`;
    const ts = String(Date.now() + this.timeDiff);

    const res = await this.post({
      body: this.getBodyTemplateContainsHeaders({
        commandId: 'GetUserInfo',
        timestamp: ts,
        body: {
          RequestDetail: {
            Encoding: 'unicode',
            Msisdn: cleanTarget,
            isLiveDb: false,
          },
          Identity: {
            Initiator: {
              Identifier: this.phoneWithZero,
              IdentifierType: '1',
            },
            ReceiverParty: {
              Identifier: this.phoneWithZero,
              IdentifierType: '1',
            },
          },
        },
      }),
      header: this.getTemplateHeader('GetUserInfo', false),
      timestamp: ts,
    });

    const body = res.data?.Response?.Body;
    const detail = body?.ResponseDetail;
    if (!res.isEncrypted || body?.ResponseCode !== '0' || detail?.ResultCode !== '0') {
      throw new Error(
        sanitizeKbzMessage(
          body?.ResponseDesc || detail?.ResultDesc,
          `KBZPay ဖုန်းနံပါတ် ${cleanTarget} ကို အတည်ပြု၍ မရပါ။`
        )
      );
    }

    const resolvedName =
      detail?.UserName ||
      detail?.FullName ||
      detail?.CustomerName ||
      detail?.Name ||
      detail?.NickName ||
      `KBZPay (${cleanTarget})`;

    return String(resolvedName);
  }

  private async historyPinCheckIdentity(usePin: string): Promise<boolean> {
    if (!usePin) return false;
    const bodyTemp = this.getBodyTemplate1();
    const ts = bodyTemp.timestamp;
    const encryptedPin = this.encryptPin(usePin, ts);

    const res = await this.post({
      body: {
        ...bodyTemp,
        commandId: 'HistoryPinCheckIdentity',
        businessScenario: 'history',
        initiatorMSISDN: this.phoneWithZero,
        initiatorPin: encryptedPin,
        useDynamicCaller: 'true',
      },
      header: this.getTemplateHeader('HistoryPinCheckIdentity', true),
      timestamp: ts,
    });

    return Boolean(res.isEncrypted && res.data?.responseCode === '0' && String(res.data?.isCorrect) === 'true');
  }

  private async fetchRawRecordList(startNum: number, count: number): Promise<any> {
    const bodyTemp = this.getBodyTemplate1();
    const res = await this.post({
      body: {
        ...bodyTemp,
        startNum,
        count,
        needTotalAmount: startNum !== 0,
        filterTypes: [],
        isHomePage: 'false',
        commandId: 'NewTransRecordList',
        initiatorMSISDN: this.phoneWithZero,
        direction: '',
        toDate: 0,
        fromDate: 0,
        maxAmount: '',
        minAmount: '',
        oppositeMsisdn: '',
        oppositePartyId: '',
        oppositeShortCode: '',
      },
      header: this.getTemplateHeader('NewTransRecordList', true),
      timestamp: bodyTemp.timestamp,
    });

    if (!res.isEncrypted || !res.data || res.data.responseCode !== '0') {
      throw new Error(
        sanitizeKbzMessage(
          res.data?.responseDesc || res.data?.Response?.Body?.ResponseDesc,
          'KBZPay ငွေလွှဲမှတ်တမ်း ရယူ၍ မရပါ။'
        )
      );
    }

    return res.data;
  }

  async getTransactionHistory(limit: number = 20, offset: number = 0): Promise<{
    status: number;
    items: TransactionHistoryItem[];
  }> {
    if (!this.token) {
      throw new Error(`KBZPay အကောင့် ${this.phoneWithZero} သည် Login မဝင်ရသေးပါ။`);
    }

    const clampedLimit = Math.max(1, Math.min(Math.floor(limit), 20));
    const clampedOffset = Math.max(0, Math.floor(offset));

    let data = await this.fetchRawRecordList(clampedOffset, clampedLimit);
    if (String(data?.needVerifyPin) === 'true' && this.pin) {
      await this.historyPinCheckIdentity(this.pin);
      data = await this.fetchRawRecordList(clampedOffset, clampedLimit);
    }

    const rawRecords: any[] = Array.isArray(data?.transRecordList) ? data.transRecordList : [];
    const items: TransactionHistoryItem[] = [];

    for (const rec of rawRecords) {
      if (!rec || typeof rec !== 'object') continue;
      const transId = String(rec.orderId || '');
      const absAmt = Math.abs(Number(rec.amount ?? rec.totalAmount ?? 0));
      const direction: 'CR' | 'DR' = String(rec.debitOrCredit || '').toUpperCase() === 'C' ? 'CR' : 'DR';
      const opposite = String(rec.oppositeName || '').trim();
      const baseTitle = String(rec.historyTitle || rec.tradeType || 'KBZPay Transfer').trim();
      const tradeTimeMs = Number(rec.tradeTime || 0);
      const timeStr =
        tradeTimeMs > 0
          ? new Date(tradeTimeMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
          : '';

      items.push({
        transId,
        amount: absAmt,
        direction,
        title: opposite && !baseTitle.includes(opposite) ? `${baseTitle} (${opposite})` : baseTitle,
        time: timeStr,
      });
    }

    return {
      status: 200,
      items,
    };
  }

  async transfer(
    receiver: string,
    amount: number | string,
    pin?: string,
    note: string = ''
  ): Promise<{ trxId: string; receiverName: string; senderName: string }> {
    const usePin = (pin || this.pin || '').trim();
    if (!usePin) {
      throw new Error(`KBZPay အကောင့် ${this.phoneWithZero} တွင် PIN သိမ်းဆည်းထားခြင်း မရှိပါ။`);
    }
    if (!this.token) {
      throw new Error(`KBZPay အကောင့် ${this.phoneWithZero} သည် Login မဝင်ရသေးပါ။`);
    }

    const cleanReceiverNoZero = receiver.trim().replace(/^\+?95/, '').replace(/^0+/, '');
    const receiverWithZero = `0${cleanReceiverNoZero}`;
    const numericAmount = Math.floor(Number(amount));
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      throw new Error('မှန်ကန်သော ငွေပမာဏ ထည့်သွင်းပါ။');
    }

    const receiverName = await this.checkBeneficiary(receiverWithZero);
    const transNote = note.trim() || 'Transfer';

    // Primary KBZPay TransferToAccount protocol (returns OrderNo directly)
    const ts = String(Date.now() + this.timeDiff);
    const encryptedPin = this.encryptPin(usePin, ts);

    const res = await this.post({
      body: this.getBodyTemplateContainsHeaders({
        commandId: 'TransferToAccount',
        timestamp: ts,
        useDynamicCaller: true,
        body: {
          RequestDetail: {
            Amount: String(numericAmount),
            Encoding: 'unicode',
            FromName: this.fullName || this.phoneWithZero,
            ReceiverType: '1',
            TransNote: transNote,
            isLiveDb: false,
          },
          Identity: {
            Initiator: {
              Identifier: this.phoneWithZero,
              IdentifierType: '1',
              SecurityCredential: encryptedPin,
            },
            ReceiverParty: {
              Identifier: receiverWithZero,
              IdentifierType: '1',
            },
          },
        },
      }),
      header: this.getTemplateHeader('TransferToAccount', false),
      timestamp: ts,
    });

    const respBody = res.data?.Response?.Body;
    if (res.isEncrypted && respBody?.ResponseCode === '0') {
      const orderNo = String(respBody?.ResponseDetail?.OrderNo || `KBZ${Date.now()}`);
      await this.getWalletBalance().catch(() => {
        const cur = getAccountByPhone(this.phone, this.workspaceId, 'kbz');
        const nextBal = Math.max(0, (Number(cur?.balance) || 0) - numericAmount);
        updateAccountCredentials(this.phone, { balance: nextBal }, this.workspaceId, 'kbz');
      });

      return {
        trxId: orderNo,
        receiverName,
        senderName: this.fullName || this.phoneWithZero,
      };
    }

    // Fallback: PreCheckout.TransferToAccount + PayOrder.TransferToAccount
    const preBody = {
      ...this.getBodyTemplate1(),
      amount: String(numericAmount),
      note: transNote,
      referenceData: { authType: 'PIN', qrOrigin: '' },
      supportMultiPayMethod: 'true',
      commandId: 'PreCheckout.TransferToAccount',
      initiatorMSISDN: this.phoneWithZero,
      receiverMSISDN: receiverWithZero,
    };
    const preRes = await this.post({
      body: preBody,
      header: this.getTemplateHeader('PreCheckout.TransferToAccount', true),
      timestamp: preBody.timestamp,
    });

    if (preRes.isEncrypted && preRes.data?.responseCode === '0' && preRes.data?.prepayId) {
      const prepayId = String(preRes.data.prepayId);
      const payTemp = this.getBodyTemplate1();
      const payTs = payTemp.timestamp;
      const payEncPin = this.encryptPin(usePin, payTs);

      const payRes = await this.post({
        body: {
          ...payTemp,
          additionalParam: {},
          extendParams: { amount: String(numericAmount), transNote },
          payMethod: {
            alpha: 1.0,
            available: 'true',
            displayIcon: '',
            displayInfo: 'Balance',
            isSelect: true,
            odActivate: false,
            payMethod: 'PAY_BY_WALLET',
            selected: 'true',
          },
          prepayId,
          referenceData: { authType: 'PIN', qrOrigin: '' },
          commandId: 'PayOrder.TransferToAccount',
          supportMultiPayMethod: 'true',
          initiatorMSISDN: this.phoneWithZero,
          initiatorPin: payEncPin,
          receiverMSISDN: receiverWithZero,
          useDynamicCaller: 'true',
        },
        header: this.getTemplateHeader('PayOrder.TransferToAccount', true),
        timestamp: payTs,
      });

      if (payRes.isEncrypted && payRes.data?.responseCode === '0' && String(payRes.data?.needVerify) !== 'true') {
        const orderNo = String(
          payRes.data?.payOrderResult?.orderId ||
            payRes.data?.orderId ||
            prepayId
        );
        await this.getWalletBalance().catch(() => {});
        return {
          trxId: orderNo,
          receiverName,
          senderName: this.fullName || this.phoneWithZero,
        };
      }
    }

    const errMsg = sanitizeKbzMessage(
      respBody?.ResponseDesc || preRes.data?.responseDesc,
      'KBZPay ငွေလွှဲခြင်း မအောင်မြင်ပါ။ လက်ကျန်ငွေ သို့မဟုတ် PIN ကို ပြန်လည်စစ်ဆေးပါ။'
    );
    logGatewayEvent('kbz_transfer_failed', 'ERROR', `KBZPay transfer failed from ${this.phoneWithZero} to ${receiverWithZero}`);
    throw new Error(errMsg);
  }
}
