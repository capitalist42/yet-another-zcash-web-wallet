# Exclude (coin control)

Note/UTXO browser under the balances: every note shows its spend state and the SDK's operation lock (both display-only truth), and the user Excludes specific notes from sending. Exclusions persist per Wallet across reloads, always announce themselves as an "N excluded" count beside the balances with one-tap Reset, and Send composition is asserted against them: because the SDK has no forced-inputs API, a Proposal that spends outside the selection stays on review showing its real inputs until the user explicitly accepts them.

## Sub-features

- `exclude-count` Beside the balances: "N excluded" with a Reset button, disabled at zero, visible on every wallet screen.
- `exclude-toggle` Each note row toggles Exclude ↔ Include; the row keeps spend-state and lock columns.
- `exclude-persist` An exclusion survives a reload; the count and row state come back from the registry.
- `exclude-reset` Reset drops every exclusion in one tap (count 0, rows back to Exclude).
- `exclude-review` A Proposal spending an excluded note shows `[data-testid="selection-deviation"]`, disables `[data-testid="confirm-send"]`, and offers `[data-testid="accept-inputs"]`; accepting re-enables Send of exactly that Proposal.

## How to get to it (user POV)

- Any open wallet shows `[data-testid="excluded-count"]` inside `ul.balances` on `[aria-label="wallet"]`.
- The Notes table renders only when the wallet has notes/UTXOs; excluding is only reachable from there.

## Driving it with playwright-core

Preconditions:

- `exclude-count` alone: fresh profile, mainnet; a zero-note wallet shows "0 excluded" and a disabled Reset. Everything below needs spendable notes, so it is operator-run: a funded wallet (testnet faucet or mainnet funds) where Review reaches `[aria-label="proposal review"]`.
- The assertion/toggle/persistence logic is proven in `src/wallet/exclude.test.ts` on the fake engine (pass/fail paths, persistence, count, reset). The browser legs below confirm the real surface; a run without notes reports those legs as skipped with this reason, never as passed.

- **Count + reset.** On `[aria-label="wallet"]`: `[data-testid="excluded-count"]` reads "0 excluded", `[data-testid="reset-excluded"]` is disabled. Click Exclude on a `[data-testid="note-row"]`: the count becomes "1 excluded", Reset becomes enabled, the row's button reads Include. Click `[data-testid="reset-excluded"]`: count back to "0 excluded", button back to Exclude.
- **Persist.** Exclude one note, reload the SAME profile (mutation proof): the count still reads "1 excluded" and that row renders Include again.
- **Deviation review (operator, funded).** Exclude the note Review's plan spends, then click Review. `[aria-label="proposal review"]` shows the Inputs list with the real `txid:index` of the spent note, `[data-testid="selection-deviation"]` is visible, and `[data-testid="confirm-send"]` is disabled. Click `[data-testid="accept-inputs"]`: Send becomes enabled; Send broadcasts exactly the shown Proposal.

## Gotchas

- `confirm-send` spends real money once accepted — automated runs stop before it (same rule as `send`).
- Testnet create stops at `SYNC_REQUIRED` on the rc.5 codec (see README chain reality), so the notes legs run on mainnet or once testnet unblocks; do not weaken a failed leg.
- The operation-lock column is the SDK's inventory lock, not Exclude; a `held` row is still Excludable.
- Excluding while a review is open re-arms the deviation guard at confirm time: Send refuses until the fresh deviation is accepted (`src/wallet/exclude.test.ts`, "a new exclusion while the review is open").
- Accept is consent for the selection at accept time only: excluding a different note after accepting invalidates the accept at confirm time — Send refuses until a fresh accept (`src/wallet/exclude.test.ts`, "an exclusion added after accepting a deviation").
- Shielding (issue #8) does not assert Exclude: an excluded UTXO still shields. The Shield screen selects whole addresses rather than per-UTXO, and with `ALLOW_TRANSPARENT_SENDS = false` there is no send-path bypass. Known gap.
