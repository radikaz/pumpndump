// Runs the mock executor until stopped. Rounds only move while this runs.
//
//   ANCHOR_PROVIDER_URL=<rpc> ANCHOR_WALLET=<any keypair> PRICE_Q32=<price> \
//   yarn mock:run
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PndMock } from "../target/types/pnd_mock";
import { MockExecutor } from "./mock-executor";
import { loadExecutorKeys } from "./keys";

const POLL_MS = Number(process.env.POLL_MS ?? 2000);
const PRICE_Q32 = BigInt(process.env.PRICE_Q32 ?? (1n << 32n).toString());
const mask = (s: string) => s.replace(/api-key=[A-Za-z0-9_-]+/g, "api-key=***");

describe("pnd_mock executor", () => {
  it("runs", async () => {
    anchor.setProvider(anchor.AnchorProvider.env());
    const program = anchor.workspace.PndMock as Program<PndMock>;
    const { signer, x25519Secret } = loadExecutorKeys();
    const ex = new MockExecutor(program, { signer, x25519Secret, priceQ32: PRICE_Q32 });
    await ex.assertNotMainnet();
    console.log(`executor ${signer.publicKey.toBase58()} on ${mask(program.provider.connection.rpcEndpoint)}`);
    for (;;) {
      try {
        const did = await ex.step();
        if (did !== "idle") continue; // more work may be waiting
      } catch (e) {
        console.log(mask(`step failed: ${String(e).split("\n")[0]}`));
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  });
});
