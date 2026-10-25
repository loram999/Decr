/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { Lock, AlertCircle, RefreshCw } from 'lucide-react';
import { TopNav, NavTab } from './components/TopNav';
import { WaveAccountManager } from './components/WaveAccountManager';
import { PaymentOperations } from './components/PaymentOperations';
import { ApiDocsPage } from './components/ApiDocsPage';
import { AdminPanel990 } from './components/AdminPanel990';
import { WaveAccount, Workspace } from './types';
import {
  auth,
  signInWithGooglePopup,
  signOutUser,
  syncUserProfileToFirestore,
  recordSecurityEventToFirestore,
} from './firebase';
import { apiFetch } from './api';

export default function App() {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [authBusy, setAuthBusy] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string>('');

  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  const [activeTab, setActiveTab] = useState<NavTab>('accounts');
  const [accounts, setAccounts] = useState<WaveAccount[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [openAddModalSignal, setOpenAddModalSignal] = useState<number>(0);

  useEffect(() => {
    const fallbackTimer = window.setTimeout(() => {
      setAuthReady(true);
      setIsLoading(false);
    }, 2500);

    const unsub = onAuthStateChanged(
      auth,
      (u) => {
        window.clearTimeout(fallbackTimer);
        setFirebaseUser(u);
        setAuthReady(true);
        if (!u) {
          setIsAdmin(false);
          setWorkspace(null);
          setAccounts([]);
          setIsLoading(false);
        }
      },
      () => {
        window.clearTimeout(fallbackTimer);
        setAuthReady(true);
        setIsLoading(false);
      }
    );
    return () => {
      window.clearTimeout(fallbackTimer);
      unsub();
    };
  }, []);

  const fetchSessionAndAccounts = useCallback(async () => {
    if (!auth.currentUser) return;
    setIsLoading(true);
    try {
      const [meRes, accRes] = await Promise.all([
        apiFetch('/api/me'),
        apiFetch('/api/accounts'),
      ]);

      if (meRes.ok) {
        const meData = await meRes.json();
        const adminFlag = Boolean(meData.is_admin);
        setIsAdmin(adminFlag);
        setWorkspace(meData.workspace || null);

        // Allow /admin990 URL shortcut ONLY if backend verified user is Admin
        const path = window.location.pathname;
        const hash = window.location.hash;
        if (adminFlag && (path === '/admin990' || hash === '#admin990')) {
          setActiveTab('admin990');
        } else if (!adminFlag && activeTab === 'admin990') {
          setActiveTab('accounts');
        }

        if (meData.workspace?.id && auth.currentUser) {
          syncUserProfileToFirestore(auth.currentUser, meData.workspace.id).catch(() => {});
        }
      }

      if (accRes.ok) {
        const accData = await accRes.json();
        setAccounts(Array.isArray(accData) ? accData : []);
      }
    } catch (err) {
      console.error('Session initialization error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    if (firebaseUser) {
      fetchSessionAndAccounts();
    }
  }, [firebaseUser, fetchSessionAndAccounts]);

  useEffect(() => {
    const path = window.location.pathname;
    const hash = window.location.hash;
    if (path === '/payments' || hash === '#payments') {
      setActiveTab('payments');
    } else if (path === '/docs' || hash === '#apidocs') {
      setActiveTab('apidocs');
    }
  }, []);

  const handleGoogleLogin = async () => {
    setAuthBusy(true);
    setAuthError('');
    try {
      const user = await signInWithGooglePopup();
      const meRes = await apiFetch('/api/me');
      if (meRes.ok) {
        const meData = await meRes.json();
        if (meData.workspace?.id) {
          await syncUserProfileToFirestore(user, meData.workspace.id);
          await recordSecurityEventToFirestore('login', `Signed in with Google (${user.email})`);
        }
      }
    } catch (err: any) {
      const code = String(err?.code || '');
      if (code === 'auth/unauthorized-domain') {
        const host = typeof window !== 'undefined' ? window.location.hostname : '';
        setAuthError(
          `Firebase Console > Authentication > Settings > Authorized domains တွင် "${host}" ကို ထည့်သွင်းပေးပါ။`
        );
      } else if (code !== 'auth/popup-closed-by-user') {
        setAuthError(err?.message || 'Google Sign-In မအောင်မြင်ပါ။ ထပ်မံကြိုးစားပါ။');
      }
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = async () => {
    await signOutUser();
    setActiveTab('accounts');
  };

  const handleQuickAddAccount = () => {
    setActiveTab('accounts');
    setOpenAddModalSignal((n) => n + 1);
  };

  // Initial Firebase Auth Hydration State
  if (!authReady) {
    return (
      <div className="min-h-screen bg-white text-black flex items-center justify-center p-6">
        <div className="flex items-center gap-2.5 text-xs font-medium text-zinc-600">
          <RefreshCw className="w-4 h-4 text-black animate-spin" />
          <span>Loading session...</span>
        </div>
      </div>
    );
  }

  // Pure White & Black Google Authentication Gate
  if (!firebaseUser) {
    return (
      <div className="min-h-screen bg-white text-black flex flex-col justify-between px-4 py-8 sm:px-6">
        <header className="max-w-7xl w-full mx-auto flex items-center justify-between">
          <span className="text-base sm:text-lg font-bold tracking-tight text-black">
            Wave Gateway
          </span>
          <span className="text-xs font-medium text-zinc-500">
            WavePay · KBZPay · AYA Pay
          </span>
        </header>

        <main className="w-full max-w-md mx-auto my-auto py-12">
          <div className="bg-white border border-zinc-200 rounded-2xl p-6 sm:p-8 space-y-6 shadow-xs">
            <div className="space-y-2">
              <div className="w-10 h-10 rounded-xl bg-black text-white flex items-center justify-center">
                <Lock className="w-4 h-4" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-black pt-2">
                Sign in to Wave Gateway
              </h1>
              <p className="text-xs sm:text-sm text-zinc-600 leading-relaxed">
                သင်၏ WavePay, KBZPay နှင့် AYA Pay အကောင့်များ၊ Auto-Deposit / Auto-Withdraw နှင့် Merchant API Key ကို လုံခြုံစွာ စီမံခန့်ခွဲရန် Google အကောင့်ဖြင့် ဝင်ရောက်ပါ။
              </p>
            </div>

            {authError && (
              <div className="p-3.5 rounded-xl bg-white border-2 border-black text-xs text-black font-medium flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-black shrink-0 mt-0.5" />
                <span className="leading-relaxed">{authError}</span>
              </div>
            )}

            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={authBusy}
              className="w-full py-3 px-4 bg-black hover:bg-zinc-800 text-white text-xs sm:text-sm font-semibold rounded-xl transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2.5"
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M21.35 11.1h-9.17v2.73h6.51c-.33 1.81-1.5 3.34-3.2 4.37v3.62h5.18c3.03-2.79 4.78-6.9 4.78-11.8 0-.8-.08-1.57-.22-2.32l.12.4z"
                />
                <path
                  fill="currentColor"
                  d="M12.18 22c4.32 0 7.95-1.43 10.6-3.88l-5.18-3.62c-1.44.97-3.28 1.55-5.42 1.55-4.17 0-7.7-2.81-8.96-6.6H-2.1v3.73C.54 18.42 5.94 22 12.18 22z"
                />
                <path
                  fill="currentColor"
                  d="M3.22 13.45a9.6 9.6 0 0 1 0-6.1V3.62H-2.1a16.02 16.02 0 0 0 0 13.56l5.32-3.73z"
                />
                <path
                  fill="currentColor"
                  d="M12.18 4.75c2.35 0 4.46.81 6.12 2.4l4.59-4.59C20.12.98 16.5 0 12.18 0 5.94 0 .54 3.58-2.1 8.82l5.32 3.73c1.26-3.79 4.79-6.6 8.96-6.6z"
                />
              </svg>
              <span>{authBusy ? 'Connecting to Google...' : 'Continue with Google'}</span>
            </button>

            <div className="pt-2 border-t border-zinc-200 text-[11px] text-zinc-500 leading-relaxed">
              အကောင့်တစ်ခုချင်းစီအတွက် သီးသန့် Workspace နှင့် Encrypted Vault ဖြင့် လုံခြုံစွာ သီးခြားစီ ခွဲခြားထားပါသည်။
            </div>
          </div>
        </main>

        <footer className="max-w-7xl w-full mx-auto text-center text-xs text-zinc-400">
          Wave Money Payment Gateway · WavePay · KBZPay · AYA Pay
        </footer>
      </div>
    );
  }

  const safeTab: NavTab = !isAdmin && activeTab === 'admin990' ? 'accounts' : activeTab;

  return (
    <div className="min-h-screen bg-white text-black flex flex-col selection:bg-black selection:text-white overflow-x-hidden">
      <TopNav
        activeTab={safeTab}
        setActiveTab={(t) => {
          if (t === 'admin990' && !isAdmin) return;
          setActiveTab(t);
        }}
        onQuickAddAccount={handleQuickAddAccount}
        userEmail={firebaseUser.email || ''}
        isAdmin={isAdmin}
        onSignOut={handleSignOut}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {safeTab === 'accounts' && (
          <WaveAccountManager
            accounts={accounts}
            workspace={workspace}
            userUid={firebaseUser.uid}
            isLoading={isLoading}
            openAddModalSignal={openAddModalSignal}
            onRefresh={fetchSessionAndAccounts}
            onNavigateToApiDocs={() => setActiveTab('apidocs')}
          />
        )}

        {safeTab === 'payments' && (
          <PaymentOperations
            accounts={accounts}
            workspace={workspace}
            onRefreshAccounts={fetchSessionAndAccounts}
          />
        )}

        {safeTab === 'apidocs' && (
          <ApiDocsPage
            workspace={workspace}
            onRefreshWorkspace={fetchSessionAndAccounts}
          />
        )}

        {isAdmin && safeTab === 'admin990' && (
          <AdminPanel990 onRefreshGlobal={fetchSessionAndAccounts} />
        )}
      </main>

      <footer className="border-t border-zinc-200 bg-white py-5 text-xs text-zinc-500">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="font-medium text-zinc-600">
            Wave Money Payment Gateway · WavePay · KBZPay · AYA Pay
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setActiveTab('accounts')}
              className="hover:text-black cursor-pointer"
            >
              Wallets
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => setActiveTab('payments')}
              className="hover:text-black cursor-pointer"
            >
              Payment Mode
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => setActiveTab('apidocs')}
              className="hover:text-black cursor-pointer"
            >
              REST API
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
