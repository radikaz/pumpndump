use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

const COMP_DEF_OFFSET_DRAW_CLOSE: u32 = comp_def_offset("draw_close");
const COMP_DEF_OFFSET_TICK: u32 = comp_def_offset("tick");
const COMP_DEF_OFFSET_SUBMIT_ORDER: u32 = comp_def_offset("submit_order");
const COMP_DEF_OFFSET_MATCH_PAIR: u32 = comp_def_offset("match_pair");

mod state;
pub use state::*;

declare_id!("8ZoAUA3iVcLxGHstnHz295DmfAtGE9PVZeHFueHP6NFR");

#[arcium_program]
pub mod pnd_spike {
    use super::*;

    pub fn init_draw_close_comp_def(ctx: Context<InitDrawCloseCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    pub fn init_tick_comp_def(ctx: Context<InitTickCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    pub fn init_submit_order_comp_def(ctx: Context<InitSubmitOrderCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    pub fn init_match_pair_comp_def(ctx: Context<InitMatchPairCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    /// One config for the spike. The round limits are public.
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

    /// Sets the public limits for rounds that open after this. An open round keeps its limits.
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

    /// Opens the next round and queues the hidden close draw.
    /// Rounds do not overlap: the previous round must be closed first.
    pub fn open_round(ctx: Context<OpenRound>, computation_offset: u64) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if config.next_round > 0 {
            // Round ids are PDA seeds, so only one account can have this id.
            let prev = ctx
                .accounts
                .prev_round
                .as_ref()
                .ok_or(SpikeError::PrevRoundMissing)?
                .load()?;
            require!(prev.id + 1 == config.next_round, SpikeError::PrevRoundMissing);
            require!(prev.state >= RoundState::Closed as u8, SpikeError::PrevRoundOpen);
        }

        {
            let mut round = ctx.accounts.round.load_init()?;
            round.id = config.next_round;
            round.bump = ctx.bumps.round;
            round.state = RoundState::Drawing as u8;
            round.min_close_s = config.min_close_s;
            round.span_close_s = config.span_close_s;
        }
        config.next_round += 1;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let args = ArgBuilder::new()
            .plaintext_u64(config.min_close_s)
            .plaintext_u64(config.span_close_s)
            .build();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![DrawCloseCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.round.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "draw_close")]
    pub fn draw_close_callback(
        ctx: Context<DrawCloseCallback>,
        output: SignedComputationOutputs<DrawCloseOutput>,
    ) -> Result<()> {
        let close = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(DrawCloseOutput { field_0 }) => field_0,
            Err(_) => return Err(SpikeError::AbortedComputation.into()),
        };
        let mut round = ctx.accounts.round.load_mut()?;
        require!(round.state == RoundState::Drawing as u8, SpikeError::WrongRoundState);
        round.close_nonce = close.nonce.to_le_bytes();
        round.close_ct = close.ciphertexts[0];
        // The round starts when the hidden time exists, not when it was asked for.
        round.open_ts = Clock::get()?.unix_timestamp;
        round.state = RoundState::Open as u8;
        emit!(RoundOpened {
            round: round.id,
            open_ts: round.open_ts,
        });
        Ok(())
    }

    /// The keeper asks "is it time?". Only the answer is public.
    pub fn tick(ctx: Context<Tick>, computation_offset: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.payer.key(),
            ctx.accounts.config.keeper,
            SpikeError::NotKeeper
        );
        let round_key = ctx.accounts.round.key();
        let (round_id, close_nonce, elapsed) = {
            let mut round = ctx.accounts.round.load_mut()?;
            require!(round.state == RoundState::Open as u8, SpikeError::WrongRoundState);
            let now = Clock::get()?.unix_timestamp;
            round.ticks += 1;
            let elapsed = now.saturating_sub(round.open_ts).max(0) as u64;
            (round.id, u128::from_le_bytes(round.close_nonce), elapsed)
        };

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let args = ArgBuilder::new()
            .plaintext_u64(elapsed)
            .plaintext_u128(close_nonce)
            .account(round_key, Round::CLOSE_CT_OFFSET, 32)
            .build();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![TickCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: round_key,
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        emit!(TickQueued {
            round: round_id,
            elapsed_s: elapsed,
        });
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "tick")]
    pub fn tick_callback(
        ctx: Context<TickCallback>,
        output: SignedComputationOutputs<TickOutput>,
    ) -> Result<()> {
        let now_is_close = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(TickOutput { field_0 }) => field_0,
            Err(_) => return Err(SpikeError::AbortedComputation.into()),
        };
        let mut round = ctx.accounts.round.load_mut()?;
        // Several ticks can be in flight. The first "now" closes the round; later ones do nothing.
        if now_is_close && round.state == RoundState::Open as u8 {
            round.state = RoundState::Closed as u8;
            round.close_ts = Clock::get()?.unix_timestamp;
        }
        emit!(TickResult {
            round: round.id,
            closed: now_is_close,
        });
        Ok(())
    }

