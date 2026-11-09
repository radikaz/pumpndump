import { expect } from "chai";
import { Ledger, MAX_WAITS, newState, UserError } from "../executor/v2/ledger";

const M = 1_000_000n;
const prices = { USDC: 1, SOL: 100, BONK: 0.00002, JUP: 0.5 };

function setup() {
  let t = 1_000_000;
  const l = new Ledger(newState(), () => prices, undefined, () => t);
  l.openRound(0, 60, 0);
  return { l, tick: (ms: number) => (t += ms) };
}

describe("devnet v2 ledger", () => {
  it("matches a pair inside and charges 0.2%", () => {
    const { l } = setup();
    l.credit("a", "", "SOL", 10n * M);
    l.credit("b", "", "USDC", 1000n * M);
    l.order("a", "SOL", "USDC", 1n * M, 1, 0);
    l.order("b", "USDC", "SOL", 100n * M, 1, 0);
    const { result } = l.closeRound();
    expect(result.volume[0]).to.be.closeTo(200e6, 1);
    expect(result.volume[3]).to.equal(0);
    expect(l.s.users.a.bal.USDC).to.equal((100n * M - (100n * M * 2n) / 1000n).toString());
    expect(l.s.users.a.orders[0].status).to.equal("done");
    expect(result.net).to.deep.equal([]);
  });

  it("finds a ring of three coins", () => {
    const { l } = setup();
    l.credit("a", "", "SOL", 1n * M);
    l.credit("b", "", "USDC", 100n * M);
    l.credit("c", "", "JUP", 200n * M);
    l.order("a", "SOL", "USDC", 1n * M, 1, 0);
    l.order("b", "USDC", "JUP", 100n * M, 1, 0);
    l.order("c", "JUP", "SOL", 200n * M, 1, 0);
    const { result } = l.closeRound();
    expect(result.volume[1]).to.be.closeTo(300e6, 10);
    expect(result.volume[2] + result.volume[3]).to.be.below(10);
  });

  it("sends the rest to earn and market, splits over rounds, and locks for earn", () => {
    const { l, tick } = setup();
    l.credit("a", "", "SOL", 3n * M);
    const o = l.order("a", "SOL", "BONK", 3n * M, 3, 7);
    const r = l.closeRound().result;
    expect(r.volume[2]).to.be.closeTo(50e6, 1);
    expect(r.volume[3]).to.be.closeTo(50e6, 1);
    expect(r.net.map((n) => n.coin).sort()).to.deep.equal(["BONK", "SOL"]);
    expect(o.partsDone).to.equal(1);
    expect(l.s.users.a.locks.length).to.equal(1);
    tick(1000);
    l.closeRound();
    l.closeRound();
    expect(o.status).to.equal("done");
    expect(o.remaining).to.equal("0");
    // Fees from the fills went to the one locker.
    expect(BigInt(l.s.users.a.locks[0].earned) > 0n).to.equal(true);
    tick(8 * 86400_000);
    l.closeRound();
    expect(l.s.users.a.locks.length).to.equal(0);
    expect(BigInt(l.s.users.a.bal.BONK) > 0n).to.equal(true);
  });

  it("cancels, rejects overdrafts, and converts on withdraw", () => {
    const { l } = setup();
    l.credit("a", "", "SOL", 2n * M);
    const o = l.order("a", "SOL", "USDC", 2n * M, 12, 0);
    l.closeRound();
    l.cancel("a", o.id);
    expect(BigInt(l.s.users.a.bal.SOL)).to.equal(2n * M - 2n * M / 12n);
    expect(() => l.order("a", "SOL", "USDC", 5n * M, 1, 0)).to.throw(UserError);
    const paid = l.withdraw("a", "SOL", 1n * M, "USDC");
    expect(paid.coin).to.equal("USDC");
    expect(paid.amount).to.equal(100n * M - (100n * M * 6n) / 1000n);
  });

  it("waits below min out, fills when the price is back, and returns after too many waits", () => {
    const px = { ...prices };
    const l = new Ledger(newState(), () => px);
    l.openRound(0, 60, 0);
    l.credit("a", "", "SOL", 2n * M);
    const o = l.order("a", "SOL", "USDC", 1n * M, 1, 0, 100);
    px.SOL = 98.5; // 1.5% worse than the quote: below 1% min out
    l.closeRound();
    expect([o.wait, o.status, o.remaining]).to.deep.equal([true, "open", (1n * M).toString()]);
    px.SOL = 99.5; // 0.5% worse: inside min out
    l.closeRound();
    expect([o.wait, o.status]).to.deep.equal([false, "done"]);
    const o2 = l.order("a", "SOL", "USDC", 1n * M, 1, 0, 500);
    px.SOL = 50;
    for (let i = 0; i < MAX_WAITS; i++) l.closeRound();
    expect(o2.status).to.equal("returned");
    expect(l.s.users.a.bal.SOL).to.equal((1n * M).toString());
    expect(() => l.order("a", "SOL", "USDC", 1n * M, 1, 0, 50)).to.throw(UserError);
  });
});
