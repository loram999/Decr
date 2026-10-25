import React, { useState, useEffect, useMemo } from 'react';
import {
  RefreshCw,
  ArrowRightLeft,
  History,
  Trash2,
  Plus,
  Copy,
  Check,
  X,
  CheckCircle2,
  AlertCircle,
  Search,
} from 'lucide-react';
import {
  WaveAccount,
  WalletProvider,
  Workspace,
  Merchant,
  GatewayLog,
  UsedTrxRecord,
  TransactionHistoryItem,
  formatProviderLabel,
} from '../types';
import { apiFetch } from '../api';

interface AdminPanel990Props {
  onRefreshGlobal: () => Promise<void> | void;
}

function getAccProvider(acc: Pick<WaveAccount, 'provider'>): WalletProvider {
  if (acc.provider === 'kbz') return 'kbz';
  if (acc.provider === 'aya') return 'aya';
  return 'wave';
}

function makeUiAccountKey(acc: Pick<WaveAccount, 'phone' | 'workspace_id' | 'provider'>): string {
  return `${acc.workspace_id || 'default'}:${getAccProvider(acc)}:${acc.phone}`;
}

function parseUiAccountKey(key: string): {
  workspaceId?: string;
  provider: WalletProvider;
  phone: string;
} {
  const parts = key.split(':');
  if (parts.length >= 3) {
    const phone = parts.pop() || '';
    const provRaw = parts.pop() || 'wave';
    const workspaceId = parts.join(':') || undefined;
    const provider: WalletProvider =
      provRaw === 'kbz' ? 'kbz' : provRaw === 'aya' ? 'aya' : 'wave';
    return { workspaceId, provider, phone };
  }
  if (parts.length === 2) {
    return { workspaceId: parts[0] || undefined, provider: 'wave', phone: parts[1] || '' };
  }
  return { provider: 'wave', phone: key };
}

