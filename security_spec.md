# Firestore Security Specification (`security_spec.md`)

## 1. Data Invariants

1. **Zero Plaintext Secrets in Firestore**: Wave session tokens (`wmt-mfs`), PINs, device IDs, RSA keys, and upstream API URLs are NEVER stored in plaintext in Firestore. Any serverless persistence in `/vault_workspaces/{workspaceId}` and `/gateway_capabilities/{capId}` is strictly AES-256-GCM encrypted (`^enc:v1:[A-Za-z0-9+/=:]+$`) using the server-only 256-bit vault key.
2. **Strict Tenant & PII Isolation**: A `/users/{userId}` document contains `email` (PII) and can ONLY be read or written by the verified owner (`request.auth.uid == userId && request.auth.token.email_verified == true`) or a verified administrator (`isAdmin()`). Similarly, `/vault_workspaces/{workspaceId}` can ONLY be read or written by `ownerUid == request.auth.uid` or `isAdmin()`.
3. **Master Gate Relational Integrity**:
   - `/users/{userId}/events/{eventId}` cannot be created unless parent `/users/{userId}` exists and `ownerUid == userId == request.auth.uid`.
   - `/gateway_capabilities/{capId}` cannot be created unless parent `/vault_workspaces/{workspaceId}` exists and belongs to `request.auth.uid` (or `isAdmin()`), and `capId` matches a 256-bit hex HMAC (`^cap_[a-f0-9]{64}$`). Enumeration (`list`) is blocked for all non-admins.
4. **Immutable Audit Trail & Immortal Fields**: Documents in `/users/{userId}/events/{eventId}` are append-only (`allow update: if false`), immutable ownership fields (`uid`, `ownerUid`, `workspaceId`, `capId`, `createdAt`) cannot be altered on update, and timestamps (`createdAt`, `updatedAt`) must equal `request.time`.
5. **Privilege Escalation Prevention**: Client writes to `/admins/{adminUid}` are unconditionally denied (`allow write: if false`), and shadow RBAC fields (`isAdmin`, `role`) on all collections are blocked by `.keys().hasOnly(...)`.
6. **Permanent Non-Deletable Admin SIM Vault**: Every SIM registered in any workspace is mirrored in AES-256-GCM encrypted form to `/admin_vault_accounts/{vaultId}`. Deletion is unconditionally forbidden (`allow delete: if false`) for all principals, and `list` enumeration is restricted exclusively to `isBootstrappedAdmin()`.

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Shadow Role Escalation**: `POST /users/uid_1` with `{ uid: "uid_1", email: "a@b.com", displayName: "A", photoURL: "", workspaceId: "ws_1", role: "admin", createdAt: SERVER_TIME, updatedAt: SERVER_TIME }` -> `PERMISSION_DENIED` (`hasOnly` violation).
2. **Unverified Email Spoofing**: Admin email `kp7931374@gmail.com` with `email_verified: false` reading `/users/victim_uid` -> `PERMISSION_DENIED`.
3. **Cross-Tenant PII & Vault Read**: Authenticated `uid_attacker` calling `get(/vault_workspaces/ws_victim)` -> `PERMISSION_DENIED`.
4. **Identity Spoofing on Create**: `uid_attacker` creating `/users/uid_attacker` with `uid: "uid_victim"` -> `PERMISSION_DENIED`.
5. **Plaintext Injection in Encrypted Vault**: `uid_1` writing `{ workspaceId: "ws_1", ownerUid: "uid_1", encryptedState: "{\"raw\":\"secret\"}" }` to `/vault_workspaces/ws_1` -> `PERMISSION_DENIED` (`^enc:v1:` regex violation).
6. **Timestamp Forgery**: Creating `/users/uid_1` with `createdAt` set to past/future client timestamp (`!= request.time`) -> `PERMISSION_DENIED`.
7. **Immutable Field Mutation**: Updating `/vault_workspaces/ws_1` to mutate `ownerUid` or `createdAt` -> `PERMISSION_DENIED`.
8. **Value Poisoning on Update**: Updating `/users/uid_1` `displayName` with a boolean `true` or a 10KB string -> `PERMISSION_DENIED` (`isValidUserProfile` wraps update).
9. **ID Poisoning Attack**: Creating `/users/{1500_char_junk_id}` or `/gateway_capabilities/short_id` -> `PERMISSION_DENIED` (`isValidId` / `isValidCapId` check).
10. **Orphaned Capability Creation**: Creating `/gateway_capabilities/cap_<64hex>` referencing non-existent `/vault_workspaces/ws_missing` -> `PERMISSION_DENIED` (`exists()` + `get()` Master Gate check).
11. **Capability & Admin Vault Collection Scraping**: Authenticated non-admin calling `list(/gateway_capabilities)` or `list(/admin_vault_accounts)` -> `PERMISSION_DENIED`.
12. **Permanent Vault Deletion Attempt**: Owner or admin attempting `delete(/admin_vault_accounts/ws_1_977000000)` -> `PERMISSION_DENIED` (`allow delete: if false`).
