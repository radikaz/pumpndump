import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PndSpike } from "../target/types/pnd_spike";
import { randomBytes } from "crypto";
import { execSync } from "child_process";
import * as os from "os";
import { expect } from "chai";
import {
  RescueCipher,
  awaitComputationFinalization,
  deserializeLE,
  x25519,
} from "@arcium-hq/client";
import {
  CIRCUITS,
  RPC,
  Sample,
  getMXEPublicKeyWithRetry,
  initCompDef,
  measure,
  newOffset,
  pda,
  queueAccounts,
  readKpJson,
  saveSamples,
  sleep,
  u64le,
} from "./helpers";

const BATCH_SIZE = 16;
const BOND = 10_000_000; // 0.01 SOL per order
const REFUND_AFTER_SLOTS = 30;
const ROUND_SPACE = 8 + 3080;
const ONE = 1n << 32n; // price 1.0 in Q32
const TICK_EVERY_MS = 2000;

const Slot = { Empty: 0, Pending: 1, Sealed: 2, Late: 3, Refunded: 4 };
const SLOT_NAME = Object.keys(Slot);

/** The market leg of match_pair, in plain BigInt math. Mirrors the circuit spec. */
function modelLeg(orders: { isBuy: boolean; amount: bigint }[], price: bigint) {
  let buyQ = 0n;
  let sellB = 0n;
  for (const o of orders) o.isBuy ? (buyQ += o.amount) : (sellB += o.amount);
  const sellQ = (sellB * price) >> 32n;
  const matchedQ = buyQ < sellQ ? buyQ : sellQ;
  const ratio = (sideQ: bigint) => (sideQ === 0n ? 0n : (matchedQ << 32n) / sideQ);
  let filledQ = 0n;
  let filledB = 0n;
  for (const o of orders) {
    const fill = (o.amount * ratio(o.isBuy ? buyQ : sellQ)) >> 32n;
    o.isBuy ? (filledQ += fill) : (filledB += fill);
  }
  return buyQ > sellQ
    ? { isBuy: true, amount: buyQ - filledQ }
    : { isBuy: false, amount: sellB - filledB };
}

