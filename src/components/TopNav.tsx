import React from 'react';
import { Plus, LogOut } from 'lucide-react';

export type NavTab = 'accounts' | 'payments' | 'apidocs' | 'admin990';

interface TopNavProps {
  activeTab: NavTab;
  setActiveTab: (tab: NavTab) => void;
  onQuickAddAccount: () => void;
  userEmail: string;
  isAdmin: boolean;
  onSignOut: () => void;
}

export const TopNav: React.FC<TopNavProps> = ({
  activeTab,
  setActiveTab,
  onQuickAddAccount,
  userEmail,
  isAdmin,
  onSignOut,
}) => {
  // Admin tab is completely omitted from DOM for regular users
  const navLinks: Array<{ id: NavTab; label: string; shortLabel: string }> = [
    { id: 'accounts', label: 'Wallet Accounts', shortLabel: 'Wallets' },
    { id: 'payments', label: 'Payment Mode', shortLabel: 'Payment' },
    { id: 'apidocs', label: 'API Docs', shortLabel: 'API' },
    ...(isAdmin ? [{ id: 'admin990' as NavTab, label: 'Admin Control', shortLabel: 'Admin' }] : []),
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white/95 backdrop-blur-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between gap-3 sm:gap-6">
        {/* Zone 1: Brand wordmark */}
        <button
          type="button"
          onClick={() => setActiveTab('accounts')}
          className="text-base sm:text-lg font-bold tracking-tight text-black whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black rounded"
        >
          Wave Gateway
        </button>

        {/* Zone 2: Desktop navigation links */}
        <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-zinc-500">
          {navLinks.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`py-1 whitespace-nowrap shrink-0 transition-colors cursor-pointer border-b-2 ${
                  isActive
                    ? 'text-black border-black font-semibold'
                    : 'border-transparent hover:text-black hover:border-zinc-300'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: User session & primary action */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="hidden lg:inline-block text-xs font-mono text-zinc-500 max-w-[180px] truncate">
            {userEmail}
          </span>
          <button
            type="button"
            onClick={onQuickAddAccount}
            className="px-3 sm:px-4 py-2 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Wallet</span>
          </button>
          <button
            type="button"
            onClick={onSignOut}
            title={`Sign out (${userEmail})`}
            className="p-2 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg transition-colors cursor-pointer shrink-0 flex items-center gap-1"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Sign Out</span>
          </button>
        </div>
      </div>

      {/* Mobile Tab Strip: 3-col for standard users, 4-col ONLY for verified Admin */}
      <nav
        className={`md:hidden grid ${
          isAdmin ? 'grid-cols-4' : 'grid-cols-3'
        } border-t border-zinc-200 bg-white`}
      >
        {navLinks.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`py-2.5 px-1 text-center text-xs transition-colors whitespace-nowrap truncate cursor-pointer border-b-2 ${
                isActive
                  ? 'text-black font-bold border-black bg-zinc-50'
                  : 'text-zinc-500 font-medium border-transparent hover:text-black'
              }`}
            >
              {item.shortLabel}
            </button>
          );
        })}
      </nav>
    </header>
  );
};
