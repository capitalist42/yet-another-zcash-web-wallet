# Send

Spend path from a seed wallet: recipient, amount, memo, a review of the exact proposal, then a broadcast of that proposal. Broadcasting spends real notes and stays operator-run.

## Sub-features

- `send-open` Send opens the form; Cancel returns to the wallet screen.
- `send-memo` A non-empty memo to a shielded recipient shows the on-chain warning. A transparent recipient hides that warning and shows the transparent-sends-off warning instead.
- `send-uri` Pasting a `zcash:` ZIP-321 URI into the recipient field prefills the address, amount, and memo.
- `send-review` Review lists the proposal's fee, expiry, inputs, and outputs. Confirm broadcasts that proposal and no other. Back releases it.
- `send-recover` A sync-stale propose routes to the sync screen, a missing signer routes to unlock, and a stale proposal returns to the form for a new plan. The raw engine message stays off the screen. These routes are proven in `src/wallet/send.test.ts`; this browser recipe cannot force them without spendable funds.

## How to get to it (user POV)

- A spend-capable seed wallet is on `[aria-label="wallet"]` and the Send button is enabled. A view-only wallet has no Send button and shows "No spend authority — this Wallet is view-only."
- Click Send.

## Driving it with playwright-core

Preconditions:

- Fresh profile on mainnet. Testnet create stops at `SYNC_REQUIRED` on rc.5, so there is no wallet screen to send from.
- Open/Cancel on a fresh seed wallet is also asserted by `create-wallet`. The memo, URI, and transparent-refusal legs run as `node .claude/skills/verify/scripts/run.mjs --port $PORT --feature send --network mainnet`. That driver never clicks Confirm.

- **Open.** Click `Send` inside `[aria-label="wallet"]`. `[aria-label="send"]` appears.
- **Memo warning.** Put a mainnet Sapling (`zs1…`) or unified (`u1…`) address in `[data-testid="send-recipient"]` and `1` in `[data-testid="send-amount"]`. Leave the memo empty: `[data-testid="memo-warning"]` is absent. Type `hello` into `[data-testid="send-memo"]`: the warning reads "This memo rides on-chain, encrypted to the recipient."
- **ZIP-321 prefill.** Replace the recipient with `zcash:<that-address>?amount=1&memo=VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg` (`memo` is base64url for "This is a simple memo."). The recipient field becomes the bare address, the amount stays `1`, the memo becomes `This is a simple memo.`, and the warning is visible.
- **Transparent recipient.** Set the recipient to a `t1…` address. The warning "Transparent recipients are off. Allow transparent sends is in Settings." is visible and the memo warning is not. Click Review: the form stays up, the error says transparent recipients are off, and `[aria-label="proposal review"]` does not appear.
- **Cancel.** Click Cancel. `[aria-label="send"]` is gone and the Send button is back.
- **Review and broadcast (operator, funded shielded wallet only).** Fill a shielded recipient, an amount, and an optional memo. Click Review. `[aria-label="proposal review"]` shows `[data-testid="proposal-fee"]`, `[data-testid="proposal-expiry"]`, an Inputs list, and an Outputs list that includes the memo text when one was entered. Click `[data-testid="confirm-send"]` only to spend. `[aria-label="sent"]` then shows the txid. Matching history on the paying and receiving wallets is a separate observation.

## Gotchas

- Confirm broadcasts. An automated run must not click `[data-testid="confirm-send"]`.
- An unfunded Review does not reach the review screen: the engine refuses the payment and the form shows "The wallet refused the payment (…)".
- Unlock is phrase re-entry on `[aria-label="unlock"]`. The phrase is not stored.
- The Settings switch for transparent sends does not exist yet. A transparent recipient is refused, and a proposal that spends a transparent note is released instead of shown.
