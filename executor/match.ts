// The pair match in plain BigInt math, the same rules as the match_pair circuit:
// the smaller side fills in full, the larger side fills pro rata (Q32 ratio, rounded down),
// and the rest of the larger side is the market leg.

export const BATCH = 16;
export const MAX_AMOUNT = 1n << 40n;
const Q = 32n;

export interface Order {
  active: boolean;
  isBuy: boolean;
  amount: bigint;
}

export interface MatchResult {
  /** Fill of each slot, in the units the order paid in. */
  fills: bigint[];
  leg: { isBuy: boolean; amount: bigint };
}

/** price: quote units per base unit, Q32. */
export function matchPair(orders: Order[], price: bigint): MatchResult {
  const amt = orders.map((o) => (o.active ? o.amount : 0n));
  let buyQ = 0n;
  let sellB = 0n;
  orders.forEach((o, i) => (o.isBuy ? (buyQ += amt[i]) : (sellB += amt[i])));
  const sellQ = (sellB * price) >> Q;
  const matchedQ = buyQ < sellQ ? buyQ : sellQ;
  const ratio = (sideQ: bigint) => (sideQ === 0n ? 0n : (matchedQ << Q) / sideQ);
  const buyR = ratio(buyQ);
  const sellR = ratio(sellQ);
  let filledQ = 0n;
  let filledB = 0n;
  const fills = orders.map((o, i) => {
    const f = (amt[i] * (o.isBuy ? buyR : sellR)) >> Q;
    o.isBuy ? (filledQ += f) : (filledB += f);
    return f;
  });
  const leg =
    buyQ > sellQ
      ? { isBuy: true, amount: buyQ - filledQ }
      : { isBuy: false, amount: sellB - filledB };
  return { fills, leg };
}

/**
 * Packs 16 u64 fills into 6 field elements, 3 per element (little end first).
 * The mock's own format. Arcium's Pack<[u64; 16]> also gives 6 elements, but its bit layout
 * is not specified here, so do not rely on the two being the same.
 */
export function packFills(fills: bigint[]): bigint[] {
  const out: bigint[] = [];
  for (let i = 0; i < BATCH; i += 3) {
    let v = 0n;
    for (let k = 0; k < 3 && i + k < BATCH; k++) v |= fills[i + k] << (64n * BigInt(k));
    out.push(v);
  }
  return out;
}

export function unpackFills(packed: bigint[]): bigint[] {
  const out: bigint[] = [];
  for (const v of packed) {
    for (let k = 0; k < 3 && out.length < BATCH; k++) {
      out.push((v >> (64n * BigInt(k))) & ((1n << 64n) - 1n));
    }
  }
  return out;
}
