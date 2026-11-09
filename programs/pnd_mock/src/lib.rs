//! pnd_mock: the devnet demo of pnd_spike, with Arcium replaced by one executor key.
//!
//! ORDERS ARE NOT PRIVATE IN THIS PROGRAM. Users encrypt orders to the executor's x25519 key,
//! and the executor can read them. Use it to demo the flow while no Arcium devnet cluster can
//! run our MXE. Never deploy it to mainnet.
//!
//! It keeps the accounts, user instructions and events of pnd_spike. What a circuit and its
//! callback do in pnd_spike, the executor does here with one signed instruction:
//!
//! | pnd_spike                         | pnd_mock                      |
//! |-----------------------------------|-------------------------------|
//! | open_round + draw_close callback  | open_round (executor)         |
//! | tick + tick callback              | close_round (executor)        |
//! | submit_order callback             | seal_order (executor)         |
//! | match_round + match_pair callback | settle_match (executor)       |
use anchor_lang::prelude::*;

// state.rs is a symlink to pnd_spike's, so both programs share one layout.
mod state;
pub use state::*;

declare_id!("24GtYmstfSQN6xkpJREt3YQpQHeePr7xDRSMy2uo9mw8");

#[program]
pub mod pnd_mock {
    use super::*;

    /// The keeper key is the executor: it signs every step that a circuit does in pnd_spike.
    pub fn init_config(
        ctx: Context<InitConfig>,
        keeper: Pubkey,
        min_close_s: u64,
        span_close_s: u64,
        bond_lamports: u64,
        refund_after_slots: u64,
        executor_x25519: [u8; 32],
    ) -> Result<()> {
        require!(span_close_s > 0 && span_close_s < (1 << 32), SpikeError::BadRoundLimits);
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.payer.key();
        config.keeper = keeper;
        config.min_close_s = min_close_s;
        config.span_close_s = span_close_s;
        config.bond_lamports = bond_lamports;
        config.refund_after_slots = refund_after_slots;
        config.executor_x25519 = executor_x25519;
        config.next_round = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_round_limits(
        ctx: Context<SetRoundLimits>,
        min_close_s: u64,
        span_close_s: u64,
    ) -> Result<()> {
        require!(span_close_s > 0 && span_close_s < (1 << 32), SpikeError::BadRoundLimits);
        let config = &mut ctx.accounts.config;
        config.min_close_s = min_close_s;
        config.span_close_s = span_close_s;
        Ok(())
    }

    /// Opens the next round. The executor draws the close time off chain and stores it here
    /// encrypted to its own key, so it survives a restart.
    pub fn open_round(ctx: Context<OpenRound>, close_ct: [u8; 32], close_nonce: u128) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require_keys_eq!(ctx.accounts.executor.key(), config.keeper, SpikeError::NotKeeper);
        if config.next_round > 0 {
            let prev = ctx
                .accounts
                .prev_round
                .as_ref()
                .ok_or(SpikeError::PrevRoundMissing)?
                .load()?;
            require!(prev.id + 1 == config.next_round, SpikeError::PrevRoundMissing);
            require!(prev.state >= RoundState::Closed as u8, SpikeError::PrevRoundOpen);
        }
        let open_ts = Clock::get()?.unix_timestamp;
        {
            let mut round = ctx.accounts.round.load_init()?;
            round.id = config.next_round;
            round.bump = ctx.bumps.round;
            round.min_close_s = config.min_close_s;
            round.span_close_s = config.span_close_s;
            round.close_ct = close_ct;
            round.close_nonce = close_nonce.to_le_bytes();
            round.open_ts = open_ts;
            round.state = RoundState::Open as u8;
        }
        emit!(RoundOpened {
            round: config.next_round,
            open_ts,
        });
        config.next_round += 1;
        Ok(())
    }

    /// The executor closes the round when its hidden time has passed.
    pub fn close_round(ctx: Context<ExecutorRound>) -> Result<()> {
        let mut round = ctx.accounts.round.load_mut()?;
        require!(round.state == RoundState::Open as u8, SpikeError::WrongRoundState);
        round.state = RoundState::Closed as u8;
        round.close_ts = Clock::get()?.unix_timestamp;
        round.ticks += 1;
        emit!(TickResult {
            round: round.id,
            closed: true,
        });
        Ok(())
    }

