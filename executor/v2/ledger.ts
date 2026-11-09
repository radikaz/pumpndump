// The devnet v2 ledger: private balances, orders, locks, and the round match. Pure logic, no
// chain calls, so tests can drive it. The executor owns this state and can read all of it.
//
// Fill order per round (CLAUDE.md): pairs, rings, earn, market. Every part fills in full in its
// round: what pairs and rings do not cover, the house (the earn strategy) takes at the
// reference price. Devnet has no Jupiter, so the house also stands in for the market.
import { randomInt } from "crypto";

export type Parts = 1 | 3 | 6 | 12 | "drip";
export const DRIP_MS = 24 * 3600_000;
export const LOCK_DAYS = [1, 7, 30];
export const EARN_SHARE = 0.5;
export const DRAW_SHARE = 0.1;
export const DRAW_EVERY_MS = 7 * 24 * 3600_000;
const MAX_ORDERS_IN_DOC = 6;
const MAX_HISTORY = 10;
const MAX_LOCKS = 8;

export interface Order {
  id: string;
  from: string;
  to: string;
  amount: string;
  remaining: string;
  parts: Parts;
  partsDone: number;
  filled: string;
  got: string;
  fees: string;
  via: { pairs: string; rings: string; earn: string; market: string };
  earnDays: number;
  status: "open" | "done" | "cancelled";
  ts: number;
}
export interface Lock { id: string; coin: string; amount: string; days: number; until: number; earned: string }
export interface Hist { kind: string; coin: string; amount: string; ts: number; tx?: string; to?: string }
export interface User {
  box: string;
  seq: number;
  bal: Record<string, string>;
  orders: Order[];
  locks: Lock[];
  history: Hist[];
}
export interface RoundOut {
  id: number;
  openTs: number;
  closeTs: number;
  orders: number;
  parts: number;
  /** micro-USD: pairs, rings, earn, market */
  volume: [number, number, number, number];
  /** base units per coin. Positive: the round bought it from outside on net. */
  net: { coin: string; amount: bigint }[];
}
export interface State {
  users: Record<string, User>;
  /** The house (earn strategy). Can go negative: it mints test coins on devnet. */
  house: Record<string, string>;
  feesUsd: number;
  drawPotUsd: number;
  lastDrawTs: number;
  nextId: number;
  round: { id: number; openTs: number; closeAt: number };
  rounds: RoundOut[];
  creditedDeposits: number[];
  /** Closed rounds whose result is not on chain yet. */
  pendingPosts?: RoundOut[];
}

export const newState = (): State => ({
  users: {}, house: {}, feesUsd: 0, drawPotUsd: 0, lastDrawTs: Date.now(), nextId: 1,
  round: { id: 0, openTs: 0, closeAt: 0 }, rounds: [], creditedDeposits: [],
});

const B = (s: string | undefined) => BigInt(s ?? "0");
const add = (m: Record<string, string>, k: string, d: bigint) => {
  const v = B(m[k]) + d;
  if (v === 0n) delete m[k];
  else m[k] = v.toString();
};
/** Base units (6 decimals) to USD. */
const usd = (amount: bigint, price: number) => (Number(amount) / 1e6) * price;
/** Converts base units of one coin to another at reference prices. */
const convert = (amount: bigint, pFrom: number, pTo: number) =>
  (amount * BigInt(Math.round((pFrom / pTo) * 1e12))) / 1_000_000_000_000n;

export class Ledger {
  constructor(
    public s: State,
    private prices: () => Record<string, number>,
    private fees = { inside: 0.002, market: 0.006 },
    private now = () => Date.now(),
  ) {}

  user(pub: string, box?: string): User {
    let u = this.s.users[pub];
    if (!u) u = this.s.users[pub] = { box: box ?? "", seq: 0, bal: {}, orders: [], locks: [], history: [] };
    if (box) u.box = box;
    return u;
  }

  private hist(u: User, h: Hist) {
    u.history.unshift(h);
    u.history.length = Math.min(u.history.length, MAX_HISTORY);
  }

  private price(coin: string) {
    const p = this.prices()[coin];
    if (!(p > 0)) throw new UserError(`No price for ${coin}`);
    return p;
  }

  credit(pub: string, box: string, coin: string, amount: bigint, tx?: string) {
    const u = this.user(pub, box);
    add(u.bal, coin, amount);
    this.hist(u, { kind: "deposit", coin, amount: amount.toString(), ts: this.now(), tx });
  }

  private take(u: User, coin: string, amount: bigint) {
    if (amount <= 0n) throw new UserError("Amount must be more than zero");
    if (B(u.bal[coin]) < amount) throw new UserError(`Not enough ${coin} in your private balance`);
    add(u.bal, coin, -amount);
  }

