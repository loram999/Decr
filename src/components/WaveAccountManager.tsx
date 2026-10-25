import React, { useState, useEffect } from 'react';
import {
  Plus,
  RefreshCw,
  Copy,
  Check,
  KeyRound,
  ArrowRightLeft,
  History,
  Trash2,
  Search,
  UserCheck,
  AlertCircle,
  CheckCircle2,
  X,
} from 'lucide-react';
import {
  WaveAccount,
  WalletProvider,
  Workspace,
  TransactionHistoryItem,
  formatProviderLabel,
} from '../types';
import { apiFetch } from '../api';
import {
  CloudSecurityEvent,
  recordSecurityEventToFirestore,
  subscribeToUserSecurityEvents,
} from '../firebase';

interface WaveAccountManagerProps {
  accounts: WaveAccount[];
  workspace: Workspace | null;
  userUid: string;
  isLoading: boolean;
  openAddModalSignal: number;
  onRefresh: () => Promise<void> | void;
  onNavigateToApiDocs: () => void;
}

type LoginModalStep =
  | 'requesting_otp'
  | 'wave_otp'
  | 'wave_pin'
  | 'kbz_credentials'
  | 'kbz_qr'
  | 'aya_password'
  | 'aya_otp'
  | 'aya_old_device';

function getAccProvider(acc?: WaveAccount | null): WalletProvider {
  if (acc?.provider === 'kbz') return 'kbz';
  if (acc?.provider === 'aya') return 'aya';
  return 'wave';
}

function getAccKey(acc: WaveAccount): string {
  return `${getAccProvider(acc)}:${acc.phone}`;
}