    /// A user sends an order encrypted to the executor key and locks a bond.
    /// Same arguments as pnd_spike, without the Arcium computation offset.
    pub fn submit_order(
        ctx: Context<SubmitOrder>,
        is_buy_ct: [u8; 32],
        amount_ct: [u8; 32],
        pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let bond = ctx.accounts.config.bond_lamports;
        let (round_id, i) = {
            let mut round = ctx.accounts.round.load_mut()?;
            require!(round.state == RoundState::Open as u8, SpikeError::WrongRoundState);
            let i = round.order_count as usize;
            require!(i < BATCH_SIZE, SpikeError::BatchFull);
            round.order_count += 1;
            // Until the executor seals it, the slot holds the user's ciphertext and key.
            round.order_ct[i][..32].copy_from_slice(&is_buy_ct);
            round.order_ct[i][32..].copy_from_slice(&amount_ct);
            round.slots[i] = Slot {
                owner: ctx.accounts.payer.key(),
                computation: Pubkey::new_from_array(pubkey),
                nonce: nonce.to_le_bytes(),
                queued_slot: Clock::get()?.slot,
                bond_lamports: bond,
                state: SlotState::Pending as u8,
                _pad: [0; 7],
            };
            (round.id, i)
        };
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.round.to_account_info(),
                },
            ),
            bond,
        )?;
        emit!(OrderQueued {
            round: round_id,
            slot: i as u8,
        });
        Ok(())
    }

    /// The executor re-encrypts a pending order to its own key, as the cluster would.
    /// The amount is clamped off chain, as in the circuit.
    pub fn seal_order(
        ctx: Context<ExecutorRound>,
        slot: u8,
        order_ct: [[u8; 32]; 2],
        nonce: u128,
    ) -> Result<()> {
        let mut round = ctx.accounts.round.load_mut()?;
        let i = slot as usize;
        require!(i < round.order_count as usize, SpikeError::SlotNotFound);
        if round.slots[i].state != SlotState::Pending as u8 {
            return Ok(());
        }
        let in_batch = round.state == RoundState::Open as u8;
        if in_batch {
            round.order_ct[i][..32].copy_from_slice(&order_ct[0]);
            round.order_ct[i][32..].copy_from_slice(&order_ct[1]);
            round.slots[i].nonce = nonce.to_le_bytes();
            round.slots[i].state = SlotState::Sealed as u8;
        } else {
            round.slots[i].state = SlotState::Late as u8;
        }
        emit!(OrderSealed {
            round: round.id,
            slot,
            in_batch,
        });
        Ok(())
    }

    /// The executor writes the match result: fills encrypted to itself, and the market leg.
    pub fn settle_match(
        ctx: Context<ExecutorRound>,
        fills_ct: [[u8; 32]; FILLS_CT_COUNT],
        fills_nonce: u128,
        leg_ct: [[u8; 32]; 2],
        leg_nonce: u128,
    ) -> Result<()> {
        let mut round = ctx.accounts.round.load_mut()?;
        require!(round.state == RoundState::Closed as u8, SpikeError::WrongRoundState);
        round.fills_ct = fills_ct;
        round.fills_nonce = fills_nonce.to_le_bytes();
        round.leg_ct = leg_ct;
        round.leg_nonce = leg_nonce.to_le_bytes();
        round.state = RoundState::Matched as u8;
        emit!(RoundMatched {
            round: round.id,
            leg_nonce: leg_nonce.to_le_bytes(),
            leg_ct,
        });
        Ok(())
    }

    /// Same rules as pnd_spike: late orders, orders that were never sealed in time, and
    /// sealed orders after the match get the bond back. Anyone can send it.
    pub fn refund(ctx: Context<Refund>, slot: u8) -> Result<()> {
        let refund_after = ctx.accounts.config.refund_after_slots;
        let now_slot = Clock::get()?.slot;
        let (round_id, bond, timed_out) = {
            let mut round = ctx.accounts.round.load_mut()?;
            let (round_id, round_state) = (round.id, round.state);
            let s = round
                .slots
                .get_mut(slot as usize)
                .ok_or(SpikeError::SlotNotFound)?;
            require_keys_eq!(s.owner, ctx.accounts.owner.key(), SpikeError::NotOwner);
            let timed_out = s.state == SlotState::Pending as u8
                && now_slot > s.queued_slot.saturating_add(refund_after);
            let matched =
                s.state == SlotState::Sealed as u8 && round_state == RoundState::Matched as u8;
            require!(
                timed_out || matched || s.state == SlotState::Late as u8,
                SpikeError::NotRefundable
            );
            s.state = SlotState::Refunded as u8;
            (round_id, s.bond_lamports, timed_out)
        };
        ctx.accounts.round.sub_lamports(bond)?;
        ctx.accounts.owner.add_lamports(bond)?;
        emit!(OrderRefunded {
            round: round_id,
            slot,
            timed_out,
        });
        Ok(())
    }

    /// Closes an old round and returns its rent to the executor. Only a matched round with no
    /// bond left in it, and never the latest round: the next open_round reads the latest one.
    pub fn close_round_account(ctx: Context<CloseRoundAccount>) -> Result<()> {
        let round = ctx.accounts.round.load()?;
        require!(round.state == RoundState::Matched as u8, SpikeError::WrongRoundState);
        require!(round.id + 1 < ctx.accounts.config.next_round, SpikeError::WrongRoundState);
        require!(
            round.slots.iter().all(|s| s.state == SlotState::Empty as u8
                || s.state == SlotState::Refunded as u8),
            SpikeError::BondsLeft
        );
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRoundLimits<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct OpenRound<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub prev_round: Option<AccountLoader<'info, Round>>,
    #[account(
        init,
        payer = executor,
        space = Round::SPACE,
        seeds = [ROUND_SEED, &config.next_round.to_le_bytes()],
        bump,
    )]
    pub round: AccountLoader<'info, Round>,
    pub system_program: Program<'info, System>,
}

/// Executor-only steps on one round.
#[derive(Accounts)]
pub struct ExecutorRound<'info> {
    pub executor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.keeper == executor.key() @ SpikeError::NotKeeper)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub round: AccountLoader<'info, Round>,
}

#[derive(Accounts)]
pub struct CloseRoundAccount<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.keeper == executor.key() @ SpikeError::NotKeeper)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, close = executor)]
    pub round: AccountLoader<'info, Round>,
}

#[derive(Accounts)]
pub struct SubmitOrder<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub round: AccountLoader<'info, Round>,
    pub system_program: Program<'info, System>,
}

/// Anyone can send a refund. The bond always goes to the owner of the slot.
#[derive(Accounts)]
pub struct Refund<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub owner: SystemAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub round: AccountLoader<'info, Round>,
}
