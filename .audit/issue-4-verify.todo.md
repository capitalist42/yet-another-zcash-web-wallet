# Issue 4 verify backup and view-only on mainnet

Playbook: Investigation (are the flows working). No product code change.

- [x] Route through the how skill. For motivation questions, also route through the why skill.
  skip: sequential pass. This session has no subagent dispatch tool. The question is empirical (do the flows work on mainnet), so the proof is a browser run, not an architecture essay.
- [x] Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only investigation`.
- [x] Produce the how-shaped output (Overview / Key Concepts / How It Works / Where Things Live / Gotchas), or a recommendation with a tradeoffs table if the request is a decision between alternatives.
- [x] Apply the unslop skill to the reply.

Task evidence:

- [x] Build and serve the product on a run-specific port.
- [x] Doctor green (preview, chrome, lightd mainnet).
- [x] Start on the default network, switch to mainnet, screenshot the welcome screen on mainnet.
- [x] Forced backup gate: 24 words, wrong words rejected, matching words exit. Screenshots.
- [x] Mainnet create reaches the wallet screen. Screenshot.
- [x] View-only: invalid key rejected. Valid UFVK derived offline from the throwaway phrase (not committed). Import on mainnet, View-only chip, no spend authority. Screenshots.
- [x] Record a short video of the two flows if the driver can.
  skip: page screenshots worked. The driver's video recorder timed out, so the evidence is screenshots.