describe("pnd_spike", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.PndSpike as Program<PndSpike>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const conn = provider.connection;
  const owner = readKpJson(
    process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/pumpndump-devnet.json`,
  );
  const configPda = pda(program.programId, Buffer.from("config"));
  const roundPda = (id: number) =>
    pda(program.programId, Buffer.from("round"), u64le(id));
  const samples: Sample[] = [];
  let mxePub: Uint8Array;
  const executorSk = x25519.utils.randomSecretKey();
  const executorPk = x25519.getPublicKey(executorSk);

  before(async () => {
    // A fresh localnet can reject the first transactions with "Blockhash not found".
    const start = await conn.getSlot("confirmed");
    while ((await conn.getSlot("confirmed")) < start + 5) await sleep(400);
    mxePub = await getMXEPublicKeyWithRetry(provider, program.programId);
    for (const c of CIRCUITS) await initCompDef(program, owner, c);
    if (!(await conn.getAccountInfo(configPda))) {
      await program.methods
        .initConfig(
          owner.publicKey,
          new anchor.BN(6),
          new anchor.BN(14),
          new anchor.BN(BOND),
          new anchor.BN(REFUND_AFTER_SLOTS),
          Array.from(executorPk),
        )
        .accountsPartial({ payer: owner.publicKey, config: configPda })
        .rpc(RPC);
    }
  });

  after(() => saveSamples(`localnet-${Date.now()}`, samples));

  // ---------- helpers ----------

  const currentRound = async () =>
    (await program.account.config.fetch(configPda)).nextRound.toNumber() - 1;

  async function setLimits(min: number, span: number) {
    await program.methods
      .setRoundLimits(new anchor.BN(min), new anchor.BN(span))
      .accountsPartial({ authority: owner.publicKey, config: configPda })
      .rpc(RPC);
  }

  async function openRound(): Promise<number> {
    const id = (await currentRound()) + 1;
    const offset = newOffset();
    const rent = await conn.getMinimumBalanceForRentExemption(ROUND_SPACE);
    samples.push(
      await measure(
        program,
        "draw_close",
        offset,
        () =>
          program.methods
            .openRound(offset)
            .accountsPartial({
              payer: owner.publicKey,
              config: configPda,
              prevRound: id > 0 ? roundPda(id - 1) : null,
              round: roundPda(id),
              ...queueAccounts(program.programId, "draw_close", offset),
            })
            .rpc(RPC),
        { rentLamports: rent },
      ),
    );
    return id;
  }

  function sendTick(id: number, offset: anchor.BN) {
    return program.methods
      .tick(offset)
      .accountsPartial({
        payer: owner.publicKey,
        config: configPda,
        round: roundPda(id),
        ...queueAccounts(program.programId, "tick", offset),
      })
      .rpc(RPC);
  }

  /** Ticks until the round closes. Returns the seconds from open to close. */
  async function tickUntilClosed(id: number): Promise<number> {
    for (let i = 0; i < 200; i++) {
      const offset = newOffset();
      samples.push(await measure(program, "tick", offset, () => sendTick(id, offset)));
      const round = await program.account.round.fetch(roundPda(id));
      if (round.state === 2) return round.closeTs.sub(round.openTs).toNumber();
      await sleep(TICK_EVERY_MS);
    }
    throw new Error("round did not close");
  }

  async function fundedUser(): Promise<anchor.web3.Keypair> {
    const kp = anchor.web3.Keypair.generate();
    await conn.confirmTransaction(
      await conn.requestAirdrop(kp.publicKey, 1e9),
      "confirmed",
    );
    return kp;
  }

  /** Encrypts an order to the cluster with a fresh key, as a browser would. */
  function seal(isBuy: boolean, amount: bigint) {
    const sk = x25519.utils.randomSecretKey();
    const pk = x25519.getPublicKey(sk);
    const cipher = new RescueCipher(x25519.getSharedSecret(sk, mxePub));
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([isBuy ? 1n : 0n, amount], nonce);
    return { pk, nonce, ct };
  }

  function sendSubmit(
    id: number,
    user: anchor.web3.Keypair,
    offset: anchor.BN,
    isBuy: boolean,
    amount: bigint,
  ) {
    const o = seal(isBuy, amount);
    return program.methods
      .submitOrder(
        offset,
        Array.from(o.ct[0]),
        Array.from(o.ct[1]),
        Array.from(o.pk),
        new anchor.BN(deserializeLE(o.nonce).toString()),
      )
      .accountsPartial({
        payer: user.publicKey,
        config: configPda,
        round: roundPda(id),
        ...queueAccounts(program.programId, "submit_order", offset),
      })
      .signers([user])
      .rpc(RPC);
  }

  function sendRefund(id: number, user: anchor.web3.Keypair, slot: number) {
    return program.methods
      .refund(slot)
      .accountsPartial({ caller: user.publicKey, owner: user.publicKey, config: configPda, round: roundPda(id) })
      .signers([user])
      .rpc(RPC);
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

  // ---------- step 2: random close ----------

  it("opens a round with a hidden close time", async () => {
    const id = await openRound();
    const round = await program.account.round.fetch(roundPda(id));
    expect(round.state).to.equal(1);
    expect(round.openTs.toNumber()).to.be.greaterThan(0);
    expect(Buffer.from(round.closeCt).equals(Buffer.alloc(32))).to.equal(false);
    expect((await conn.getAccountInfo(roundPda(id)))!.data.length).to.equal(ROUND_SPACE);
  });

  it("rejects a tick from a key that is not the keeper", async () => {
    const stranger = await fundedUser();
    const offset = newOffset();
    await expectError(
      program.methods
        .tick(offset)
        .accountsPartial({
          payer: stranger.publicKey,
          config: configPda,
          round: roundPda(await currentRound()),
          ...queueAccounts(program.programId, "tick", offset),
        })
        .signers([stranger])
        .rpc(RPC),
      "NotKeeper",
    );
  });

  it("closes inside the limits, and the next round can open", async () => {
    const id = await currentRound();
    const lived = await tickUntilClosed(id);
    console.log(`      round ${id} closed after ${lived} s`);
    // A tick reads the clock when it is queued, so the close can land a little late.
    expect(lived).to.be.at.least(6);
    expect(lived).to.be.below(6 + 14 + 10);

    const next = await openRound();
    expect(next).to.equal(id + 1);
    await tickUntilClosed(next);
  });

  // ---------- step 3: sealed orders and refunds ----------

  // One round with a full batch. Step 4 matches it.
  let batchRound: number;
  const users: anchor.web3.Keypair[] = [];

  it(`seals ${BATCH_SIZE} orders sent at the same time`, async () => {
    await setLimits(40, 5);
    batchRound = await openRound();
    const id = batchRound;
    for (let i = 0; i <= BATCH_SIZE; i++) users.push(await fundedUser());

    const t0 = Date.now();
    const results = await Promise.all(
      users.slice(0, BATCH_SIZE).map((u, i) => {
        const offset = newOffset();
        return measure(
          program,
          "submit_order",
          offset,
          () => sendSubmit(id, u, offset, i % 2 === 0, BigInt(1000 + i)),
          { payer: u.publicKey, lockedLamports: BOND },
        );
      }),
    );
    samples.push(...results);
    console.log(`      ${BATCH_SIZE} orders sealed in ${Date.now() - t0} ms`);

    const round = await program.account.round.fetch(roundPda(id));
    expect(round.orderCount).to.equal(BATCH_SIZE);
    for (let i = 0; i < BATCH_SIZE; i++) {
      expect(round.slots[i].state).to.equal(Slot.Sealed);
      expect(Buffer.from(round.orderCt[i]).equals(Buffer.alloc(64))).to.equal(false);
    }
    // Each slot belongs to the user who sent it, in some order.
    const owners = new Set(round.slots.map((s) => s.owner.toBase58()));
    for (const u of users.slice(0, BATCH_SIZE)) {
      expect(owners.has(u.publicKey.toBase58())).to.equal(true);
    }
  });

  it("rejects order 17", async () => {
    await expectError(
      sendSubmit(batchRound, users[BATCH_SIZE], newOffset(), true, 1n),
      "BatchFull",
    );
  });

  it("does not refund a sealed order", async () => {
    const round = await program.account.round.fetch(roundPda(batchRound));
    const slot = round.slots.findIndex((s) => s.owner.equals(users[0].publicKey));
    await expectError(sendRefund(batchRound, users[0], slot), "NotRefundable");
  });

  it("closes the batch round", async () => {
    await tickUntilClosed(batchRound);
  });

  it("matches the batch, and only the executor can read the market leg", async () => {
    const id = batchRound;
    const price = 2n * ONE;
    const offset = newOffset();
    samples.push(
      await measure(program, "match_pair", offset, () =>
        program.methods
          .matchRound(
            offset,
            new anchor.BN(price.toString()),
            new anchor.BN(deserializeLE(randomBytes(16)).toString()),
          )
          .accountsPartial({
            payer: owner.publicKey,
            config: configPda,
            round: roundPda(id),
            ...queueAccounts(program.programId, "match_pair", offset),
          })
          .rpc(RPC),
      ),
    );
    const round = await program.account.round.fetch(roundPda(id));
    expect(round.state).to.equal(4);

    // The orders we sent, by slot.
    const orders = round.slots.map((s) => {
      const i = users.findIndex((u) => u.publicKey.equals(s.owner));
      return { isBuy: i % 2 === 0, amount: BigInt(1000 + i) };
    });
    const want = modelLeg(orders, price);

    const nonce = Uint8Array.from(round.legNonce);
    const leg = new RescueCipher(x25519.getSharedSecret(executorSk, mxePub)).decrypt(
      round.legCt.map((c) => Uint8Array.from(c)),
      nonce,
    );
    console.log(`      market leg: ${leg[0] ? "buy" : "sell"} ${leg[1]} (model: ${want.isBuy ? "buy" : "sell"} ${want.amount})`);
    expect(leg[0] === 1n).to.equal(want.isBuy);
    expect(leg[1]).to.equal(want.amount);

    // Any other key gets noise.
    const other = x25519.utils.randomSecretKey();
    const wrong = new RescueCipher(x25519.getSharedSecret(other, mxePub)).decrypt(
      round.legCt.map((c) => Uint8Array.from(c)),
      nonce,
    );
    expect(wrong[1]).to.not.equal(want.amount);
  });

  it("returns the bond after the match", async () => {
    const round = await program.account.round.fetch(roundPda(batchRound));
    const slot = round.slots.findIndex((s) => s.owner.equals(users[3].publicKey));
    const before = await conn.getBalance(users[3].publicKey);
    await sendRefund(batchRound, users[3], slot);
    expect((await conn.getBalance(users[3].publicKey)) - before).to.be.greaterThan(BOND - 10_000);
  });

  it("refunds an order that comes back after the round closed", async () => {
    await setLimits(6, 1);
    const id = await openRound();
    const user = await fundedUser();
    await sleep(6500);
    // Queue the tick first. The order is queued while the round is still open,
    // but its callback is likely to land after the tick closes the round.
    const tickOffset = newOffset();
    await sendTick(id, tickOffset);
    const orderOffset = newOffset();
    await sendSubmit(id, user, orderOffset, true, 5n);
    await Promise.all(
      [tickOffset, orderOffset].map((o) =>
        awaitComputationFinalization(provider, o, program.programId, "confirmed"),
      ),
    );
    const round = await program.account.round.fetch(roundPda(id));
    const state = round.slots[0].state;
    console.log(`      order state after close: ${SLOT_NAME[state]}, round state ${round.state}`);
    if (state === Slot.Late) {
      const before = await conn.getBalance(user.publicKey);
      await sendRefund(id, user, 0);
      const after = await conn.getBalance(user.publicKey);
      expect(after - before).to.be.greaterThan(BOND - 10_000);
    } else {
      expect(state).to.equal(Slot.Sealed);
    }
    if (round.state !== 2) await tickUntilClosed(id);
  });

  it("refunds an order whose computation never runs", async () => {
    await setLimits(600, 10);
    const id = await openRound();
    const user = await fundedUser();
    const nodes = execSync("docker ps --format '{{.Names}}'")
      .toString()
      .split("\n")
      .filter((n) => /^artifacts-arx-node-\d+-1$/.test(n));
    expect(nodes.length).to.be.greaterThan(0);

    execSync(`docker stop ${nodes.join(" ")}`);
    const offset = newOffset();
    let restarted = false;
    try {
      await sendSubmit(id, user, offset, false, 7n);
      await expectError(sendRefund(id, user, 0), "NotRefundable");

      const queued = (await program.account.round.fetch(roundPda(id))).slots[0]
        .queuedSlot.toNumber();
      while ((await conn.getSlot("confirmed")) <= queued + REFUND_AFTER_SLOTS) {
        await sleep(1000);
      }
      const before = await conn.getBalance(user.publicKey);
      await sendRefund(id, user, 0);
      const after = await conn.getBalance(user.publicKey);
      expect(after - before).to.be.greaterThan(BOND - 10_000);
      expect((await program.account.round.fetch(roundPda(id))).slots[0].state).to.equal(
        Slot.Refunded,
      );

      execSync(`docker start ${nodes.join(" ")}`);
      restarted = true;
      const t0 = Date.now();
      // Does the old computation still run when the nodes come back?
      const late = await Promise.race([
        awaitComputationFinalization(provider, offset, program.programId, "confirmed").then(
          () => true,
        ),
        sleep(120_000).then(() => false),
      ]);
      console.log(
        `      old computation after restart: ${late ? `ran after ${Date.now() - t0} ms` : "did not run in 120 s"}`,
      );
      // Either way the refund stands.
      expect((await program.account.round.fetch(roundPda(id))).slots[0].state).to.equal(
        Slot.Refunded,
      );

      // The cluster works again.
      const t1 = Date.now();
      const tickOffset = newOffset();
      samples.push(await measure(program, "tick", tickOffset, () => sendTick(id, tickOffset)));
      console.log(`      first tick after restart done in ${Date.now() - t1} ms`);
    } finally {
      if (!restarted) execSync(`docker start ${nodes.join(" ")}`);
    }
  });
});
