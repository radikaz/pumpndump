// One-time setup of pnd_demo: config, the 52 test coins, executor funding. Safe to run again:
// it skips what exists. DEVNET ONLY.
//
//   RPC_URL=<rpc> AUTHORITY_KEYPAIR=<path> node setup-v2.js
import * as anchor from "@anchor-lang/core";
import * as fs from "fs";
import { SystemProgram, Transaction } from "@solana/web3.js";
import { x25519 } from "@arcium-hq/client";
import coinList from "./coins.json";
import { DemoChain } from "./chain";
import { loadExecutorKeys } from "../keys";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const FAUCET_USD = 1000;
const EXECUTOR_FUNDING = Number(process.env.EXECUTOR_FUNDING_LAMPORTS ?? 3_000_000_000);

async function main() {
  const authority = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(process.env.AUTHORITY_KEYPAIR!, "utf8"))),
  );
  const provider = new anchor.AnchorProvider(new anchor.web3.Connection(RPC_URL, "confirmed"), new anchor.Wallet(authority), {
    commitment: "confirmed", preflightCommitment: "confirmed",
  });
  const chain = new DemoChain(provider);
  await chain.assertNotMainnet();
  const { signer, x25519Secret } = loadExecutorKeys();

  if (!(await chain.exists(chain.config))) {
    await chain.program.methods
      .initConfig(signer.publicKey, Array.from(x25519.getPublicKey(x25519Secret)), 20, 60)
      .accountsPartial({ authority: authority.publicKey, config: chain.config })
      .rpc();
    console.log("config created");
  }
  const bal = await provider.connection.getBalance(signer.publicKey);
  if (bal < EXECUTOR_FUNDING) {
    await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({
      fromPubkey: authority.publicKey, toPubkey: signer.publicKey, lamports: EXECUTOR_FUNDING - bal,
    })));
    console.log(`executor funded to ${EXECUTOR_FUNDING / 1e9} SOL`);
  }
  const cfg = await chain.fetchConfig();
  for (let i = cfg.coinCount; i < coinList.length; i++) {
    const c = coinList[i];
    const symbol = Buffer.alloc(16);
    symbol.write(c.t.slice(0, 16));
    const faucet = BigInt(Math.max(1, Math.round((FAUCET_USD / c.usd) * 1e6)));
    await chain.program.methods
      .addCoin(i, Array.from(symbol), new anchor.BN(faucet.toString()))
      .accountsPartial({
        authority: authority.publicKey, config: chain.config, pool: chain.pool,
        coin: chain.coin(i), mint: chain.mint(i), vault: chain.vault(i),
      })
      .rpc({ commitment: "confirmed" });
    console.log(`coin ${i} ${c.t} added`);
  }
  console.log(`program ${chain.id.toBase58()}, ${coinList.length} coins, executor ${signer.publicKey.toBase58()}`);
}

main().catch((e) => {
  console.error(String(e).replace(/api-key=[A-Za-z0-9_-]+/g, "api-key=***"));
  process.exit(1);
});
