// The mock executor as a plain Node service, for a server. Same loop as run.ts, without mocha
// or the Anchor workspace. Build one file with `yarn mock:bundle`.
//
//   RPC_URL=<rpc> EXECUTOR_KEYPAIR=<path> EXECUTOR_X25519=<path> node executor.js
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import * as fs from "fs";
import idl from "../target/idl/pnd_mock.json";
import { PndMock } from "../target/types/pnd_mock";
import { MockExecutor } from "./mock-executor";
import { SIGNER_PATH, X25519_PATH, loadExecutorKeys } from "./keys";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const POLL_MS = Number(process.env.POLL_MS ?? 5000);
const PRICE_Q32 = BigInt(process.env.PRICE_Q32 ?? (1n << 32n).toString());
const mask = (s: string) => s.replace(/api-key=[A-Za-z0-9_-]+/g, "api-key=***");

async function main() {
  // The x25519 key is in the on-chain config. A new key would make every order unreadable.
  for (const f of [SIGNER_PATH, X25519_PATH]) {
    if (!fs.existsSync(f)) throw new Error(`missing key file ${f}`);
  }
  const { signer, x25519Secret } = loadExecutorKeys();
  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(signer), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl as PndMock, provider);
  const ex = new MockExecutor(program, { signer, x25519Secret, priceQ32: PRICE_Q32 });
  await ex.assertNotMainnet();
  console.log(`executor ${signer.publicKey.toBase58()} on ${mask(RPC_URL)}`);
  for (;;) {
    try {
      const did = await ex.step();
      if (did !== "idle") continue; // more work may be waiting
    } catch (e) {
      console.log(mask(`step failed: ${String(e).split("\n")[0]}`));
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(mask(String(e)));
  process.exit(1);
});