export const AdminPanel990: React.FC<AdminPanel990Props> = ({ onRefreshGlobal }) => {
  const [subTab, setSubTab] = useState<
    'accounts' | 'users' | 'db_search' | 'transfer' | 'merchants' | 'logs' | 'used_trx'
  >('accounts');
  const [isLoading, setIsLoading] = useState(true);
  const [overview, setOverview] = useState<{
    total_balance: number;
    total_accounts: number;
    active_accounts: number;
    total_workspaces: number;
    total_merchants: number;
    total_transactions: number;
  }>({
    total_balance: 0,
    total_accounts: 0,
    active_accounts: 0,
    total_workspaces: 0,
    total_merchants: 0,
    total_transactions: 0,
  });

  const [accounts, setAccounts] = useState<WaveAccount[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [logs, setLogs] = useState<GatewayLog[]>([]);
  const [usedTrx, setUsedTrx] = useState<UsedTrxRecord[]>([]);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  // Filters on All Wallet Accounts
  const [searchQuery, setSearchQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<'all' | WalletProvider>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'offline' | 'removed'>('all');
  const [workspaceFilter, setWorkspaceFilter] = useState<string>('');

  // Direct Transfer state (composite value: workspace_id:provider:phone)
  const [senderSelection, setSenderSelection] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferBusy, setTransferBusy] = useState(false);

  const [merchName, setMerchName] = useState('');
  const [merchDomain, setMerchDomain] = useState('');
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const [histTarget, setHistTarget] = useState<{
    phone: string;
    provider: WalletProvider;
    workspaceId?: string;
  } | null>(null);
  const [histItems, setHistItems] = useState<TransactionHistoryItem[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histError, setHistError] = useState('');

  const [syncingKey, setSyncingKey] = useState<string | null>(null);

  // Cloud DB Search state
  const [dbQuery, setDbQuery] = useState('');
  const [dbSearching, setDbSearching] = useState(false);
  const [dbResult, setDbResult] = useState<{
    query: string;
    matched_accounts: WaveAccount[];
    matched_users: Array<{
      uid: string;
      email: string;
      displayName: string;
      workspaceId: string;
      createdAt: string;
      updatedAt: string;
    }>;
    matched_events: Array<{
      uid: string;
      email: string;
      eventType: string;
      summary: string;
      createdAt: string;
    }>;
    matched_vault_docs: Array<{
      collection: string;
      doc_id: string;
      owner_uid: string;
      workspace_id: string;
      updated_at: string;
      inspection: {
        decrypt_ok: boolean;
        version?: number;
        workspace_id?: string;
        workspace_name?: string;
        owner_email?: string;
        owner_name?: string;
        accounts: Array<{
          phone: string;
          provider?: WalletProvider;
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
      };
    }>;
  } | null>(null);

  const runCloudDbSearch = async (overrideQuery?: string) => {
    const q = overrideQuery !== undefined ? overrideQuery : dbQuery;
    if (overrideQuery !== undefined) setDbQuery(overrideQuery);
    setDbSearching(true);
    try {
      const res = await apiFetch(`/api/admin/db-search?q=${encodeURIComponent(q.trim())}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.status === 'success') {
        setDbResult(data);
        await fetchAdminOverview();
      }
    } catch {
      // Ignore
    } finally {
      setDbSearching(false);
    }
  };

  const fetchAdminOverview = async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/admin/overview');
      if (!res.ok) return;
      const data = await res.json();
      if (data.status === 'success') {
        setOverview(data.overview);
        const loadedAccs: WaveAccount[] = data.accounts || [];
        setAccounts(loadedAccs);
        setWorkspaces(data.workspaces || []);
        setMerchants(data.merchants || []);
        setLogs(data.logs || []);
        setUsedTrx(data.usedTrx || []);
        if (!senderSelection && loadedAccs.length > 0) {
          const active = loadedAccs.find(
            (a) => Boolean(a.has_session) && getAccProvider(a) !== 'aya'
          );
          if (active) setSenderSelection(makeUiAccountKey(active));
        }
      }
    } catch {
      // Stealth guard
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAdminOverview();
  }, []);

  const filteredAccounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return accounts.filter((acc) => {
      const prov = getAccProvider(acc);
      if (workspaceFilter && (acc.workspace_id || 'default') !== workspaceFilter) {
        return false;
      }
      if (providerFilter !== 'all' && prov !== providerFilter) {
        return false;
      }
      if (statusFilter === 'active' && !acc.has_session) return false;
      if (statusFilter === 'offline' && acc.has_session) return false;
      if (statusFilter === 'removed' && !acc.user_removed) return false;
      if (!q) return true;
      const hay = [
        `0${acc.phone}`,
        acc.phone,
        formatProviderLabel(prov),
        acc.name || '',
        acc.workspace_name || '',
        acc.workspace_id || '',
        acc.owner_email || '',
        acc.owner_name || '',
        acc.model || '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [accounts, searchQuery, providerFilter, statusFilter, workspaceFilter]);

  const handleSyncBalance = async (acc: WaveAccount) => {
    const key = makeUiAccountKey(acc);
    const prov = getAccProvider(acc);
    setSyncingKey(key);
    setFeedback(null);
    try {
      const params = new URLSearchParams({ provider: prov });
      if (acc.workspace_id) params.set('workspace_id', acc.workspace_id);
      const res = await apiFetch(`/api/accounts/${acc.phone}/sync?${params.toString()}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({ ok: false, msg: `${formatProviderLabel(prov)} 0${acc.phone}: ${data.message}` });
      } else {
        setFeedback({
          ok: true,
          msg: `${formatProviderLabel(prov)} 0${acc.phone} Live Balance: ${Number(data.balance).toLocaleString()} Ks`,
        });
        await Promise.all([fetchAdminOverview(), onRefreshGlobal()]);
      }
    } catch (err: any) {
      setFeedback({ ok: false, msg: err.message });
    } finally {
      setSyncingKey(null);
    }
  };

  const handleOpenHistory = async (acc: WaveAccount) => {
    const prov = getAccProvider(acc);
    setHistTarget({ phone: acc.phone, provider: prov, workspaceId: acc.workspace_id });
    setHistItems([]);
    setHistError('');
    setHistLoading(true);
    try {
      const params = new URLSearchParams({ limit: '15', provider: prov });
      if (acc.workspace_id) params.set('workspace_id', acc.workspace_id);
      const res = await apiFetch(`/api/admin/accounts/${acc.phone}/history?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setHistError(data.message || 'မှတ်တမ်း ရယူ၍ မရပါ။');
      } else {
        setHistItems(data.history || []);
      }
    } catch (err: any) {
      setHistError(err.message);
    } finally {
      setHistLoading(false);
    }
  };

  const handleAdminTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!senderSelection || !receiverPhone.trim() || !transferAmount) return;
    setTransferBusy(true);
    setFeedback(null);

    const parsed = parseUiAccountKey(senderSelection);

    try {
      const res = await apiFetch('/api/admin/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender_phone: parsed.phone,
          sender_workspace_id: parsed.workspaceId,
          sender_provider: parsed.provider,
          receiver_phone: receiverPhone.trim(),
          amount: Number(transferAmount),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({ ok: false, msg: data.message || 'Transfer မအောင်မြင်ပါ။' });
      } else {
        const provLabel = formatProviderLabel(data.provider || parsed.provider);
        setFeedback({
          ok: true,
          msg: `${provLabel} Transfer အောင်မြင်ပါသည် — ${Number(data.amount).toLocaleString()} Ks to ${data.receiver_name} (0${data.receiver}) · ID: ${data.trx_id}`,
        });
        setReceiverPhone('');
        setTransferAmount('');
        await Promise.all([fetchAdminOverview(), onRefreshGlobal()]);
      }
    } catch (err: any) {
      setFeedback({ ok: false, msg: err.message });
    } finally {
      setTransferBusy(false);
    }
  };

  const handleCreateMerchant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!merchName.trim()) return;
    try {
      const res = await apiFetch('/api/merchants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          merchant_name: merchName.trim(),
          domain: merchDomain.trim() || '*',
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMerchName('');
        setMerchDomain('');
        setFeedback({ ok: true, msg: `Merchant "${data.merchant.merchant_name}" ဖန်တီးပြီးပါပြီ။` });
        await fetchAdminOverview();
      } else {
        setFeedback({ ok: false, msg: data.message });
      }
    } catch (err: any) {
      setFeedback({ ok: false, msg: err.message });
    }
  };

  const handleRevokeMerchant = async (token: string) => {
    try {
      await apiFetch(`/api/merchants/${token}`, { method: 'DELETE' });
      await fetchAdminOverview();
    } catch {
      // Ignore
    }
  };

  const handleUnblockTrx = async (trxId: string) => {
    try {
      const res = await apiFetch('/api/admin/unblock-trx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trx_id: trxId }),
      });
      if (res.ok) {
        setFeedback({ ok: true, msg: `Transaction ID ${trxId} ကို Replay Lock မှ ဖြေလျှော့ပေးလိုက်ပါပြီ။` });
        await fetchAdminOverview();
      }
    } catch {
      // Ignore
    }
  };

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Header & Summary Strip */}
      <section className="border-b border-zinc-200 pb-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-black">
              Master Control
            </h1>
            <p className="text-xs sm:text-sm text-zinc-600 leading-relaxed">
              User အားလုံး၏ WavePay, KBZPay နှင့် AYA Pay အကောင့်များ (User ဖျက်ထားသော အကောင့်များ အပါအဝင်)၊ Google Workspaces၊ တိုက်ရိုက် ငွေလွှဲမှု နှင့် System Audit Logs။
            </p>
          </div>
          <button
            type="button"
            onClick={fetchAdminOverview}
            className="px-4 py-2 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg cursor-pointer flex items-center gap-1.5 self-start"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh Cloud Data</span>
          </button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6 pt-1">
          <div className="p-3.5 sm:p-0 border sm:border-0 border-zinc-200 rounded-xl sm:rounded-none bg-zinc-50/70 sm:bg-transparent">
            <div className="text-xs font-medium text-zinc-500">Pool Liquidity</div>
            <div className="text-lg sm:text-2xl font-bold font-mono tabular-nums text-black mt-1">
              {overview.total_balance.toLocaleString()} Ks
            </div>
          </div>
          <div className="p-3.5 sm:p-0 border sm:border-0 border-zinc-200 rounded-xl sm:rounded-none bg-zinc-50/70 sm:bg-transparent lg:border-l lg:border-zinc-200 lg:pl-6">
            <div className="text-xs font-medium text-zinc-500">Wallet SIMs (Active / Total)</div>
            <div className="text-lg sm:text-2xl font-bold font-mono tabular-nums text-black mt-1">
              {overview.active_accounts} / {overview.total_accounts}
            </div>
          </div>
          <div className="p-3.5 sm:p-0 border sm:border-0 border-zinc-200 rounded-xl sm:rounded-none bg-zinc-50/70 sm:bg-transparent lg:border-l lg:border-zinc-200 lg:pl-6">
            <div className="text-xs font-medium text-zinc-500">User Workspaces</div>
            <div className="text-lg sm:text-2xl font-bold font-mono tabular-nums text-black mt-1">
              {overview.total_workspaces}
            </div>
          </div>
          <div className="p-3.5 sm:p-0 border sm:border-0 border-zinc-200 rounded-xl sm:rounded-none bg-zinc-50/70 sm:bg-transparent lg:border-l lg:border-zinc-200 lg:pl-6">
            <div className="text-xs font-medium text-zinc-500">Gateway Requests</div>
            <div className="text-lg sm:text-2xl font-bold font-mono tabular-nums text-black mt-1">
              {overview.total_transactions}
            </div>
          </div>
        </div>
      </section>

      {feedback && (
        <div
          className={`p-4 rounded-xl border text-xs font-medium flex items-center justify-between gap-3 ${
            feedback.ok
              ? 'bg-zinc-50 border-black text-black'
              : 'bg-white border-2 border-black text-black'
          }`}
        >
          <div className="flex items-center gap-2">
            {feedback.ok ? (
              <CheckCircle2 className="w-4 h-4 text-black shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-black shrink-0" />
            )}
            <span>{feedback.msg}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-zinc-500 hover:text-black cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Sub-navigation Tabs */}
      <div className="flex items-center gap-1 p-1 bg-zinc-100 border border-zinc-200 rounded-lg overflow-x-auto max-w-full">
        {[
          { id: 'accounts', label: `Wallet Accounts (${accounts.length})` },
          { id: 'users', label: `User Accounts (${workspaces.length})` },
          { id: 'db_search', label: 'DB Search' },
          { id: 'transfer', label: 'Direct Transfer' },
          { id: 'merchants', label: `Merchants (${merchants.length})` },
          { id: 'logs', label: 'Audit Logs' },
          { id: 'used_trx', label: 'Used Receipts' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setSubTab(t.id as any);
              if (t.id === 'db_search' && !dbResult && !dbSearching) {
                void runCloudDbSearch(dbQuery);
              }
            }}
            className={`px-3.5 py-2 sm:py-1.5 text-xs font-semibold rounded-md whitespace-nowrap cursor-pointer transition-colors ${
              subTab === t.id ? 'bg-black text-white' : 'text-zinc-600 hover:text-black'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Deep Cloud Database Search */}
      {subTab === 'db_search' && (
        <div className="space-y-5">
          <div className="bg-white border border-zinc-200 rounded-xl p-4 sm:p-5 space-y-3">
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-black">
                Cloud Firestore & Vault Deep Search
              </h3>
              <p className="text-xs text-zinc-600 leading-relaxed">
                Firebase Collections အားလုံး (Users, Activity Events, Encrypted Workspaces, Capabilities, Admin Vault) ထဲတွင် ဖုန်းနံပါတ်၊ Wallet (WavePay / KBZPay / AYA Pay)၊ Email သို့မဟုတ် အမည်ဖြင့် ရှာဖွေစစ်ဆေးနိုင်ပါသည်။
              </p>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void runCloudDbSearch(dbQuery);
              }}
              className="flex flex-col sm:flex-row gap-2"
            >
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={dbQuery}
                  onChange={(e) => setDbQuery(e.target.value)}
                  placeholder="09xxxxxxxxx, email သို့မဟုတ် အလွတ်ထား၍ အကုန်ရှာပါ..."
                  className="w-full pl-9 pr-3 py-2.5 bg-white border border-zinc-300 rounded-lg text-xs font-mono text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
                />
              </div>
              <button
                type="submit"
                disabled={dbSearching}
                className="px-4 py-2.5 bg-black hover:bg-zinc-800 text-white rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-40 whitespace-nowrap"
              >
                {dbSearching ? 'Searching Cloud DB...' : 'Search Database'}
              </button>
              <button
                type="button"
                disabled={dbSearching}
                onClick={() => void runCloudDbSearch('')}
                className="px-4 py-2.5 bg-white hover:bg-zinc-100 border border-zinc-300 text-black rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-40 whitespace-nowrap"
              >
                Show All Records
              </button>
            </form>
          </div>

          {dbResult && (
            <div className="space-y-5">
              {/* 1. Matched Wallet SIMs */}
              <div className="border border-zinc-200 rounded-xl overflow-hidden bg-white">
                <div className="px-4 py-3 bg-zinc-50 border-b border-zinc-200 text-xs font-bold text-black">
                  1. Matched Wallet SIM Accounts ({dbResult.matched_accounts.length})
                </div>
                {dbResult.matched_accounts.length === 0 ? (
                  <div className="p-6 text-center text-xs text-zinc-500">
                    ကိုက်ညီသော Wallet SIM မှတ်တမ်း မတွေ့ပါ။
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-200">
                    {dbResult.matched_accounts.map((acc) => {
                      const key = makeUiAccountKey(acc);
                      const prov = getAccProvider(acc);
                      return (
                        <div
                          key={key}
                          className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                        >
                          <div className="space-y-1 min-w-0">
                            <div className="font-mono font-bold text-sm text-black">
                              {formatProviderLabel(prov)} · 0{acc.phone}{' '}
                              <span className="font-sans font-normal text-zinc-600">
                                ({acc.name || 'No Name'})
                              </span>
                            </div>
                            <div className="text-zinc-600">
                              Owner: <span className="font-mono">{acc.owner_email || '-'}</span> · Workspace:{' '}
                              <span className="font-mono">{acc.workspace_id}</span>
                            </div>
                            <div className="font-mono text-[11px] text-zinc-500">
                              {acc.model} · OS {acc.os_version} ·{' '}
                              {acc.has_session
                                ? `Active Session (${acc.has_pin ? 'PIN Saved' : 'No PIN'})`
                                : 'No Encrypted Session in Vault'}
                              {acc.user_removed ? ' · User Removed' : ''}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="font-mono font-bold text-black mr-2">
                              {(Number(acc.balance) || 0).toLocaleString()} Ks
                            </span>
                            {acc.has_session && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleSyncBalance(acc)}
                                  className="px-2.5 py-1.5 bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg font-semibold text-black cursor-pointer"
                                >
                                  Balance
                                </button>
                                {prov !== 'aya' && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSenderSelection(key);
                                      setSubTab('transfer');
                                    }}
                                    className="px-3 py-1.5 bg-black hover:bg-zinc-800 rounded-lg font-semibold text-white cursor-pointer"
                                  >
                                    Transfer
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 2. Matched Google Users */}
              <div className="border border-zinc-200 rounded-xl overflow-hidden bg-white">
                <div className="px-4 py-3 bg-zinc-50 border-b border-zinc-200 text-xs font-bold text-black">
                  2. Google User Profiles in /users ({dbResult.matched_users.length})
                </div>
                {dbResult.matched_users.length === 0 ? (
                  <div className="p-6 text-center text-xs text-zinc-500">
                    /users collection တွင် ကိုက်ညီသော Google အကောင့် မတွေ့ပါ။
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-200">
                    {dbResult.matched_users.map((u) => (
                      <div key={u.uid} className="p-4 text-xs space-y-1">
                        <div className="font-bold text-black">
                          {u.displayName || 'User'} · <span className="font-mono">{u.email}</span>
                        </div>
                        <div className="font-mono text-[11px] text-zinc-500">
                          UID: {u.uid} · Workspace: {u.workspaceId} · Joined:{' '}
                          {u.createdAt ? new Date(u.createdAt).toLocaleString() : '-'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 3. Matched Encrypted Vault Documents */}
              <div className="border border-zinc-200 rounded-xl overflow-hidden bg-white">
                <div className="px-4 py-3 bg-zinc-50 border-b border-zinc-200 text-xs font-bold text-black">
                  3. Encrypted Cloud Vault Documents ({dbResult.matched_vault_docs.length})
                </div>
                {dbResult.matched_vault_docs.length === 0 ? (
                  <div className="p-6 text-center text-xs text-zinc-500">
                    Encrypted Vault (/vault_workspaces, /gateway_capabilities, /admin_vault_accounts) တွင် ကိုက်ညီသော မှတ်တမ်း မတွေ့ပါ။
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-200">
                    {dbResult.matched_vault_docs.map((v, idx) => (
                      <div key={`${v.collection}:${v.doc_id}:${idx}`} className="p-4 text-xs space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2 font-mono">
                          <span className="font-bold text-black">
                            /{v.collection}/{v.doc_id.slice(0, 28)}
                            {v.doc_id.length > 28 ? '...' : ''}
                          </span>
                          <span className="text-zinc-600">
                            {v.inspection.decrypt_ok ? 'Decrypted OK' : 'Key Mismatch (VAULT_SECRET_KEY)'}
                          </span>
                        </div>
                        <div className="font-mono text-[11px] text-zinc-500">
                          Workspace: {v.workspace_id} · Owner: {v.inspection.owner_email || v.owner_uid} · Updated:{' '}
                          {v.updated_at ? new Date(v.updated_at).toLocaleString() : '-'}
                        </div>
                        {v.inspection.accounts.length > 0 && (
                          <div className="pt-1 space-y-1">
                            {v.inspection.accounts.map((ia) => (
                              <div
                                key={`${ia.provider || 'wave'}:${ia.phone}`}
                                className="px-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded font-mono text-[11px] text-black"
                              >
                                {formatProviderLabel(ia.provider)} 0{ia.phone} ({ia.name || '-'}) ·{' '}
                                {ia.model} OS {ia.os_version} · {ia.balance.toLocaleString()} Ks · Session:{' '}
                                {ia.has_session ? 'YES' : 'NO'} · PIN: {ia.has_pin ? 'YES' : 'NO'}
                                {ia.user_removed ? ' · User Removed' : ''}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 4. Immutable Activity Events */}
              <div className="border border-zinc-200 rounded-xl overflow-hidden bg-white">
                <div className="px-4 py-3 bg-zinc-50 border-b border-zinc-200 text-xs font-bold text-black">
                  4. Immutable Activity Trail in /users/*/events ({dbResult.matched_events.length})
                </div>
                {dbResult.matched_events.length === 0 ? (
                  <div className="p-6 text-center text-xs text-zinc-500">
                    Activity Events မှတ်တမ်း မတွေ့ပါ။
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-200">
                    {dbResult.matched_events.map((ev, i) => (
                      <div
                        key={`${ev.uid}-${ev.createdAt}-${i}`}
                        className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 text-xs"
                      >
                        <div className="space-y-0.5">
                          <div className="font-medium text-black">{ev.summary}</div>
                          <div className="font-mono text-[11px] text-zinc-500">
                            {ev.email} · {ev.eventType}
                          </div>
                        </div>
                        <div className="font-mono text-[11px] text-zinc-500 shrink-0">
                          {ev.createdAt ? new Date(ev.createdAt).toLocaleString() : '-'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 1. All Wallet SIM Accounts across ALL Workspaces */}
      {subTab === 'accounts' && (
        <div className="space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="ဖုန်းနံပါတ်၊ Wallet၊ အမည် သို့မဟုတ် User Email ဖြင့် ရှာရန်..."
                className="w-full pl-9 pr-3 py-2 bg-white border border-zinc-300 rounded-lg text-xs text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {workspaceFilter && (
                <button
                  type="button"
                  onClick={() => setWorkspaceFilter('')}
                  className="px-3 py-1.5 bg-white border border-black rounded-lg text-xs font-semibold text-black flex items-center gap-1.5 cursor-pointer"
                >
                  <span>Workspace: {workspaceFilter}</span>
                  <X className="w-3 h-3" />
                </button>
              )}

              {/* Provider Filter */}
              <div className="flex items-center gap-1 p-1 bg-zinc-100 border border-zinc-200 rounded-lg overflow-x-auto max-w-full">
                {(
                  [
                    { id: 'all', label: 'All Wallets' },
                    { id: 'wave', label: 'WavePay' },
                    { id: 'kbz', label: 'KBZPay' },
                    { id: 'aya', label: 'AYA Pay' },
                  ] as const
                ).map((pf) => (
                  <button
                    key={pf.id}
                    type="button"
                    onClick={() => setProviderFilter(pf.id)}
                    className={`px-2.5 py-1 text-xs font-semibold rounded whitespace-nowrap transition-colors cursor-pointer ${
                      providerFilter === pf.id
                        ? 'bg-black text-white'
                        : 'text-zinc-600 hover:text-black'
                    }`}
                  >
                    {pf.label}
                  </button>
                ))}
              </div>

              {/* Status Filter */}
              <div className="flex items-center gap-1 p-1 bg-zinc-100 border border-zinc-200 rounded-lg overflow-x-auto max-w-full">
                {(
                  [
                    { id: 'all', label: `All (${accounts.length})` },
                    {
                      id: 'active',
                      label: `Active (${accounts.filter((a) => Boolean(a.has_session)).length})`,
                    },
                    {
                      id: 'offline',
                      label: `Offline (${accounts.filter((a) => !a.has_session).length})`,
                    },
                    {
                      id: 'removed',
                      label: `User Removed (${accounts.filter((a) => Boolean(a.user_removed)).length})`,
                    },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setStatusFilter(f.id)}
                    className={`px-2.5 py-1 text-xs font-semibold rounded whitespace-nowrap transition-colors cursor-pointer ${
                      statusFilter === f.id ? 'bg-black text-white' : 'text-zinc-600 hover:text-black'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {filteredAccounts.length === 0 ? (
            <div className="border border-zinc-200 rounded-xl py-12 px-6 text-center text-xs text-zinc-500 bg-zinc-50/50">
              {accounts.length === 0
                ? 'စနစ်တွင် ထည့်သွင်းထားသော Wallet အကောင့် မရှိသေးပါ။'
                : 'ရှာဖွေထားသော စစ်ထုတ်မှုနှင့် ကိုက်ညီသည့် Wallet အကောင့် မတွေ့ပါ။'}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 md:hidden">
                {filteredAccounts.map((acc) => {
                  const key = makeUiAccountKey(acc);
                  const prov = getAccProvider(acc);
                  const supportsTransfer = prov !== 'aya';
                  return (
                    <div key={key} className="bg-white border border-zinc-200 rounded-xl p-4 space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-zinc-500">
                            {formatProviderLabel(prov)}
                          </div>
                          <div className="font-mono font-bold text-sm text-black">0{acc.phone}</div>
                          <div className="text-xs text-zinc-700 truncate">
                            {acc.name || 'No Name'} · {acc.workspace_name || acc.workspace_id || 'Primary'}
                          </div>
                          {acc.owner_email && (
                            <div className="font-mono text-[11px] text-zinc-500 truncate">
                              {acc.owner_email}
                            </div>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-xs font-semibold text-black">
                            {acc.has_session ? 'Active' : 'Offline'}
                          </div>
                          {acc.user_removed && (
                            <div className="text-[11px] font-mono text-zinc-500">User Removed</div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-xs bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 font-mono">
                        <span>
                          PIN: <strong>{acc.has_pin ? 'Encrypted' : 'None'}</strong>
                        </span>
                        <span className="font-bold text-black">
                          {(Number(acc.balance) || 0).toLocaleString()} Ks
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <button
                          type="button"
                          disabled={!acc.has_session || syncingKey === key}
                          onClick={() => handleSyncBalance(acc)}
                          className="py-2 text-xs font-semibold bg-white border border-zinc-300 rounded-lg text-black disabled:opacity-40 cursor-pointer"
                        >
                          {syncingKey === key ? '...' : 'Balance'}
                        </button>
                        <button
                          type="button"
                          disabled={!acc.has_session}
                          onClick={() => handleOpenHistory(acc)}
                          className="py-2 text-xs font-semibold bg-white border border-zinc-300 rounded-lg text-black disabled:opacity-40 cursor-pointer"
                        >
                          History
                        </button>
                        <button
                          type="button"
                          disabled={!acc.has_session || !supportsTransfer}
                          onClick={() => {
                            setSenderSelection(key);
                            setSubTab('transfer');
                          }}
                          className="py-2 text-xs font-semibold bg-black text-white rounded-lg disabled:opacity-40 cursor-pointer"
                        >
                          Transfer
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="hidden md:block border border-zinc-200 rounded-xl overflow-hidden bg-white">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-zinc-200 text-zinc-500 bg-zinc-50">
                        <th className="py-3 px-4 font-semibold">Wallet / Phone / Name</th>
                        <th className="py-3 px-4 font-semibold">Owner / Workspace</th>
                        <th className="py-3 px-4 font-semibold">Model / OS</th>
                        <th className="py-3 px-4 font-semibold">Vault State</th>
                        <th className="py-3 px-4 font-semibold text-right">Balance</th>
                        <th className="py-3 px-4 font-semibold text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-200 text-zinc-800">
                      {filteredAccounts.map((acc) => {
                        const key = makeUiAccountKey(acc);
                        const prov = getAccProvider(acc);
                        const supportsTransfer = prov !== 'aya';
                        return (
                          <tr key={key} className="hover:bg-zinc-50/70">
                            <td className="py-3 px-4">
                              <div className="flex items-center gap-1.5">
                                <span className="font-semibold text-zinc-600">
                                  {formatProviderLabel(prov)}
                                </span>
                                <span className="text-zinc-400">·</span>
                                <span className="font-mono font-bold text-black">0{acc.phone}</span>
                              </div>
                              <div className="text-[11px] text-zinc-500">{acc.name || '-'}</div>
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-medium text-black">
                                {acc.workspace_name || acc.workspace_id || '-'}
                              </div>
                              <div className="font-mono text-[11px] text-zinc-500">
                                {acc.owner_email || acc.workspace_id || '-'}
                              </div>
                            </td>
                            <td className="py-3 px-4 text-zinc-700">
                              {acc.model} · Android {acc.os_version}
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-medium text-black">
                                {acc.has_session
                                  ? `Active · ${acc.has_pin ? 'PIN Saved' : 'No PIN'}`
                                  : 'Offline (No Session)'}
                              </div>
                              {acc.user_removed && (
                                <div className="font-mono text-[11px] text-zinc-500">
                                  User Removed (Retained in Vault)
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-4 text-right font-mono tabular-nums font-bold text-black">
                              {(Number(acc.balance) || 0).toLocaleString()} Ks
                            </td>
                            <td className="py-3 px-4 text-right">
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={!acc.has_session || syncingKey === key}
                                  onClick={() => handleSyncBalance(acc)}
                                  className="px-2.5 py-1.5 bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg text-xs font-semibold text-black disabled:opacity-40 cursor-pointer"
                                >
                                  {syncingKey === key ? '...' : 'Balance'}
                                </button>
                                <button
                                  type="button"
                                  disabled={!acc.has_session}
                                  onClick={() => handleOpenHistory(acc)}
                                  className="px-2.5 py-1.5 bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg text-xs font-semibold text-black disabled:opacity-40 cursor-pointer flex items-center gap-1"
                                >
                                  <History className="w-3 h-3" />
                                  <span>History</span>
                                </button>
                                <button
                                  type="button"
                                  disabled={!acc.has_session || !supportsTransfer}
                                  onClick={() => {
                                    setSenderSelection(key);
                                    setSubTab('transfer');
                                  }}
                                  className="px-3 py-1.5 bg-black hover:bg-zinc-800 rounded-lg text-xs font-semibold text-white disabled:opacity-40 cursor-pointer"
                                >
                                  Transfer
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
        </div>
      )}

      {/* 2. All Registered Google User Accounts / Workspaces */}
      {subTab === 'users' && (
        <>
          {workspaces.length === 0 ? (
            <div className="border border-zinc-200 rounded-xl py-12 px-6 text-center text-xs text-zinc-500 bg-zinc-50/50">
              Google Login ဝင်ရောက်ထားသော User အကောင့် မှတ်တမ်း မရှိသေးပါ။
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 md:hidden">
                {workspaces.map((ws) => (
                  <div key={ws.id} className="bg-white border border-zinc-200 rounded-xl p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-bold text-sm text-black truncate">
                          {ws.owner_name || ws.name}
                        </div>
                        <div className="font-mono text-xs text-zinc-600 truncate">
                          {ws.owner_email || '-'}
                        </div>
                        <div className="font-mono text-[11px] text-zinc-400 mt-0.5">
                          Workspace: {ws.id}
                        </div>
                      </div>
                      <div className="text-right shrink-0 font-mono text-xs">
                        <div className="font-bold text-black">
                          {(Number(ws.total_balance) || 0).toLocaleString()} Ks
                        </div>
                        <div className="text-zinc-500">
                          Wallets: {ws.active_accounts_count ?? 0} / {ws.accounts_count ?? 0}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setWorkspaceFilter(ws.id);
                        setStatusFilter('all');
                        setSubTab('accounts');
                      }}
                      className="w-full py-2 text-xs font-semibold bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg text-black cursor-pointer"
                    >
                      View Workspace Wallets ({ws.accounts_count ?? 0})
                    </button>
                  </div>
                ))}
              </div>

              <div className="hidden md:block border border-zinc-200 rounded-xl overflow-hidden bg-white">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-zinc-200 text-zinc-500 bg-zinc-50">
                        <th className="py-3 px-4 font-semibold">User / Google Email</th>
                        <th className="py-3 px-4 font-semibold">Workspace ID</th>
                        <th className="py-3 px-4 font-semibold text-right">Wallets (Active / Total)</th>
                        <th className="py-3 px-4 font-semibold text-right">Total Balance</th>
                        <th className="py-3 px-4 font-semibold text-right">Joined</th>
                        <th className="py-3 px-4 font-semibold text-right">Inspect</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-200 text-zinc-800">
                      {workspaces.map((ws) => (
                        <tr key={ws.id} className="hover:bg-zinc-50/70">
                          <td className="py-3 px-4">
                            <div className="font-bold text-black">{ws.owner_name || ws.name}</div>
                            <div className="font-mono text-[11px] text-zinc-600">
                              {ws.owner_email || '-'}
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono text-zinc-600">{ws.id}</td>
                          <td className="py-3 px-4 text-right font-mono font-semibold text-black">
                            {ws.active_accounts_count ?? 0} / {ws.accounts_count ?? 0}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums font-bold text-black">
                            {(Number(ws.total_balance) || 0).toLocaleString()} Ks
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-[11px] text-zinc-500">
                            {ws.created_at ? new Date(ws.created_at).toLocaleDateString() : '-'}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <button
                              type="button"
                              onClick={() => {
                                setWorkspaceFilter(ws.id);
                                setStatusFilter('all');
                                setSubTab('accounts');
                              }}
                              className="px-3 py-1.5 bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg text-xs font-semibold text-black cursor-pointer"
                            >
                              View Wallets ({ws.accounts_count ?? 0})
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* 3. Admin Transfer */}
      {subTab === 'transfer' && (
        <div className="max-w-lg bg-white border border-zinc-200 rounded-xl p-5 sm:p-6 space-y-4">
          <div>
            <h3 className="text-base font-bold text-black">Direct Vault Transfer</h3>
            <p className="text-xs text-zinc-600 mt-1 leading-relaxed">
              ချိတ်ဆက်ပြီးသား WavePay သို့မဟုတ် KBZPay SIM မှ သိမ်းဆည်းထားသော Encrypted PIN ဖြင့် တိုက်ရိုက် ငွေလွှဲနိုင်ပါသည်။
            </p>
          </div>

          <form onSubmit={handleAdminTransfer} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                Sender Wallet Account *
              </label>
              <select
                required
                value={senderSelection}
                onChange={(e) => setSenderSelection(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-xs font-mono text-black focus:outline-none focus:border-black"
              >
                <option value="">Select Logged-In WavePay / KBZPay SIM</option>
                {accounts
                  .filter((a) => Boolean(a.has_session) && getAccProvider(a) !== 'aya')
                  .map((a) => {
                    const key = makeUiAccountKey(a);
                    const provLabel = formatProviderLabel(a.provider);
                    return (
                      <option key={key} value={key}>
                        {provLabel} · 0{a.phone} ({a.workspace_name || a.workspace_id || 'Primary'}
                        {a.user_removed ? ' · User Removed' : ''}) —{' '}
                        {(Number(a.balance) || 0).toLocaleString()} Ks
                      </option>
                    );
                  })}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                Receiver Phone *
              </label>
              <input
                type="tel"
                required
                value={receiverPhone}
                onChange={(e) => setReceiverPhone(e.target.value)}
                placeholder="09xxxxxxxxx"
                className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm font-mono text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-800 mb-1.5">
                Amount (Ks) *
              </label>
              <input
                type="number"
                required
                min="1"
                step="1"
                value={transferAmount}
                onChange={(e) => setTransferAmount(e.target.value)}
                placeholder="ငွေပမာဏ ရိုက်ထည့်ပါ"
                className="w-full px-3.5 py-2.5 bg-white border border-zinc-300 rounded-lg text-sm font-mono tabular-nums text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
              />
            </div>

            <button
              type="submit"
              disabled={transferBusy || !senderSelection || !receiverPhone.trim() || !transferAmount}
              className="w-full py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer disabled:opacity-40 flex items-center justify-center gap-1.5"
            >
              <ArrowRightLeft className="w-3.5 h-3.5" />
              <span>{transferBusy ? 'Executing Transfer...' : 'Execute Direct Transfer'}</span>
            </button>
          </form>
        </div>
      )}

      {/* 4. Merchants */}
      {subTab === 'merchants' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8 items-start">
          <form
            onSubmit={handleCreateMerchant}
            className="lg:col-span-4 bg-white border border-zinc-200 rounded-xl p-5 space-y-4"
          >
            <h3 className="text-sm font-bold text-black">Issue Merchant Token</h3>
            <div>
              <label className="block text-xs font-semibold text-zinc-800 mb-1">
                Merchant Name *
              </label>
              <input
                type="text"
                required
                value={merchName}
                onChange={(e) => setMerchName(e.target.value)}
                placeholder="Merchant သို့မဟုတ် Website အမည်"
                className="w-full px-3 py-2.5 bg-white border border-zinc-300 rounded-lg text-xs text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-800 mb-1">
                Allowed Domain (Optional)
              </label>
              <input
                type="text"
                value={merchDomain}
                onChange={(e) => setMerchDomain(e.target.value)}
                placeholder="* သို့မဟုတ် example.com"
                className="w-full px-3 py-2.5 bg-white border border-zinc-300 rounded-lg text-xs font-mono text-black placeholder:text-zinc-400 focus:outline-none focus:border-black"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer flex items-center justify-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Generate 32-Hex Token</span>
            </button>
          </form>

          <div className="lg:col-span-8 border border-zinc-200 rounded-xl overflow-hidden bg-white">
            {merchants.length === 0 ? (
              <div className="py-12 px-6 text-center text-xs text-zinc-500">
                ထုတ်ပေးထားသော Merchant Token မရှိသေးပါ။
              </div>
            ) : (
              <div className="divide-y divide-zinc-200">
                {merchants.map((m) => (
                  <div key={m.token} className="p-4 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0 space-y-1">
                      <div className="font-bold text-black">
                        {m.merchant_name}{' '}
                        <span className="font-mono font-normal text-zinc-500">({m.domain})</span>
                      </div>
                      <div className="flex items-center gap-2 font-mono text-zinc-700">
                        <span className="truncate max-w-[200px] sm:max-w-xs">{m.token}</span>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(m.token);
                            setCopiedToken(m.token);
                            setTimeout(() => setCopiedToken(null), 1800);
                          }}
                          className="text-black cursor-pointer shrink-0"
                        >
                          {copiedToken === m.token ? (
                            <Check className="w-3.5 h-3.5" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRevokeMerchant(m.token)}
                      className="p-2 text-zinc-500 hover:text-black border border-zinc-200 rounded-lg cursor-pointer shrink-0"
                      title="Revoke Token"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 5. Audit Logs */}
      {subTab === 'logs' && (
        <div className="border border-zinc-200 rounded-xl overflow-hidden bg-white">
          {logs.length === 0 ? (
            <div className="py-12 px-6 text-center text-xs text-zinc-500">
              Gateway Log မှတ်တမ်း မရှိသေးပါ။
            </div>
          ) : (
            <div className="divide-y divide-zinc-200">
              {logs.map((l) => (
                <div
                  key={l.id}
                  className="p-3.5 sm:px-5 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 text-xs"
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2 font-mono">
                      <span className="font-bold text-black">{l.level}</span>
                      <span className="text-zinc-400">·</span>
                      <span className="text-zinc-600">{l.event_type}</span>
                    </div>
                    <div className="text-zinc-800 break-words">{l.message}</div>
                  </div>
                  <div className="font-mono text-[11px] text-zinc-500 shrink-0">
                    {new Date(l.created_at).toLocaleTimeString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 6. Used Receipts */}
      {subTab === 'used_trx' && (
        <div className="border border-zinc-200 rounded-xl overflow-hidden bg-white">
          {usedTrx.length === 0 ? (
            <div className="py-12 px-6 text-center text-xs text-zinc-500">
              အသုံးပြုပြီးသား ပြေစာ (Used Receipts) မှတ်တမ်း မရှိသေးပါ။
            </div>
          ) : (
            <div className="divide-y divide-zinc-200">
              {usedTrx.map((u, idx) => (
                <div
                  key={`${u.trx_id}-${idx}`}
                  className="p-4 flex items-center justify-between gap-3 text-xs"
                >
                  <div className="space-y-0.5 font-mono">
                    <div className="font-bold text-black">{u.trx_id}</div>
                    <div className="text-[11px] text-zinc-500">
                      {Number(u.amount || 0).toLocaleString()} Ks · {u.source} ·{' '}
                      {new Date(u.used_at).toLocaleString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleUnblockTrx(u.trx_id)}
                    className="px-3 py-1.5 bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg text-xs font-semibold text-black cursor-pointer shrink-0"
                  >
                    Unblock
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* History Inspection Modal */}
      {histTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-zinc-300 rounded-2xl p-5 sm:p-6 max-w-lg w-full max-h-[85vh] flex flex-col space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-zinc-200 pb-3">
              <h3 className="text-base font-bold text-black">
                {formatProviderLabel(histTarget.provider)} History · 0{histTarget.phone}
              </h3>
              <button
                type="button"
                onClick={() => setHistTarget(null)}
                className="text-zinc-500 hover:text-black cursor-pointer p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2.5">
              {histLoading ? (
                <div className="py-10 text-center text-xs text-zinc-600">Loading history...</div>
              ) : histError ? (
                <div className="p-4 rounded-xl bg-white border-2 border-black text-xs text-black font-medium">
                  {histError}
                </div>
              ) : histItems.length === 0 ? (
                <div className="py-10 text-center text-xs text-zinc-500">မှတ်တမ်း မရှိပါ။</div>
              ) : (
                histItems.map((h, i) => (
                  <div
                    key={`${h.transId || 'trx'}-${i}`}
                    className="p-3.5 bg-zinc-50 border border-zinc-200 rounded-xl flex items-start justify-between gap-3 text-xs"
                  >
                    <div className="space-y-0.5 min-w-0">
                      <div className="font-mono font-bold text-black break-all">ID: {h.transId}</div>
                      <div className="text-zinc-600 break-words">{h.title}</div>
                      {h.time && <div className="font-mono text-[11px] text-zinc-500">{h.time}</div>}
                    </div>
                    <div className="font-mono tabular-nums font-bold text-black shrink-0">
                      {h.direction === 'CR' ? '+' : '-'}
                      {h.amount.toLocaleString()} Ks
                    </div>
                  </div>
                ))
              )}
            </div>

            <button
              type="button"
              onClick={() => setHistTarget(null)}
              className="w-full py-2.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
