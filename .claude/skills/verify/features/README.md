# Zcash browser wallet — verification map

This directory is the maintained source for verifying the user-facing behavior of the product UI (the app served at `/`). Read the index before driving, then use the matching feature file as the recipe. A proof that drives one convenient entry point is incomplete when this map lists others.

## Baseline preconditions

- `npm run build` is green (it is also the typecheck gate).
- Preview launched BY THIS RUN on a run-specific port: `npm run preview -- --port $PORT --strictPort --host 127.0.0.1 & echo $! > /tmp/yaw-preview-$PORT.pid` (never assume 4173 is yours).
- `node .claude/skills/verify/scripts/doctor.mjs --port $PORT` is all-green: right build served, our PID, Chromium resolvable, both lightd endpoints answering.
- Chromium runs with a throwaway profile per run (fresh Playwright context). A wallet exists only inside that profile's IndexedDB + OPFS: fresh context ⇒ welcome screen; persistence legs reload the SAME context.
- Network for a fresh profile is forced via `?network=mainnet|testnet`; default boot is testnet.

## Chain reality that shapes every journey

- Mainnet (`https://zcash-mainnet.chainsafe.dev`): the full happy path must work — create/restore/import reach the wallet screen, live sync, balances, history.
- Testnet (`https://zcash-testnet.chainsafe.dev`): public chain is NU7; the pinned SDK codec (`@zcashlabs/zcash.js@0.1.0-rc.5`) tops out at Nu6.3. Create/restore/import MUST end in the honest `.error` (`SYNC_REQUIRED` after one bounded retry). That IS the testnet pass condition. Never weaken a journey to make it pass; if a precondition is missing (funds, a funded UFVK), the journey reports failure and the reason goes in that feature's Gotchas.

## Driving conventions

- Harness: `playwright-core` 1.58.2 headless Chromium; maintained entrypoint `node .claude/skills/verify/scripts/run.mjs --port $PORT --feature <id> [--network …]`. Hand-drive with the selectors/labels in `SKILL.md` → *Drive*; prefer ARIA labels (`[aria-label="welcome"]`, `[aria-label="backup gate"]`, `[aria-label="wallet"]`, `[aria-label="storage busy"]`, `[aria-label="restore"]`, `[aria-label="view-only import"]`) and exact button strings over coordinates/tab order.
- Treat every quoted string in the recipes as literal UI copy from `src/app/App.tsx`.
- A run is FAIL if any page error, worker exception (CDP), or failed response (favicon 404 probe excepted) appears — zero-app-errors is part of every proof.

## Proof and skip reporting

- Capture the action and the resulting state: aria snapshot after each mapped transition, `final.png` full-page, `console.log` transcript incl. lightd request lines, `meta.json` — under `.claude/skills/verify/evidence/<UTC-ISO>-<feature>/` (gitignored; survives cleanup).
- Mutation proof = second user-facing view: reload boots into the wallet; a second tab reports `storage busy`; the fingerprint chip is identical across the reload.
- Side effects verified alongside pixels: lightd traffic observed, zero third-party requests, OPFS lease collision, Send opens and Cancel closes on a seed wallet.
- Record the feature ID + entry point with every artifact. Report an unreachable path with the attempted command and the unmet precondition; never report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph of user-visible behavior, then exactly four H2s in order: `Sub-features` (short IDs, one line each); `How to get to it (user POV)` (every entry point); `Driving it with playwright-core` (starts with `Preconditions:`, then labeled bullets pairing user action → exact drive → observable result); `Gotchas` (traps that waste or invalidate a run).

Keep implementation details out of the map: only user paths, stable handles, required state, commands, observable proof.

## Features

- [Create a wallet](./create-wallet.md) — welcome → forced backup gate → live engine create, persistence, lease collision, honest testnet failure. Implemented in `run.mjs --feature create-wallet`.
- [Restore from recovery phrase](./restore-phrase.md) — Restore tab: valid/invalid phrases, birthday choice, view-after-reload.
- [Import a viewing key (view-only)](./view-only-import.md) — View-only tab: UFVK import, View-only chip, no spend authority, no minting.
- [Switch network](./switch-network.md) — header toggle: old client closes, other network's registry row boots (or welcome).
- [Send](./send.md) — recipient, ZIP-321 prefill, memo warning, transparent refusal. Form legs are `run.mjs --feature send`. Broadcast stays operator-run (needs funds).

Not yet mapped (ship-gated, add when the surface exists): Pending Payments Resume/Abandon, Exclude notes, Lock/Unlock, Shielding. `docs/manual-verification.md` is the human checklist this map automates; tick items only with an evidence dir to point at.