  order(pub: string, from: string, to: string, amount: bigint, parts: Parts, earnDays: number): Order {
    const u = this.user(pub);
    if (from === to) throw new UserError("Pick two different coins");
    if (![1, 3, 6, 12, "drip"].includes(parts)) throw new UserError("Parts must be 1, 3, 6, 12 or drip");
    if (![0, ...LOCK_DAYS].includes(earnDays)) throw new UserError("Earn lock must be 0, 1, 7 or 30 days");
    this.price(from);
    this.price(to);
    this.take(u, from, amount);
    const o: Order = {
      id: `o${this.s.nextId++}`, from, to, amount: amount.toString(), remaining: amount.toString(), parts,
      partsDone: 0, filled: "0", got: "0", fees: "0", via: { pairs: "0", rings: "0", earn: "0", market: "0" },
      earnDays, status: "open", ts: this.now(),
    };
    u.orders.unshift(o);
    this.trimOrders(u);
    return o;
  }

  private trimOrders(u: User) {
    // Keep every open order; keep the newest finished ones up to the limit.
    const open = u.orders.filter((o) => o.status === "open");
    const done = u.orders.filter((o) => o.status !== "open").slice(0, Math.max(0, MAX_ORDERS_IN_DOC - open.length));
    u.orders = [...open, ...done].sort((a, b) => b.ts - a.ts);
  }

  cancel(pub: string, id: string) {
    const u = this.user(pub);
    const o = u.orders.find((x) => x.id === id && x.status === "open");
    if (!o) throw new UserError("No open order with this id");
    add(u.bal, o.from, B(o.remaining));
    o.remaining = "0";
    o.status = "cancelled";
  }

  lock(pub: string, coin: string, amount: bigint, days: number) {
    const u = this.user(pub);
    if (!LOCK_DAYS.includes(days)) throw new UserError("Lock for 1, 7 or 30 days");
    if (u.locks.length >= MAX_LOCKS) throw new UserError(`At most ${MAX_LOCKS} locks at a time`);
    this.price(coin);
    this.take(u, coin, amount);
    this.addLock(u, coin, amount, days);
  }

  private addLock(u: User, coin: string, amount: bigint, days: number) {
    const same = u.locks.find((l) => l.coin === coin && l.days === days && l.until > this.now() + days * 86400_000 - 3600_000);
    if (same) same.amount = (B(same.amount) + amount).toString();
    else u.locks.push({ id: `l${this.s.nextId++}`, coin, amount: amount.toString(), days, until: this.now() + days * 86400_000, earned: "0" });
  }

  /** Takes the coin out of the balance for a withdrawal. Returns what to pay, in which coin. */
  withdraw(pub: string, coin: string, amount: bigint, payCoin?: string) {
    const u = this.user(pub);
    this.take(u, coin, amount);
    let out = { coin, amount };
    if (payCoin && payCoin !== coin) {
      const gross = convert(amount, this.price(coin), this.price(payCoin));
      const fee = (gross * BigInt(Math.round(this.fees.market * 1e6))) / 1_000_000n;
      add(this.s.house, coin, amount);
      add(this.s.house, payCoin, -(gross - fee));
      this.s.feesUsd += usd(fee, this.price(payCoin));
      out = { coin: payCoin, amount: gross - fee };
    }
    return out;
  }

  /** Undo a withdrawal whose payout failed. */
  refundWithdraw(pub: string, coin: string, amount: bigint, paid: { coin: string; amount: bigint }) {
    const u = this.user(pub);
    if (paid.coin !== coin) {
      add(this.s.house, coin, -amount);
      add(this.s.house, paid.coin, paid.amount);
    }
    add(u.bal, coin, amount);
  }

  logWithdraw(pub: string, coin: string, amount: bigint, to: string, tx: string) {
    this.hist(this.user(pub), { kind: "withdraw", coin, amount: amount.toString(), ts: this.now(), tx, to });
  }

