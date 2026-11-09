// pnd_demo calls the v2 executor makes. DEVNET ONLY.
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { ComputeBudgetProgram, PublicKey, Transaction } from "@solana/web3.js";
import idl from "../../target/idl/pnd_demo.json";
import { PndDemo } from "../../target/types/pnd_demo";

const RPC = { commitment: "confirmed", preflightCommitment: "confirmed" } as const;
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b6hvZbsiqW5xWH4BtJ7aA8RMKw2c");
/** Bytes of a balance document per transaction. */
const CHUNK = 800;

const u16le = (n: number) => Buffer.from(new Uint16Array([n]).buffer);
const u64le = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

export class DemoChain {
  readonly program: Program<PndDemo>;
  readonly id: PublicKey;
  constructor(readonly provider: anchor.AnchorProvider) {
    this.program = new Program(idl as PndDemo, provider);
    this.id = this.program.programId;
  }
  private pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, this.id)[0];
  get config() { return this.pda(Buffer.from("config")); }
  get pool() { return this.pda(Buffer.from("pool")); }
  coin = (i: number) => this.pda(Buffer.from("coin"), u16le(i));
  mint = (i: number) => this.pda(Buffer.from("mint"), u16le(i));
  vault = (i: number) => this.pda(Buffer.from("vault"), u16le(i));
  deposit = (n: number | bigint) => this.pda(Buffer.from("dep"), u64le(n));
  balance = (tag: Uint8Array) => this.pda(Buffer.from("bal"), Buffer.from(tag));
  round = (id: number) => this.pda(Buffer.from("round"), u64le(id));
  private get me() { return this.provider.wallet.publicKey; }

  async assertNotMainnet() {
    if ((await this.provider.connection.getGenesisHash()) === MAINNET_GENESIS) {
      throw new Error("refusing to run the demo executor on mainnet");
    }
  }

  fetchConfig() { return this.program.account.config.fetch(this.config); }
  pendingDeposits() { return this.program.account.depositNote.all(); }

  async credit(id: number, depositor: PublicKey) {
    return this.program.methods.credit(new anchor.BN(id))
      .accountsPartial({ executor: this.me, config: this.config, depositor, deposit: this.deposit(id) })
      .rpc(RPC);
  }

  /** Writes a balance document in chunks. Readers switch to it only after the last chunk. */
  async writeBalance(tag: Uint8Array, seq: number, data: Uint8Array) {
    const tagArr = Array.from(tag);
    for (let off = 0; off < data.length || off === 0; off += CHUNK) {
      const chunk = Buffer.from(data.subarray(off, off + CHUNK));
      await this.program.methods
        .writeBalance(tagArr, new anchor.BN(seq), off, data.length, chunk)
        .accountsPartial({ executor: this.me, config: this.config, balance: this.balance(tag) })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 })])
        .rpc(RPC);
      if (data.length === 0) break;
    }
  }

  async vaultAmount(i: number) {
    return BigInt((await this.provider.connection.getTokenAccountBalance(this.vault(i), "confirmed")).value.amount);
  }

  /** Pays `amount` of coin `i` to the wallet `to`. Mints into the vault first if it is short. */
  async payout(i: number, amount: bigint, to: PublicKey) {
    const ata = PublicKey.findProgramAddressSync([to.toBuffer(), TOKEN_PROGRAM.toBuffer(), this.mint(i).toBuffer()], ATA_PROGRAM)[0];
    const pre = [];
    const have = await this.vaultAmount(i);
    if (have < amount) {
      pre.push(await this.program.methods.mintHouse(i, new anchor.BN((amount - have).toString()))
        .accountsPartial({ executor: this.me, config: this.config, coin: this.coin(i), pool: this.pool, mint: this.mint(i), vault: this.vault(i) })
        .instruction());
    }
    // Create the recipient's token account if it does not exist (idempotent).
    pre.push(new anchor.web3.TransactionInstruction({
      programId: ATA_PROGRAM,
      keys: [
        { pubkey: this.me, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: to, isSigner: false, isWritable: false },
        { pubkey: this.mint(i), isSigner: false, isWritable: false },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),
    }));
    return this.program.methods.payout(i, new anchor.BN(amount.toString()))
      .accountsPartial({ executor: this.me, config: this.config, coin: this.coin(i), pool: this.pool, vault: this.vault(i), dest: ata })
      .preInstructions(pre)
      .rpc(RPC);
  }

  async postRound(id: number, r: { openTs: number; closeTs: number; orders: number; parts: number; volume: number[]; net: { coin: number; amount: bigint }[] }) {
    return this.program.methods.postRound(new anchor.BN(id), {
      openTs: new anchor.BN(Math.floor(r.openTs / 1000)),
      closeTs: new anchor.BN(Math.floor(r.closeTs / 1000)),
      orders: r.orders,
      parts: r.parts,
      volume: r.volume.map((v) => new anchor.BN(v)),
      net: r.net.map((n) => ({ coin: n.coin, amount: new anchor.BN(n.amount.toString()) })),
    }).accountsPartial({ executor: this.me, config: this.config, round: this.round(id) }).rpc(RPC);
  }

  async closeRound(id: number) {
    return this.program.methods.closeRound(new anchor.BN(id))
      .accountsPartial({ executor: this.me, config: this.config, round: this.round(id) }).rpc(RPC);
  }

  async exists(pk: PublicKey) {
    return !!(await this.provider.connection.getAccountInfo(pk, "confirmed"));
  }

  send(tx: Transaction) { return this.provider.sendAndConfirm(tx, [], RPC); }
}
