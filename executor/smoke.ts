// End-to-end check of a running pnd_mock deployment: sends one order as a user would and
// follows it until the bond comes back. The executor must be running.
//
//   ANCHOR_PROVIDER_URL=<rpc> ANCHOR_WALLET=<user keypair> yarn mock:smoke
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { randomBytes } from "crypto";
import { RescueCipher, deserializeLE, x25519 } from "@arcium-hq/client";
import { PndMock } from "../target/types/pnd_mock";
import { SlotState } from "./mock-executor";

const RPC = { commitment: "confirmed", preflightCommitment: "confirmed" } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const u64le = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

describe("pnd_mock smoke", () => {
  it("sends one order and follows it until the bond comes back", async () => {
    anchor.setProvider(anchor.AnchorProvider.env());
    const provider = anchor.getProvider() as anchor.AnchorProvider;
    const program = anchor.workspace.PndMock as Program<PndMock>;
    const user = provider.wallet.publicKey;
    const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId)[0];
    const cfg = await program.account.config.fetch(configPda);
    const id = cfg.nextRound.toNumber() - 1;
    const roundPda = PublicKey.findProgramAddressSync([Buffer.from("round"), u64le(id)], program.programId)[0];
    const t0 = Date.now();
    const log = (m: string) => console.log(`  +${Math.round((Date.now() - t0) / 1000)} s  ${m}`);

    // What the frontend does: encrypt to the executor key from the config.
    const sk = x25519.utils.randomSecretKey();
    const cipher = new RescueCipher(x25519.getSharedSecret(sk, Uint8Array.from(cfg.executorX25519)));
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([1n, 1234n], nonce);
    const before = await provider.connection.getBalance(user);
    await program.methods
      .submitOrder(ct[0], ct[1], Array.from(x25519.getPublicKey(sk)), new anchor.BN(deserializeLE(nonce).toString()))
      .accountsPartial({ payer: user, config: configPda, round: roundPda })
      .rpc(RPC);
    let round = await program.account.round.fetch(roundPda);
    const slot = round.slots.findIndex((s: any, i: number) => i < round.orderCount && s.owner.equals(user) && s.state === SlotState.Pending);
    log(`order sent to round ${id}, slot ${slot}`);

    let last = -1;
    let lastRound = -1;
    for (;;) {
      round = await program.account.round.fetch(roundPda);
      const s = round.slots[slot].state;
      if (s !== last) log(`order: ${Object.keys(SlotState)[s]}`);
      if (round.state !== lastRound) log(`round: ${["Drawing", "Open", "Closed", "Matching", "Matched"][round.state]}`);
      last = s;
      lastRound = round.state;
      if (s === SlotState.Refunded) break;
      if (Date.now() - t0 > 30 * 60_000) throw new Error("no refund after 30 min");
      await sleep(10_000);
    }
    const paid = before - (await provider.connection.getBalance(user));
    log(`done. The user paid ${paid} lamports in fees; the bond came back.`);
  });
});
