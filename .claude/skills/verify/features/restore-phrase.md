# Restore from recovery phrase

Restore re-opens an existing Wallet from its 24 words (optionally BIP-39 passphrase, account index, birthday), and the restored wallet behaves like any other: synced balances, reload persistence, spend authority.

## Sub-features

- `restore-invalid` a malformed phrase is rejected in-form with `.error`, staying on the Restore tab.
- `restore-open` a valid phrase + chosen birthday boots the wallet screen with name `restored` and a fingerprint chip.
- `restore-fingerprint` restoring the SAME phrase that create generated yields the SAME fingerprint chip (cross-check of key derivation).
- `restore-birthday` unchecking `Full scan from genesis` reveals `Birthday height`; a numeric height is accepted, a bogus one fails honestly.

## How to get to it (user POV)

- Welcome screen → `Restore` tab → form `[aria-label="restore"]`.
- Not reachable while a wallet is open: with a wallet registered, boot goes straight to it — restore needs the welcome state (fresh profile, or the other network's empty registry via the header network switch).

## Driving it with playwright-core

Preconditions:

- Fresh context for the primary leg. To drive `restore-fingerprint` without external funds: in the SAME context run the create-wallet journey first (its phrase is harvestable from the gate), then open a fresh profile/context and restore that phrase — or supply an operator phrase via `ZCASH_VERIFY_PHRASE` env (never committed, never logged).
- mainnet leg for pass-conditions; testnet expects the honest `SYNC_REQUIRED`.

- **Invalid phrase.** Navigate `<base>/?network=mainnet`, click `Restore`, fill `Recovery Phrase` textarea with `not a real mnemonic`, click `Restore`. `.error` with a phrase-invalid message; still on `[aria-label="restore"]`.
- **Valid phrase, full scan.** Fill the phrase (create-flow words or `ZCASH_VERIFY_PHRASE`), leave account index `0` and `Full scan from genesis` checked, click `Restore`. Race wallet screen vs `.error` (≤240 s). Wallet screen: h1 contains `restored`, fingerprint chip `^[a-z2-7]{4}$`. Snapshot.
- **Fingerprint equality.** If the phrase came from a create run, assert the chip equals the create-run chip from that run's console.log.
- **Birthday height.** Re-open restore in a fresh profile; uncheck `Full scan from genesis`; the `Birthday height` input appears; enter a plausible recent height (from doctor's lightd height output), click `Restore`; wallet boots. With a nonsense height (e.g. above current tip or non-numeric) an honest `.error` appears instead — never a silent fallback to full scan.
- **Persistence.** Reload: boots straight back to `[aria-label="wallet"]` with the same chip.

Not implemented in run.mjs yet — hand-drive per SKILL.md *Drive* until added.

## Gotchas

- Restore with no funds still must reach the wallet screen on mainnet (empty balances/history are valid states; "No transactions yet." is a PASS, not a skip).
- The passphrase field is `input[type=password]` inside `[aria-label="restore"]`; a passphrase-protected phrase restored WITHOUT it derives a DIFFERENT wallet (different fingerprint) — don't mistake that for a bug, and don't cross-compare chips across passphrase mismatch.
- Account index selects the ZIP-32 account; index 1 of an unused phrase restores an empty account — empty is not failure.
- A fresh full scan from genesis on mainnet can take minutes for a real history; prefer a recent birthday height when the phrase's history start is known, and budget 240 s minimum.
- Testnet restore must fail honestly (NU7 NO-GO). Same rule as create-wallet.