export const WaveAccountManager: React.FC<WaveAccountManagerProps> = ({
  accounts,
  workspace,
  userUid,
  isLoading,
  openAddModalSignal,
  onRefresh,
  onNavigateToApiDocs,
}) => {
  const [copiedKey, setCopiedKey] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [providerFilter, setProviderFilter] = useState<'all' | WalletProvider>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncingKey, setSyncingKey] = useState<string | null>(null);
  const [cloudEvents, setCloudEvents] = useState<CloudSecurityEvent[]>([]);

  const [banner, setBanner] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Add Account Form State
  const [providerInput, setProviderInput] = useState<WalletProvider>('wave');
  const [phoneInput, setPhoneInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [modelInput, setModelInput] = useState('Pixel 6');
  const [osInput, setOsInput] = useState('14');
  const [nrcInput, setNrcInput] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  // Multi-Provider Real Login Modal State
  const [loginTarget, setLoginTarget] = useState<WaveAccount | null>(null);
  const [loginStep, setLoginStep] = useState<LoginModalStep>('requesting_otp');
  const [otpInput, setOtpInput] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [loginNrcInput, setLoginNrcInput] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [oldDeviceName, setOldDeviceName] = useState('');
  const [loginStatusMsg, setLoginStatusMsg] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);

  // Transfer Modal State (WavePay & KBZPay)
  const [transferAcc, setTransferAcc] = useState<WaveAccount | null>(null);
  const [receiverInput, setReceiverInput] = useState('');
  const [resolvedReceiverName, setResolvedReceiverName] = useState('');
  const [checkingName, setCheckingName] = useState(false);
  const [amountInput, setAmountInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferStatus, setTransferStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  // History Modal State (WavePay, KBZPay & AYA Pay)
  const [historyAcc, setHistoryAcc] = useState<WaveAccount | null>(null);
  const [historyList, setHistoryList] = useState<TransactionHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');

  // Delete Confirmation Modal State
  const [deleteTarget, setDeleteTarget] = useState<WaveAccount | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    if (!userUid) return;
    let unsub: (() => void) | undefined;
    try {
      unsub = subscribeToUserSecurityEvents(userUid, (list) => {
        setCloudEvents(list);
      });
    } catch {
      // Handled by Firestore error logger
    }
    return () => {
      if (unsub) unsub();
    };
  }, [userUid]);

  useEffect(() => {
    if (openAddModalSignal > 0) {
      setShowAddForm(true);
    }
  }, [openAddModalSignal]);

  const copyApiKey = () => {
    if (!workspace?.api_key) return;
    navigator.clipboard.writeText(workspace.api_key);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    setIsAdding(true);
    try {
      const res = await apiFetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: providerInput,
          phone: phoneInput,
          name: nameInput,
          model: modelInput || 'Pixel 6',
          os_version: osInput || '14',
          nrc_id: providerInput === 'kbz' ? nrcInput.trim() : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: 'error', message: data.message || 'အကောင့် ထည့်သွင်း၍ မရပါ။' });
      } else {
        const provLabel = formatProviderLabel(data.provider || providerInput);
        setPhoneInput('');
        setNameInput('');
        setNrcInput('');
        setShowAddForm(false);
        setBanner({
          type: 'success',
          message: `${provLabel} SIM 0${data.phone} ထည့်သွင်းပြီးပါပြီ။ "Login" နှိပ်၍ အကောင့် ချိတ်ဆက်ပါ။`,
        });
        recordSecurityEventToFirestore(
          'account_added',
          `Registered ${provLabel} SIM 0${data.phone}`
        ).catch(() => {});
        await onRefresh();
      }
    } catch (err: any) {
      setBanner({ type: 'error', message: err.message });
    } finally {
      setIsAdding(false);
    }
  };

  const initiateWalletLogin = async (acc: WaveAccount) => {
    const prov = getAccProvider(acc);
    const provLabel = formatProviderLabel(prov);
    setLoginTarget(acc);
    setOtpInput('');
    setPinInput('');
    setLoginNrcInput('');
    setQrDataUrl('');
    setOldDeviceName('');
    setLoginError('');

    // AYA Pay requires entering PIN / Password BEFORE requesting SMS OTP
    if (prov === 'aya') {
      setLoginStep('aya_password');
      setLoginBusy(false);
      setLoginStatusMsg(
        `AYA Pay အကောင့် 0${acc.phone} ၏ PIN / Password ကို ဦးစွာ ရိုက်ထည့်ပါ။`
      );
      return;
    }

    // WavePay & KBZPay dispatch SMS OTP immediately
    setLoginStep('requesting_otp');
    setLoginStatusMsg(`${provLabel} 0${acc.phone} အတွက် SMS OTP တောင်းဆိုနေပါသည်...`);
    setLoginBusy(true);

    try {
      const res = await apiFetch('/api/accounts/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: acc.phone,
          provider: prov,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginStep(prov === 'kbz' ? 'kbz_credentials' : 'wave_otp');
        setLoginError(data.message || 'SMS OTP တောင်းဆိုခြင်း မအောင်မြင်ပါ။');
        setLoginStatusMsg('');
      } else {
        setLoginStep(prov === 'kbz' ? 'kbz_credentials' : 'wave_otp');
        setLoginStatusMsg(
          data.message ||
            `0${acc.phone} သို့ ${provLabel} SMS OTP ပေးပို့လိုက်ပါပြီ။`
        );
      }
    } catch (err: any) {
      setLoginStep(prov === 'kbz' ? 'kbz_credentials' : 'wave_otp');
      setLoginError(err.message);
      setLoginStatusMsg('');
    } finally {
      setLoginBusy(false);
    }
  };

  // WavePay Step 1: Confirm SMS OTP
  const handleWaveConfirmOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginTarget || !otpInput.trim()) return;
    setLoginBusy(true);
    setLoginError('');

    try {
      const res = await apiFetch('/api/accounts/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loginTarget.phone,
          provider: 'wave',
          otp: otpInput.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.message || 'OTP မှားယွင်းနေပါသည် သို့မဟုတ် အတည်ပြု၍မရပါ။');
      } else {
        setLoginStep('wave_pin');
        setLoginStatusMsg('SMS OTP အတည်ပြုပြီးပါပြီ။ သင့် WavePay PIN ကို ရိုက်ထည့်ပါ။');
      }
    } catch (err: any) {
      setLoginError(err.message);
    } finally {
      setLoginBusy(false);
    }
  };

  // WavePay Step 2: Complete PIN Login
  const handleWaveCompletePin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginTarget || !pinInput.trim()) return;
    setLoginBusy(true);
    setLoginError('');

    try {
      const res = await apiFetch('/api/accounts/login-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loginTarget.phone,
          provider: 'wave',
          pin: pinInput.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.message || 'WavePay PIN Login မအောင်မြင်ပါ။');
      } else {
        const loggedPhone = loginTarget.phone;
        setLoginTarget(null);
        setBanner({
          type: 'success',
          message: `WavePay SIM 0${loggedPhone} Login အောင်မြင်ပါသည်။ လက်ကျန်ငွေ: ${Number(data.balance || 0).toLocaleString()} Ks`,
        });
        recordSecurityEventToFirestore(
          'login',
          `Authenticated WavePay SIM 0${loggedPhone}`
        ).catch(() => {});
        await onRefresh();
      }
    } catch (err: any) {
      setLoginError(err.message);
    } finally {
      setLoginBusy(false);
    }
  };

  // KBZPay Step 1: Submit SMS OTP + 6-digit PIN + NRC
  const handleKbzSubmitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginTarget || !otpInput.trim() || !pinInput.trim()) return;
    setLoginBusy(true);
    setLoginError('');

    try {
      const res = await apiFetch('/api/accounts/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loginTarget.phone,
          provider: 'kbz',
          otp: otpInput.trim(),
          pin: pinInput.trim(),
          nrc_id: loginNrcInput.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.message || 'KBZPay အတည်ပြုခြင်း မအောင်မြင်ပါ။');
      } else if (data.authenticated) {
        const loggedPhone = loginTarget.phone;
        setLoginTarget(null);
        setBanner({
          type: 'success',
          message: `KBZPay SIM 0${loggedPhone} Login အောင်မြင်ပါသည်။ လက်ကျန်ငွေ: ${Number(data.balance || 0).toLocaleString()} Ks`,
        });
        recordSecurityEventToFirestore(
          'login',
          `Authenticated KBZPay SIM 0${loggedPhone}`
        ).catch(() => {});
        await onRefresh();
      } else if (data.requires_qr && data.qr_data_url) {
        setQrDataUrl(data.qr_data_url);
        setLoginStep('kbz_qr');
        setLoginStatusMsg(
          data.message ||
            'KBZPay App ဖွင့်ထားသော ဖုန်းအဟောင်းဖြင့် ဤ QR Code ကို Scan ဖတ်၍ အတည်ပြုပြီးနောက် "Complete QR Verification" ကိုနှိပ်ပါ။'
        );
      }
    } catch (err: any) {
      setLoginError(err.message);
    } finally {
      setLoginBusy(false);
    }
  };

  // KBZPay Step 2 (if QR required): Complete QR Verification
  const handleKbzCompleteQr = async () => {
    if (!loginTarget) return;
    setLoginBusy(true);
    setLoginError('');

    try {
      const res = await apiFetch('/api/accounts/complete-device-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loginTarget.phone,
          provider: 'kbz',
          nrc_id: loginNrcInput.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.message || 'QR Scan အတည်ပြုချက် မရသေးပါ။');
      } else {
        const loggedPhone = loginTarget.phone;
        setLoginTarget(null);
        setBanner({
          type: 'success',
          message: `KBZPay SIM 0${loggedPhone} Login အောင်မြင်ပါသည်။ လက်ကျန်ငွေ: ${Number(data.balance || 0).toLocaleString()} Ks`,
        });
        recordSecurityEventToFirestore(
          'login',
          `Authenticated KBZPay SIM 0${loggedPhone}`
        ).catch(() => {});
        await onRefresh();
      }
    } catch (err: any) {
      setLoginError(err.message);
    } finally {
      setLoginBusy(false);
    }
  };

  // AYA Pay Step 1: Submit Password/PIN & Request SMS OTP (or immediate login if trusted)
  const handleAyaRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginTarget || !pinInput.trim()) return;
    setLoginBusy(true);
    setLoginError('');

    try {
      const res = await apiFetch('/api/accounts/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loginTarget.phone,
          provider: 'aya',
          password: pinInput.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.message || 'AYA Pay OTP တောင်းဆိုမှု မအောင်မြင်ပါ။');
      } else if (data.authenticated) {
        const loggedPhone = loginTarget.phone;
        setLoginTarget(null);
        setBanner({
          type: 'success',
          message: `AYA Pay SIM 0${loggedPhone} တိုက်ရိုက် Login အောင်မြင်ပါသည်။ လက်ကျန်ငွေ: ${Number(data.balance || 0).toLocaleString()} Ks`,
        });
        recordSecurityEventToFirestore(
          'login',
          `Authenticated AYA Pay SIM 0${loggedPhone}`
        ).catch(() => {});
        await onRefresh();
      } else {
        setLoginStep('aya_otp');
        setLoginStatusMsg(
          data.message ||
            `0${loginTarget.phone} သို့ AYA Pay SMS OTP ပေးပို့လိုက်ပါပြီ။ SMS ကုဒ်ကို ရိုက်ထည့်ပါ။`
        );
      }
    } catch (err: any) {
      setLoginError(err.message);
    } finally {
      setLoginBusy(false);
    }
  };

  // AYA Pay Step 2: Verify SMS OTP
  const handleAyaVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginTarget || !otpInput.trim()) return;
    setLoginBusy(true);
    setLoginError('');

    try {
      const res = await apiFetch('/api/accounts/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loginTarget.phone,
          provider: 'aya',
          otp: otpInput.trim(),
          password: pinInput.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.message || 'AYA Pay OTP အတည်ပြု၍ မရပါ။');
      } else if (data.authenticated) {
        const loggedPhone = loginTarget.phone;
        setLoginTarget(null);
        setBanner({
          type: 'success',
          message: `AYA Pay SIM 0${loggedPhone} Login အောင်မြင်ပါသည်။ လက်ကျန်ငွေ: ${Number(data.balance || 0).toLocaleString()} Ks`,
        });
        recordSecurityEventToFirestore(
          'login',
          `Authenticated AYA Pay SIM 0${loggedPhone}`
        ).catch(() => {});
        await onRefresh();
      } else if (data.awaiting_old_device) {
        setOldDeviceName(data.old_device_name || '');
        setLoginStep('aya_old_device');
        setLoginStatusMsg(
          data.message ||
            'သင်၏ AYA Pay ဖုန်းအဟောင်းတွင် New Device Login Notification ကို Approve နှိပ်ပေးပြီးနောက် "Complete Login" ကိုနှိပ်ပါ။'
        );
      }
    } catch (err: any) {
      setLoginError(err.message);
    } finally {
      setLoginBusy(false);
    }
  };

  // AYA Pay Step 3: Complete Old Device Approval
  const handleAyaCompleteOldDevice = async () => {
    if (!loginTarget) return;
    setLoginBusy(true);
    setLoginError('');

    try {
      const res = await apiFetch('/api/accounts/complete-device-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loginTarget.phone,
          provider: 'aya',
          password: pinInput.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.message || 'ဖုန်းအဟောင်းတွင် Approve မနှိပ်ရသေးပါ။');
      } else {
        const loggedPhone = loginTarget.phone;
        setLoginTarget(null);
        setBanner({
          type: 'success',
          message: `AYA Pay SIM 0${loggedPhone} Login အောင်မြင်ပါသည်။ လက်ကျန်ငွေ: ${Number(data.balance || 0).toLocaleString()} Ks`,
        });
        recordSecurityEventToFirestore(
          'login',
          `Authenticated AYA Pay SIM 0${loggedPhone}`
        ).catch(() => {});
        await onRefresh();
      }
    } catch (err: any) {
      setLoginError(err.message);
    } finally {
      setLoginBusy(false);
    }
  };

  const handleSyncSingle = async (acc: WaveAccount) => {
    const prov = getAccProvider(acc);
    const key = getAccKey(acc);
    setSyncingKey(key);
    setBanner(null);
    try {
      const res = await apiFetch(`/api/accounts/${acc.phone}/sync?provider=${prov}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({
          type: 'error',
          message: `${formatProviderLabel(prov)} 0${acc.phone}: ${data.message}`,
        });
      } else {
        setBanner({
          type: 'success',
          message: `${formatProviderLabel(prov)} 0${acc.phone} လက်ကျန်ငွေ: ${Number(data.balance || 0).toLocaleString()} Ks`,
        });
        await onRefresh();
      }
    } catch (err: any) {
      setBanner({ type: 'error', message: err.message });
    } finally {
      setSyncingKey(null);
    }
  };

  const handleSyncAllBalances = async () => {
    setSyncingAll(true);
    setBanner(null);
    try {
      const res = await apiFetch('/api/accounts/sync-all', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        await onRefresh();
        setBanner({
          type: 'success',
          message: 'ချိတ်ဆက်ထားသော Wallet အကောင့်အားလုံး၏ လက်ကျန်ငွေကို စစ်ဆေးပြီးပါပြီ။',
        });
      } else {
        setBanner({ type: 'error', message: data.message || 'Balance စစ်ဆေး၍ မရပါ။' });
      }
    } catch (err: any) {
      setBanner({ type: 'error', message: err.message });
    } finally {
      setSyncingAll(false);
    }
  };

  const handleLookupBeneficiary = async () => {
    if (!transferAcc || !receiverInput.trim()) return;
    const prov = getAccProvider(transferAcc);
    setCheckingName(true);
    setResolvedReceiverName('');
    setTransferStatus(null);
    try {
      const res = await apiFetch(`/api/accounts/${transferAcc.phone}/beneficiary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_phone: receiverInput.trim(),
          provider: prov,
        }),
      });
      const data = await res.json();
      if (res.ok && data.beneficiary_name) {
        setResolvedReceiverName(data.beneficiary_name);
      } else {
        setTransferStatus({ ok: false, msg: data.message || 'အကောင့်အမည် ရှာမတွေ့ပါ။' });
      }
    } catch (err: any) {
      setTransferStatus({ ok: false, msg: err.message });
    } finally {
      setCheckingName(false);
    }
  };

  const handleExecuteTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!transferAcc || !receiverInput.trim() || !amountInput) return;
    const prov = getAccProvider(transferAcc);
    setTransferBusy(true);
    setTransferStatus(null);

    try {
      const res = await apiFetch('/api/accounts/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender_phone: transferAcc.phone,
          sender_provider: prov,
          receiver_phone: receiverInput.trim(),
          amount: Number(amountInput),
          note: noteInput.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTransferStatus({ ok: false, msg: data.message || 'ငွေလွှဲခြင်း မအောင်မြင်ပါ။' });
      } else {
        setTransferStatus({
          ok: true,
          msg: `ငွေလွှဲအောင်မြင်ပါသည် — လက်ခံသူ: ${data.receiver_name} · Trx ID: ${data.trx_id}`,
        });
        await onRefresh();
      }
    } catch (err: any) {
      setTransferStatus({ ok: false, msg: err.message });
    } finally {
      setTransferBusy(false);
    }
  };

  const handleOpenHistory = async (acc: WaveAccount) => {
    const prov = getAccProvider(acc);
    setHistoryAcc(acc);
    setHistoryList([]);
    setHistoryError('');
    setHistoryLoading(true);

    try {
      const res = await apiFetch(
        `/api/accounts/${acc.phone}/history?provider=${prov}&limit=15`
      );
      const data = await res.json();
      if (!res.ok) {
        setHistoryError(data.message || 'မှတ်တမ်း ရယူ၍ မရပါ။');
      } else {
        setHistoryList(data.history || []);
      }
    } catch (err: any) {
      setHistoryError(err.message);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      const deletedPhone = deleteTarget.phone;
      const prov = getAccProvider(deleteTarget);
      const provLabel = formatProviderLabel(prov);
      const res = await apiFetch(`/api/accounts/${deletedPhone}?provider=${prov}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (res.ok) {
        setDeleteTarget(null);
        setBanner({ type: 'success', message: data.message });
        recordSecurityEventToFirestore(
          'account_removed',
          `Removed ${provLabel} SIM 0${deletedPhone}`
        ).catch(() => {});
        await onRefresh();
      } else {
        setBanner({ type: 'error', message: data.message || 'ဖျက်၍မရပါ။' });
      }
    } catch (err: any) {
      setBanner({ type: 'error', message: err.message });
    } finally {
      setDeleteBusy(false);
    }
  };

  const filteredAccounts = accounts.filter((acc) => {
    const prov = getAccProvider(acc);
    if (providerFilter !== 'all' && prov !== providerFilter) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      acc.phone.toLowerCase().includes(q) ||
      `0${acc.phone}`.includes(q) ||
      formatProviderLabel(prov).toLowerCase().includes(q) ||
      (acc.name || '').toLowerCase().includes(q) ||
      acc.model.toLowerCase().includes(q)
    );
  });

  const totalBalance = accounts.reduce((sum, a) => sum + (Number(a.balance) || 0), 0);
  const activeCount = accounts.filter((a) => Boolean(a.has_session)).length;
  const waveCount = accounts.filter((a) => getAccProvider(a) === 'wave').length;
  const kbzCount = accounts.filter((a) => getAccProvider(a) === 'kbz').length;
  const ayaCount = accounts.filter((a) => getAccProvider(a) === 'aya').length;

  const loginProvider = getAccProvider(loginTarget);

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Page Header & Metrics Strip */}
      <section className="border-b border-zinc-200 pb-6 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-black">
              Wallet SIM Accounts
            </h1>
            <p className="text-xs sm:text-sm text-zinc-600 max-w-2xl leading-relaxed">
              WavePay, KBZPay နှင့် AYA Pay အကောင့်များကို တိုက်ရိုက် ချိတ်ဆက်ပြီး လက်ကျန်ငွေ၊ ငွေလွှဲမှတ်တမ်း နှင့် Auto Payment Gateway အသုံးပြုနိုင်ပါသည်။
            </p>
          </div>

          <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowAddForm(!showAddForm)}
              className="px-4 py-2.5 sm:py-2 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer flex items-center justify-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>{showAddForm ? 'Close Form' : 'Add Wallet'}</span>
            </button>
            <button
              type="button"
              onClick={handleSyncAllBalances}
              disabled={syncingAll || activeCount === 0}
              className="px-3.5 py-2.5 sm:py-2 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 flex items-center justify-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncingAll ? 'animate-spin' : ''}`} />
              <span>Sync Balances</span>
            </button>
          </div>
        </div>

        {/* Clean Monochrome Summary Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6 pt-1">
          <div className="p-4 sm:p-0 border sm:border-0 border-zinc-200 rounded-xl sm:rounded-none bg-zinc-50/70 sm:bg-transparent">
            <div className="text-xs font-medium text-zinc-500">Total Live Liquidity</div>
            <div className="text-xl sm:text-2xl font-bold font-mono tabular-nums text-black mt-1">
              {totalBalance.toLocaleString()} Ks
            </div>
          </div>

          <div className="p-4 sm:p-0 border sm:border-0 border-zinc-200 rounded-xl sm:rounded-none bg-zinc-50/70 sm:bg-transparent sm:border-l sm:border-zinc-200 sm:pl-6">
            <div className="text-xs font-medium text-zinc-500">Authenticated Sessions</div>
            <div className="text-xl sm:text-2xl font-bold font-mono tabular-nums text-black mt-1">
              {activeCount}{' '}
              <span className="text-sm font-normal text-zinc-500">/ {accounts.length} Wallets</span>
            </div>
            <div className="text-[11px] text-zinc-500 mt-0.5">
              WavePay {waveCount} · KBZPay {kbzCount} · AYA Pay {ayaCount}
            </div>
          </div>

          <div className="p-4 sm:p-0 border sm:border-0 border-zinc-200 rounded-xl sm:rounded-none bg-zinc-50/70 sm:bg-transparent sm:border-l sm:border-zinc-200 sm:pl-6 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-zinc-500">Workspace API Key</span>
              <button
                type="button"
                onClick={onNavigateToApiDocs}
                className="text-xs font-semibold text-black underline underline-offset-2 hover:text-zinc-600 cursor-pointer shrink-0"
              >
                API Docs
              </button>
            </div>
            <div className="flex items-center gap-2 mt-1.5 min-w-0">
              <code className="text-xs font-mono text-black bg-zinc-100 border border-zinc-200 px-2.5 py-1 rounded truncate flex-1 min-w-0">
                {workspace?.api_key || (isLoading ? 'Loading...' : 'Tap Retry to load')}
              </code>
              {workspace?.api_key ? (
                <button
                  type="button"
                  onClick={copyApiKey}
                  className="px-2.5 py-1 text-xs font-semibold bg-black hover:bg-zinc-800 text-white rounded cursor-pointer flex items-center gap-1 shrink-0"
                >
                  {copiedKey ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedKey ? 'Copied' : 'Copy'}</span>
                </button>
              ) : (
                !isLoading && (
                  <button
                    type="button"
                    onClick={() => onRefresh()}
                    className="px-2.5 py-1 text-xs font-semibold bg-black hover:bg-zinc-800 text-white rounded cursor-pointer flex items-center gap-1 shrink-0"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Retry</span>
                  </button>
                )
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Monochrome Notification Banner */}
      {banner && (
        <div
          className={`p-4 rounded-xl border flex items-start justify-between gap-3 text-xs sm:text-sm ${
            banner.type === 'success'
              ? 'bg-zinc-50 border-black text-black'
              : 'bg-white border-2 border-black text-black'
          }`}
        >
          <div className="flex items-start gap-2.5">
            {banner.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-black shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="w-4 h-4 text-black shrink-0 mt-0.5" />
            )}
            <span className="font-medium leading-relaxed">{banner.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-zinc-500 hover:text-black cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Add Wallet Account Form */}
      {showAddForm && (
        <section className="bg-zinc-50 border border-zinc-200 rounded-xl p-4 sm:p-6 space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-black">Register Wallet SIM Account</h2>
              <p className="text-xs text-zinc-600 mt-0.5">
                ချိတ်ဆက်မည့် Wallet အမျိုးအစား ရွေးချယ်ပြီး ဖုန်းနံပါတ်နှင့် Device အချက်အလက် ထည့်သွင်းပါ။
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="text-zinc-500 hover:text-black cursor-pointer p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Interactive Wallet Provider Selector */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-zinc-800">
              Wallet Provider ရွေးချယ်ပါ *
            </label>
            <div className="grid grid-cols-3 sm:inline-flex items-center gap-1 p-1 bg-zinc-200/70 border border-zinc-300 rounded-lg">
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
                  onClick={() => setProviderInput(p.id)}
                  className={`px-4 py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                    providerInput === p.id
                      ? 'bg-black text-white'
                      : 'text-zinc-700 hover:text-black'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <form
            onSubmit={handleAddAccount}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
          >
            <div>
              <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                {formatProviderLabel(providerInput)} ဖုန်းနံပါတ် *
              </label>
              <input
                type="tel"
                required
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                placeholder="09xxxxxxxxx"
                className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm font-mono text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                Device Model *
              </label>
              <input
                type="text"
                required
                value={modelInput}
                onChange={(e) => setModelInput(e.target.value)}
                placeholder="Pixel 6, Xiaomi 13"
                className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                Android OS Version *
              </label>
              <input
                type="text"
                required
                value={osInput}
                onChange={(e) => setOsInput(e.target.value)}
                placeholder="13, 14"
                className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm font-mono text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                မှတ်ချက်အမည် (Optional)
              </label>
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Main Wallet"
                className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
              />
            </div>

            {providerInput === 'kbz' && (
              <div className="sm:col-span-2 lg:col-span-2">
                <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                  KBZPay မှတ်ပုံတင်အမှတ် / NRC (Optional — Device စစ်ဆေးမှုအတွက်)
                </label>
                <input
                  type="text"
                  value={nrcInput}
                  onChange={(e) => setNrcInput(e.target.value)}
                  placeholder="12/OUKAMA(N)123456"
                  className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm font-mono uppercase text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                />
              </div>
            )}

            <div className="sm:col-span-2 lg:col-span-4 flex flex-col-reverse sm:flex-row justify-end gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="px-4 py-2.5 sm:py-2 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isAdding}
                className="px-5 py-2.5 sm:py-2 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer disabled:opacity-50"
              >
                {isAdding ? 'Saving...' : `Save ${formatProviderLabel(providerInput)} Account`}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Accounts Section: Provider Filter + Mobile Cards + Desktop Table */}
      <section className="space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-bold text-black">
              Registered Wallets ({filteredAccounts.length})
            </span>
            {accounts.length > 0 && (
              <div className="flex items-center gap-1 p-1 bg-zinc-100 border border-zinc-200 rounded-lg overflow-x-auto">
                {(
                  [
                    { id: 'all', label: `All (${accounts.length})` },
                    { id: 'wave', label: `WavePay (${waveCount})` },
                    { id: 'kbz', label: `KBZPay (${kbzCount})` },
                    { id: 'aya', label: `AYA Pay (${ayaCount})` },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setProviderFilter(tab.id)}
                    className={`px-2.5 py-1 text-xs font-semibold rounded whitespace-nowrap transition-colors cursor-pointer ${
                      providerFilter === tab.id
                        ? 'bg-black text-white'
                        : 'text-zinc-600 hover:text-black'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {accounts.length > 0 && (
            <div className="relative w-full lg:w-72">
              <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search phone, wallet, name..."
                className="w-full pl-8 pr-3 py-2 bg-white border border-zinc-300 rounded-lg text-xs text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
              />
            </div>
          )}
        </div>

        {isLoading ? (
          <div className="border border-zinc-200 rounded-xl p-6 space-y-3 bg-white">
            <div className="h-10 bg-zinc-100 rounded animate-pulse" />
            <div className="h-10 bg-zinc-100 rounded animate-pulse" />
          </div>
        ) : accounts.length === 0 ? (
          <div className="border border-zinc-200 bg-zinc-50/60 rounded-xl py-14 px-6 text-center space-y-3">
            <h3 className="text-base font-bold text-black">
              ချိတ်ဆက်ထားသော Wallet အကောင့် မရှိသေးပါ
            </h3>
            <p className="text-xs text-zinc-600 max-w-md mx-auto leading-relaxed">
              သင်၏ WavePay, KBZPay သို့မဟုတ် AYA Pay ဖုန်းနံပါတ်ကို ထည့်သွင်းပြီး SMS OTP / PIN ဖြင့် စတင်ချိတ်ဆက်ပါ။
            </p>
            <div className="pt-2">
              <button
                type="button"
                onClick={() => setShowAddForm(true)}
                className="px-4 py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer inline-flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>Add First Wallet</span>
              </button>
            </div>
          </div>
        ) : filteredAccounts.length === 0 ? (
          <div className="border border-zinc-200 rounded-xl py-10 px-6 text-center text-xs text-zinc-500">
            ရွေးချယ်ထားသော စစ်ထုတ်မှုနှင့် ကိုက်ညီသည့် အကောင့် မရှိပါ။
          </div>
        ) : (
          <>
            {/* MOBILE CARD LAYOUT (< md) */}
            <div className="grid grid-cols-1 gap-3.5 md:hidden">
              {filteredAccounts.map((acc) => {
                const prov = getAccProvider(acc);
                const provLabel = formatProviderLabel(prov);
                const key = getAccKey(acc);
                const hasSession = Boolean(acc.has_session);
                const isSyncing = syncingKey === key;
                const supportsTransfer = prov !== 'aya';

                return (
                  <div
                    key={key}
                    className="bg-white border border-zinc-200 rounded-xl p-4 space-y-3.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-zinc-500">
                          {provLabel} · {acc.model} (OS {acc.os_version})
                        </div>
                        <div className="font-mono text-base font-bold text-black mt-0.5">
                          0{acc.phone}
                        </div>
                        <div className="text-xs text-zinc-600 truncate mt-0.5">
                          {acc.name || 'Account Name Pending'}
                        </div>
                      </div>
                      <span className="text-xs font-semibold text-black shrink-0">
                        {hasSession ? 'Active' : 'Needs Login'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between py-2.5 px-3 bg-zinc-50 border border-zinc-200 rounded-lg">
                      <span className="text-xs font-medium text-zinc-600">Live Balance</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-base font-bold tabular-nums text-black">
                          {(Number(acc.balance) || 0).toLocaleString()} Ks
                        </span>
                        <button
                          type="button"
                          onClick={() => handleSyncSingle(acc)}
                          disabled={isSyncing || !hasSession}
                          className="p-1.5 bg-white border border-zinc-300 rounded-md text-black disabled:opacity-40 cursor-pointer"
                          title="Sync Balance"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 pt-0.5">
                      <button
                        type="button"
                        onClick={() => initiateWalletLogin(acc)}
                        className="py-2.5 px-3 text-xs font-semibold bg-black text-white hover:bg-zinc-800 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <KeyRound className="w-3.5 h-3.5" />
                        <span>{hasSession ? 'Re-Login' : 'Login'}</span>
                      </button>

                      <button
                        type="button"
                        disabled={!hasSession || !supportsTransfer}
                        title={
                          !supportsTransfer
                            ? 'AYA Pay supports Deposit/History/Balance'
                            : 'Send Money'
                        }
                        onClick={() => {
                          setTransferAcc(acc);
                          setReceiverInput('');
                          setResolvedReceiverName('');
                          setAmountInput('');
                          setNoteInput('');
                          setTransferStatus(null);
                        }}
                        className="py-2.5 px-3 text-xs font-semibold bg-white text-black hover:bg-zinc-100 border border-zinc-300 rounded-lg flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                      >
                        <ArrowRightLeft className="w-3.5 h-3.5" />
                        <span>{supportsTransfer ? 'Transfer' : 'Deposit Only'}</span>
                      </button>

                      <button
                        type="button"
                        disabled={!hasSession}
                        onClick={() => handleOpenHistory(acc)}
                        className="py-2.5 px-3 text-xs font-semibold bg-white text-black hover:bg-zinc-100 border border-zinc-300 rounded-lg flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                      >
                        <History className="w-3.5 h-3.5" />
                        <span>History</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setDeleteTarget(acc)}
                        className="py-2.5 px-3 text-xs font-semibold bg-white text-zinc-700 hover:text-black hover:bg-zinc-100 border border-zinc-300 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Remove</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* DESKTOP TABLE LAYOUT (>= md) */}
            <div className="hidden md:block border border-zinc-200 rounded-xl overflow-hidden bg-white">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-zinc-200 text-zinc-500 bg-zinc-50">
                      <th className="py-3.5 px-4 font-semibold">Wallet / Phone / Name</th>
                      <th className="py-3.5 px-4 font-semibold">Device Profile</th>
                      <th className="py-3.5 px-4 font-semibold">Session State</th>
                      <th className="py-3.5 px-4 font-semibold text-right">Live Balance</th>
                      <th className="py-3.5 px-4 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 text-zinc-800">
                    {filteredAccounts.map((acc) => {
                      const prov = getAccProvider(acc);
                      const provLabel = formatProviderLabel(prov);
                      const key = getAccKey(acc);
                      const hasSession = Boolean(acc.has_session);
                      const isSyncing = syncingKey === key;
                      const supportsTransfer = prov !== 'aya';

                      return (
                        <tr key={key} className="hover:bg-zinc-50/80 transition-colors">
                          <td className="py-3.5 px-4">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-zinc-600">{provLabel}</span>
                              <span className="text-zinc-400">·</span>
                              <span className="font-mono font-bold text-sm text-black">
                                0{acc.phone}
                              </span>
                            </div>
                            <div className="text-xs text-zinc-500 mt-0.5">
                              {acc.name || 'Account Name Pending'}
                            </div>
                          </td>

                          <td className="py-3.5 px-4 text-zinc-700">
                            <span>{acc.model}</span>
                            <span className="text-zinc-400 mx-1.5">·</span>
                            <span className="font-mono text-zinc-500">Android {acc.os_version}</span>
                          </td>

                          <td className="py-3.5 px-4">
                            {hasSession ? (
                              <span className="text-black font-semibold">Connected</span>
                            ) : (
                              <span className="text-zinc-500 font-medium">Awaiting Login</span>
                            )}
                          </td>

                          <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                            <div className="inline-flex items-center justify-end gap-2">
                              <span className="text-sm font-bold text-black">
                                {(Number(acc.balance) || 0).toLocaleString()} Ks
                              </span>
                              <button
                                type="button"
                                onClick={() => handleSyncSingle(acc)}
                                disabled={isSyncing || !hasSession}
                                title="Sync live balance"
                                className="p-1.5 rounded-md bg-white hover:bg-zinc-100 border border-zinc-300 text-black disabled:opacity-40 cursor-pointer"
                              >
                                <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                              </button>
                            </div>
                          </td>

                          <td className="py-3.5 px-4 text-right">
                            <div className="inline-flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => initiateWalletLogin(acc)}
                                className="px-3 py-1.5 text-xs font-semibold bg-black hover:bg-zinc-800 text-white rounded-lg whitespace-nowrap cursor-pointer flex items-center gap-1"
                              >
                                <KeyRound className="w-3.5 h-3.5" />
                                <span>{hasSession ? 'Re-Login' : 'Login'}</span>
                              </button>

                              <button
                                type="button"
                                disabled={!hasSession || !supportsTransfer}
                                title={
                                  !supportsTransfer
                                    ? 'AYA Pay supports Deposit/History/Balance'
                                    : 'Send Money'
                                }
                                onClick={() => {
                                  setTransferAcc(acc);
                                  setReceiverInput('');
                                  setResolvedReceiverName('');
                                  setAmountInput('');
                                  setNoteInput('');
                                  setTransferStatus(null);
                                }}
                                className="px-2.5 py-1.5 text-xs font-semibold bg-white hover:bg-zinc-100 text-black border border-zinc-300 rounded-lg whitespace-nowrap cursor-pointer disabled:opacity-40 flex items-center gap-1"
                              >
                                <ArrowRightLeft className="w-3.5 h-3.5" />
                                <span>Transfer</span>
                              </button>

                              <button
                                type="button"
                                disabled={!hasSession}
                                onClick={() => handleOpenHistory(acc)}
                                className="px-2.5 py-1.5 text-xs font-semibold bg-white hover:bg-zinc-100 text-black border border-zinc-300 rounded-lg whitespace-nowrap cursor-pointer disabled:opacity-40 flex items-center gap-1"
                              >
                                <History className="w-3.5 h-3.5" />
                                <span>History</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => setDeleteTarget(acc)}
                                className="p-1.5 text-zinc-500 hover:text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg cursor-pointer"
                                title="Remove Wallet"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>

      {/* Cloud Activity Trail */}
      {cloudEvents.length > 0 && (
        <section className="space-y-3 pt-2">
          <div className="text-xs font-bold text-black">Recent Account Activity</div>
          <div className="border border-zinc-200 rounded-xl bg-white divide-y divide-zinc-200">
            {cloudEvents.slice(0, 5).map((ev) => (
              <div
                key={ev.id}
                className="px-4 py-3 flex items-center justify-between gap-3 text-xs"
              >
                <span className="text-zinc-800 truncate">{ev.summary}</span>
                <span className="font-mono text-[11px] text-zinc-500 shrink-0">
                  {new Date(ev.createdAtMs).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Modal 1: Multi-Provider Login (WavePay / KBZPay / AYA Pay) */}
      {loginTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-zinc-300 rounded-2xl p-5 sm:p-6 max-w-md w-full space-y-4 shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between border-b border-zinc-200 pb-3">
              <div>
                <h3 className="text-base font-bold text-black">
                  {formatProviderLabel(loginProvider)} Login · 0{loginTarget.phone}
                </h3>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {loginProvider === 'wave' &&
                    (loginStep === 'wave_pin'
                      ? 'Step 2 of 2: Enter WavePay PIN'
                      : 'Step 1 of 2: Confirm SMS OTP')}
                  {loginProvider === 'kbz' &&
                    (loginStep === 'kbz_qr'
                      ? 'Step 2: Scan Device Verification QR'
                      : 'Step 1: Enter SMS OTP, 6-Digit PIN & NRC')}
                  {loginProvider === 'aya' &&
                    (loginStep === 'aya_password'
                      ? 'Step 1: Enter AYA Pay PIN / Password'
                      : loginStep === 'aya_otp'
                        ? 'Step 2: Confirm SMS OTP'
                        : 'Step 3: Approve on Old Phone')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setLoginTarget(null)}
                className="text-zinc-500 hover:text-black cursor-pointer p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {loginStatusMsg && (
              <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200 text-xs text-zinc-800 leading-relaxed">
                {loginStatusMsg}
              </div>
            )}

            {loginError && (
              <div className="p-3 rounded-lg bg-white border-2 border-black text-xs text-black font-medium leading-relaxed">
                {loginError}
              </div>
            )}

            {loginStep === 'requesting_otp' && (
              <div className="py-6 text-center space-y-2">
                <RefreshCw className="w-6 h-6 text-black animate-spin mx-auto" />
                <div className="text-xs text-zinc-600">SMS OTP တောင်းဆိုနေပါသည်...</div>
              </div>
            )}

            {/* WAVEPAY STEP 1: OTP */}
            {loginStep === 'wave_otp' && (
              <form onSubmit={handleWaveConfirmOtp} className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-semibold text-zinc-800">
                      WavePay SMS OTP ကုဒ် *
                    </label>
                    <button
                      type="button"
                      disabled={loginBusy}
                      onClick={() => initiateWalletLogin(loginTarget)}
                      className="text-xs font-semibold text-black underline cursor-pointer"
                    >
                      Resend SMS
                    </button>
                  </div>
                  <input
                    type="text"
                    inputMode="numeric"
                    required
                    maxLength={8}
                    value={otpInput}
                    onChange={(e) => setOtpInput(e.target.value)}
                    placeholder="SMS OTP ရိုက်ထည့်ပါ"
                    autoFocus
                    className="w-full px-4 py-2.5 bg-white border border-zinc-300 rounded-lg text-base font-mono text-center tracking-widest text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                  />
                </div>

                <div className="flex gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => setLoginTarget(null)}
                    className="flex-1 py-2.5 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loginBusy || !otpInput.trim()}
                    className="flex-1 py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer disabled:opacity-40"
                  >
                    {loginBusy ? 'Verifying...' : 'Confirm SMS OTP'}
                  </button>
                </div>
              </form>
            )}

            {/* WAVEPAY STEP 2: PIN */}
            {loginStep === 'wave_pin' && (
              <form onSubmit={handleWaveCompletePin} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                    WavePay PIN (၄ လုံး သို့မဟုတ် ၆ လုံး) *
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    required
                    maxLength={6}
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value)}
                    placeholder="••••"
                    autoFocus
                    className="w-full px-4 py-2.5 bg-white border border-zinc-300 rounded-lg text-base font-mono text-center tracking-widest text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                  />
                </div>

                <div className="flex gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => setLoginStep('wave_otp')}
                    className="flex-1 py-2.5 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg cursor-pointer"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={loginBusy || !pinInput.trim()}
                    className="flex-1 py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer disabled:opacity-40"
                  >
                    {loginBusy ? 'Signing In...' : 'Complete Login'}
                  </button>
                </div>
              </form>
            )}

            {/* KBZPAY STEP 1: OTP + 6-DIGIT PIN + NRC */}
            {loginStep === 'kbz_credentials' && (
              <form onSubmit={handleKbzSubmitCredentials} className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-semibold text-zinc-800">
                      KBZPay SMS OTP ကုဒ် *
                    </label>
                    <button
                      type="button"
                      disabled={loginBusy}
                      onClick={() => initiateWalletLogin(loginTarget)}
                      className="text-xs font-semibold text-black underline cursor-pointer"
                    >
                      Resend SMS
                    </button>
                  </div>
                  <input
                    type="text"
                    inputMode="numeric"
                    required
                    maxLength={8}
                    value={otpInput}
                    onChange={(e) => setOtpInput(e.target.value)}
                    placeholder="SMS OTP (ဥပမာ 123456)"
                    autoFocus
                    className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm font-mono text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                    KBZPay 6-Digit PIN *
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    required
                    maxLength={6}
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value)}
                    placeholder="••••••"
                    className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm font-mono tracking-widest text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                    မှတ်ပုံတင်အမှတ် / NRC {loginTarget.has_nrc ? '(Saved — Optional Override)' : '(Recommended)'}
                  </label>
                  <input
                    type="text"
                    value={loginNrcInput}
                    onChange={(e) => setLoginNrcInput(e.target.value)}
                    placeholder="12/OUKAMA(N)123456"
                    className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm font-mono uppercase text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1">
                    Device အသစ်အတည်ပြုရန် KBZPay မှ NRC စစ်ဆေးပါက အလိုအလျောက် အတည်ပြုပေးပါမည်။
                  </p>
                </div>

                <div className="flex gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => setLoginTarget(null)}
                    className="flex-1 py-2.5 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loginBusy || !otpInput.trim() || !pinInput.trim()}
                    className="flex-1 py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer disabled:opacity-40"
                  >
                    {loginBusy ? 'Verifying KBZPay...' : 'Verify & Login'}
                  </button>
                </div>
              </form>
            )}

            {/* KBZPAY STEP 2: QR SCAN VERIFICATION */}
            {loginStep === 'kbz_qr' && (
              <div className="space-y-4">
                {qrDataUrl && (
                  <div className="p-4 bg-white border border-zinc-300 rounded-xl flex flex-col items-center justify-center space-y-2">
                    <img
                      src={qrDataUrl}
                      alt="KBZPay Device Verification QR"
                      className="w-52 h-52 object-contain"
                    />
                    <span className="text-[11px] text-zinc-500 text-center">
                      KBZPay App ဖွင့်ထားသော ဖုန်းအဟောင်းမှ Scan ဖတ်၍ Confirm နှိပ်ပါ
                    </span>
                  </div>
                )}

                <div className="flex gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => setLoginStep('kbz_credentials')}
                    className="flex-1 py-2.5 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg cursor-pointer"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={loginBusy}
                    onClick={handleKbzCompleteQr}
                    className="flex-1 py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer disabled:opacity-40"
                  >
                    {loginBusy ? 'Checking QR...' : 'Complete QR Verification'}
                  </button>
                </div>
              </div>
            )}

            {/* AYA PAY STEP 1: PASSWORD / PIN */}
            {loginStep === 'aya_password' && (
              <form onSubmit={handleAyaRequestOtp} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                    AYA Pay PIN / Password *
                  </label>
                  <input
                    type="password"
                    required
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value)}
                    placeholder="AYA Pay PIN ရိုက်ထည့်ပါ"
                    autoFocus
                    className="w-full px-4 py-2.5 bg-white border border-zinc-300 rounded-lg text-base font-mono text-center tracking-widest text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                  />
                </div>

                <div className="flex gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => setLoginTarget(null)}
                    className="flex-1 py-2.5 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loginBusy || !pinInput.trim()}
                    className="flex-1 py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer disabled:opacity-40"
                  >
                    {loginBusy ? 'Checking & Sending OTP...' : 'Continue'}
                  </button>
                </div>
              </form>
            )}

            {/* AYA PAY STEP 2: SMS OTP */}
            {loginStep === 'aya_otp' && (
              <form onSubmit={handleAyaVerifyOtp} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                    AYA Pay SMS OTP ကုဒ် *
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    required
                    maxLength={8}
                    value={otpInput}
                    onChange={(e) => setOtpInput(e.target.value)}
                    placeholder="SMS OTP ရိုက်ထည့်ပါ"
                    autoFocus
                    className="w-full px-4 py-2.5 bg-white border border-zinc-300 rounded-lg text-base font-mono text-center tracking-widest text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                  />
                </div>

                <div className="flex gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => setLoginStep('aya_password')}
                    className="flex-1 py-2.5 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg cursor-pointer"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={loginBusy || !otpInput.trim()}
                    className="flex-1 py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer disabled:opacity-40"
                  >
                    {loginBusy ? 'Verifying OTP...' : 'Verify OTP'}
                  </button>
                </div>
              </form>
            )}

            {/* AYA PAY STEP 3: OLD DEVICE APPROVAL */}
            {loginStep === 'aya_old_device' && (
              <div className="space-y-4">
                <div className="p-3.5 bg-zinc-50 border border-zinc-200 rounded-xl text-xs text-zinc-700 space-y-1">
                  <div className="font-semibold text-black">
                    Old Device Confirmation Required {oldDeviceName ? `(${oldDeviceName})` : ''}
                  </div>
                  <p className="leading-relaxed">
                    သင်၏ ဖုန်းအဟောင်းပေါ်ရှိ AYA Pay App Notification တွင် New Device Login ကို Approve နှိပ်ပြီးပါက အောက်ပါခလုတ်ကို နှိပ်ပါ။
                  </p>
                </div>

                <div className="flex gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => setLoginTarget(null)}
                    className="flex-1 py-2.5 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={loginBusy}
                    onClick={handleAyaCompleteOldDevice}
                    className="flex-1 py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer disabled:opacity-40"
                  >
                    {loginBusy ? 'Completing...' : 'Complete Login'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal 2: Live P2P Transfer (WavePay & KBZPay) */}
      {transferAcc && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-zinc-300 rounded-2xl p-5 sm:p-6 max-w-md w-full space-y-4 shadow-xl">
            <div className="flex items-start justify-between border-b border-zinc-200 pb-3">
              <div>
                <h3 className="text-base font-bold text-black">
                  Send Money ({formatProviderLabel(transferAcc.provider)})
                </h3>
                <p className="text-xs text-zinc-600 font-mono mt-0.5">
                  From: 0{transferAcc.phone} · Available:{' '}
                  {(Number(transferAcc.balance) || 0).toLocaleString()} Ks
                </p>
              </div>
              <button
                type="button"
                onClick={() => setTransferAcc(null)}
                className="text-zinc-500 hover:text-black cursor-pointer p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleExecuteTransfer} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                  လက်ခံမည့် {formatProviderLabel(transferAcc.provider)} ဖုန်းနံပါတ် *
                </label>
                <div className="flex gap-2">
                  <input
                    type="tel"
                    required
                    value={receiverInput}
                    onChange={(e) => {
                      setReceiverInput(e.target.value);
                      setResolvedReceiverName('');
                    }}
                    placeholder="09xxxxxxxxx"
                    className="flex-1 min-w-0 px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm font-mono text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                  />
                  <button
                    type="button"
                    onClick={handleLookupBeneficiary}
                    disabled={checkingName || !receiverInput.trim()}
                    className="px-3 py-2.5 text-xs font-semibold bg-zinc-100 hover:bg-zinc-200 border border-zinc-300 text-black rounded-lg whitespace-nowrap cursor-pointer disabled:opacity-40 flex items-center gap-1.5 shrink-0"
                  >
                    <UserCheck className="w-3.5 h-3.5" />
                    <span>{checkingName ? '...' : 'Check Name'}</span>
                  </button>
                </div>
                {resolvedReceiverName && (
                  <div className="mt-1.5 text-xs text-black font-semibold">
                    Account Name: {resolvedReceiverName}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                  လွှဲမည့် ငွေပမာဏ (Ks) *
                </label>
                <input
                  type="number"
                  required
                  min="1"
                  step="1"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  placeholder="ငွေပမာဏ ရိုက်ထည့်ပါ"
                  className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm font-mono tabular-nums text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                  Note (Optional)
                </label>
                <input
                  type="text"
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  placeholder="မှတ်ချက်"
                  className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                />
              </div>

              {transferStatus && (
                <div
                  className={`p-3 rounded-lg border text-xs font-medium ${
                    transferStatus.ok
                      ? 'bg-zinc-50 border-black text-black'
                      : 'bg-white border-2 border-black text-black'
                  }`}
                >
                  {transferStatus.msg}
                </div>
              )}

              <div className="flex gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => setTransferAcc(null)}
                  className="flex-1 py-2.5 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={transferBusy || !receiverInput.trim() || !amountInput}
                  className="flex-1 py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer disabled:opacity-40"
                >
                  {transferBusy ? 'Sending...' : 'Confirm Transfer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal 3: Live Transaction History */}
      {historyAcc && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-zinc-300 rounded-2xl p-5 sm:p-6 max-w-lg w-full max-h-[85vh] flex flex-col space-y-4 shadow-xl">
            <div className="flex items-start justify-between border-b border-zinc-200 pb-3 gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-black">
                  {formatProviderLabel(historyAcc.provider)} History · 0{historyAcc.phone}
                </h3>
                <p className="text-xs text-zinc-500 mt-0.5 truncate">
                  Recent completed wallet transactions
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHistoryAcc(null)}
                className="text-zinc-500 hover:text-black cursor-pointer p-1 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2.5 pr-0.5">
              {historyLoading ? (
                <div className="py-10 text-center space-y-2">
                  <RefreshCw className="w-5 h-5 text-black animate-spin mx-auto" />
                  <div className="text-xs text-zinc-600">မှတ်တမ်း ဆွဲယူနေပါသည်...</div>
                </div>
              ) : historyError ? (
                <div className="p-4 rounded-xl bg-white border-2 border-black text-xs text-black font-medium leading-relaxed">
                  {historyError}
                </div>
              ) : historyList.length === 0 ? (
                <div className="py-10 text-center text-xs text-zinc-500">
                  ဤအကောင့်တွင် ငွေလွှဲမှတ်တမ်း မရှိသေးပါ။
                </div>
              ) : (
                historyList.map((item, idx) => (
                  <div
                    key={`${item.transId || 'trx'}-${idx}`}
                    className="p-3.5 bg-zinc-50 border border-zinc-200 rounded-xl flex items-start justify-between gap-3 text-xs"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="font-mono font-bold text-black break-all">
                        ID: {item.transId}
                      </div>
                      <div className="text-zinc-600 break-words">{item.title}</div>
                      {item.time && (
                        <div className="font-mono text-[11px] text-zinc-500">{item.time}</div>
                      )}
                    </div>
                    <div className="text-right font-mono tabular-nums shrink-0">
                      <span className="text-sm font-bold text-black">
                        {item.direction === 'CR' ? '+' : '-'}
                        {item.amount.toLocaleString()} Ks
                      </span>
                      <div className="text-[10px] font-sans font-medium text-zinc-500 mt-0.5">
                        {item.direction === 'CR' ? 'Received' : 'Sent'}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <button
              type="button"
              onClick={() => setHistoryAcc(null)}
              className="w-full py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Modal 4: Delete Account Confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-zinc-300 rounded-2xl p-5 sm:p-6 max-w-sm w-full space-y-4 shadow-xl">
            <h3 className="text-base font-bold text-black">
              Remove {formatProviderLabel(deleteTarget.provider)} Account
            </h3>
            <p className="text-xs text-zinc-700 leading-relaxed">
              {formatProviderLabel(deleteTarget.provider)} SIM{' '}
              <span className="font-mono font-bold text-black">0{deleteTarget.phone}</span> ကို စာရင်းမှ ဖယ်ရှားရန် သေချာပါသလား?
            </p>
            <div className="flex gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="flex-1 py-2.5 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={deleteBusy}
                className="flex-1 py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer disabled:opacity-40"
              >
                {deleteBusy ? 'Removing...' : 'Confirm Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
