# Switch network

The wallet screen's header toggle moves the whole session between Mainnet and Testnet: the current client closes, and the OTHER network's last-used wallet boots — or welcome, when that network has none. Wallets never mix across networks.

## Sub-features

- `net-toggle-ui` header button flips label text and `main.app` `data-network` on click.
- `net-boot-other` the target network's registry row boots (wallet screen) or welcome renders when none exists there.
- `net-isolation` a wallet created on mainnet is invisible on testnet and vice versa (fingerprint/name never cross).

## How to get to it (user POV)

- On the wallet screen, header-right button: `Switch to testnet` on mainnet, `Switch to mainnet` on testnet. This is the only entry point (the `?network=` URL param affects a fresh boot only when that network has no wallet — it is not the live-session switch).

## Driving it with playwright-core

Preconditions:

- A wallet open on one network (the create-wallet mainnet journey provides one on a fresh profile).
- NU7 honesty rules apply to any leg that needs live testnet sync.

- **Toggle label.** With `[aria-label="wallet"]` visible on `data-network="mainnet"`, the header button reads `Switch to testnet`.
- **Switch away.** Click it. Boot text `Loading your Wallet…` may flash; settle on `[aria-label="welcome"]` (testnet registry empty on this profile) with `main.app` `data-network="testnet"`. ≤60 s. Snapshot.
- **Isolation proof.** Welcome, not the old wallet: the mainnet wallet's name/fingerprint is nowhere on the testnet welcome screen.
- **Return via boot.** The toggle lives on the wallet screen, and welcome has none — so switching back goes through a reload: navigate `<base>/?network=mainnet` (registry row present ⇒ boot goes straight to `[aria-label="wallet"]`, ≤120 s) and assert the ORIGINAL fingerprint chip. This proves both isolation-flip-back and boot-from-registry; the header button again reads `Switch to testnet`.
- **Both sides populated (stretch).** After also having a testnet wallet (currently blocked by the NU7 NO-GO — record as blocked), toggling back and forth must alternate fingerprints in ≤60 s each way with zero page errors, and each side keeps its own balances/history.

Not implemented in run.mjs yet — hand-drive per SKILL.md *Drive* until added.

## Gotchas

- `?network=` on the URL only forces the boot network when NO wallet exists for it; while a wallet is registered on the boot network, boot always goes to that wallet. Do not fake the toggle with a URL navigation and count `net-toggle-ui` as verified — the click is the entry point.
- The old client must actually close: stale sync-line updates from the previous network appearing AFTER `data-network` flipped is a watch-loop leak — fail it.
- On every transition assert BOTH the header label and `data-network`, not just one.
- Testnet legs still owe the NU7 honest-error rules; a testnet wallet screen here would contradict the create-map — fail loudly and reconcile the map.
