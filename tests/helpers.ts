import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { PndSpike } from "../target/types/pnd_spike";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  uploadCircuit,
  getMXEPublicKey,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getLookupTableAddress,
} from "@arcium-hq/client";
import * as fs from "fs";

/**
 * Fetch the blockhash and simulate at the same commitment. Anchor takes the blockhash at the
 * connection default ("processed") and simulates at `commitment`, which fails at random with
 * "Blockhash not found".
 */
export const RPC = { commitment: "confirmed", preflightCommitment: "confirmed" } as const;

export const CIRCUITS = ["draw_close", "tick", "submit_order", "match_pair"] as const;
export type Circuit = (typeof CIRCUITS)[number];

export function readKpJson(path: string): anchor.web3.Keypair {
  return anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(path).toString())),
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function newOffset(): anchor.BN {
  return new anchor.BN(randomBytes(8), "hex");
}

export function pda(programId: PublicKey, ...seeds: (Buffer | Uint8Array)[]) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

/** The Arcium accounts every queue instruction needs. */
export function queueAccounts(
  programId: PublicKey,
  circuit: Circuit,
  offset: anchor.BN,
) {
  const env = getArciumEnv();
  return {
    computationAccount: getComputationAccAddress(env.arciumClusterOffset, offset),
    clusterAccount: getClusterAccAddress(env.arciumClusterOffset),
    mxeAccount: getMXEAccAddress(programId),
    mempoolAccount: getMempoolAccAddress(env.arciumClusterOffset),
    executingPool: getExecutingPoolAccAddress(env.arciumClusterOffset),
    compDefAccount: getCompDefAccAddress(
      programId,
      Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE(),
    ),
  };
}

const INIT_METHOD: Record<Circuit, string> = {
  draw_close: "initDrawCloseCompDef",
  tick: "initTickCompDef",
  submit_order: "initSubmitOrderCompDef",
  match_pair: "initMatchPairCompDef",
};

/** Creates the computation definition and uploads the circuit. Skips it if it exists. */
export async function initCompDef(
  program: Program<PndSpike>,
  owner: anchor.web3.Keypair,
  circuit: Circuit,
) {
  const provider = program.provider as anchor.AnchorProvider;
  const arciumProgram = getArciumProgram(provider);
  const compDefPDA = PublicKey.findProgramAddressSync(
    [
      getArciumAccountBaseSeed("ComputationDefinitionAccount"),
      program.programId.toBuffer(),
      getCompDefAccOffset(circuit),
    ],
    getArciumProgramId(),
  )[0];
  if (await provider.connection.getAccountInfo(compDefPDA)) return;

  const mxeAccount = getMXEAccAddress(program.programId);
  const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
  await (program.methods as any)
    [INIT_METHOD[circuit]]()
    .accounts({
      compDefAccount: compDefPDA,
      payer: owner.publicKey,
      mxeAccount,
      addressLookupTable: getLookupTableAddress(
        program.programId,
        mxeAcc.lutOffsetSlot,
      ),
    })
    .signers([owner])
    .rpc(RPC);

  await uploadCircuit(
    provider,
    circuit,
    program.programId,
    fs.readFileSync(`build/${circuit}.arcis`),
    true,
    500,
    { skipPreflight: true, preflightCommitment: "confirmed", commitment: "confirmed" },
  );
}

export async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
): Promise<Uint8Array> {
  // Keygen can take a while after the nodes start.
  for (let i = 0; i < 240; i++) {
    try {
      const k = await getMXEPublicKey(provider, programId);
      if (k) return k;
    } catch {}
    await sleep(500);
  }
  throw new Error("No MXE public key");
}

/** One measured computation. */
export interface Sample {
  circuit: string;
  cluster: string;
  queueSig: string;
  callbackSig: string;
  /** From "queue transaction confirmed" to "callback transaction confirmed". */
  ms: number;
  slots: number;
  /** Payer balance drop, minus the queue transaction fee and new rent. */
  arciumFeeLamports: number;
  txFeeLamports: number;
  rentLamports: number;
  callbackTxBytes: number;
}

async function rawTxBytes(connection: anchor.web3.Connection, sig: string) {
  const res = await fetch(connection.rpcEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        sig,
        { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      ],
    }),
  });
  const json: any = await res.json();
  return Buffer.from(json.result.transaction[0], "base64").length;
}

/**
 * Sends a queue instruction, waits for its callback and records cost and time.
 * `rentLamports` is the rent of accounts the queue instruction creates, and `lockedLamports`
 * is what it locks (a bond). Both are known by the caller and are not counted as fees.
 * Give each parallel call its own payer, or the balance numbers mix.
 */
export async function measure(
  program: Program<PndSpike>,
  circuit: string,
  offset: anchor.BN,
  send: () => Promise<string>,
  opts: { rentLamports?: number; lockedLamports?: number; payer?: PublicKey } = {},
): Promise<Sample> {
  const provider = program.provider as anchor.AnchorProvider;
  const conn = provider.connection;
  const payer = opts.payer ?? provider.wallet.publicKey;
  const rentLamports = (opts.rentLamports ?? 0) + (opts.lockedLamports ?? 0);

  const before = await conn.getBalance(payer, "confirmed");
  const queueSig = await send();
  const t0 = Date.now();
  const slot0 = await conn.getSlot("confirmed");
  const callbackSig = await awaitComputationFinalization(
    provider,
    offset,
    program.programId,
    "confirmed",
  );
  const ms = Date.now() - t0;
  const slots = (await conn.getSlot("confirmed")) - slot0;
  const after = await conn.getBalance(payer, "confirmed");

  const queueTx = await conn.getTransaction(queueSig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const txFeeLamports = queueTx?.meta?.fee ?? 0;
  return {
    circuit,
    cluster: conn.rpcEndpoint,
    queueSig,
    callbackSig,
    ms,
    slots,
    arciumFeeLamports: before - after - txFeeLamports - rentLamports,
    txFeeLamports,
    rentLamports: opts.rentLamports ?? 0,
    callbackTxBytes: await rawTxBytes(conn, callbackSig),
  };
}

export function saveSamples(name: string, samples: Sample[]) {
  fs.mkdirSync("results", { recursive: true });
  fs.writeFileSync(`results/${name}.json`, JSON.stringify(samples, null, 2));
}
