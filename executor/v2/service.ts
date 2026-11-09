// The devnet v2 executor: rounds, the ledger, balance documents on chain, and the relayer API.
// IT CAN READ EVERY ORDER AND BALANCE. DEVNET ONLY. See docs/devnet-v2.md.
//
//   RPC_URL=<rpc> EXECUTOR_KEYPAIR=<path> EXECUTOR_X25519=<path> STATE_FILE=<path> node executor-v2.js
import * as anchor from "@anchor-lang/core";
import * as fs from "fs";
import * as http from "http";
import { PublicKey } from "@solana/web3.js";
import { x25519 } from "@arcium-hq/client";
import coinList from "./coins.json";
import { DemoChain } from "./chain";
import { balanceTag, openNote, sealBalance, verifySig } from "./crypto";
import { Ledger, newState, Parts, State, UserError } from "./ledger";
import { SIGNER_PATH, X25519_PATH, loadExecutorKeys } from "../keys";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PORT = Number(process.env.PORT ?? 8095);
const STATE_FILE = process.env.STATE_FILE ?? "state-v2.json";
const MIN_CLOSE_S = Number(process.env.MIN_CLOSE_S ?? 60);
const SPAN_CLOSE_S = Number(process.env.SPAN_CLOSE_S ?? 540);
const TICK_MS = 2000;
const PRICE_EVERY_MS = 5 * 60_000;
const KEEP_ROUNDS = 50;
/** Lockers share the fees only when this is "1". Off by default: earn shows 0% APR for now. */
const PAY_LOCKERS = process.env.PAY_LOCKERS === "1";
const mask = (s: string) => s.replace(/api-key=[A-Za-z0-9_-]+/g, "api-key=***");
const log = (m: string) => console.log(`${new Date().toISOString()} ${mask(m)}`);

const COINS = coinList.map((c, index) => ({ index, t: c.t, id: c.id, listUsd: c.usd }));
const BY_T = new Map(COINS.map((c) => [c.t, c]));
const prices: Record<string, number> = Object.fromEntries(COINS.map((c) => [c.t, c.listUsd]));
let pricesTs = 0;

const b58 = anchor.utils.bytes.bs58;

// ---------- state ----------

