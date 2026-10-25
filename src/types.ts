export type WalletProvider = 'wave' | 'kbz' | 'aya';

export const WALLET_PROVIDER_LABELS: Record<WalletProvider, string> = {
  wave: 'WavePay',
  kbz: 'KBZPay',
  aya: 'AYA Pay',
};

export function formatProviderLabel(provider?: string): string {
  if (provider === 'kbz') return 'KBZPay';
  if (provider === 'aya') return 'AYA Pay';
  return 'WavePay';
}

export interface Workspace {
  id: string;
  name: string;
  api_key?: string;
  owner_uid?: string;
  owner_email?: string;
  owner_name?: string;
  photo_url?: string;
  created_at: string;
  accounts_count?: number;
  active_accounts_count?: number;
  total_balance?: number;
}

export interface WaveAccount {
  phone: string;
  provider?: WalletProvider;
  workspace_id?: string;
  workspace_name?: string;
  owner_email?: string;
  owner_name?: string;
  model: string;
  os_version: string;
  has_session?: boolean;
  has_pin?: boolean;
  has_nrc?: boolean;
  masked_pin?: string;
  balance?: number;
  name?: string;
  status?: string;
  user_removed?: boolean;
  removed_at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Merchant {
  merchant_name: string;
  domain: string;
  token: string;
  created_at: string;
  active: boolean | number;
}

export interface PaymentTokenRecord {
  token: string;
  type: 'deposit' | 'withdraw';
  provider?: WalletProvider;
  workspace_id?: string;
  merchant_token?: string;
  merchant_name?: string;
  domain?: string;
  amount: number;
  phone_number?: string;
  receiver?: string;
  created_at: number;
  expires_at: number;
  status: 'pending' | 'authorized' | 'success' | 'executed' | 'expired';
  trx_id?: string;
  executed_from?: string;
  last5_digits?: string;
  verified_at?: number;
}

export interface TransactionHistoryItem {
  transId: string;
  amount: number;
  direction?: 'CR' | 'DR' | string;
  title?: string;
  time?: string;
  senderPhone?: string;
  receiverPhone?: string;
}

export interface GatewayLog {
  id: number;
  event_type: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';
  message: string;
  details?: string;
  forwarded_to_bot: number;
  created_at: string;
}

export interface UsedTrxRecord {
  trx_id: string;
  used_at: number;
  auth_token: string;
  amount: number;
  source: string;
}

export interface AuthenticatedSessionInfo {
  uid: string;
  email: string;
  name: string;
  is_admin: boolean;
  workspace: Workspace;
}
