//! Accounts, events and errors shared by pnd_spike (Arcium) and pnd_mock (devnet demo).
//! Both programs include this file, so clients read the same layouts in both modes.
use anchor_lang::prelude::*;

/// Orders per round. Fixed, because the match circuit has a fixed shape.
pub const BATCH_SIZE: usize = 16;
/// Two ciphertexts per order: is_buy and amount.
pub const ORDER_CT_LEN: usize = 64;
/// 16 packed u64 fills take 6 field elements.
pub const FILLS_CT_COUNT: usize = 6;

pub const CONFIG_SEED: &[u8] = b"config";
pub const ROUND_SEED: &[u8] = b"round";

#[repr(u8)]
pub enum RoundState {
    Drawing = 0,
    Open = 1,
    Closed = 2,
    Matching = 3,
    Matched = 4,
}

#[repr(u8)]
pub enum SlotState {
    Empty = 0,
    /// Queued. The sealed order has not come back yet.
    Pending = 1,
    /// The cluster holds the order. It goes into the match.
    Sealed = 2,
    /// The order came back after the round closed. It is not in the match.
    Late = 3,
    Refunded = 4,
}

#[zero_copy]
pub struct Slot {
    pub owner: Pubkey,
    /// pnd_spike: the computation account of the submit. The callback finds its slot with it.
    /// pnd_mock: the user's x25519 public key, so the executor can open the order.
    pub computation: Pubkey,
    /// u128, little endian. Bytes, so the struct has no alignment padding.
    pub nonce: [u8; 16],
    pub queued_slot: u64,
    pub bond_lamports: u64,
    pub state: u8,
    pub _pad: [u8; 7],
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub keeper: Pubkey,
    pub min_close_s: u64,
    pub span_close_s: u64,
    /// Lamports a user locks per order. Returned on refund.
    pub bond_lamports: u64,
    /// A pending order can be refunded this many slots after it was queued.
    /// A match can be sent again after this many slots.
    pub refund_after_slots: u64,
    /// The market leg of each match is encrypted to this key.
    pub executor_x25519: [u8; 32],
    pub next_round: u64,
    pub bump: u8,
}

/// Zero-copy: at about 2.8 KB, a Borsh copy of this account overflows the 4 KB BPF stack.
#[account(zero_copy)]
pub struct Round {
    // The ciphertexts come first so their byte offsets are fixed. Circuits read them in place.
    pub close_ct: [u8; 32],
    pub order_ct: [[u8; ORDER_CT_LEN]; BATCH_SIZE],
    pub slots: [Slot; BATCH_SIZE],
    /// u128, little endian.
    pub close_nonce: [u8; 16],
    /// The fill of each order, packed, encrypted to the cluster. Settlement reads it later.
    pub fills_ct: [[u8; 32]; FILLS_CT_COUNT],
    pub fills_nonce: [u8; 16],
    /// The market leg, encrypted to the executor.
    pub leg_ct: [[u8; 32]; 2],
    pub leg_nonce: [u8; 16],
    pub match_queued_slot: u64,
    pub id: u64,
    pub min_close_s: u64,
    pub span_close_s: u64,
    pub open_ts: i64,
    pub close_ts: i64,
    pub ticks: u32,
    pub state: u8,
    pub bump: u8,
    pub order_count: u8,
    pub _pad: [u8; 1],
}

impl Round {
    pub const SPACE: usize = 8 + std::mem::size_of::<Round>();
    /// 8 bytes of Anchor discriminator, then close_ct.
    pub const CLOSE_CT_OFFSET: u32 = 8;
    pub const ORDER_CT_OFFSET: u32 = Self::CLOSE_CT_OFFSET + 32;

    pub fn order_ct_offset(i: usize) -> u32 {
        Self::ORDER_CT_OFFSET + (i * ORDER_CT_LEN) as u32
    }
}

#[event]
pub struct RoundOpened {
    pub round: u64,
    pub open_ts: i64,
}

#[event]
pub struct TickQueued {
    pub round: u64,
    pub elapsed_s: u64,
}

#[event]
pub struct TickResult {
    pub round: u64,
    pub closed: bool,
}

#[event]
pub struct OrderQueued {
    pub round: u64,
    pub slot: u8,
}

#[event]
pub struct OrderSealed {
    pub round: u64,
    pub slot: u8,
    pub in_batch: bool,
}

#[event]
pub struct OrderRefunded {
    pub round: u64,
    pub slot: u8,
    pub timed_out: bool,
}

#[event]
pub struct RoundMatched {
    pub round: u64,
    pub leg_nonce: [u8; 16],
    pub leg_ct: [[u8; 32]; 2],
}

#[error_code]
pub enum SpikeError {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Round limits are not valid")]
    BadRoundLimits,
    #[msg("The previous round account is missing or wrong")]
    PrevRoundMissing,
    #[msg("The previous round is still open")]
    PrevRoundOpen,
    #[msg("The round is not in the right state")]
    WrongRoundState,
    #[msg("Only the keeper can do this")]
    NotKeeper,
    #[msg("The batch is full")]
    BatchFull,
    #[msg("No slot for this order")]
    SlotNotFound,
    #[msg("Only the owner of the order can do this")]
    NotOwner,
    #[msg("This order cannot be refunded now")]
    NotRefundable,
    #[msg("Some bonds in this round are not returned yet")]
    BondsLeft,
}