  /** Closes the current round. Returns the public result and the users whose documents changed. */
  closeRound(): { result: RoundOut; touched: Set<string> } {
    const now = this.now();
    const prices = this.prices();
    const touched = new Set<string>();
    type Part = { pub: string; o: Order; amt: bigint; v: number; f: [number, number, number, number] };
    const parts: Part[] = [];
    const orders = new Set<string>();
    for (const [pub, u] of Object.entries(this.s.users)) {
      for (const o of u.orders) {
        if (o.status !== "open" || !(prices[o.from] > 0) || !(prices[o.to] > 0)) continue;
        const amt = this.partSize(o, now);
        if (amt <= 0n) continue;
        parts.push({ pub, o, amt, v: usd(amt, prices[o.from]), f: [0, 0, 0, 0] });
        orders.add(o.id);
      }
    }

    // Directed USD flow per coin pair.
    const edge = (a: string, b: string) => `${a}>${b}`;
    const flow = new Map<string, number>();
    for (const p of parts) flow.set(edge(p.o.from, p.o.to), (flow.get(edge(p.o.from, p.o.to)) ?? 0) + p.v);
    const left = new Map(flow);
    const pairsDone = new Map<string, number>();
    const ringsDone = new Map<string, number>();
    // 1. Pairs: A>B against B>A.
    for (const [k, v] of flow) {
      const [a, b] = k.split(">");
      const back = left.get(edge(b, a)) ?? 0;
      const m = Math.min(left.get(k)!, back);
      if (m <= 0 || a > b) continue;
      left.set(k, left.get(k)! - m);
      left.set(edge(b, a), back - m);
      pairsDone.set(k, m);
      pairsDone.set(edge(b, a), m);
      void v;
    }
    // 2. Rings: cycles of 3 to 6 coins on what is left.
    for (;;) {
      const cyc = findCycle(left);
      if (!cyc) break;
      const m = Math.min(...cyc.map((k) => left.get(k)!));
      for (const k of cyc) {
        left.set(k, left.get(k)! - m);
        ringsDone.set(k, (ringsDone.get(k) ?? 0) + m);
      }
    }
    // 3 and 4. Earn takes part of the rest, the market leg takes the remainder.
    const vol: [number, number, number, number] = [0, 0, 0, 0];
    const netUnits = new Map<string, bigint>();
    for (const p of parts) {
      const k = edge(p.o.from, p.o.to);
      const total = flow.get(k)!;
      const fp = (pairsDone.get(k) ?? 0) / total;
      const fr = (ringsDone.get(k) ?? 0) / total;
      const rest = Math.max(0, 1 - fp - fr);
      p.f = [fp, fr, rest * EARN_SHARE, rest * (1 - EARN_SHARE)];
      const gross = convert(p.amt, prices[p.o.from], prices[p.o.to]);
      const feeRate = (fp + fr) * this.fees.inside + rest * this.fees.market;
      const fee = BigInt(Math.floor(Number(gross) * feeRate));
      const net = gross - fee;
      const u = this.s.users[p.pub];
      const o = p.o;
      o.remaining = (B(o.remaining) - p.amt).toString();
      o.filled = (B(o.filled) + p.amt).toString();
      o.got = (B(o.got) + net).toString();
      o.fees = (B(o.fees) + fee).toString();
      o.partsDone += 1;
      const via = ["pairs", "rings", "earn", "market"] as const;
      via.forEach((name, i) => {
        o.via[name] = (B(o.via[name]) + BigInt(Math.floor(Number(p.amt) * p.f[i]))).toString();
        vol[i] += p.v * p.f[i] * 1e6;
      });
      if (B(o.remaining) === 0n) o.status = "done";
      if (o.earnDays > 0) this.addLock(u, o.to, net, o.earnDays);
      else add(u.bal, o.to, net);
      this.hist(u, { kind: "fill", coin: o.to, amount: net.toString(), ts: now });
      // The house is the other side of everything the users did not cover between them.
      add(this.s.house, o.from, p.amt);
      add(this.s.house, o.to, -net);
      this.s.feesUsd += usd(fee, prices[o.to]);
      // What would go to the outside market: the earn and market share.
      const outside = rest;
      netUnits.set(o.to, (netUnits.get(o.to) ?? 0n) + BigInt(Math.floor(Number(gross) * outside)));
      netUnits.set(o.from, (netUnits.get(o.from) ?? 0n) - BigInt(Math.floor(Number(p.amt) * outside)));
      touched.add(p.pub);
    }
    for (const pub of this.payEarn(now)) touched.add(pub);

    const net = [...netUnits.entries()]
      .filter(([, a]) => a !== 0n)
      .sort((x, y) => usd(abs(y[1]), prices[y[0]]) - usd(abs(x[1]), prices[x[0]]))
      .slice(0, 16)
      .map(([coin, amount]) => ({ coin, amount }));
    const result: RoundOut = {
      id: this.s.round.id, openTs: this.s.round.openTs, closeTs: now, orders: orders.size, parts: parts.length,
      volume: vol.map(Math.round) as RoundOut["volume"], net,
    };
    this.s.rounds.unshift(result);
    this.s.rounds.length = Math.min(this.s.rounds.length, 50);
    for (const pub of touched) this.trimOrders(this.s.users[pub]);
    return { result, touched };
  }

  openRound(id: number, minS: number, spanS: number) {
    const now = this.now();
    this.s.round = { id, openTs: now, closeAt: now + (minS + randomInt(spanS + 1)) * 1000 };
  }

