import React, { useState } from 'react';
import { Copy, Check, Play, RefreshCw, RotateCw } from 'lucide-react';
import { Workspace, WalletProvider, formatProviderLabel } from '../types';
import { apiFetch } from '../api';
import { recordSecurityEventToFirestore } from '../firebase';

interface ApiDocsPageProps {
  workspace: Workspace | null;
  onRefreshWorkspace: () => Promise<void> | void;
}

export const ApiDocsPage: React.FC<ApiDocsPageProps> = ({
  workspace,
  onRefreshWorkspace,
}) => {
  const [selectedLang, setSelectedLang] = useState<'curl' | 'python' | 'node' | 'php'>('curl');
  const [selectedEndpoint, setSelectedEndpoint] = useState<'deposit' | 'verify' | 'withdraw'>('deposit');
  const [selectedProvider, setSelectedProvider] = useState<WalletProvider>('wave');
  const [copiedCode, setCopiedCode] = useState(false);
  const [rotatingKey, setRotatingKey] = useState(false);

  const [testAmount, setTestAmount] = useState('');
  const [testAuthToken, setTestAuthToken] = useState('');
  const [testTrxOrLast5, setTestTrxOrLast5] = useState('');
  const [testReceiver, setTestReceiver] = useState('');
  const [testLoading, setTestLoading] = useState(false);
  const [testResponse, setTestResponse] = useState<any>(null);

  const apiKey = workspace?.api_key || '<YOUR_WORKSPACE_API_KEY>';
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-gateway-domain.com';
  const effectiveWithdrawProv: 'wave' | 'kbz' = selectedProvider === 'kbz' ? 'kbz' : 'wave';

  const handleRotateKey = async () => {
    if (!workspace) return;
    setRotatingKey(true);
    try {
      const res = await apiFetch(`/api/workspaces/${workspace.id}/rotate-key`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.api_key) {
        recordSecurityEventToFirestore('key_rotated', 'Rotated Workspace API Key').catch(() => {});
        await onRefreshWorkspace();
      }
    } finally {
      setRotatingKey(false);
    }
  };

  const getSnippet = () => {
    if (selectedEndpoint === 'deposit') {
      if (selectedLang === 'curl') {
        return `curl -X POST "${origin}/api/v1/deposit" \\
  -H "Content-Type: application/json" \\
  -d '{
    "api_key": "${apiKey}",
    "provider": "${selectedProvider}",
    "amount": 10000
  }'`;
      }
      if (selectedLang === 'python') {
        return `import requests

# provider: "wave" | "kbz" | "aya"
res = requests.post("${origin}/api/v1/deposit", json={
    "api_key": "${apiKey}",
    "provider": "${selectedProvider}",
    "amount": 10000
})
data = res.json()
print("Transfer to Number:", data.get("phone_number"), data.get("provider_label"))
print("Auth Token:", data.get("auth_token"))`;
      }
      if (selectedLang === 'node') {
        return `const res = await fetch("${origin}/api/v1/deposit", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    "api_key": "${apiKey}",
    "provider": "${selectedProvider}", // "wave" | "kbz" | "aya"
    "amount": 10000
  })
});
const data = await res.json();
console.log(data);`;
      }
      return `<?php
$ch = curl_init("${origin}/api/v1/deposit");
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
  "api_key" => "${apiKey}",
  "provider" => "${selectedProvider}", // "wave" | "kbz" | "aya"
  "amount" => 10000
]));
curl_setopt($ch, CURLOPT_HTTPHEADER, ["Content-Type: application/json"]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$response = curl_exec($ch);
echo $response;
?>`;
    }

    if (selectedEndpoint === 'verify') {
      if (selectedLang === 'curl') {
        return `curl -X POST "${origin}/api/v1/verify" \\
  -H "Content-Type: application/json" \\
  -d '{
    "auth_token": "<AUTH_TOKEN_FROM_DEPOSIT>",
    "last5_digits": "<LAST_5_DIGITS_OR_FULL_TRX_ID>"
  }'`;
      }
      if (selectedLang === 'python') {
        return `import requests

# Automatically verifies WavePay, KBZPay, or AYA Pay based on auth_token
res = requests.post("${origin}/api/v1/verify", json={
    "auth_token": "<AUTH_TOKEN_FROM_DEPOSIT>",
    "last5_digits": "<LAST_5_DIGITS_OR_FULL_TRX_ID>"
})
print(res.json())`;
      }
      if (selectedLang === 'node') {
        return `const res = await fetch("${origin}/api/v1/verify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    "auth_token": "<AUTH_TOKEN_FROM_DEPOSIT>",
    "last5_digits": "<LAST_5_DIGITS_OR_FULL_TRX_ID>"
  })
});
console.log(await res.json());`;
      }
      return `<?php
$ch = curl_init("${origin}/api/v1/verify");
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
  "auth_token" => "<AUTH_TOKEN_FROM_DEPOSIT>",
  "last5_digits" => "<LAST_5_DIGITS_OR_FULL_TRX_ID>"
]));
curl_setopt($ch, CURLOPT_HTTPHEADER, ["Content-Type: application/json"]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
echo curl_exec($ch);
?>`;
    }

    if (selectedLang === 'curl') {
      return `curl -X POST "${origin}/api/v1/withdraw" \\
  -H "Content-Type: application/json" \\
  -d '{
    "api_key": "${apiKey}",
    "provider": "${effectiveWithdrawProv}",
    "amount": 10000,
    "receiver_phone": "<RECEIVER_PHONE>"
  }'`;
    }
    if (selectedLang === 'python') {
      return `import requests

# provider: "wave" | "kbz"
res = requests.post("${origin}/api/v1/withdraw", json={
    "api_key": "${apiKey}",
    "provider": "${effectiveWithdrawProv}",
    "amount": 10000,
    "receiver_phone": "<RECEIVER_PHONE>"
})
print(res.json())`;
    }
    if (selectedLang === 'node') {
      return `const res = await fetch("${origin}/api/v1/withdraw", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    "api_key": "${apiKey}",
    "provider": "${effectiveWithdrawProv}", // "wave" | "kbz"
    "amount": 10000,
    "receiver_phone": "<RECEIVER_PHONE>"
  })
});
console.log(await res.json());`;
    }
    return `<?php
$ch = curl_init("${origin}/api/v1/withdraw");
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
  "api_key" => "${apiKey}",
  "provider" => "${effectiveWithdrawProv}", // "wave" | "kbz"
  "amount" => 10000,
  "receiver_phone" => "<RECEIVER_PHONE>"
]));
curl_setopt($ch, CURLOPT_HTTPHEADER, ["Content-Type: application/json"]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
echo curl_exec($ch);
?>`;
  };

  const runLiveRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setTestLoading(true);
    setTestResponse(null);
    try {
      if (selectedEndpoint === 'deposit') {
        const res = await apiFetch('/api/v1/deposit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            provider: selectedProvider,
            amount: Number(testAmount),
          }),
        });
        const data = await res.json();
        setTestResponse(data);
        if (data.auth_token) setTestAuthToken(data.auth_token);
      } else if (selectedEndpoint === 'verify') {
        const cleanVal = testTrxOrLast5.trim();
        const body =
          cleanVal.length <= 6
            ? { auth_token: testAuthToken.trim(), last5_digits: cleanVal }
            : { auth_token: testAuthToken.trim(), trx_id: cleanVal };
        const res = await apiFetch('/api/v1/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        setTestResponse(await res.json());
      } else {
        const res = await apiFetch('/api/v1/withdraw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            provider: effectiveWithdrawProv,
            amount: Number(testAmount),
            receiver_phone: testReceiver.trim(),
          }),
        });
        setTestResponse(await res.json());
      }
    } catch (err: any) {
      setTestResponse({ status: 'error', message: err.message });
    } finally {
      setTestLoading(false);
    }
  };

  return (
    <div className="space-y-6 sm:space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-zinc-200 pb-6">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-black">
            REST API Reference
          </h1>
          <p className="text-xs sm:text-sm text-zinc-600 leading-relaxed">
            သင်၏ ပြင်ပ Website သို့မဟုတ် App များမှ WavePay, KBZPay နှင့် AYA Pay Auto-Deposit, Receipt Verification နှင့် Auto-Withdraw ချိတ်ဆက်အသုံးပြုရန် API လမ်းညွှန်။
          </p>
        </div>

        {workspace && (
          <div className="flex items-center gap-2">
            <span className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-xs font-medium text-zinc-700 truncate max-w-[180px]">
              {workspace.name}
            </span>
            <button
              type="button"
              onClick={handleRotateKey}
              disabled={rotatingKey}
              className="px-3 py-2 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
            >
              <RotateCw className={`w-3.5 h-3.5 ${rotatingKey ? 'animate-spin' : ''}`} />
              <span>Rotate Key</span>
            </button>
          </div>
        )}
      </div>

      {/* Endpoint & Language Selectors */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="grid grid-cols-3 sm:flex items-center gap-1 p-1 bg-zinc-100 border border-zinc-200 rounded-lg">
          {[
            { id: 'deposit', label: '1. Deposit', fullLabel: '1. POST /api/v1/deposit' },
            { id: 'verify', label: '2. Verify', fullLabel: '2. POST /api/v1/verify' },
            { id: 'withdraw', label: '3. Withdraw', fullLabel: '3. POST /api/v1/withdraw' },
          ].map((ep) => (
            <button
              key={ep.id}
              type="button"
              onClick={() => {
                setSelectedEndpoint(ep.id as any);
                setTestResponse(null);
              }}
              className={`px-2.5 sm:px-3.5 py-2 sm:py-1.5 text-xs font-mono font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap text-center ${
                selectedEndpoint === ep.id
                  ? 'bg-black text-white'
                  : 'text-zinc-600 hover:text-black'
              }`}
            >
              <span className="sm:hidden">{ep.label}</span>
              <span className="hidden sm:inline">{ep.fullLabel}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {selectedEndpoint !== 'verify' && (
            <div className="flex items-center gap-1 p-1 bg-zinc-100 border border-zinc-200 rounded-lg">
              {(selectedEndpoint === 'withdraw'
                ? ([
                    { id: 'wave', label: 'WavePay' },
                    { id: 'kbz', label: 'KBZPay' },
                  ] as const)
                : ([
                    { id: 'wave', label: 'WavePay' },
                    { id: 'kbz', label: 'KBZPay' },
                    { id: 'aya', label: 'AYA Pay' },
                  ] as const)
              ).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedProvider(p.id)}
                  className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors cursor-pointer ${
                    (selectedEndpoint === 'withdraw' ? effectiveWithdrawProv : selectedProvider) ===
                    p.id
                      ? 'bg-black text-white'
                      : 'text-zinc-600 hover:text-black'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-4 sm:flex items-center gap-1 p-1 bg-zinc-100 border border-zinc-200 rounded-lg">
            {(['curl', 'python', 'node', 'php'] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                onClick={() => setSelectedLang(lang)}
                className={`px-3 py-1.5 sm:py-1 text-xs font-mono font-semibold uppercase rounded transition-colors cursor-pointer text-center ${
                  selectedLang === lang ? 'bg-black text-white' : 'text-zinc-600 hover:text-black'
                }`}
              >
                {lang}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Code Snippet & Live Console */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8 items-start">
        <div className="lg:col-span-7 bg-zinc-50 border border-zinc-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-200 flex items-center justify-between bg-white">
            <span className="text-xs font-mono font-semibold text-zinc-700">
              Integration Example ({selectedLang.toUpperCase()})
            </span>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(getSnippet());
                setCopiedCode(true);
                setTimeout(() => setCopiedCode(false), 2000);
              }}
              className="px-2.5 py-1 text-xs font-semibold bg-black hover:bg-zinc-800 text-white rounded cursor-pointer flex items-center gap-1"
            >
              {copiedCode ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedCode ? 'Copied' : 'Copy Code'}</span>
            </button>
          </div>
          <pre className="p-4 sm:p-5 text-xs font-mono text-black overflow-x-auto leading-relaxed">
            {getSnippet()}
          </pre>
        </div>

        <div className="lg:col-span-5 bg-white border border-zinc-200 rounded-xl p-5 sm:p-6 space-y-4">
          <div>
            <h3 className="text-sm font-bold text-black">Live Endpoint Console</h3>
            <p className="text-xs text-zinc-600 mt-0.5">
              သင်၏ API Key ဖြင့် တိုက်ရိုက် ခေါ်ယူစမ်းသပ်နိုင်ပါသည်။
            </p>
          </div>

          <form onSubmit={runLiveRequest} className="space-y-3.5">
            {selectedEndpoint === 'deposit' && (
              <>
                <div>
                  <label className="block text-xs font-semibold text-zinc-800 mb-1">
                    Wallet Provider *
                  </label>
                  <select
                    value={selectedProvider}
                    onChange={(e) => setSelectedProvider(e.target.value as WalletProvider)}
                    className="w-full px-3 py-2.5 bg-white border border-zinc-300 rounded-lg text-xs font-semibold text-black focus:outline-none focus:border-black"
                  >
                    <option value="wave">WavePay ("wave")</option>
                    <option value="kbz">KBZPay ("kbz")</option>
                    <option value="aya">AYA Pay ("aya")</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-800 mb-1">
                    Deposit Amount (Ks) *
                  </label>
                  <input
                    type="number"
                    required
                    min="1"
                    value={testAmount}
                    onChange={(e) => setTestAmount(e.target.value)}
                    placeholder="ငွေပမာဏ ရိုက်ထည့်ပါ"
                    className="w-full px-3 py-2.5 bg-white border border-zinc-300 rounded-lg text-xs font-mono text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                  />
                </div>
              </>
            )}

            {selectedEndpoint === 'verify' && (
              <>
                <div>
                  <label className="block text-xs font-semibold text-zinc-800 mb-1">
                    Auth Token *
                  </label>
                  <input
                    type="text"
                    required
                    value={testAuthToken}
                    onChange={(e) => setTestAuthToken(e.target.value)}
                    placeholder="Deposit မှ ရရှိသော auth_token"
                    className="w-full px-3 py-2.5 bg-white border border-zinc-300 rounded-lg text-xs font-mono text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-800 mb-1">
                    Transaction / Order ID သို့မဟုတ် Last 5 Digits *
                  </label>
                  <input
                    type="text"
                    required
                    value={testTrxOrLast5}
                    onChange={(e) => setTestTrxOrLast5(e.target.value)}
                    placeholder="ပြေစာပါ ID သို့မဟုတ် Last 5"
                    className="w-full px-3 py-2.5 bg-white border border-zinc-300 rounded-lg text-xs font-mono text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                  />
                </div>
              </>
            )}

            {selectedEndpoint === 'withdraw' && (
              <>
                <div>
                  <label className="block text-xs font-semibold text-zinc-800 mb-1">
                    Disbursement Wallet *
                  </label>
                  <select
                    value={effectiveWithdrawProv}
                    onChange={(e) => setSelectedProvider(e.target.value as WalletProvider)}
                    className="w-full px-3 py-2.5 bg-white border border-zinc-300 rounded-lg text-xs font-semibold text-black focus:outline-none focus:border-black"
                  >
                    <option value="wave">WavePay ("wave")</option>
                    <option value="kbz">KBZPay ("kbz")</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-800 mb-1">
                    Receiver {formatProviderLabel(effectiveWithdrawProv)} Phone *
                  </label>
                  <input
                    type="tel"
                    required
                    value={testReceiver}
                    onChange={(e) => setTestReceiver(e.target.value)}
                    placeholder="09xxxxxxxxx"
                    className="w-full px-3 py-2.5 bg-white border border-zinc-300 rounded-lg text-xs font-mono text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-800 mb-1">
                    Withdraw Amount (Ks) *
                  </label>
                  <input
                    type="number"
                    required
                    min="1"
                    value={testAmount}
                    onChange={(e) => setTestAmount(e.target.value)}
                    placeholder="ငွေပမာဏ ရိုက်ထည့်ပါ"
                    className="w-full px-3 py-2.5 bg-white border border-zinc-300 rounded-lg text-xs font-mono text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                  />
                </div>
              </>
            )}

            <button
              type="submit"
              disabled={testLoading}
              className="w-full py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer flex items-center justify-center gap-1.5"
            >
              {testLoading ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              <span>Send Request</span>
            </button>
          </form>

          {testResponse && (
            <div className="pt-2 space-y-1.5">
              <div className="text-xs font-mono font-semibold text-zinc-600">
                HTTP Response Payload
              </div>
              <pre className="p-3.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs font-mono text-black overflow-x-auto max-h-64">
                {JSON.stringify(testResponse, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
