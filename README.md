# pumpndump programs

On-chain code for pumpndump: sealed orders that fill at a random moment.

This is early work: a spike to prove the risky parts. It is not audited. Do not use it with real funds.

## Programs

| Program | What it is | Devnet |
|---|---|---|
| `pnd_spike` | The real design. Orders are sealed with [Arcium](https://docs.arcium.com) MPC. A round closes at a random moment drawn inside Arcium. Buys and sells of one pair match inside the circuit. | Not deployed. No Arcium devnet cluster could run its key setup on 2026-11-09. |
| `pnd_mock` | A demo of the round flow with Arcium replaced by one executor key. **Orders are not private in this program.** The executor can read every order. | Closed on 2026-11-10. Replaced by `pnd_demo`. |
| `pnd_demo` | The full devnet demo: 52 test coins with a faucet, public deposits, balances encrypted to a key in the browser, payouts to any address, and public round results. One trusted executor runs the ledger, rounds and matching (pairs, rings, earn, market), split and drip, and earn locks. **Nothing is private from the executor.** | `3qjjCvCh4txLgvuCsxKoHKvG9Lbv1Ax6CSvotX9ZYc1d` |

Both programs share one account layout (`programs/pnd_spike/src/state.rs`), so a client reads the same accounts in both modes.

## How a round works (`pnd_spike`)

1. **Open.** `draw_close` draws a secret close offset (2 to 20 min) with `ArcisRNG`. Only the cluster can decrypt it.
2. **Orders.** A user encrypts an order (side and amount) in the browser. `submit_order` re-encrypts it to the cluster and puts it in one of 16 slots. The user locks a small bond.
3. **Close.** A keeper sends `tick`. The circuit compares the time with the hidden offset and reveals one bit: "now" or "not yet".
4. **Match.** `match_pair` matches buys and sells of one pair at a public reference price. The smaller side fills in full. The larger side fills pro rata. The fills stay encrypted to the cluster. The rest (the market leg) is encrypted to the executor key only. Nothing is revealed in public.
5. **Refund.** If a computation does not come back in time, or an order lands after the close, the bond comes back. Anyone can send `refund`; the bond always goes to the slot owner.

Privacy holds while at least one Arcium node in the cluster is honest (Cerberus protocol). The net trade of each round becomes public when the market leg lands on chain.

## The devnet demo (`pnd_demo`)

The executor (`executor/v2/`) does off chain what Arcium and a shielded pool will do later:

- **Deposit.** A public wallet transfer into a coin vault. An encrypted note tells the executor which browser key to credit.
- **Balance.** The executor writes the user's balance document to an account, encrypted to the user's browser key (x25519, AES-GCM).
- **Orders, locks, withdrawals.** The browser signs them with its own key (ed25519) and sends them to the relayer API. No wallet pop-up.
- **Rounds.** Each closes at a hidden time, 1 to 10 min after it opens. One part of each order goes into each round. Fill order: pairs, then rings of 3 to 6 coins, then the house (earn strategy), then the market leg. Devnet has no Jupiter, so the house fills the market leg at reference prices.
- **Fees.** 0.2% matched inside, 0.6% earn and market. Fees go to earn lockers, weighted by value and lock length.
- **Public.** The net trade of each round is posted on chain.

```
yarn demo:test     # ledger tests
yarn demo:bundle   # dist/executor-v2.js and dist/setup-v2.js
RPC_URL=<rpc> AUTHORITY_KEYPAIR=<path> node dist/setup-v2.js
RPC_URL=<rpc> EXECUTOR_KEYPAIR=<path> EXECUTOR_X25519=<path> STATE_FILE=<path> node dist/executor-v2.js
```

## Build and test

Needs Arcium 0.16, Solana CLI 3.1.10, Anchor 1.0.2, Rust and Docker.

```
yarn install
arcium build
arcium test
```

`arcium test` starts a local validator and two Arx nodes in Docker. It runs the Arcium tests and the mock tests.

## Run the mock

```
ANCHOR_PROVIDER_URL=<rpc> ANCHOR_WALLET=<payer> yarn mock:setup   # once: keys, funding, config
ANCHOR_PROVIDER_URL=<rpc> ANCHOR_WALLET=<any> yarn mock:run       # keeps rounds moving
ANCHOR_PROVIDER_URL=<rpc> ANCHOR_WALLET=<user> yarn mock:smoke    # one order, end to end
```

The executor keeps its keys in `~/.config/solana/`, outside the repo. It refuses to run on mainnet.

To run the executor on a server, build one file and run it with Node 22:

```
yarn mock:bundle   # writes dist/executor.js
RPC_URL=<rpc> EXECUTOR_KEYPAIR=<path> EXECUTOR_X25519=<path> node dist/executor.js
```

It stops if a key file is missing. It never makes new keys, because users encrypt orders to the x25519 key in the on-chain config.