  /** How much of an order goes into this round. */
  private partSize(o: Order, now: number): bigint {
    const rem = B(o.remaining);
    if (o.parts === "drip") {
      const end = o.ts + DRIP_MS;
      if (now >= end) return rem;
      const avgRoundMs = (this.s.round.closeAt - this.s.round.openTs) || 330_000;
      const roundsLeft = Math.max(1, Math.floor((end - now) / avgRoundMs));
      return rem / BigInt(roundsLeft) || rem;
    }
    const left = o.parts - o.partsDone;
    return left <= 1 ? rem : B(o.amount) / BigInt(o.parts);
  }

  /** Shares new fees among lockers, unlocks expired locks, runs the weekly draw. */
  private payEarn(now: number): Set<string> {
    const touched = new Set<string>();
    const prices = this.prices();
    const fees = this.s.feesUsd;
    this.s.feesUsd = 0;
    const pot = fees * (1 - DRAW_SHARE);
    this.s.drawPotUsd += fees * DRAW_SHARE;
    const weights: { pub: string; l: Lock; w: number }[] = [];
    for (const [pub, u] of Object.entries(this.s.users)) {
      for (const l of u.locks) {
        if (l.until > now && prices[l.coin] > 0) weights.push({ pub, l, w: usd(B(l.amount), prices[l.coin]) * l.days });
      }
    }
    const total = weights.reduce((a, x) => a + x.w, 0);
    if (total > 0 && pot > 0) {
      for (const { pub, l, w } of weights) {
        const units = BigInt(Math.floor(((pot * w) / total / prices[l.coin]) * 1e6));
        if (units <= 0n) continue;
        l.earned = (B(l.earned) + units).toString();
        add(this.s.house, l.coin, -units);
        touched.add(pub);
      }
    }
    if (now - this.s.lastDrawTs >= DRAW_EVERY_MS && total > 0 && prices.USDC > 0) {
      let r = Math.random() * total;
      const win = weights.find((x) => (r -= x.w) <= 0) ?? weights[weights.length - 1];
      const units = BigInt(Math.floor((this.s.drawPotUsd / prices.USDC) * 1e6));
      const u = this.s.users[win.pub];
      add(u.bal, "USDC", units);
      add(this.s.house, "USDC", -units);
      this.hist(u, { kind: "draw", coin: "USDC", amount: units.toString(), ts: now });
      this.s.drawPotUsd = 0;
      this.s.lastDrawTs = now;
      touched.add(win.pub);
    }
    for (const [pub, u] of Object.entries(this.s.users)) {
      const done = u.locks.filter((l) => l.until <= now);
      if (!done.length) continue;
      for (const l of done) {
        add(u.bal, l.coin, B(l.amount) + B(l.earned));
        this.hist(u, { kind: "unlock", coin: l.coin, amount: (B(l.amount) + B(l.earned)).toString(), ts: now });
      }
      u.locks = u.locks.filter((l) => l.until > now);
      touched.add(pub);
    }
    return touched;
  }

  /** The document the user's browser decrypts. */
  doc(pub: string) {
    const u = this.user(pub);
    u.seq += 1;
    return { v: 1, seq: u.seq, bal: u.bal, orders: u.orders, locks: u.locks, history: u.history };
  }

  /** Public numbers for the earn tiles. */
  earnStats() {
    const prices = this.prices();
    let locked = 0;
    let lockers = 0;
    for (const u of Object.values(this.s.users)) {
      if (u.locks.length) lockers++;
      for (const l of u.locks) locked += usd(B(l.amount), prices[l.coin] ?? 0);
    }
    return { lockedUsd: locked, lockers, drawPotUsd: this.s.drawPotUsd, nextDrawTs: this.s.lastDrawTs + DRAW_EVERY_MS };
  }
}

const abs = (x: bigint) => (x < 0n ? -x : x);

/** Finds one directed cycle of 3 to 6 coins over edges with flow left. */
function findCycle(left: Map<string, number>): string[] | null {
  const out = new Map<string, string[]>();
  for (const [k, v] of left) {
    if (v <= 1e-9) continue;
    const [a, b] = k.split(">");
    (out.get(a) ?? out.set(a, []).get(a)!).push(b);
  }
  const path: string[] = [];
  const dfs = (start: string, at: string, depth: number): string[] | null => {
    for (const nx of out.get(at) ?? []) {
      if (nx === start && depth >= 3) return [...path, `${at}>${nx}`];
      if (depth >= 6 || path.some((e) => e.startsWith(`${nx}>`)) || nx === start) continue;
      path.push(`${at}>${nx}`);
      const r = dfs(start, nx, depth + 1);
      if (r) return r;
      path.pop();
    }
    return null;
  };
  for (const s of out.keys()) {
    path.length = 0;
    const c = dfs(s, s, 1);
    if (c) return c;
  }
  return null;
}

export class UserError extends Error {}
