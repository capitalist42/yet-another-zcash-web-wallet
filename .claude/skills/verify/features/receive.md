# Receive (auto-rotating address)

Receive shows the Wallet's current Receive Address with QR, copy and
reveal-under-click, plus the Exposed Address list. Under ADR-0004 an observed
inbound transfer advances the displayed address exactly once; every Exposed
Address stays listed with its received amount.

## Sub-features

- `receive-display` the Receive Address renders masked (CSS blur) but the text
  node holds the FULL address; Reveal/Hide and a click on the address both
  toggle the blur; Copy puts the full address on the clipboard with `Copied`
  feedback; a QR canvas encodes the address.
- `receive-exposed` the Exposed Addresses list shows every minted address with
  its received ZEC; the displayed one carries a `shown` chip.
- `receive-rotate` (engine seam, covered by `src/wallet/receive.test.ts`): a
  non-self, non-Shielding payment to the displayed address rotates exactly
  once; own change, self-payments and Shielding never rotate; view-only never
  mints.

## How to get to it (user POV)

Any opened wallet screen. Fastest: create a wallet (see create-wallet.md) —
the Receive Address block sits under the balances, `Exposed Addresses` below
it. No funding needed for the display legs.

## Driving it with playwright-core

Preconditions: fresh build (preview never rebuilds), doctor green on the port,
fresh context. Grant `clipboard-read`/`clipboard-write` for the origin.

- **Reach the wallet screen** per create-wallet.md (quiz inputs carry
  `data-word-position`).
- **Masked full text.** `[data-testid="receive-address"]` waits until trimmed
  length > 20 and no `preparing`. Its class contains `masked` and computed
  `filter` contains `blur` — while `textContent` still equals the full
  address (harness contract: masking is CSS-only).
- **Reveal/Hide.** `[data-testid="reveal-button"]` flips the label
  Reveal→Hide, drops `masked`/blur; second click restores. Clicking the
  address itself toggles identically.
- **Copy.** `[data-testid="copy-address"]` → label `Copied` (≤5 s) and
  `navigator.clipboard.readText()` equals the full address.
- **QR.** `canvas.qr` exists; sample `getImageData`: hundreds of dark pixels
  (observed ~12.4k dark of 25.6k). A blank/absent canvas fails the leg.
- **Exposed list.** `[data-testid="exposed-address"]` rows; exactly 1 for a
  fresh wallet; row text contains the full address, a received amount
  (`0 ZEC` on a fresh wallet — `formatZats` renders bare `0`), and a `.chip`
  reading `shown`.
- Screenshot as evidence; zero page console errors.

Manual-only legs (need testnet funds / a second wallet — operator run):
send to the displayed address → it rotates exactly once and the old row stays
listed with its amount; a self-send (change) and a Shielding do NOT rotate.

## Gotchas

- `[data-testid="receive-address"]` MUST keep the full address text even while
  masked — restore-viewonly.mjs and run.mjs assert trimmed length > 20.
- The QR uses `toCanvas` (canvas, not data URL) so the page CSP
  (`default-src 'self'`) needs no change.
- Clipboard writes can reject on permission denial; the button simply shows no
  feedback then — grant permissions in the harness instead of asserting the
  denial path.
- Rotation itself needs real inbound funds; the deterministic proof lives in
  `src/wallet/receive.test.ts` through the fake engine. Don't fake a rotation
  in the browser leg.
