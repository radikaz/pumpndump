// The mock executor for pnd_mock. It does off chain what Arcium does for pnd_spike:
// draws the hidden close time, seals orders, closes the round, and matches it.
//
// IT CAN READ EVERY ORDER. That is the point of a mock: it stands in for the cluster
// so the flow can run on devnet. Never run it against mainnet.
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { randomBytes, randomInt } from "crypto";
import { RescueCipher, deserializeLE, x25519 } from "@arcium-hq/client";
import { PndMock } from "../target/types/pnd_mock";
import { BATCH, MAX_AMOUNT, matchPair, packFills } from "./match";

const RPC = { commitment: "confirmed", preflightCommitment: "confirmed" } as const;
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export const RoundState = { Drawing: 0, Open: 1, Closed: 2, Matching: 3, Matched: 4 };
export const SlotState = { Empty: 0, Pending: 1, Sealed: 2, Late: 3, Refunded: 4 };

const u64le = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

export interface ExecutorOptions {
  /** Signs every executor step and pays for round accounts. */
  signer: anchor.web3.Keypair;
  /** The x25519 secret that users encrypt orders to. */
  x25519Secret: Uint8Array;
  /** Match price, quote per base, Q32. The demo uses a fixed public price. */
  priceQ32: bigint;
  log?: (msg: string) => void;
}

export class MockExecutor {
  readonly configPda: PublicKey;
  readonly x25519Public: Uint8Array;
  private readonly self: RescueCipher;
  private readonly log: (msg: string) => void;

