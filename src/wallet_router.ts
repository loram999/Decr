import { normalizeProvider, WalletProvider } from './db.js';
import { WaveWalletEngine } from './wave_client.js';
import { KbzWalletEngine } from './kbz_client.js';
import { AyaWalletEngine } from './aya_client.js';
import type { TransactionHistoryItem } from './types.js';

export interface UnifiedWalletOperations {
  provider: WalletProvider;
  getWalletBalance(): Promise<number>;
  getTransactionHistory(
    limit?: number,
    offset?: number
  ): Promise<{ status: number; items: TransactionHistoryItem[] }>;
  checkBeneficiary(msisdn: string): Promise<string>;
  transfer(
    receiver: string,
    amount: number | string,
    pin?: string,
    note?: string
  ): Promise<{ trxId: string; receiverName: string; senderName: string }>;
}

export function createWalletEngineForAccount(
  decryptedAcc: any,
  customPin?: string
): UnifiedWalletOperations {
  const provider = normalizeProvider(decryptedAcc?.provider);

  if (provider === 'kbz') {
    const engine = new KbzWalletEngine({
      phone: decryptedAcc.phone,
      workspaceId: decryptedAcc.workspace_id,
      deviceId: decryptedAcc.device_id,
      model: decryptedAcc.model,
      osVersion: decryptedAcc.os_version,
      wmtMfs: decryptedAcc.wmt_mfs,
      pin: customPin || decryptedAcc.pin,
      nrcId: decryptedAcc.nrc_id,
      name: decryptedAcc.name,
      meta: decryptedAcc.meta,
    });
    return {
      provider: 'kbz',
      getWalletBalance: () => engine.getWalletBalance(),
      getTransactionHistory: (limit, offset) => engine.getTransactionHistory(limit, offset),
      checkBeneficiary: (msisdn) => engine.checkBeneficiary(msisdn),
      transfer: (receiver, amount, pin, note) => engine.transfer(receiver, amount, pin, note),
    };
  }

  if (provider === 'aya') {
    const engine = new AyaWalletEngine({
      phone: decryptedAcc.phone,
      workspaceId: decryptedAcc.workspace_id,
      deviceId: decryptedAcc.device_id,
      model: decryptedAcc.model,
      osVersion: decryptedAcc.os_version,
      wmtMfs: decryptedAcc.wmt_mfs,
      pin: customPin || decryptedAcc.pin,
      name: decryptedAcc.name,
      meta: decryptedAcc.meta,
    });
    return {
      provider: 'aya',
      getWalletBalance: () => engine.getWalletBalance(),
      getTransactionHistory: (limit, offset) => engine.getTransactionHistory(limit, offset),
      checkBeneficiary: (msisdn) => engine.checkBeneficiary(msisdn),
      transfer: (receiver, amount, pin, note) => engine.transfer(receiver, amount, pin, note),
    };
  }

  const engine = new WaveWalletEngine({
    phone: decryptedAcc.phone,
    workspaceId: decryptedAcc.workspace_id,
    deviceId: decryptedAcc.device_id,
    model: decryptedAcc.model,
    osVersion: decryptedAcc.os_version,
    wmtMfs: decryptedAcc.wmt_mfs,
    pin: customPin || decryptedAcc.pin,
  });

  return {
    provider: 'wave',
    getWalletBalance: () => engine.getWalletBalance(),
    getTransactionHistory: (limit, offset) => engine.getTransactionHistory(limit, offset),
    checkBeneficiary: (msisdn) => engine.checkBeneficiary(msisdn),
    transfer: (receiver, amount, pin, note) => engine.transfer(receiver, amount, pin, note),
  };
}
