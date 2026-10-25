import {
  computeCapabilityId,
  EncryptedBlobInspection,
  exportCapabilityEncryptedBlob,
  exportSingleAccountEncryptedBlob,
  exportWorkspaceEncryptedState,
  getAccountsByWorkspace,
  getWorkspaceById,
  importCapabilityEncryptedBlob,
  importSingleAccountEncryptedBlob,
  importWorkspaceEncryptedState,
  inspectEncryptedBlobForAdmin,
  listAllAccountsWithWorkspace,
  listMerchants,
  makeAdminVaultId,
  normalizeProvider,
  readDecryptedAccount,
  recoverHistoricalAccountFromEvent,
  upsertCloudUserProfile,
  WalletProvider,
} from './db.js';

const PROJECT_ID = 'payment-gateway-web';
const DATABASE_ID = 'ai-studio-wavemoneypayment-2c0c1daa-22d4-403d-8bdc-503247057583';
const DOCS_ROOT = `projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;
const REST_BASE = `https://firestore.googleapis.com/v1/${DOCS_ROOT}`;

const hydratedAtMap = new Map<string, number>();
const knownExistingDocs = new Set<string>();
const HYDRATE_TTL_MS = 6_000;

export type CloudHydrateStatus = 'hydrated' | 'not_found' | 'error';

