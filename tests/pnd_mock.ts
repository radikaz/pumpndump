import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PndMock } from "../target/types/pnd_mock";
import { randomBytes } from "crypto";
import { expect } from "chai";
import { execSync } from "child_process";
import { RescueCipher, deserializeLE, x25519 } from "@arcium-hq/client";
import { MockExecutor, RoundState, SlotState } from "../executor/mock-executor";
import { matchPair, unpackFills } from "../executor/match";
import { RPC, sleep } from "./helpers";

const BOND = 10_000_000;
const PRICE = 2n << 32n;

describe("pnd_mock", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.PndMock as Program<PndMock>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const conn = provider.connection;
  const signer = anchor.web3.Keypair.generate();
  const x25519Secret = x25519.utils.randomSecretKey();
  const ex = new MockExecutor(program, { signer, x25519Secret, priceQ32: PRICE, log: () => {} });

  async function funded() {
    const kp = anchor.web3.Keypair.generate();
    await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 2e9), "confirmed");
    return kp;
  }

  /** What the frontend does: encrypt to the executor key from the config. */
  async function submit(user: anchor.web3.Keypair, id: number, isBuy: boolean, amount: bigint) {
    const cfg = await program.account.config.fetch(ex.configPda);
    const sk = x25519.utils.randomSecretKey();
    const cipher = new RescueCipher(x25519.getSharedSecret(sk, Uint8Array.from(cfg.executorX25519)));
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([isBuy ? 1n : 0n, amount], nonce);
    return program.methods
      .submitOrder(ct[0], ct[1], Array.from(x25519.getPublicKey(sk)), new anchor.BN(deserializeLE(nonce).toString()))
      .accountsPartial({ payer: user.publicKey, config: ex.configPda, round: ex.roundPda(id) })
      .signers([user])
      .rpc(RPC);
  }

  async function stepUntil(want: string, max = 60) {
    for (let i = 0; i < max; i++) {
      if ((await ex.step()) === want) return;
      await sleep(1000);
    }
    throw new Error(`executor never did "${want}"`);
  }

  async function expectError(p: Promise<unknown>, name: string) {
    let msg = "no error";
    try {
      await p;
    } catch (e) {
      msg = String(e);
    }
    expect(msg).to.include(name);
  }

  before(async () => {
    // pnd_mock is not in [programs.localnet] (see Anchor.toml), so deploy it here.
    if (!(await conn.getAccountInfo(program.programId))) {
      execSync(
        `solana program deploy target/deploy/pnd_mock.so --program-id target/deploy/pnd_mock-keypair.json ` +
          `-u ${conn.rpcEndpoint} --keypair ${process.env.ANCHOR_WALLET} --commitment confirmed`,
        { stdio: "ignore" },
      );
    }
    await conn.confirmTransaction(await conn.requestAirdrop(signer.publicKey, 5e9), "confirmed");
    await program.methods
      .initConfig(signer.publicKey, new anchor.BN(8), new anchor.BN(2), new anchor.BN(BOND), new anchor.BN(20), Array.from(ex.x25519Public))
      .accountsPartial({ payer: provider.wallet.publicKey, config: ex.configPda })
      .rpc(RPC);
  });

  it("runs a full round: open, seal, close, match, bonds back", async () => {
    // Fund users first: the round must still be open when they send.
    const users = [await funded(), await funded(), await funded()];
    expect(await ex.step()).to.equal("open");
    const orders = [
      { isBuy: true, amount: 300n },
      { isBuy: true, amount: 100n },
      { isBuy: false, amount: 150n },
    ];
    const before = await Promise.all(users.map((u) => conn.getBalance(u.publicKey)));
    for (let i = 0; i < 3; i++) await submit(users[i], 0, orders[i].isBuy, orders[i].amount);

    expect(await ex.step()).to.equal("seal");
    let round = await program.account.round.fetch(ex.roundPda(0));
    expect(round.slots.slice(0, 3).map((s) => s.state)).to.deep.equal([2, 2, 2]);

    await stepUntil("close");
    await expectError(submit(users[0], 0, true, 1n), "WrongRoundState");
    expect(await ex.step()).to.equal("match");

    round = await program.account.round.fetch(ex.roundPda(0));
    expect(round.state).to.equal(RoundState.Matched);
    const want = matchPair(orders.map((o) => ({ ...o, active: true })).concat(
      Array.from({ length: 13 }, () => ({ active: false, isBuy: false, amount: 0n }))), PRICE);
    // The market leg is encrypted to the executor key.
    const self = new RescueCipher(x25519.getSharedSecret(x25519Secret, ex.x25519Public));
    const leg = self.decrypt(round.legCt, Uint8Array.from(round.legNonce));
    expect([leg[0] === 1n, leg[1]]).to.deep.equal([want.leg.isBuy, want.leg.amount]);
    const fills = unpackFills(self.decrypt(round.fillsCt, Uint8Array.from(round.fillsNonce)));
    expect(fills).to.deep.equal(want.fills);

    expect(await ex.step()).to.equal("refund");
    round = await program.account.round.fetch(ex.roundPda(0));
    expect(round.slots.slice(0, 3).map((s) => s.state)).to.deep.equal(
      [SlotState.Refunded, SlotState.Refunded, SlotState.Refunded],
    );
    const after = await Promise.all(users.map((u) => conn.getBalance(u.publicKey)));
    // Each user paid only transaction fees: the bond came back.
    after.forEach((a, i) => expect(before[i] - a).to.be.below(20_000));
  });

  it("opens the next round and closes the old account for its rent", async () => {
    expect(await ex.step()).to.equal("open");
    await stepUntil("close");
    expect(await ex.step()).to.equal("match");
    const rent = (await conn.getAccountInfo(ex.roundPda(0)))!.lamports;
    const bal = await conn.getBalance(signer.publicKey);
    expect(await ex.step()).to.equal("open"); // round 2, and round 0 is closed
    expect(await conn.getAccountInfo(ex.roundPda(0))).to.equal(null);
    // Round 2's rent is paid with round 0's rent: the executor spends only fees.
    expect(bal - (await conn.getBalance(signer.publicKey))).to.be.below(rent / 10);
  });

  it("lets only the executor seal, close and settle", async () => {
    const stranger = await funded();
    const id = (await program.account.config.fetch(ex.configPda)).nextRound.toNumber() - 1;
    await expectError(
      program.methods.closeRound()
        .accountsPartial({ executor: stranger.publicKey, config: ex.configPda, round: ex.roundPda(id) })
        .signers([stranger]).rpc(RPC),
      "NotKeeper",
    );
  });

  it("refunds a pending order that the executor never seals", async () => {
    const id = (await program.account.config.fetch(ex.configPda)).nextRound.toNumber() - 1;
    const user = await funded();
    await submit(user, id, true, 5n);
    const round = await program.account.round.fetch(ex.roundPda(id));
    const slot = round.orderCount - 1;
    const send = () => program.methods.refund(slot)
      .accountsPartial({ caller: user.publicKey, owner: user.publicKey, config: ex.configPda, round: ex.roundPda(id) })
      .signers([user]).rpc(RPC);
    await expectError(send(), "NotRefundable");
    const queued = round.slots[slot].queuedSlot.toNumber();
    while ((await conn.getSlot("confirmed")) <= queued + 20) await sleep(500);
    await send();
    expect((await program.account.round.fetch(ex.roundPda(id))).slots[slot].state).to.equal(SlotState.Refunded);
  });
});
