// One-time setup of pnd_mock on a cluster: executor keys, executor funding, config.
//
//   ANCHOR_PROVIDER_URL=<rpc> ANCHOR_WALLET=<payer keypair> \
//   yarn mock:setup
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { SystemProgram, Transaction } from "@solana/web3.js";
import { PndMock } from "../target/types/pnd_mock";
import { MockExecutor } from "./mock-executor";
import { loadExecutorKeys } from "./keys";

const RPC = { commitment: "confirmed", preflightCommitment: "confirmed" } as const;
const MIN_CLOSE_S = Number(process.env.MIN_CLOSE_S ?? 120);
const SPAN_CLOSE_S = Number(process.env.SPAN_CLOSE_S ?? 1080);
const BOND = Number(process.env.BOND_LAMPORTS ?? 10_000_000);
const REFUND_AFTER_SLOTS = Number(process.env.REFUND_AFTER_SLOTS ?? 250);
const EXECUTOR_FUNDING = Number(process.env.EXECUTOR_FUNDING_LAMPORTS ?? 500_000_000);

describe("pnd_mock setup", () => {
  it("creates keys, funds the executor and writes the config", async () => {
    anchor.setProvider(anchor.AnchorProvider.env());
    const provider = anchor.getProvider() as anchor.AnchorProvider;
    const program = anchor.workspace.PndMock as Program<PndMock>;
    const { signer, x25519Secret } = loadExecutorKeys();
    const ex = new MockExecutor(program, { signer, x25519Secret, priceQ32: 0n });
    await ex.assertNotMainnet();

    const bal = await provider.connection.getBalance(signer.publicKey);
    if (bal < EXECUTOR_FUNDING / 2) {
      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            toPubkey: signer.publicKey,
            lamports: EXECUTOR_FUNDING - bal,
          }),
        ),
        [],
        RPC,
      );
    }
    if (!(await provider.connection.getAccountInfo(ex.configPda))) {
      await program.methods
        .initConfig(
          signer.publicKey,
          new anchor.BN(MIN_CLOSE_S),
          new anchor.BN(SPAN_CLOSE_S),
          new anchor.BN(BOND),
          new anchor.BN(REFUND_AFTER_SLOTS),
          Array.from(ex.x25519Public),
        )
        .accountsPartial({ payer: provider.wallet.publicKey, config: ex.configPda })
        .rpc(RPC);
    }
    console.log(`  program   ${program.programId.toBase58()}`);
    console.log(`  executor  ${signer.publicKey.toBase58()}`);
    console.log(`  x25519    ${Buffer.from(ex.x25519Public).toString("hex")}`);
  });
});
