# Create a wallet

Create walks a user from the welcome screen through a forced backup gate into a live, synced Wallet — and the wallet survives reloads and tab collisions on the same profile.

## Sub-features

- `create-gate` the backup gate shows exactly the generated 24 words and quizzes 3 random positions; only the matching words exit it.
- `create-open` confirming the quiz opens the engine and boots the wallet screen (mainnet) or surfaces the honest `SYNC_REQUIRED` (testnet, while rc.5 < NU7).
- `create-persist` reload in the same profile boots straight back into the same wallet (fingerprint chip identical).
- `create-lease` a second tab on the same wallet renders the storage-busy screen.

## How to get to it (user POV)

- Open `<base>/?network=mainnet` (or `?network=testnet`) in a fresh browser profile: welcome screen, `Create` tab already active, button `Create a new Wallet`.
- No other entry: with no wallet registered there is nothing else to open.

## Driving it with playwright-core

Preconditions:

- This run's preview passes `doctor.mjs` on its port; build fresh.
- Fresh browser context (no registry rows).
- mainnet leg: lightd mainnet green in doctor. testnet leg: expect the honest error, per chain reality.

- **Welcome renders.** Navigate `<base>/?network=mainnet`, wait `[aria-label="welcome"]`. `main.app` has `data-network="mainnet"`. Snapshot `state-welcome.aria.yml`.
- **Generate the phrase.** Click `Create a new Wallet`; `[aria-label="backup gate"]` appears (≤60 s — first WASM load). Assert `ol.phrase li` count 24; harvest words stripping the leading `N ` numbering. Snapshot `state-gate.aria.yml`.
- **Wrong words rejected.** Fill each quiz input `[data-word-position="N"]` (3 of them) with a junk word; click `I saved my phrase`. `.error` appears, gate still on screen. Record the error string.
- **Confirm the gate.** Fill each quiz input with `words[N - 1]` for its position; click `I saved my phrase`. Engine open begins (WASM + OPFS + bounded freshness): race `[aria-label="wallet"]` vs `.error` with a 240 s budget.
- **Mainnet outcome = wallet screen.** `[aria-label="wallet"]` visible; fingerprint chip matches `^[a-z2-7]{4}$`; `[data-testid="receive-address"]` non-placeholder within 30 s; Send button `disabled` with title "ships in the next milestone"; history list or `No transactions yet.` present; sync line rendered. Snapshot `state-after-open.aria.yml` + `final.png`.
- **Testnet outcome = honest failure with recovery.** `.error` carries the engine's sync failure — observed text: `Sync the wallet before continuing; retain any existing payment operation.` (the `SYNC_REQUIRED` code, rendered as its message) — inside the `[aria-label="sync retry"]` screen; no wallet screen. The screen explains nothing was created, shows the testnet/NU7 note, and offers `Try again`, `Switch to Mainnet`, `Back to my recovery phrase`. Clicking `Back to my recovery phrase` returns to `[aria-label="backup gate"]`. That string + those actions ARE the proof; snapshot them.
- **Live, not decorative.** From the run's request log: ≥1 request to the configured lightd host, zero requests to any other http(s) host, zero failed responses (favicon probe excepted).
- **Second tab collides.** Open a second page in the same context to the same URL: `[aria-label="storage busy"]` renders (≤30 s). Close it.
- **Reload persistence.** Reload the first page: boots straight to `[aria-label="wallet"]` (≤120 s) with the SAME fingerprint chip as before the reload.

Implemented in `node .claude/skills/verify/scripts/run.mjs --port $PORT --feature create-wallet --network mainnet|testnet`.

## Gotchas

- The gate has no dismiss control and the wrong-words error shares `.error` with boot errors — assert on the visible screen (`[aria-label="backup gate"]` still present), not merely on the error text.
- Harvest phrase words from the `li` elements, not the `phrase` state: the list renders `1 word` numbering (recent commit removed visible numbering — still strip `^\d+\s+` defensively).
- The quiz positions are random per attempt (`Math.random`), so never hardcode positions — read each input's `data-word-position` attribute and answer `words[pos - 1]`. Quiz comparison is case-insensitive and trims whitespace.
- First create pays real download/sync cost (~70 MB assets + freshness pass): a 240 s budget is real, not flake; but >30 s on a RE-open signals a broken instance — doctor first.
- `SYNC_REQUIRED` on mainnet can appear once under endpoint tip lag and self-heal via the single retry; only surface it if the wallet screen never arrives.
- Testnet create passing the wallet screen would mean the NU7 NO-GO premise changed — fail the leg and update the map, don't silently accept.
- The throwaway phrase is generated inside the run's ephemeral profile; never log it and never write it into evidence.
- The gate's `.error` survives a rejected attempt on screen; the post-confirm outcome race must watch for a NEW error (text differs from the wrong-words one) or the wallet screen — matching the stale text reads an instant false-"error" on both networks.