    /// A user sends a sealed order (encrypted to the cluster and to the user) and locks a bond.
    /// The circuit re-encrypts it to the cluster only and writes it to the next free slot.
    pub fn submit_order(
        ctx: Context<SubmitOrder>,
        computation_offset: u64,
        is_buy_ct: [u8; 32],
        amount_ct: [u8; 32],
        pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let bond = ctx.accounts.config.bond_lamports;
        let round_key = ctx.accounts.round.key();
        let (round_id, i) = {
            let mut round = ctx.accounts.round.load_mut()?;
            require!(round.state == RoundState::Open as u8, SpikeError::WrongRoundState);
            let i = round.order_count as usize;
            require!(i < BATCH_SIZE, SpikeError::BatchFull);
            round.order_count += 1;
            round.slots[i] = Slot {
                owner: ctx.accounts.payer.key(),
                computation: ctx.accounts.computation_account.key(),
                nonce: [0; 16],
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

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let args = ArgBuilder::new()
            .x25519_pubkey(pubkey)
            .plaintext_u128(nonce)
            .encrypted_bool(is_buy_ct)
            .encrypted_u64(amount_ct)
            .build();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![SubmitOrderCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: round_key,
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        emit!(OrderQueued {
            round: round_id,
            slot: i as u8,
        });
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "submit_order")]
    pub fn submit_order_callback(
        ctx: Context<SubmitOrderCallback>,
        output: SignedComputationOutputs<SubmitOrderOutput>,
    ) -> Result<()> {
        let sealed = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(SubmitOrderOutput { field_0 }) => field_0,
            // State changes would roll back with the error. The refund path covers this case.
            Err(_) => return Err(SpikeError::AbortedComputation.into()),
        };
        let computation = ctx.accounts.computation_account.key();
        let mut round = ctx.accounts.round.load_mut()?;
        let Some(i) = round
            .slots
            .iter()
            .position(|s| s.computation == computation)
        else {
            return err!(SpikeError::SlotNotFound);
        };
        // A refund can come first if the callback was very late. Then do nothing.
        if round.slots[i].state != SlotState::Pending as u8 {
            return Ok(());
        }
        if round.state == RoundState::Open as u8 {
            round.order_ct[i][..32].copy_from_slice(&sealed.ciphertexts[0]);
            round.order_ct[i][32..].copy_from_slice(&sealed.ciphertexts[1]);
            round.slots[i].nonce = sealed.nonce.to_le_bytes();
            round.slots[i].state = SlotState::Sealed as u8;
        } else {
            round.slots[i].state = SlotState::Late as u8;
        }
        emit!(OrderSealed {
            round: round.id,
            slot: i as u8,
            in_batch: round.slots[i].state == SlotState::Sealed as u8,
        });
        Ok(())
    }

    /// Returns the bond to the slot owner. Anyone can send it, so a keeper can return all
    /// bonds after the match. Allowed when the order came back late, when it never came back
    /// (abort or expiry) within refund_after_slots, or after the match.
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
            // In the spike the bond only stands for the order. It comes back after the match.
            let matched = s.state == SlotState::Sealed as u8 && round_state == RoundState::Matched as u8;
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

    /// Matches the sealed orders of a closed round at a public reference price (Q32).
    /// The keeper can send it again if the first match did not come back in time.
    pub fn match_round(
        ctx: Context<MatchRound>,
        computation_offset: u64,
        price: u64,
        executor_nonce: u128,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.payer.key(),
            ctx.accounts.config.keeper,
            SpikeError::NotKeeper
        );
        let refund_after = ctx.accounts.config.refund_after_slots;
        let executor = ctx.accounts.config.executor_x25519;
        let now_slot = Clock::get()?.slot;
        let round_key = ctx.accounts.round.key();

        let mut args = ArgBuilder::new();
        {
            let mut round = ctx.accounts.round.load_mut()?;
            let retry = round.state == RoundState::Matching as u8
                && now_slot > round.match_queued_slot.saturating_add(refund_after);
            require!(
                round.state == RoundState::Closed as u8 || retry,
                SpikeError::WrongRoundState
            );
            round.state = RoundState::Matching as u8;
            round.match_queued_slot = now_slot;
            // Which slots hold a sealed order is public anyway: the slot states are on chain.
            for s in round.slots.iter() {
                args = args.plaintext_bool(s.state == SlotState::Sealed as u8);
            }
            args = args
                .plaintext_u64(price)
                .x25519_pubkey(executor)
                .plaintext_u128(executor_nonce);
            for i in 0..BATCH_SIZE {
                args = args
                    .plaintext_u128(u128::from_le_bytes(round.slots[i].nonce))
                    .account(round_key, Round::order_ct_offset(i), ORDER_CT_LEN as u32);
            }
        }

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        queue_computation(
            ctx.accounts,
            computation_offset,
            args.build(),
            vec![MatchPairCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: round_key,
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "match_pair")]
    pub fn match_pair_callback(
        ctx: Context<MatchPairCallback>,
        output: SignedComputationOutputs<MatchPairOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(MatchPairOutput { field_0 }) => field_0,
            Err(_) => return Err(SpikeError::AbortedComputation.into()),
        };
        let (fills, leg) = (o.field_0, o.field_1);
        let mut round = ctx.accounts.round.load_mut()?;
        // A retried match can land twice. Keep the first.
        if round.state != RoundState::Matching as u8 {
            return Ok(());
        }
        round.fills_nonce = fills.nonce.to_le_bytes();
        round.fills_ct = fills.ciphertexts;
        round.leg_nonce = leg.nonce.to_le_bytes();
        round.leg_ct = leg.ciphertexts;
        round.state = RoundState::Matched as u8;
        emit!(RoundMatched {
            round: round.id,
            leg_nonce: leg.nonce.to_le_bytes(),
            leg_ct: leg.ciphertexts,
        });
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

#[queue_computation_accounts("draw_close", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct OpenRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub prev_round: Option<AccountLoader<'info, Round>>,
    #[account(
        init,
        payer = payer,
        space = Round::SPACE,
        seeds = [ROUND_SEED, &config.next_round.to_le_bytes()],
        bump,
    )]
    pub round: AccountLoader<'info, Round>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_DRAW_CLOSE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("draw_close")]
