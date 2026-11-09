use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    /// Bits of randomness for the close offset. 2^16 steps over the span.
    const CLOSE_RNG_BITS: usize = 16;

    /// Largest order amount (2^40). 16 orders of this size still fit in a u64 sum,
    /// and amount x price fits in a u128.
    const MAX_AMOUNT: u64 = 1_099_511_627_776;

    /// Orders per round.
    const BATCH: usize = 16;

    // Prices and fill ratios are Q32 fixed point: 2^32 is 1.0. The shifts below use the
    // literal 32. In Arcis 0.16, shifting a u128 by a named const, or a const declared
    // between two instructions, makes the compiler panic in a debug build
    // ("profile sizes out of order").

    /// Draws the hidden close offset of a round, in seconds after it opens.
    /// The offset is uniform in [min_s, min_s + span_s). Only the cluster can decrypt it.
    /// min_s and span_s are public: they are the published round limits.
    #[instruction]
    pub fn draw_close(min_s: u64, span_s: u64) -> Enc<Mxe, u64> {
        let r = ArcisRNG::gen_integer_from_width(CLOSE_RNG_BITS) as u64;
        let offset = min_s + ((r * span_s) >> CLOSE_RNG_BITS);
        Mxe::get().from_arcis(offset)
    }

    /// Compares the public time since open with the hidden close offset.
    /// Reveals one bit: true means "now", false means "not yet".
    #[instruction]
    pub fn tick(elapsed_s: u64, close: Enc<Mxe, u64>) -> bool {
        let close = close.to_arcis();
        (elapsed_s >= close).reveal()
    }

    #[derive(Copy, Clone)]
    pub struct Order {
        /// true: pay quote, get base. false: pay base, get quote.
        pub is_buy: bool,
        /// What the user pays in: quote units for a buy, base units for a sell.
        pub amount: u64,
    }

    /// Takes a sealed order from a user and re-encrypts it to the cluster only.
    /// The amount is clamped to MAX_AMOUNT, so a bad input cannot overflow the match.
    #[instruction]
    pub fn submit_order(order: Enc<Shared, Order>) -> Enc<Mxe, Order> {
        let o = order.to_arcis();
        Mxe::get().from_arcis(Order {
            is_buy: o.is_buy,
            amount: o.amount.min(MAX_AMOUNT),
        })
    }

    /// What goes to the market after the pair match. Only the executor can read it.
    #[derive(Copy, Clone)]
    pub struct MarketLeg {
        /// true: buy base with quote. false: sell base for quote.
        pub is_buy: bool,
        /// Quote units for a buy, base units for a sell.
        pub amount: u64,
    }

    /// Matches buys against sells of one pair at a public reference price.
    ///
    /// - `active[i]` is public: it says which slots hold a sealed order.
    /// - `price` is public: quote units per base unit, Q32 fixed point.
    /// - The smaller side fills in full. The larger side fills pro rata. The rest of the
    ///   larger side is the market leg, encrypted to the executor only.
    /// - The fill of each order (in the units it paid in) stays encrypted to the cluster.
    ///
    /// Nothing is revealed in public.
    #[instruction]
    pub fn match_pair(
        active: [bool; BATCH],
        price: u64,
        executor: Shared,
        orders: [Enc<Mxe, Order>; BATCH],
    ) -> (Enc<Mxe, Pack<[u64; BATCH]>>, Enc<Shared, MarketLeg>) {
        let mut is_buy = [false; BATCH];
        let mut amount = [0u64; BATCH];
        let mut buy_q: u64 = 0;
        let mut sell_b: u64 = 0;
        for i in 0..BATCH {
            let o = orders[i].to_arcis();
            is_buy[i] = o.is_buy;
            amount[i] = if active[i] { o.amount } else { 0 };
            if is_buy[i] {
                buy_q += amount[i];
            } else {
                sell_b += amount[i];
            }
        }
        // The sell side valued in quote units.
        let sell_q = ((sell_b as u128 * price as u128) >> 32) as u64;
        let matched_q = buy_q.min(sell_q);

        // Fill ratios in Q32, one secret division per side. A side with nothing gets 0.
        let buy_ratio = if buy_q > 0 {
            ((matched_q as u128) << 32) / (buy_q as u128)
        } else {
            0
        };
        let sell_ratio = if sell_q > 0 {
            ((matched_q as u128) << 32) / (sell_q as u128)
        } else {
            0
        };

        let mut fills = [0u64; BATCH];
        let mut filled_b: u64 = 0;
        let mut filled_q: u64 = 0;
        for i in 0..BATCH {
            let ratio = if is_buy[i] { buy_ratio } else { sell_ratio };
            fills[i] = ((amount[i] as u128 * ratio) >> 32) as u64;
            if is_buy[i] {
                filled_q += fills[i];
            } else {
                filled_b += fills[i];
            }
        }

        // Rounding goes down, so the rest is never negative.
        let leg_is_buy = buy_q > sell_q;
        let leg = MarketLeg {
            is_buy: leg_is_buy,
            amount: if leg_is_buy {
                buy_q - filled_q
            } else {
                sell_b - filled_b
            },
        };
        (
            Mxe::get().from_arcis(Pack::new(fills)),
            executor.from_arcis(leg),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::circuits::*;
    use arcis::{testing::*, *};

    #[test]
    fn draw_close_stays_in_range() {
        let draw = get_instruction("draw_close");
        let tick = get_instruction("tick");
        let (min_s, span_s) = (120u64, 1080u64);
        for _ in 0..200 {
            let close: Enc<Mxe, u64> = draw.eval(&(min_s, span_s));
            let offset = close.to_arcis();
            assert!(offset >= min_s && offset < min_s + span_s, "offset {offset}");
            // tick says "now" from the offset on, and "not yet" one second before.
            let now: bool = tick.eval(&(offset, close));
            let before: bool = tick.eval(&(offset - 1, Mxe::get().from_arcis(offset)));
            assert!(now && !before);
        }
    }

    #[test]
    fn submit_order_keeps_side_and_clamps_amount() {
        let submit = get_instruction("submit_order");
        const MAX_AMOUNT: u64 = 1 << 40;
        let user = ArcisX25519Pubkey::from_base58(b"user");
        for (is_buy, amount, want) in [
            (true, 0u64, 0u64),
            (false, 12_345, 12_345),
            (true, MAX_AMOUNT, MAX_AMOUNT),
            (false, u64::MAX, MAX_AMOUNT),
        ] {
            let sealed: Enc<Mxe, Order> = submit.eval(&Shared::new(user).from_arcis(Order { is_buy, amount }));
            let o = sealed.to_arcis();
            assert_eq!((o.is_buy, o.amount), (is_buy, want));
        }
    }

    const N: usize = 16;

    /// The match in plain Rust, written from the spec, not from the circuit.
    /// Returns the fill of each order and the market leg (is_buy, amount).
    fn model(active: [bool; N], orders: [(bool, u64); N], price: u64) -> ([u64; N], (bool, u64)) {
        let amt = |i: usize| if active[i] { orders[i].1 } else { 0 };
        let buy_q: u64 = (0..N).filter(|&i| orders[i].0).map(amt).sum();
        let sell_b: u64 = (0..N).filter(|&i| !orders[i].0).map(amt).sum();
        let sell_q = (sell_b as u128 * price as u128 / (1u128 << 32)) as u64;
        let matched_q = buy_q.min(sell_q);
        let ratio = |side_q: u64| {
            if side_q == 0 { 0 } else { (matched_q as u128 * (1u128 << 32)) / side_q as u128 }
        };
        let (buy_r, sell_r) = (ratio(buy_q), ratio(sell_q));
        let mut fills = [0u64; N];
        for i in 0..N {
            let r = if orders[i].0 { buy_r } else { sell_r };
            fills[i] = (amt(i) as u128 * r / (1u128 << 32)) as u64;
        }
        let filled_q: u64 = (0..N).filter(|&i| orders[i].0).map(|i| fills[i]).sum();
        let filled_b: u64 = (0..N).filter(|&i| !orders[i].0).map(|i| fills[i]).sum();
        let leg = if buy_q > sell_q { (true, buy_q - filled_q) } else { (false, sell_b - filled_b) };
        (fills, leg)
    }

    struct XorShift(u64);
    impl XorShift {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
    }

    fn run_match(
        ix: &ArcisInstructionWithInfo,
        active: [bool; N],
        orders: [(bool, u64); N],
        price: u64,
    ) -> ([u64; N], (bool, u64)) {
        let executor = ArcisX25519Pubkey::from_base58(b"executor");
        let sealed: [Enc<Mxe, Order>; N] = std::array::from_fn(|i| {
            Mxe::get().from_arcis(Order { is_buy: orders[i].0, amount: orders[i].1 })
        });
        let (fills, leg): (Enc<Mxe, Pack<[u64; N]>>, Enc<Shared, MarketLeg>) =
            ix.eval(&(active, price, Shared::new(executor), sealed));
        let leg = leg.to_arcis();
        (fills.to_arcis().unpack(), (leg.is_buy, leg.amount))
    }

    #[test]
    fn match_pair_agrees_with_model() {
        let ix = get_instruction("match_pair");
        let one = 1u64 << 32; // price 1.0
        let all = [true; N];
        let mut cases: Vec<([bool; N], [(bool, u64); N], u64)> = vec![
            // Empty batch.
            ([false; N], [(true, 0); N], one),
            // Only buys: nothing matches, everything goes to market.
            (all, [(true, 100); N], one),
            // Only sells.
            (all, [(false, 100); N], 3 * one),
            // Exact cross at price 2.0: 8 buys of 200 quote, 8 sells of 100 base.
            (all, std::array::from_fn(|i| if i < 8 { (true, 200) } else { (false, 100) }), 2 * one),
            // Data in inactive slots must be ignored.
            (
                std::array::from_fn(|i| i < 4),
                std::array::from_fn(|i| (i % 2 == 0, 1_000_000 + i as u64)),
                one + one / 2,
            ),
            // Largest amounts and a high price: no overflow.
            (all, std::array::from_fn(|i| (i % 2 == 0, 1u64 << 40)), u32::MAX as u64 * one),
        ];
        let mut rng = XorShift(0x9e3779b97f4a7c15);
        for _ in 0..12 {
            let active = std::array::from_fn(|_| rng.next() % 4 != 0);
            let orders = std::array::from_fn(|_| (rng.next() % 2 == 0, rng.next() % (1u64 << 40)));
            // Price between 0.001 and about 1000.
            let price = (one / 1000).max(rng.next() % (1000 * one));
            cases.push((active, orders, price));
        }
        for (k, (active, orders, price)) in cases.into_iter().enumerate() {
            let got = run_match(&ix, active, orders, price);
            let want = model(active, orders, price);
            assert_eq!(got, want, "case {k}");
            // The smaller side fills in full.
            let (fills, (leg_is_buy, _)) = got;
            for i in 0..N {
                if active[i] && orders[i].0 != leg_is_buy {
                    assert!(orders[i].1 - fills[i] <= 1, "case {k} order {i}");
                }
            }
        }
    }
}