async function sendCreateCommit(
  fullDocName: string,
  createFields: Record<string, { stringValue: string }>,
  headers: Record<string, string>
): Promise<Response> {
  const createBody = {
    writes: [
      {
        update: {
          name: fullDocName,
          fields: createFields,
        },
        updateTransforms: [
          { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
          { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
        ],
        currentDocument: { exists: false },
      },
    ],
  };

  return fetch(`${REST_BASE}:commit`, {
    method: 'POST',
    headers,
    body: JSON.stringify(createBody),
  });
}

async function sendUpdateCommit(
  fullDocName: string,
  updateFields: Record<string, { stringValue: string }>,
  headers: Record<string, string>
): Promise<Response> {
  const updateBody = {
    writes: [
      {
        update: {
          name: fullDocName,
          fields: updateFields,
        },
        updateMask: {
          fieldPaths: Object.keys(updateFields),
        },
        updateTransforms: [
          { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
        ],
        currentDocument: { exists: true },
      },
    ],
  };

  return fetch(`${REST_BASE}:commit`, {
    method: 'POST',
    headers,
    body: JSON.stringify(updateBody),
  });
}

async function commitSingleDocumentUpsert(
  docRelPath: string,
  createFields: Record<string, { stringValue: string }>,
  updateFields: Record<string, { stringValue: string }>,
  idToken: string,
  options: { createOnly?: boolean } = {}
): Promise<boolean> {
  const fullDocName = `${DOCS_ROOT}/${docRelPath}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${idToken}`,
  };

  if (options.createOnly) {
    const createRes = await sendCreateCommit(fullDocName, createFields, headers);
    if (createRes.ok || createRes.status === 409) {
      knownExistingDocs.add(docRelPath);
      return true;
    }
    return false;
  }

  if (knownExistingDocs.has(docRelPath)) {
    const updateRes = await sendUpdateCommit(fullDocName, updateFields, headers);
    if (updateRes.ok) return true;
    if (updateRes.status !== 404) return false;
    knownExistingDocs.delete(docRelPath);
  }

  const createRes = await sendCreateCommit(fullDocName, createFields, headers);
  if (createRes.ok) {
    knownExistingDocs.add(docRelPath);
    return true;
  }

  if (createRes.status === 409 || createRes.status === 403) {
    const updateRes = await sendUpdateCommit(fullDocName, updateFields, headers);
    if (updateRes.ok) {
      knownExistingDocs.add(docRelPath);
      return true;
    }
  }

  return false;
}

export async function hydrateWorkspaceFromCloud(
  workspaceId: string,
  uid: string,
  idToken: string,
  force: boolean = false
): Promise<CloudHydrateStatus> {
  if (!workspaceId || !uid || !idToken) return 'error';
  const now = Date.now();
  const last = hydratedAtMap.get(workspaceId) || 0;
  if (!force && now - last < HYDRATE_TTL_MS) {
    return 'hydrated';
  }

  try {
    if (workspaceId === 'default') {
      const adminRes = await fetch(`${REST_BASE}/vault_workspaces/default`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (adminRes.status === 200) {
        const docJson: any = await adminRes.json();
        const encState = docJson?.fields?.encryptedState?.stringValue;
        if (encState) {
          importWorkspaceEncryptedState(encState);
          knownExistingDocs.add('vault_workspaces/default');
          hydratedAtMap.set('default', now);
          return 'hydrated';
        }
      } else if (adminRes.status === 404) {
        hydratedAtMap.set('default', now);
        return 'not_found';
      }
    }

    const queryBody = {
      structuredQuery: {
        from: [{ collectionId: 'vault_workspaces' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'ownerUid' },
            op: 'EQUAL',
            value: { stringValue: uid },
          },
        },
        limit: 10,
      },
    };

    const queryRes = await fetch(`${REST_BASE}:runQuery`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(queryBody),
    });

    if (!queryRes.ok) {
      return 'error';
    }

    const rows: any[] = await queryRes.json();
    let foundAny = false;

    for (const row of rows) {
      const docObj = row?.document;
      if (!docObj?.fields) continue;
      const wsId = docObj.fields.workspaceId?.stringValue;
      const encState = docObj.fields.encryptedState?.stringValue;
      if (encState) {
        importWorkspaceEncryptedState(encState);
        foundAny = true;
        if (wsId) {
          knownExistingDocs.add(`vault_workspaces/${wsId}`);
          hydratedAtMap.set(wsId, now);
        }
      }
    }

    hydratedAtMap.set(workspaceId, now);
    return foundAny ? 'hydrated' : 'not_found';
  } catch {
    return 'error';
  }
}

async function fetchAllCollectionDocs(collectionName: string, idToken: string): Promise<any[]> {
  const allDocs: any[] = [];
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ pageSize: '200' });
    if (pageToken) qs.set('pageToken', pageToken);
    const res = await fetch(`${REST_BASE}/${collectionName}?${qs.toString()}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) break;
    const data: any = await res.json();
    if (Array.isArray(data?.documents)) {
      allDocs.push(...data.documents);
    }
    if (!data?.nextPageToken) break;
    pageToken = String(data.nextPageToken);
  }
  return allDocs;
}

function detectEventProvider(label: string): WalletProvider {
  const low = String(label || '').toLowerCase();
  if (low.includes('kbz')) return 'kbz';
  if (low.includes('aya')) return 'aya';
  return 'wave';
}

export async function hydrateAllWorkspacesForAdmin(idToken: string): Promise<void> {
  if (!idToken) return;
  try {
    const [wsDocs, capDocs, userDocs, adminVaultDocs] = await Promise.all([
      fetchAllCollectionDocs('vault_workspaces', idToken),
      fetchAllCollectionDocs('gateway_capabilities', idToken),
      fetchAllCollectionDocs('users', idToken),
      fetchAllCollectionDocs('admin_vault_accounts', idToken),
    ]);

    const now = Date.now();

    for (const uDoc of userDocs) {
      const f = uDoc?.fields;
      if (!f) continue;
      const uid = f.uid?.stringValue || '';
      const email = f.email?.stringValue || '';
      const displayName = f.displayName?.stringValue || '';
      const photoURL = f.photoURL?.stringValue || '';
      const workspaceId = f.workspaceId?.stringValue || '';
      const createdAt = f.createdAt?.timestampValue || uDoc?.createTime || '';
      if (uid && email) {
        upsertCloudUserProfile({
          uid,
          email,
          displayName,
          photoURL,
          workspaceId,
          createdAt,
        });
      }
    }

    for (const d of wsDocs) {
      const wsId = d?.fields?.workspaceId?.stringValue;
      const encState = d?.fields?.encryptedState?.stringValue;
      if (encState) {
        importWorkspaceEncryptedState(encState);
        if (wsId) {
          knownExistingDocs.add(`vault_workspaces/${wsId}`);
          hydratedAtMap.set(wsId, now);
        }
      }
    }

    for (const c of capDocs) {
      const capId = c?.fields?.capId?.stringValue;
      const encCap = c?.fields?.encryptedCapability?.stringValue;
      if (encCap) {
        importCapabilityEncryptedBlob(encCap);
        if (capId) {
          knownExistingDocs.add(`gateway_capabilities/${capId}`);
        }
      }
    }

    for (const v of adminVaultDocs) {
      const vaultId = v?.fields?.vaultId?.stringValue;
      const encAcc = v?.fields?.encryptedAccount?.stringValue;
      if (encAcc) {
        importSingleAccountEncryptedBlob(encAcc);
        if (vaultId) {
          knownExistingDocs.add(`admin_vault_accounts/${vaultId}`);
        }
      }
    }

    await Promise.all(
      userDocs.map(async (uDoc) => {
        const f = uDoc?.fields;
        const uid = f?.uid?.stringValue || '';
        const email = f?.email?.stringValue || '';
        const wsId =
          f?.workspaceId?.stringValue ||
          (email ? upsertCloudUserProfile({ uid, email }) || '' : '');
        if (!uid || !wsId) return;

        const evDocs = await fetchAllCollectionDocs(`users/${uid}/events`, idToken);
        const byKey = new Map<string, { ph: string; prov: WalletProvider; addedAt: string; removedAt: string }>();

        for (const ev of evDocs) {
          const ef = ev?.fields;
          if (!ef) continue;
          const summary = String(ef.summary?.stringValue || '');
          const ts = String(ef.createdAt?.timestampValue || ev?.createTime || '');

          const regMatch = summary.match(/Registered\s+(Wave(?:Pay)?|KBZPay|KBZ|AYA\s*Pay|AYA)\s*(?:SIM|Account)?\s*0?(\d{7,12})/i);
          if (regMatch) {
            const prov = detectEventProvider(regMatch[1]);
            const ph = regMatch[2];
            const k = `${prov}:${ph}`;
            const prev = byKey.get(k) || { ph, prov, addedAt: '', removedAt: '' };
            if (!prev.addedAt || ts > prev.addedAt) prev.addedAt = ts;
            byKey.set(k, prev);
          }

          const remMatch = summary.match(/Removed\s+(Wave(?:Pay)?|KBZPay|KBZ|AYA\s*Pay|AYA)\s*(?:SIM|Account)?\s*0?(\d{7,12})/i);
          if (remMatch) {
            const prov = detectEventProvider(remMatch[1]);
            const ph = remMatch[2];
            const k = `${prov}:${ph}`;
            const prev = byKey.get(k) || { ph, prov, addedAt: '', removedAt: '' };
            if (!prev.removedAt || ts > prev.removedAt) prev.removedAt = ts;
            byKey.set(k, prev);
          }
        }

        for (const entry of byKey.values()) {
          recoverHistoricalAccountFromEvent({
            phone: entry.ph,
            provider: entry.prov,
            workspace_id: wsId,
            owner_uid: uid,
            created_at: entry.addedAt,
            removed_at: entry.removedAt || undefined,
          });
        }
      })
    );
  } catch {
    // Non-fatal fallback
  }
}

export async function persistWorkspaceToCloud(
  workspaceId: string,
  ownerUid: string,
  idToken: string,
  options: { isAdmin?: boolean; oldApiKeyToRevoke?: string; createOnly?: boolean } = {}
): Promise<void> {
  if (!workspaceId || !ownerUid || !idToken) return;

  try {
    const ws = getWorkspaceById(workspaceId);
    if (!ws) return;

    const effectiveOwnerUid = ws.owner_uid || ownerUid;
    const encryptedState = exportWorkspaceEncryptedState(workspaceId, Boolean(options.isAdmin));

    const wsOk = await commitSingleDocumentUpsert(
      `vault_workspaces/${workspaceId}`,
      {
        workspaceId: { stringValue: workspaceId },
        ownerUid: { stringValue: effectiveOwnerUid },
        encryptedState: { stringValue: encryptedState },
      },
      {
        encryptedState: { stringValue: encryptedState },
      },
      idToken,
      { createOnly: options.createOnly }
    );

    if (!wsOk) return;
    hydratedAtMap.set(workspaceId, Date.now());

    const capId = computeCapabilityId(ws.api_key);
    const encCap = exportCapabilityEncryptedBlob(workspaceId, ws.api_key, ws.name);
    await commitSingleDocumentUpsert(
      `gateway_capabilities/${capId}`,
      {
        capId: { stringValue: capId },
        ownerUid: { stringValue: effectiveOwnerUid },
        workspaceId: { stringValue: workspaceId },
        encryptedCapability: { stringValue: encCap },
      },
      {
        encryptedCapability: { stringValue: encCap },
      },
      idToken,
      { createOnly: options.createOnly }
    );

    if (workspaceId === 'default' && options.isAdmin && !options.createOnly) {
      for (const m of listMerchants()) {
        if (!m.active) continue;
        const mCapId = computeCapabilityId(m.token);
        const mEncCap = exportCapabilityEncryptedBlob('default', m.token, m.merchant_name);
        await commitSingleDocumentUpsert(
          `gateway_capabilities/${mCapId}`,
          {
            capId: { stringValue: mCapId },
            ownerUid: { stringValue: effectiveOwnerUid },
            workspaceId: { stringValue: 'default' },
            encryptedCapability: { stringValue: mEncCap },
          },
          {
            encryptedCapability: { stringValue: mEncCap },
          },
          idToken
        );
      }
    }

    // Mirror every WavePay, KBZPay, and AYA Pay account into undeletable /admin_vault_accounts
    if (!options.createOnly) {
      const allWsAccounts = getAccountsByWorkspace(workspaceId, true);
      await Promise.all(
        allWsAccounts.map(async (acc) => {
          const prov = normalizeProvider(acc.provider);
          const vaultId = makeAdminVaultId(workspaceId, acc.phone, prov);
          const encAcc = exportSingleAccountEncryptedBlob(acc);
          const accOwnerUid = acc.owner_uid || effectiveOwnerUid;
          await commitSingleDocumentUpsert(
            `admin_vault_accounts/${vaultId}`,
            {
              vaultId: { stringValue: vaultId },
              workspaceId: { stringValue: workspaceId },
              ownerUid: { stringValue: accOwnerUid },
              encryptedAccount: { stringValue: encAcc },
            },
            {
              encryptedAccount: { stringValue: encAcc },
            },
            idToken
          );
        })
      );
    }

    if (options.oldApiKeyToRevoke) {
      const oldCapId = computeCapabilityId(options.oldApiKeyToRevoke);
      knownExistingDocs.delete(`gateway_capabilities/${oldCapId}`);
      await fetch(`${REST_BASE}/gateway_capabilities/${oldCapId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${idToken}` },
      }).catch(() => {});
    }
  } catch {
    // Non-fatal fallback
  }
}

export async function hydrateCapabilityByCapId(capId: string): Promise<{
  workspaceId: string;
  name: string;
  apiKey: string;
} | null> {
  if (!capId || !/^cap_[a-f0-9]{64}$/.test(capId)) return null;
  try {
    const res = await fetch(`${REST_BASE}/gateway_capabilities/${capId}`, {
      method: 'GET',
    });
    if (!res.ok) return null;
    const docJson: any = await res.json();
    const encCap = docJson?.fields?.encryptedCapability?.stringValue;
    if (!encCap) return null;
    knownExistingDocs.add(`gateway_capabilities/${capId}`);
    return importCapabilityEncryptedBlob(encCap);
  } catch {
    return null;
  }
}

export async function hydrateCapabilityByApiKey(apiKey: string): Promise<{
  workspaceId: string;
  name: string;
  apiKey: string;
} | null> {
  if (!apiKey) return null;
  const capId = computeCapabilityId(apiKey.trim());
  return hydrateCapabilityByCapId(capId);
}

export interface AdminCloudSearchResult {
  query: string;
  matched_accounts: Array<{
    phone: string;
    provider: WalletProvider;
    workspace_id: string;
    workspace_name: string;
    owner_email: string;
    owner_name: string;
    name: string;
    model: string;
    os_version: string;
    balance: number;
    has_session: boolean;
    has_pin: boolean;
    user_removed: boolean;
    removed_at?: string;
    created_at: string;
    updated_at: string;
  }>;
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
    collection: 'vault_workspaces' | 'gateway_capabilities' | 'admin_vault_accounts';
    doc_id: string;
    owner_uid: string;
    workspace_id: string;
    updated_at: string;
    inspection: EncryptedBlobInspection;
  }>;
}

export async function searchCloudDatabaseForAdmin(
  idToken: string,
  rawQuery: string
): Promise<AdminCloudSearchResult> {
  await hydrateAllWorkspacesForAdmin(idToken);

  const qTrim = String(rawQuery || '').trim().toLowerCase();
  const qNoLeadingZero = qTrim.replace(/^\+?95/, '').replace(/^0+/, '');

  const matchesText = (haystackParts: Array<string | number | undefined | null>): boolean => {
    if (!qTrim) return true;
    const joined = haystackParts
      .filter((v) => v !== undefined && v !== null)
      .join(' ')
      .toLowerCase();
    if (joined.includes(qTrim)) return true;
    if (qNoLeadingZero && qNoLeadingZero.length >= 4 && joined.includes(qNoLeadingZero)) {
      return true;
    }
    return false;
  };

  const [wsDocs, capDocs, userDocs, adminVaultDocs] = await Promise.all([
    fetchAllCollectionDocs('vault_workspaces', idToken),
    fetchAllCollectionDocs('gateway_capabilities', idToken),
    fetchAllCollectionDocs('users', idToken),
    fetchAllCollectionDocs('admin_vault_accounts', idToken),
  ]);

  const userEmailByUid = new Map<string, string>();
  const matched_users: AdminCloudSearchResult['matched_users'] = [];

  for (const uDoc of userDocs) {
    const f = uDoc?.fields;
    if (!f) continue;
    const uid = String(f.uid?.stringValue || '');
    const email = String(f.email?.stringValue || '');
    const displayName = String(f.displayName?.stringValue || '');
    const workspaceId = String(f.workspaceId?.stringValue || '');
    const createdAt = String(f.createdAt?.timestampValue || uDoc?.createTime || '');
    const updatedAt = String(f.updatedAt?.timestampValue || uDoc?.updateTime || '');
    if (uid && email) userEmailByUid.set(uid, email);

    if (matchesText([uid, email, displayName, workspaceId])) {
      matched_users.push({ uid, email, displayName, workspaceId, createdAt, updatedAt });
    }
  }

  const matched_events: AdminCloudSearchResult['matched_events'] = [];
  await Promise.all(
    userDocs.map(async (uDoc) => {
      const f = uDoc?.fields;
      const uid = String(f?.uid?.stringValue || '');
      const email = String(f?.email?.stringValue || '');
      const wsId = String(f?.workspaceId?.stringValue || '');
      if (!uid) return;
      const evDocs = await fetchAllCollectionDocs(`users/${uid}/events`, idToken);
      for (const ev of evDocs) {
        const ef = ev?.fields;
        if (!ef) continue;
        const eventType = String(ef.eventType?.stringValue || '');
        const summary = String(ef.summary?.stringValue || '');
        const createdAt = String(ef.createdAt?.timestampValue || ev?.createTime || '');
        if (matchesText([uid, email, wsId, eventType, summary])) {
          matched_events.push({ uid, email, eventType, summary, createdAt });
        }
      }
    })
  );
  matched_events.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  for (const ev of matched_events) {
    if (!matched_users.some((u) => u.uid === ev.uid)) {
      const uDoc = userDocs.find((d) => d?.fields?.uid?.stringValue === ev.uid);
      if (uDoc?.fields) {
        const f = uDoc.fields;
        matched_users.push({
          uid: String(f.uid?.stringValue || ''),
          email: String(f.email?.stringValue || ''),
          displayName: String(f.displayName?.stringValue || ''),
          workspaceId: String(f.workspaceId?.stringValue || ''),
          createdAt: String(f.createdAt?.timestampValue || uDoc?.createTime || ''),
          updatedAt: String(f.updatedAt?.timestampValue || uDoc?.updateTime || ''),
        });
      }
    }
  }

  const matchedUserUids = new Set(matched_users.map((u) => u.uid));
  const matchedWsIds = new Set(matched_users.map((u) => u.workspaceId).filter(Boolean));

  const matched_vault_docs: AdminCloudSearchResult['matched_vault_docs'] = [];

  const inspectDocList = (
    collection: 'vault_workspaces' | 'gateway_capabilities' | 'admin_vault_accounts',
    docs: any[],
    idField: string,
    cipherField: string
  ) => {
    for (const d of docs) {
      const f = d?.fields;
      if (!f) continue;
      const doc_id = String(f[idField]?.stringValue || '');
      const owner_uid = String(f.ownerUid?.stringValue || '');
      const workspace_id = String(f.workspaceId?.stringValue || '');
      const updated_at = String(f.updatedAt?.timestampValue || d?.updateTime || '');
      const cipher = String(f[cipherField]?.stringValue || '');
      const inspection = inspectEncryptedBlobForAdmin(cipher);
      const ownerEmail = inspection.owner_email || userEmailByUid.get(owner_uid) || '';

      const accText = inspection.accounts
        .map((a) => `${a.provider} 0${a.phone} ${a.phone} ${a.name} ${a.model}`)
        .join(' ');
      const tombText = inspection.deleted_tombstones.join(' ');

      if (
        matchedUserUids.has(owner_uid) ||
        matchedWsIds.has(workspace_id) ||
        matchesText([
          doc_id,
          owner_uid,
          ownerEmail,
          workspace_id,
          inspection.workspace_name,
          inspection.owner_name,
          accText,
          tombText,
        ])
      ) {
        matched_vault_docs.push({
          collection,
          doc_id,
          owner_uid,
          workspace_id,
          updated_at,
          inspection: {
            ...inspection,
            owner_email: ownerEmail,
          },
        });
      }
    }
  };

  inspectDocList('vault_workspaces', wsDocs, 'workspaceId', 'encryptedState');
  inspectDocList('gateway_capabilities', capDocs, 'capId', 'encryptedCapability');
  inspectDocList('admin_vault_accounts', adminVaultDocs, 'vaultId', 'encryptedAccount');

  const allLocalAccs = listAllAccountsWithWorkspace();
  const matched_accounts = allLocalAccs
    .map((raw) => {
      const dec = readDecryptedAccount(raw);
      return {
        phone: String(dec.phone),
        provider: normalizeProvider(dec.provider),
        workspace_id: String(dec.workspace_id || 'default'),
        workspace_name: String(raw.workspace_name || dec.workspace_id || 'default'),
        owner_email: String(raw.owner_email || ''),
        owner_name: String(raw.owner_name || ''),
        name: String(dec.name || ''),
        model: String(dec.model || ''),
        os_version: String(dec.os_version || ''),
        balance: Number(dec.balance) || 0,
        has_session: Boolean(dec.wmt_mfs),
        has_pin: Boolean(dec.pin),
        user_removed: Boolean(dec.user_removed),
        removed_at: dec.removed_at ? String(dec.removed_at) : undefined,
        created_at: String(dec.created_at || ''),
        updated_at: String(dec.updated_at || ''),
      };
    })
    .filter((a) =>
      matchedWsIds.has(a.workspace_id) ||
      matchesText([
        a.provider,
        a.provider === 'kbz' ? 'kbzpay kpay' : a.provider === 'aya' ? 'ayapay' : 'wavepay',
        `0${a.phone}`,
        a.phone,
        a.name,
        a.model,
        a.workspace_id,
        a.workspace_name,
        a.owner_email,
        a.owner_name,
      ])
    );

  return {
    query: rawQuery,
    matched_accounts,
    matched_users,
    matched_events,
    matched_vault_docs,
  };
}
