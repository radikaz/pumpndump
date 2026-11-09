// Crypto for devnet v2 (docs/devnet-v2.md): deposit notes, balance documents, signed requests.
import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, verify } from "crypto";
import { deflateRawSync, inflateRawSync } from "zlib";
import { x25519 } from "@arcium-hq/client";

export const sha256 = (...parts: (Uint8Array | string)[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

function gcmSeal(key: Uint8Array, plain: Uint8Array) {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return Buffer.concat([nonce, ct]);
}

function gcmOpen(key: Uint8Array, nonce: Uint8Array, ctWithTag: Uint8Array) {
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(ctWithTag.subarray(ctWithTag.length - 16));
  return Buffer.concat([d.update(ctWithTag.subarray(0, ctWithTag.length - 16)), d.final()]);
}

/** Deposit note: eph_pub(32) | nonce(12) | AES-GCM(sign.pub | box.pub)(80) | pad(4). */
export function openNote(executorSecret: Uint8Array, note: Uint8Array) {
  const eph = note.subarray(0, 32);
  const key = sha256(x25519.getSharedSecret(executorSecret, eph));
  const plain = gcmOpen(key, note.subarray(32, 44), note.subarray(44, 124));
  return { sign: new Uint8Array(plain.subarray(0, 32)), box: new Uint8Array(plain.subarray(32, 64)) };
}

/** For tests and scripts: what the browser does. */
export function sealNote(executorPublic: Uint8Array, sign: Uint8Array, box: Uint8Array) {
  const eph = x25519.utils.randomSecretKey();
  const key = sha256(x25519.getSharedSecret(eph, executorPublic));
  const body = gcmSeal(key, Buffer.concat([sign, box]));
  return Buffer.concat([x25519.getPublicKey(eph), body, Buffer.alloc(4)]);
}

/** Balance document: nonce(12) | AES-GCM(deflate-raw(json)). Key from the user's box key. */
export function sealBalance(executorSecret: Uint8Array, box: Uint8Array, doc: unknown) {
  const key = sha256(x25519.getSharedSecret(executorSecret, box));
  return gcmSeal(key, deflateRawSync(Buffer.from(JSON.stringify(doc))));
}

export function openBalance(boxSecret: Uint8Array, executorPublic: Uint8Array, data: Uint8Array) {
  const key = sha256(x25519.getSharedSecret(boxSecret, executorPublic));
  return JSON.parse(inflateRawSync(gcmOpen(key, data.subarray(0, 12), data.subarray(12))).toString());
}

export const balanceTag = (signPub: Uint8Array) => sha256("pnd-bal", signPub);

const ED25519_DER = Buffer.from("302a300506032b6570032100", "hex");

export function verifySig(signPub: Uint8Array, msg: string, sig: Uint8Array) {
  const key = createPublicKey({ key: Buffer.concat([ED25519_DER, signPub]), format: "der", type: "spki" });
  return verify(null, Buffer.from(msg), key, sig);
}
