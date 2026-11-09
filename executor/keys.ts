// Executor keys live outside the repo, next to the other Solana keys.
import * as anchor from "@anchor-lang/core";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { x25519 } from "@arcium-hq/client";

const DIR = path.join(os.homedir(), ".config", "solana");
export const SIGNER_PATH = process.env.EXECUTOR_KEYPAIR ?? path.join(DIR, "pumpndump-mock-executor.json");
export const X25519_PATH = process.env.EXECUTOR_X25519 ?? path.join(DIR, "pumpndump-mock-executor-x25519.json");

function readOrCreate(file: string, make: () => Uint8Array): Uint8Array {
  if (fs.existsSync(file)) return new Uint8Array(JSON.parse(fs.readFileSync(file, "utf8")));
  const bytes = make();
  // wx: never overwrite a key file.
  fs.writeFileSync(file, JSON.stringify(Array.from(bytes)), { mode: 0o600, flag: "wx" });
  return bytes;
}

export function loadExecutorKeys() {
  const signer = anchor.web3.Keypair.fromSecretKey(
    readOrCreate(SIGNER_PATH, () => anchor.web3.Keypair.generate().secretKey),
  );
  const x25519Secret = readOrCreate(X25519_PATH, () => x25519.utils.randomSecretKey());
  return { signer, x25519Secret };
}
