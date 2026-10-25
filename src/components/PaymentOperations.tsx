import React, { useState, useEffect, useCallback } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Upload,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  RefreshCw,
} from 'lucide-react';
import {
  Workspace,
  PaymentTokenRecord,
  WaveAccount,
  WalletProvider,
  formatProviderLabel,
} from '../types';
import { apiFetch } from '../api';
import { recordSecurityEventToFirestore } from '../firebase';
import { preloadReceiptOcr, scanWaveReceiptFast } from '../ocr_client';

interface PaymentOperationsProps {
  accounts: WaveAccount[];
  workspace: Workspace | null;
  onRefreshAccounts: () => Promise<void> | void;
}

function getAccProvider(acc: WaveAccount): WalletProvider {
  if (acc.provider === 'kbz') return 'kbz';
  if (acc.provider === 'aya') return 'aya';
  return 'wave';
}

export const PaymentOperations: React.FC<PaymentOperationsProps> = ({
  accounts,
  workspace,
  onRefreshAccounts,
}) => {
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [recentTx, setRecentTx] = useState<PaymentTokenRecord[]>([]);

  // Deposit Flow State
  const [depositProvider, setDepositProvider] = useState<WalletProvider>('wave');
  const [depositAmount, setDepositAmount] = useState('');
  const [depositSession, setDepositSession] = useState<{
    provider: WalletProvider;
    auth_token: string;
    phone_number: string;
    account_name: string;
    amount: number;
  } | null>(null);
  const [trxIdInput, setTrxIdInput] = useState('');
  const [ocrLoading, setOcrLoading] = useState(false);
  const [depositBusy, setDepositBusy] = useState(false);
  const [depositFeedback, setDepositFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [copiedPhone, setCopiedPhone] = useState(false);

  // Withdraw Flow State (WavePay & KBZPay)
  const [withdrawProvider, setWithdrawProvider] = useState<'wave' | 'kbz'>('wave');
  const [withdrawReceiver, setWithdrawReceiver] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawFeedback, setWithdrawFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const loadTransactions = useCallback(async () => {
    try {
      const txRes = await apiFetch('/api/transactions');
      if (txRes.ok) {
        const txData = await txRes.json();
        if (txData.transactions) {
          setRecentTx(txData.transactions);
        }
      }
    } catch {
      // Ignore transient errors
    }
  }, []);

  useEffect(() => {
    loadTransactions();
  }, [loadTransactions]);

  // Auto-select first provider that has an active session on initial load
  useEffect(() => {
    const activeWave = accounts.some((a) => a.has_session && getAccProvider(a) === 'wave');
    const activeKbz = accounts.some((a) => a.has_session && getAccProvider(a) === 'kbz');
    const activeAya = accounts.some((a) => a.has_session && getAccProvider(a) === 'aya');

    if (!activeWave) {
      if (activeKbz) {
        setDepositProvider('kbz');
        setWithdrawProvider('kbz');
      } else if (activeAya) {
        setDepositProvider('aya');
      }
    }
  }, [accounts]);

  // Pre-warm OCR worker in background so receipt scanning has zero cold-start wait
  useEffect(() => {
    if (mode === 'deposit') {
      preloadReceiptOcr();
    }
  }, [mode]);

  const activeAccountsCount = accounts.filter((a) => Boolean(a.has_session)).length;
  const activeByProvider: Record<WalletProvider, number> = {
    wave: accounts.filter((a) => a.has_session && getAccProvider(a) === 'wave').length,
    kbz: accounts.filter((a) => a.has_session && getAccProvider(a) === 'kbz').length,
    aya: accounts.filter((a) => a.has_session && getAccProvider(a) === 'aya').length,
  };

  const handleStartDeposit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace?.api_key || !depositAmount) return;
    setDepositBusy(true);
    setDepositFeedback(null);

    try {
      const res = await apiFetch('/api/v1/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: workspace.api_key,
          provider: depositProvider,
          amount: Number(depositAmount),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDepositFeedback({ ok: false, msg: data.message || 'ငွေသွင်းရန် တောင်းဆို၍မရပါ။' });
      } else {
        const assignedProv: WalletProvider =
          data.provider === 'kbz' || data.provider === 'aya' ? data.provider : depositProvider;
        setDepositSession({
          provider: assignedProv,
          auth_token: data.auth_token,
          phone_number: data.phone_number,
          account_name: data.account_name || '',
          amount: data.amount,
        });
        setTrxIdInput('');
        recordSecurityEventToFirestore(
          'deposit_created',
          `Initialized ${formatProviderLabel(assignedProv)} deposit of ${Number(data.amount).toLocaleString()} Ks`
        ).catch(() => {});
        await loadTransactions();
      }
    } catch (err: any) {
      setDepositFeedback({ ok: false, msg: err.message });
    } finally {
      setDepositBusy(false);
    }
  };

  const processReceiptFile = useCallback(
    async (file: File) => {
      setOcrLoading(true);
      setDepositFeedback(null);

      try {
        const result = await scanWaveReceiptFast(file, depositSession?.phone_number || '');
        if (!result.trx_id) {
          setDepositFeedback({
            ok: false,
            msg: 'Screenshot မှ Transaction / Order ID ရှာမတွေ့ပါ။ အောက်တွင် ကိုယ်တိုင် ရိုက်ထည့်ပေးပါ။',
          });
        } else {
          setTrxIdInput(result.trx_id);
          const sec = (result.elapsedMs / 1000).toFixed(2);
          setDepositFeedback({
            ok: true,
            msg: `ID (${result.trx_id}) ကို ${sec}s အတွင်း ဖတ်ရှုပြီးပါပြီ။ "Verify Deposit" ကိုနှိပ်၍ အတည်ပြုပါ။`,
          });
        }
      } catch (err: any) {
        setDepositFeedback({
          ok: false,
          msg:
            err?.message ||
            'Screenshot ဖတ်ရှုရာတွင် အမှားဖြစ်ပေါ်နေပါသည်။ Transaction ID ကို ကိုယ်တိုင် ရိုက်ထည့်ပေးပါ။',
        });
      } finally {
        setOcrLoading(false);
      }
    },
    [depositSession?.phone_number]
  );

  const handleReceiptUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await processReceiptFile(file);
  };

  const handleReceiptPaste = async (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (ocrLoading || !depositSession) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          await processReceiptFile(file);
          break;
        }
      }
    }
  };

  const handleVerifyDeposit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!depositSession || !trxIdInput.trim()) return;
    setDepositBusy(true);
    setDepositFeedback(null);

    try {
      const cleanInput = trxIdInput.trim();
      const payload =
        cleanInput.length <= 6
          ? { auth_token: depositSession.auth_token, last5_digits: cleanInput }
          : { auth_token: depositSession.auth_token, trx_id: cleanInput };

      const res = await apiFetch('/api/v1/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setDepositFeedback({ ok: false, msg: data.message || 'အတည်ပြု၍ မရပါ။' });
      } else {
        const provLabel = formatProviderLabel(data.provider || depositSession.provider);
        setDepositFeedback({
          ok: true,
          msg: `${provLabel} ငွေသွင်း အောင်မြင်ပါသည် — ပမာဏ: ${Number(data.amount).toLocaleString()} Ks · ID: ${data.trx_id}`,
        });
        recordSecurityEventToFirestore(
          'deposit_verified',
          `Verified ${provLabel} deposit ${Number(data.amount).toLocaleString()} Ks (Trx ${data.trx_id})`
        ).catch(() => {});
        setDepositSession(null);
        setDepositAmount('');
        setTrxIdInput('');
        await Promise.all([onRefreshAccounts(), loadTransactions()]);
      }
    } catch (err: any) {
      setDepositFeedback({ ok: false, msg: err.message });
    } finally {
      setDepositBusy(false);
    }
  };

  const handleExecuteWithdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace?.api_key || !withdrawReceiver.trim() || !withdrawAmount) return;
    setWithdrawBusy(true);
    setWithdrawFeedback(null);

    try {
      const res = await apiFetch('/api/v1/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: workspace.api_key,
          provider: withdrawProvider,
          receiver_phone: withdrawReceiver.trim(),
          amount: Number(withdrawAmount),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setWithdrawFeedback({ ok: false, msg: data.message || 'ငွေထုတ်ပေးချေမှု မအောင်မြင်ပါ။' });
      } else {
        const provLabel = formatProviderLabel(data.provider || withdrawProvider);
        setWithdrawFeedback({
          ok: true,
          msg: `${provLabel} ငွေထုတ်လွှဲပြောင်းမှု အောင်မြင်ပါသည် — လက်ခံသူ: ${data.receiver_name} (${data.receiver}) · ID: ${data.trx_id} · ပေးပို့သည့် SIM: ${data.disbursed_from}`,
        });
        recordSecurityEventToFirestore(
          'withdraw_executed',
          `Disbursed ${provLabel} ${Number(data.amount).toLocaleString()} Ks to ${data.receiver}`
        ).catch(() => {});
        setWithdrawReceiver('');
        setWithdrawAmount('');
        await Promise.all([onRefreshAccounts(), loadTransactions()]);
      }
    } catch (err: any) {
      setWithdrawFeedback({ ok: false, msg: err.message });
    } finally {
      setWithdrawBusy(false);
    }
  };

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Header & Mode Segmented Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-zinc-200 pb-6">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-black">
            Payment Mode
          </h1>
          <p className="text-xs sm:text-sm text-zinc-600 leading-relaxed">
            WavePay, KBZPay နှင့် AYA Pay ပြေစာ Screenshot OCR / Transaction ID ဖြင့် ငွေသွင်းစစ်ဆေးခြင်း နှင့် WavePay / KBZPay အမြင့်ဆုံးလက်ကျန်ရှိသော SIM မှ အလိုအလျောက် ငွေထုတ်ပေးချေခြင်း။
          </p>
        </div>

        <div className="grid grid-cols-2 sm:flex items-center gap-1 p-1 bg-zinc-100 border border-zinc-200 rounded-lg w-full sm:w-auto">
          <button
            type="button"
            onClick={() => setMode('deposit')}
            className={`px-3.5 py-2 sm:py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer flex items-center justify-center gap-1.5 whitespace-nowrap ${
              mode === 'deposit'
                ? 'bg-black text-white'
                : 'text-zinc-600 hover:text-black'
            }`}
          >
            <ArrowDownLeft className="w-3.5 h-3.5" />
            <span>Deposit (ငွေသွင်း)</span>
          </button>
          <button
            type="button"
            onClick={() => setMode('withdraw')}
            className={`px-3.5 py-2 sm:py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer flex items-center justify-center gap-1.5 whitespace-nowrap ${
              mode === 'withdraw'
                ? 'bg-black text-white'
                : 'text-zinc-600 hover:text-black'
            }`}
          >
            <ArrowUpRight className="w-3.5 h-3.5" />
            <span>Withdraw (ငွေထုတ်)</span>
          </button>
        </div>
      </div>

      {activeAccountsCount === 0 && (
        <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-300 text-black text-xs flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-black shrink-0 mt-0.5" />
          <span className="leading-relaxed">
            လက်ရှိတွင် Login ဝင်ထားသော Wallet အကောင့် မရှိသေးပါ။ ငွေသွင်း/ငွေထုတ် ပြုလုပ်ရန် Wallet Accounts စာမျက်နှာတွင် WavePay, KBZPay သို့မဟုတ် AYA Pay အကောင့် ချိတ်ဆက်ပေးပါ။
          </span>
        </div>
      )}

      {/* Main Split Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8 items-start">
        <div className="lg:col-span-6 bg-white border border-zinc-200 rounded-xl p-5 sm:p-6 space-y-5">
          {mode === 'deposit' ? (
            <>
              <div>
                <h2 className="text-base font-bold text-black">
                  Deposit Verification (ငွေသွင်း အတည်ပြုရန်)
                </h2>
                <p className="text-xs text-zinc-600 mt-1 leading-relaxed">
                  ငွေလက်ခံမည့် Wallet ရွေးချယ်ပြီး ပမာဏ ရိုက်ထည့်ပါ။ ထို့နောက် ပြေစာ Screenshot တင်ခြင်း သို့မဟုတ် Transaction / Order ID ရိုက်ထည့်၍ စစ်ဆေးပါ။
                </p>
              </div>

              {depositFeedback && (
                <div
                  className={`p-3.5 rounded-lg border text-xs flex items-start gap-2 font-medium ${
                    depositFeedback.ok
                      ? 'bg-zinc-50 border-black text-black'
                      : 'bg-white border-2 border-black text-black'
                  }`}
                >
                  {depositFeedback.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-black shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-black shrink-0 mt-0.5" />
                  )}
                  <span className="leading-relaxed">{depositFeedback.msg}</span>
                </div>
              )}

              {!depositSession ? (
                <form onSubmit={handleStartDeposit} className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-zinc-800">
                      ငွေလက်ခံမည့် Wallet ရွေးချယ်ပါ *
                    </label>
                    <div className="grid grid-cols-3 gap-1 p-1 bg-zinc-100 border border-zinc-200 rounded-lg">
                      {(
                        [
                          { id: 'wave', label: 'WavePay' },
                          { id: 'kbz', label: 'KBZPay' },
                          { id: 'aya', label: 'AYA Pay' },
                        ] as const
                      ).map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setDepositProvider(p.id)}
                          className={`py-2 px-2 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                            depositProvider === p.id
                              ? 'bg-black text-white'
                              : 'text-zinc-600 hover:text-black'
                          }`}
                        >
                          {p.label} ({activeByProvider[p.id]})
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                      ငွေသွင်းမည့် ပမာဏ (Ks) *
                    </label>
                    <input
                      type="number"
                      required
                      min="1"
                      step="1"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      placeholder="ငွေပမာဏ ရိုက်ထည့်ပါ"
                      className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm font-mono tabular-nums text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={depositBusy || !depositAmount}
                    className="w-full py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer disabled:opacity-40"
                  >
                    {depositBusy
                      ? `Assigning ${formatProviderLabel(depositProvider)} Account...`
                      : `Request Receiving ${formatProviderLabel(depositProvider)} Number`}
                  </button>
                </form>
              ) : (
                <div className="space-y-5" onPaste={handleReceiptPaste}>
                  <div className="p-4 bg-zinc-50 border border-zinc-200 rounded-xl space-y-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-600">Wallet အမျိုးအစား</span>
                      <span className="font-semibold text-black">
                        {formatProviderLabel(depositSession.provider)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-600">
                        လွှဲပို့ရမည့် {formatProviderLabel(depositSession.provider)} နံပါတ်
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-base font-bold text-black">
                          {depositSession.phone_number}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(depositSession.phone_number);
                            setCopiedPhone(true);
                            setTimeout(() => setCopiedPhone(false), 1800);
                          }}
                          className="p-1.5 bg-white border border-zinc-300 rounded text-black cursor-pointer"
                        >
                          {copiedPhone ? (
                            <Check className="w-3.5 h-3.5" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                    {depositSession.account_name && (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-zinc-600">အကောင့်အမည်</span>
                        <span className="text-black font-semibold">{depositSession.account_name}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-600">လွှဲရမည့် ပမာဏအတိအကျ</span>
                      <span className="font-mono font-bold tabular-nums text-black">
                        {depositSession.amount.toLocaleString()} Ks
                      </span>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                      {formatProviderLabel(depositSession.provider)} ပြေစာ Screenshot တင်ရန် (Instant OCR Auto-Read)
                    </label>
                    <label className="flex items-center justify-center gap-2 px-4 py-3.5 bg-zinc-50 hover:bg-zinc-100 border border-dashed border-zinc-400 rounded-xl text-xs font-medium text-black cursor-pointer transition-colors">
                      {ocrLoading ? (
                        <>
                          <RefreshCw className="w-4 h-4 text-black animate-spin" />
                          <span>Screenshot ချက်ချင်း ဖတ်ရှုနေပါသည်...</span>
                        </>
                      ) : (
                        <>
                          <Upload className="w-4 h-4 text-black" />
                          <span>
                            Upload or Paste {formatProviderLabel(depositSession.provider)} Receipt Screenshot
                          </span>
                        </>
                      )}
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleReceiptUpload}
                        disabled={ocrLoading}
                        className="hidden"
                      />
                    </label>
                  </div>

                  <form onSubmit={handleVerifyDeposit} className="space-y-4">
                    <div>
                      <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                        Transaction / Order ID (အပြည့်အစုံ သို့မဟုတ် နောက်ဆုံး ဂဏန်း ၅ လုံး) *
                      </label>
                      <input
                        type="text"
                        required
                        value={trxIdInput}
                        onChange={(e) => setTrxIdInput(e.target.value)}
                        placeholder={
                          depositSession.provider === 'kbz'
                            ? 'KBZPay Order No သို့မဟုတ် Last 5 Digits'
                            : depositSession.provider === 'aya'
                              ? 'AYA Pay Reference ID သို့မဟုတ် Last 5 Digits'
                              : 'WavePay Transaction ID သို့မဟုတ် Last 5 Digits'
                        }
                        className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm font-mono text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                      />
                    </div>

                    <div className="flex gap-2.5">
                      <button
                        type="button"
                        onClick={() => setDepositSession(null)}
                        className="flex-1 py-2.5 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={depositBusy || !trxIdInput.trim()}
                        className="flex-1 py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer disabled:opacity-40"
                      >
                        {depositBusy ? 'Verifying...' : 'Verify Deposit'}
                      </button>
                    </div>
                  </form>
                </div>
              )}
            </>
          ) : (
            <>
              <div>
                <h2 className="text-base font-bold text-black">
                  Auto-Withdraw Disbursement (ငွေထုတ် ပေးချေရန်)
                </h2>
                <p className="text-xs text-zinc-600 mt-1 leading-relaxed">
                  ရွေးချယ်ထားသော Wallet (WavePay သို့မဟုတ် KBZPay) ၏ အကောင့်များအနက် လက်ကျန်ငွေ အများဆုံးရှိသော SIM ကို အလိုအလျောက် ရွေးချယ်ပြီး တိုက်ရိုက် ငွေလွှဲပေးပါမည်။
                </p>
              </div>

              {withdrawFeedback && (
                <div
                  className={`p-3.5 rounded-lg border text-xs font-medium flex items-start gap-2 ${
                    withdrawFeedback.ok
                      ? 'bg-zinc-50 border-black text-black'
                      : 'bg-white border-2 border-black text-black'
                  }`}
                >
                  {withdrawFeedback.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-black shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-black shrink-0 mt-0.5" />
                  )}
                  <span className="leading-relaxed">{withdrawFeedback.msg}</span>
                </div>
              )}

              <form onSubmit={handleExecuteWithdraw} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-zinc-800">
                    ငွေထုတ်ပေးမည့် Wallet ရွေးချယ်ပါ *
                  </label>
                  <div className="grid grid-cols-2 gap-1 p-1 bg-zinc-100 border border-zinc-200 rounded-lg">
                    {(
                      [
                        { id: 'wave', label: 'WavePay' },
                        { id: 'kbz', label: 'KBZPay' },
                      ] as const
                    ).map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setWithdrawProvider(p.id)}
                        className={`py-2 px-3 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                          withdrawProvider === p.id
                            ? 'bg-black text-white'
                            : 'text-zinc-600 hover:text-black'
                        }`}
                      >
                        {p.label} ({activeByProvider[p.id]})
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                    လက်ခံမည့် {formatProviderLabel(withdrawProvider)} ဖုန်းနံပါတ် *
                  </label>
                  <input
                    type="tel"
                    required
                    value={withdrawReceiver}
                    onChange={(e) => setWithdrawReceiver(e.target.value)}
                    placeholder="09xxxxxxxxx"
                    className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm font-mono text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                    ထုတ်ပေးမည့် ငွေပမာဏ (Ks) *
                  </label>
                  <input
                    type="number"
                    required
                    min="1"
                    step="1"
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(e.target.value)}
                    placeholder="ငွေပမာဏ ရိုက်ထည့်ပါ"
                    className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm font-mono tabular-nums text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                  />
                </div>

                <button
                  type="submit"
                  disabled={withdrawBusy || !withdrawReceiver.trim() || !withdrawAmount}
                  className="w-full py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer disabled:opacity-40"
                >
                  {withdrawBusy
                    ? 'Disbursing...'
                    : `Execute ${formatProviderLabel(withdrawProvider)} Auto-Withdraw`}
                </button>
              </form>
            </>
          )}
        </div>

        {/* Right 6 cols: Recent Gateway Payment Records */}
        <div className="lg:col-span-6 border border-zinc-200 rounded-xl bg-white overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-200 flex items-center justify-between bg-zinc-50">
            <h3 className="text-sm font-bold text-black">Recent Gateway Requests</h3>
            <button
              type="button"
              onClick={loadTransactions}
              className="text-xs font-semibold text-zinc-600 hover:text-black flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh</span>
            </button>
          </div>

          {recentTx.length === 0 ? (
            <div className="py-12 px-6 text-center text-xs text-zinc-500">
              ငွေသွင်း / ငွေထုတ် မှတ်တမ်း မရှိသေးပါ။
            </div>
          ) : (
            <div className="divide-y divide-zinc-200">
              {recentTx.slice(0, 12).map((tx, idx) => (
                <div
                  key={`${tx.token}-${idx}`}
                  className="p-4 flex items-center justify-between gap-3 text-xs hover:bg-zinc-50/70"
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="font-bold text-black">
                      <span className="text-zinc-600 font-semibold">
                        {formatProviderLabel(tx.provider)}
                      </span>{' '}
                      · <span className="capitalize">{tx.type}</span> ·{' '}
                      <span className="font-mono font-normal text-zinc-700">
                        {tx.type === 'deposit' ? `0${tx.phone_number}` : tx.receiver || '-'}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-zinc-500 truncate">
                      {tx.trx_id ? `ID: ${tx.trx_id}` : `Status: ${tx.status}`}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono font-bold tabular-nums text-black text-sm">
                      {Number(tx.amount).toLocaleString()} Ks
                    </div>
                    <div className="text-[11px] font-semibold text-zinc-600 capitalize">
                      {tx.status}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