function load(): State {
  if (!fs.existsSync(STATE_FILE)) return newState();
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}
function save(s: State) {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

/** One mutation at a time: API calls and round steps share the ledger. */
let chainLock: Promise<unknown> = Promise.resolve();
function serial<T>(f: () => Promise<T>): Promise<T> {
  const p = chainLock.then(f, f);
  chainLock = p.catch(() => {});
  return p;
}

async function main() {
  for (const f of [SIGNER_PATH, X25519_PATH]) if (!fs.existsSync(f)) throw new Error(`missing key file ${f}`);
  const { signer, x25519Secret } = loadExecutorKeys();
  const x25519Public = x25519.getPublicKey(x25519Secret);
  const provider = new anchor.AnchorProvider(new anchor.web3.Connection(RPC_URL, "confirmed"), new anchor.Wallet(signer), {
    commitment: "confirmed", preflightCommitment: "confirmed",
  });
  const chain = new DemoChain(provider);
  await chain.assertNotMainnet();
  const cfg = await chain.fetchConfig();
  if (!cfg.executor.equals(signer.publicKey)) throw new Error("this key is not the pnd_demo executor");
  if (Buffer.compare(Buffer.from(cfg.executorX25519), Buffer.from(x25519Public)) !== 0) throw new Error("x25519 key does not match the config");

  const ledger = new Ledger(load(), () => prices, undefined, undefined, PAY_LOCKERS);
  const s = ledger.s;
  const dirty = new Set<string>();
  s.pendingPosts ??= [];
  if (s.round.openTs === 0) {
    ledger.openRound(cfg.nextRound.toNumber(), MIN_CLOSE_S, SPAN_CLOSE_S);
    save(s);
  }
  log(`executor v2 ${signer.publicKey.toBase58()} on ${RPC_URL}, round ${s.round.id}`);

  async function flush() {
    for (const pub of [...dirty]) {
      dirty.delete(pub);
      const u = s.users[pub];
      if (!u?.box) continue;
      try {
        const doc = ledger.doc(pub);
        save(s);
        const data = sealBalance(x25519Secret, Buffer.from(u.box, "hex"), doc);
        await chain.writeBalance(balanceTag(b58.decode(pub)), doc.seq, data);
      } catch (e) {
        dirty.add(pub);
        log(`balance write failed for ${pub.slice(0, 6)}: ${String(e).split("\n")[0]}`);
      }
    }
  }

  async function creditDeposits() {
    const deps = await chain.pendingDeposits();
    for (const d of deps) {
      const id = d.account.id.toNumber();
      const coin = COINS[d.account.index];
      if (!s.creditedDeposits.includes(id)) {
        try {
          const note = openNote(x25519Secret, Uint8Array.from(d.account.note));
          const pub = b58.encode(note.sign);
          ledger.credit(pub, Buffer.from(note.box).toString("hex"), coin.t, BigInt(d.account.amount.toString()), d.publicKey.toBase58());
          dirty.add(pub);
          log(`deposit ${id}: ${coin.t} credited`);
        } catch {
          log(`deposit ${id}: note does not open; closing it with no credit`);
        }
        s.creditedDeposits.push(id);
        s.creditedDeposits = s.creditedDeposits.slice(-500);
        save(s);
      }
      await chain.credit(id, d.account.depositor);
    }
  }

  async function roundStep() {
    if (Date.now() >= s.round.closeAt) {
      // Close and open the next round in one save, then post. A failed post is retried.
      const { result, touched } = ledger.closeRound();
      touched.forEach((p) => dirty.add(p));
      s.pendingPosts!.push(result);
      ledger.openRound(result.id + 1, MIN_CLOSE_S, SPAN_CLOSE_S);
      save(s);
      log(`round ${result.id}: closed after ${Math.round((result.closeTs - result.openTs) / 1000)} s, ${result.parts} part(s)`);
      await flush();
    }
    while (s.pendingPosts!.length) {
      const r = s.pendingPosts![0];
      if (!(await chain.exists(chain.round(r.id)))) {
        await chain.postRound(r.id, { ...r, net: r.net.map((n) => ({ coin: BY_T.get(n.coin)!.index, amount: BigInt(n.amount) })) });
      }
      s.pendingPosts!.shift();
      save(s);
      const old = r.id - KEEP_ROUNDS;
      if (old >= 0 && (await chain.exists(chain.round(old)))) await chain.closeRound(old);
    }
  }

  async function refreshPrices() {
    if (Date.now() - pricesTs < PRICE_EVERY_MS) return;
    pricesTs = Date.now();
    try {
      const ids = COINS.map((c) => c.id).join(",");
      const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as Record<string, { usd?: number }>;
      let n = 0;
      for (const c of COINS) if (j[c.id]?.usd! > 0) { prices[c.t] = j[c.id].usd!; n++; }
      log(`prices: ${n} of ${COINS.length} from CoinGecko`);
    } catch (e) {
      log(`prices: kept the last ones (${String(e).split("\n")[0]})`);
    }
  }

  // ---------- relayer API ----------

  const seen = new Map<string, number>();
  function auth(body: any) {
    if (typeof body?.msg !== "string" || typeof body?.sig !== "string") throw new UserError("Send { msg, sig }");
    const m = JSON.parse(body.msg);
    const pub = b58.decode(String(m.pub));
    if (pub.length !== 32 || !/^[0-9a-f]{64}$/.test(String(m.box))) throw new UserError("Bad device key");
    if (!verifySig(pub, body.msg, Buffer.from(body.sig, "base64"))) throw new UserError("Bad signature");
    if (Math.abs(Date.now() - Number(m.ts)) > 60_000) throw new UserError("Request is too old. Check your clock");
    const key = `${m.pub}:${m.nonce}`;
    if (!m.nonce || seen.has(key)) throw new UserError("Request was already used");
    seen.set(key, Date.now());
    for (const [k, t] of seen) if (Date.now() - t > 120_000) seen.delete(k);
    ledger.user(m.pub, m.box);
    return m;
  }
  const coin = (t: unknown) => {
    const c = BY_T.get(String(t));
    if (!c) throw new UserError("Only listed coins on devnet");
    return c;
  };
  const amt = (a: unknown) => {
    if (!/^[0-9]{1,20}$/.test(String(a))) throw new UserError("Amount must be a whole number of base units");
    return BigInt(String(a));
  };

  const routes: Record<string, (b: any) => Promise<unknown>> = {
    "POST /v1/order": (b) => serial(async () => {
      const m = auth(b);
      const parts = (m.parts === "drip" ? "drip" : Number(m.parts)) as Parts;
      const o = ledger.order(m.pub, coin(m.from).t, coin(m.to).t, amt(m.amount), parts, Number(m.earnDays ?? 0));
      dirty.add(m.pub);
      save(s);
      return { id: o.id, round: s.round.id };
    }),
    "POST /v1/cancel": (b) => serial(async () => {
      const m = auth(b);
      ledger.cancel(m.pub, String(m.id));
      dirty.add(m.pub);
      save(s);
      return { ok: true };
    }),
    "POST /v1/lock": (b) => serial(async () => {
      const m = auth(b);
      ledger.lock(m.pub, coin(m.coin).t, amt(m.amount), Number(m.days));
      dirty.add(m.pub);
      save(s);
      return { ok: true };
    }),
    "POST /v1/withdraw": (b) => serial(async () => {
      const m = auth(b);
      let to: PublicKey;
      try { to = new PublicKey(String(m.to)); } catch { throw new UserError("Bad address"); }
      const c = coin(m.coin);
      const amount = amt(m.amount);
      const paid = ledger.withdraw(m.pub, c.t, amount, m.payCoin ? coin(m.payCoin).t : undefined);
      save(s);
      let tx: string;
      try {
        tx = await chain.payout(BY_T.get(paid.coin)!.index, paid.amount, to);
      } catch (e) {
        ledger.refundWithdraw(m.pub, c.t, amount, paid);
        save(s);
        log(`payout failed: ${String(e).split("\n")[0]}`);
        throw new UserError("The payout failed. Your balance is back. Try again");
      }
      ledger.logWithdraw(m.pub, paid.coin, paid.amount, to.toBase58(), tx);
      dirty.add(m.pub);
      save(s);
      log(`withdraw: ${paid.coin} paid out`);
      return { tx, coin: paid.coin, amount: paid.amount.toString() };
    }),
    "GET /v1/info": async () => ({
      programId: chain.id.toBase58(),
      executor: signer.publicKey.toBase58(),
      executorX25519: Buffer.from(x25519Public).toString("hex"),
      fees: { insideBps: cfg.feeInsideBps, marketBps: cfg.feeMarketBps },
      closeWindowS: [MIN_CLOSE_S, MIN_CLOSE_S + SPAN_CLOSE_S],
      round: {
        id: s.round.id, openTs: s.round.openTs,
        parts: Object.values(s.users).reduce((a, u) => a + u.orders.filter((o) => o.status === "open").length, 0),
      },
      coins: COINS.map((c) => ({ index: c.index, t: c.t, mint: chain.mint(c.index).toBase58(), usd: prices[c.t] })),
      pricesTs,
      earn: { ...ledger.earnStats(), aprPct: PAY_LOCKERS ? null : 0 },
    }),
    "GET /v1/rounds": async () => s.rounds.map((r) => ({ ...r, net: r.net.map((n) => ({ coin: n.coin, amount: n.amount.toString() })) })),
  };

  http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const route = routes[`${req.method} ${path}`];
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (!route) return send(404, { error: "Not found" });
    let raw = "";
    req.on("data", (d) => { raw += d; if (raw.length > 16_384) req.destroy(); });
    req.on("end", async () => {
      try {
        send(200, await route(raw ? JSON.parse(raw) : {}));
      } catch (e) {
        if (e instanceof UserError || e instanceof SyntaxError) send(400, { error: e.message });
        else { log(`api error: ${String(e).split("\n")[0]}`); send(500, { error: "Server error. Try again" }); }
      }
    });
  }).listen(PORT, "127.0.0.1", () => log(`api on 127.0.0.1:${PORT}`));

  for (;;) {
    try {
      await refreshPrices();
      await serial(async () => {
        await creditDeposits();
        await roundStep();
        await flush();
      });
    } catch (e) {
      log(`step failed: ${String(e).split("\n")[0]}`);
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

main().catch((e) => {
  console.error(mask(String(e)));
  process.exit(1);
});