#[derive(Accounts)]
pub struct DrawCloseCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_DRAW_CLOSE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: address is validated by the Arcium program; verify_output reads slot data from it.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub round: AccountLoader<'info, Round>,
}

#[queue_computation_accounts("tick", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct Tick<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub round: AccountLoader<'info, Round>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_TICK))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("submit_order", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SubmitOrder<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub round: AccountLoader<'info, Round>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SUBMIT_ORDER))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("submit_order")]
#[derive(Accounts)]
pub struct SubmitOrderCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SUBMIT_ORDER))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: address is validated by the Arcium program; verify_output reads slot data from it.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub round: AccountLoader<'info, Round>,
}

#[queue_computation_accounts("match_pair", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct MatchRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub round: AccountLoader<'info, Round>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_MATCH_PAIR))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("match_pair")]
#[derive(Accounts)]
pub struct MatchPairCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_MATCH_PAIR))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: address is validated by the Arcium program; verify_output reads slot data from it.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub round: AccountLoader<'info, Round>,
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

#[callback_accounts("tick")]
#[derive(Accounts)]
pub struct TickCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_TICK))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: address is validated by the Arcium program; verify_output reads slot data from it.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub round: AccountLoader<'info, Round>,
}

#[init_computation_definition_accounts("draw_close", payer)]
#[derive(Accounts)]
pub struct InitDrawCloseCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("submit_order", payer)]
#[derive(Accounts)]
pub struct InitSubmitOrderCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("match_pair", payer)]
#[derive(Accounts)]
pub struct InitMatchPairCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("tick", payer)]
#[derive(Accounts)]
pub struct InitTickCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}
