import { initializeApp } from 'firebase/app';
import { getAnalytics, isSupported } from 'firebase/analytics';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const resolvedConfig = {
  ...firebaseConfig,
  measurementId: firebaseConfig.measurementId || 'G-27YMVGQX5T',
};

export const app = initializeApp(resolvedConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Initialize Firebase Analytics safely in browser environments
if (typeof window !== 'undefined') {
  isSupported()
    .then((yes) => {
      if (yes) getAnalytics(app);
    })
    .catch(() => {});
}

// Validate connection to Firestore on boot
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Validation constants synchronized verbatim with firebase-blueprint.json
const ID_REGEX = /^[a-zA-Z0-9_\-]+$/;
const ALLOWED_EVENT_TYPES = new Set([
  'login',
  'account_added',
  'account_removed',
  'deposit_created',
  'deposit_verified',
  'withdraw_executed',
  'key_rotated',
]);

export type SecurityEventType =
  | 'login'
  | 'account_added'
  | 'account_removed'
  | 'deposit_created'
  | 'deposit_verified'
  | 'withdraw_executed'
  | 'key_rotated';

export interface CloudSecurityEvent {
  id: string;
  ownerUid: string;
  eventType: SecurityEventType;
  summary: string;
  createdAtMs: number;
}

export async function signInWithGooglePopup(): Promise<User> {
  const cred = await signInWithPopup(auth, googleProvider);
  return cred.user;
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

export async function syncUserProfileToFirestore(user: User, workspaceId: string): Promise<void> {
  if (!user.uid || !user.email || !user.emailVerified) return;
  if (!ID_REGEX.test(user.uid) || user.uid.length > 128) return;
  if (!ID_REGEX.test(workspaceId) || workspaceId.length > 64) return;

  const userPath = `users/${user.uid}`;
  const userRef = doc(db, 'users', user.uid);
  const safeDisplayName = String(user.displayName || user.email.split('@')[0] || 'User').slice(0, 100);
  const safePhoto = String(user.photoURL || '').slice(0, 500);
  const safeEmail = String(user.email).slice(0, 254);

  let exists = false;
  try {
    const snap = await getDoc(userRef);
    exists = snap.exists();
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, userPath);
  }

  if (!exists) {
    try {
      await setDoc(userRef, {
        uid: user.uid,
        email: safeEmail,
        displayName: safeDisplayName,
        photoURL: safePhoto,
        workspaceId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, userPath);
    }
  } else {
    try {
      await updateDoc(userRef, {
        displayName: safeDisplayName,
        photoURL: safePhoto,
        workspaceId,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, userPath);
    }
  }
}

export async function recordSecurityEventToFirestore(
  eventType: SecurityEventType,
  summary: string
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.uid || !user.emailVerified) return;
  if (!ID_REGEX.test(user.uid) || user.uid.length > 128) return;
  if (!ALLOWED_EVENT_TYPES.has(eventType)) return;

  const safeSummary = String(summary || '').trim().slice(0, 240);
  if (!safeSummary) return;

  const eventId = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (!ID_REGEX.test(eventId)) return;

  const eventPath = `users/${user.uid}/events/${eventId}`;
  try {
    await setDoc(doc(db, 'users', user.uid, 'events', eventId), {
      ownerUid: user.uid,
      eventType,
      summary: safeSummary,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, eventPath);
  }
}

export function subscribeToUserSecurityEvents(
  uid: string,
  onEvents: (events: CloudSecurityEvent[]) => void
): Unsubscribe {
  const path = `users/${uid}/events`;
  const q = query(
    collection(db, 'users', uid, 'events'),
    where('ownerUid', '==', uid),
    orderBy('createdAt', 'desc'),
    limit(15)
  );

  return onSnapshot(
    q,
    (snap) => {
      const list: CloudSecurityEvent[] = snap.docs.map((d) => {
        const data = d.data();
        const ts = data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now();
        return {
          id: d.id,
          ownerUid: String(data.ownerUid || ''),
          eventType: data.eventType as SecurityEventType,
          summary: String(data.summary || ''),
          createdAtMs: ts,
        };
      });
      onEvents(list);
    },
    (err) => {
      handleFirestoreError(err, OperationType.LIST, path);
    }
  );
}
