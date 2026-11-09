# pumpndump programs

On-chain code for pumpndump: sealed orders that fill at a random moment.

This is early work: a spike to prove the risky parts. It is not audited. Do not use it with real funds.

## Programs

| Program | What it is | Devnet |
|---|---|---|
| `pnd_spike` | The real design. Orders are sealed with [Arcium](https://docs.arcium.com) MPC. A round closes at a random moment drawn inside Arcium. Buys and sells of one pair match inside the circuit. | `8ZoAUA3iVcLxGHstnHz295DmfAtGE9PVZeHFueHP6NFR` (deployed, waiting for a working Arcium devnet cluster) |
| `pnd_mock` | A demo of the same flow with Arcium replaced by one executor key. **Orders are not private in this program.** The executor can read every order. | `24GtYmstfSQN6xkpJREt3YQpQHeePr7xDRSMy2uo9mw8` |

Both programs share one account layout (`programs/pnd_spike/src/state.rs`), so a client reads the same accounts in both modes.

## How a round works (`pnd_spike`)

1. **Open.** `draw_close` draws a secret close offset (2 to 20 min) with `ArcisRNG`. Only the cluster can decrypt it.
2. **Orders.** A user encrypts an order (side and amount) in the browser. `submit_order` re-encrypts it to the cluster and puts it in one of 16 slots. The user locks a small bond.
3. **Close.** A keeper sends `tick`. The circuit compares the time with the hidden offset and reveals one bit: "now" or "not yet".
4. **Match.** `match_pair` matches buys and sells of one pair at a public reference price. The smaller side fills in full. The larger side fills pro rata. The fills stay encrypted to the cluster. The rest (the market leg) is encrypted to the executor key only. Nothing is revealed in public.
5. **Refund.** If a computation does not come back in time, or an order lands after the close, the bond comes back. Anyone can send `refund`; the bond always goes to the slot owner.

Privacy holds while at least one Arcium node in the cluster is honest (Cerberus protocol). The net trade of each round becomes public when the market leg lands on chain.

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
