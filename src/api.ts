import { auth } from './firebase';

export async function safeParseJson<T = any>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    if (res.status === 404) {
      return {
        status: 'error',
        message: 'API ဆာဗာ လမ်းကြောင်း ရှာမတွေ့ပါ (HTTP 404)။ Deployment ကို ပြန်လည်စစ်ဆေးပါ။',
      } as unknown as T;
    }
    return {
      status: 'error',
      message: `ဆာဗာမှ တုံ့ပြန်ချက် ဖတ်ရှု၍မရပါ (HTTP ${res.status})။ ခေတ္တစောင့်ဆိုင်းပြီး ထပ်မံကြိုးစားပါ။`,
    } as unknown as T;
  }
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const currentUser = auth.currentUser;
  if (currentUser) {
    const idToken = await currentUser.getIdToken();
    headers.set('Authorization', `Bearer ${idToken}`);
  }
  const res = await fetch(input, {
    ...init,
    headers,
  });

  Object.defineProperty(res, 'json', {
    value: () => safeParseJson(res),
    configurable: true,
  });

  return res;
}