  constructor(
    readonly program: Program<PndMock>,
    private readonly opts: ExecutorOptions,
  ) {
    this.configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId)[0];
    this.x25519Public = x25519.getPublicKey(opts.x25519Secret);
    // What the cluster keeps as Enc<Mxe>, the mock keeps encrypted to itself.
    this.self = new RescueCipher(x25519.getSharedSecret(opts.x25519Secret, this.x25519Public));
    this.log = opts.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`));
  }

  roundPda(id: number | bigint): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("round"), u64le(id)],
      this.program.programId,
    )[0];
  }

  async assertNotMainnet() {
    const genesis = await this.program.provider.connection.getGenesisHash();
    if (genesis === MAINNET_GENESIS) throw new Error("refusing to run the mock executor on mainnet");
  }

  private seal(values: bigint[]) {
    const nonce = randomBytes(16);
    return { ct: this.self.encrypt(values, nonce), nonce: new anchor.BN(deserializeLE(nonce).toString()) };
  }

  private open(ct: number[][], nonce: number[] | Uint8Array) {
    return this.self.decrypt(ct, Uint8Array.from(nonce));
  }

  private ix(round: PublicKey) {
    return { executor: this.opts.signer.publicKey, config: this.configPda, round };
  }

  /** Does the next needed action, if any. Returns a short name of what it did. */
  async step(): Promise<string> {
    const config = await this.program.account.config.fetch(this.configPda);
    const next = config.nextRound.toNumber();
    if (next === 0) return this.openRound(0, config);

    const id = next - 1;
    const roundKey = this.roundPda(id);
    const round = await this.program.account.round.fetch(roundKey);

    if (round.state === RoundState.Open) {
      const sealed = await this.sealPending(roundKey, round);
      const [offset] = this.open([round.closeCt], round.closeNonce);
      const elapsed = BigInt(Math.floor(Date.now() / 1000) - round.openTs.toNumber());
      if (elapsed >= offset) {
        await this.program.methods.closeRound().accountsPartial(this.ix(roundKey))
          .signers([this.opts.signer]).rpc(RPC);
        this.log(`round ${id}: closed after ${elapsed} s`);
        return "close";
      }
      return sealed > 0 ? "seal" : "idle";
    }

    if (round.state === RoundState.Closed) {
      // Orders still pending at the close are marked late by seal_order.
      await this.sealPending(roundKey, round);
      return this.match(id, roundKey);
    }

    if (round.state === RoundState.Matched) {
      const returned = await this.returnBonds(id, roundKey, round);
      if (returned > 0) return "refund";
      await this.closeOldRound(id - 1);
      return this.openRound(next, config);
    }
    return "idle";
  }

  private async openRound(id: number, config: any): Promise<string> {
    const min = config.minCloseS.toNumber();
    const span = config.spanCloseS.toNumber();
    const offset = BigInt(min + randomInt(span));
    const { ct, nonce } = this.seal([offset]);
    await this.program.methods
      .openRound(ct[0], nonce)
      .accountsPartial({
        executor: this.opts.signer.publicKey,
        config: this.configPda,
        prevRound: id > 0 ? this.roundPda(id - 1) : null,
        round: this.roundPda(id),
      })
      .signers([this.opts.signer])
      .rpc(RPC);
    this.log(`round ${id}: open, closes in ${min} to ${min + span} s (hidden)`);
    return "open";
  }

  private async sealPending(roundKey: PublicKey, round: any): Promise<number> {
    let n = 0;
    for (let i = 0; i < round.orderCount; i++) {
      const s = round.slots[i];
      if (s.state !== SlotState.Pending) continue;
      let isBuy = false;
      let amount = 0n;
      try {
        const user = new RescueCipher(x25519.getSharedSecret(this.opts.x25519Secret, s.computation.toBytes()));
        const [b, a] = user.decrypt(
          [round.orderCt[i].slice(0, 32), round.orderCt[i].slice(32)],
          Uint8Array.from(s.nonce),
        );
        // Same as the circuit: a bad input becomes a sell of the clamped amount, never an error.
        isBuy = b === 1n;
        amount = a > MAX_AMOUNT ? MAX_AMOUNT : a;
      } catch {
        // A ciphertext that does not open counts as an order of 0.
      }
      const { ct, nonce } = this.seal([isBuy ? 1n : 0n, amount]);
      await this.program.methods
        .sealOrder(i, [ct[0], ct[1]], nonce)
        .accountsPartial(this.ix(roundKey))
        .signers([this.opts.signer])
        .rpc(RPC);
      n++;
    }
    if (n) this.log(`round ${round.id}: sealed ${n} order(s)`);
    return n;
  }

  private async match(id: number, roundKey: PublicKey): Promise<string> {
    const round = await this.program.account.round.fetch(roundKey);
    const orders = round.slots.map((s: any, i: number) => {
      if (s.state !== SlotState.Sealed) return { active: false, isBuy: false, amount: 0n };
      const [b, a] = this.open(
        [round.orderCt[i].slice(0, 32), round.orderCt[i].slice(32)],
        s.nonce,
      );
      return { active: true, isBuy: b === 1n, amount: a };
    });
    const { fills, leg } = matchPair(orders, this.opts.priceQ32);
    const f = this.seal(packFills(fills));
    // The market leg goes to the executor key. Here the mock is also the executor.
    const l = this.seal([leg.isBuy ? 1n : 0n, leg.amount]);
    await this.program.methods
      .settleMatch(f.ct, f.nonce, [l.ct[0], l.ct[1]], l.nonce)
      .accountsPartial(this.ix(roundKey))
      .signers([this.opts.signer])
      .rpc(RPC);
    const active = orders.filter((o: any) => o.active).length;
    this.log(`round ${id}: matched ${active} order(s), market leg ${leg.isBuy ? "buy" : "sell"} ${leg.amount}`);
    return "match";
  }

  private async returnBonds(id: number, roundKey: PublicKey, round: any): Promise<number> {
    let n = 0;
    for (let i = 0; i < BATCH; i++) {
      const s = round.slots[i];
      if (s.state !== SlotState.Sealed && s.state !== SlotState.Late) continue;
      await this.program.methods
        .refund(i)
        .accountsPartial({
          caller: this.opts.signer.publicKey,
          owner: s.owner,
          config: this.configPda,
          round: roundKey,
        })
        .signers([this.opts.signer])
        .rpc(RPC);
      n++;
    }
    if (n) this.log(`round ${id}: returned ${n} bond(s)`);
    return n;
  }

  private async closeOldRound(id: number) {
    if (id < 0) return;
    const key = this.roundPda(id);
    if (!(await this.program.provider.connection.getAccountInfo(key))) return;
    try {
      await this.program.methods.closeRoundAccount()
        .accountsPartial({ executor: this.opts.signer.publicKey, config: this.configPda, round: key })
        .signers([this.opts.signer])
        .rpc(RPC);
      this.log(`round ${id}: account closed, rent back`);
    } catch (e) {
      // Bonds left (for example a pending order the user has not refunded yet). Try later.
      this.log(`round ${id}: not closed yet (${String(e).split("\n")[0]})`);
    }
  }
}
