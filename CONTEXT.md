# Zcash Browser Wallet

Self-custodial Zcash wallet running entirely in the browser: no backend of ours, keys never leave the browser, chain access via a user-chosen lightwalletd endpoint.

## Language

### Structure

**Wallet**:
A container for one user secret (spending key or viewing key) and its accounts' balances, note/UTXO inventory, and history. Users create many Wallets per network (e.g. savings vs spending).
_Avoid_: profile, store, database (as UI terms)

**Account**:
A funded entity inside a Wallet, derived from its secret key at a distinct ZIP-32 path. What holds a balance and addresses.
_Avoid_: wallet (for this meaning), subaccount

**Client**:
The `zcash.js` connection object binding a Wallet's storage to one network endpoint. An implementation concept; never shown in UI copy.
_Avoid_: connection, session

**Network**:
Mainnet or Testnet. Each network has its own Wallets, storage, and endpoint settings.

**Vault**:
The app-level encrypted store of a Wallet's seed (AES-GCM envelope in IndexedDB). Create keys it with a user passphrase. Restore keys it with a device-local key and does not ask for a vault passphrase. Holds spend authority; the SDK's own DB never does.
_Avoid_: keystore, keychain

### Session

**Unlock**:
Loading spend authority into memory (`attachSigner`). A user-passphrase Vault asks for that passphrase. A device-stored restore wallet unlocks without one.
_Avoid_: login, sign in

**Lock**:
Session-level removal of *all* spend authority from memory, app-wide — every open Wallet on both networks (`detachSigner` + zeroize, session seed-mirrors cleared). Viewing continues; sending requires Unlock. The only user-facing "lock".
_Avoid_: logout, pause

### Coin selection

**Exclude**:
App-side flag marking a note/UTXO unavailable for sending; persists per Wallet and is always visible as an "N excluded" count with one-tap reset. Enforced by verifying the composed proposal's inputs, not by the SDK (it has no user note-lock; `InventoryFilter.locked` reflects operation-held input locks and is display-only here).
_Avoid_: lock (for notes), mute

### Receiving

**Exposed Address**:
An address once shown to a payer; it permanently occupies the next slot in the Account's address chain and stays valid for life.
_Avoid_: fresh address, one-time address

**Receive Address**:
The single Exposed Address currently shown for receiving; rotates to a new one once a transfer is observed landing on it.
_Avoid_: current address (in UI copy)

### Payments

**Proposal**:
The inspectable spend plan returned by `propose()`; `send()` executes exactly its bytes. User confirmation is consent bound to a Proposal.
_Avoid_: draft transaction, quote

**Pending Payment**:
A Payment operation whose submission outcome is unresolved or unobserved (`operations.get` non-terminal phase). Shown with Resume/Abandon actions.
_Avoid_: stuck tx, outbox

**Shielding**:
Moving transparent funds into a shielded pool, user-initiated only. No background pool reshuffling.
_Avoid_: sweep (reserved for future cross-pool moves, out of scope)
