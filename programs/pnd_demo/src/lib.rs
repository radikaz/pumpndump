// pnd_demo: the devnet v2 demo. One trusted executor does what Arcium and the shielded pool
// will do later. It can read every order and every balance. DEVNET ONLY: never deploy this to
// mainnet. See docs/devnet-v2.md.
//
// What is on chain: coin vaults, test coins with a faucet, public deposits, balance accounts
// that only the user (and the executor) can decrypt, payouts, and public round results.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("3qjjCvCh4txLgvuCsxKoHKvG9Lbv1Ax6CSvotX9ZYc1d");

pub const CONFIG_SEED: &[u8] = b"config";
pub const POOL_SEED: &[u8] = b"pool";
pub const COIN_SEED: &[u8] = b"coin";
pub const MINT_SEED: &[u8] = b"mint";
pub const VAULT_SEED: &[u8] = b"vault";
pub const DRIP_SEED: &[u8] = b"drip";
pub const DEPOSIT_SEED: &[u8] = b"dep";
pub const BALANCE_SEED: &[u8] = b"bal";
pub const ROUND_SEED: &[u8] = b"round";

pub const DECIMALS: u8 = 6;
pub const NOTE_LEN: usize = 128;
/** One balance buffer. There are two, so a reader never sees a half-written one. */
pub const BALANCE_BUF: usize = 2400;
pub const MAX_NET: usize = 16;
pub const FAUCET_EVERY_S: i64 = 3600;

#[program]
pub mod pnd_demo {
    use super::*;

    pub fn init_config(
        ctx: Context<InitConfig>,
        executor: Pubkey,
        executor_x25519: [u8; 32],
        fee_inside_bps: u16,
        fee_market_bps: u16,
    ) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.executor = executor;
        c.executor_x25519 = executor_x25519;
        c.fee_inside_bps = fee_inside_bps;
        c.fee_market_bps = fee_market_bps;
        c.coin_count = 0;
        c.next_deposit = 0;
        c.next_round = 0;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_executor(ctx: Context<SetExecutor>, executor: Pubkey, executor_x25519: [u8; 32]) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.executor = executor;
        c.executor_x25519 = executor_x25519;
        Ok(())
    }

    /// Adds the next test coin: its mint and its vault, both owned by the pool PDA.
    pub fn add_coin(ctx: Context<AddCoin>, index: u16, symbol: [u8; 16], faucet_amount: u64) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(index == config.coin_count, DemoError::WrongCoinIndex);
        config.coin_count += 1;
        let coin = &mut ctx.accounts.coin;
        coin.index = index;
        coin.mint = ctx.accounts.mint.key();
        coin.vault = ctx.accounts.vault.key();
        coin.symbol = symbol;
        coin.faucet_amount = faucet_amount;
        coin.bump = ctx.bumps.coin;
        Ok(())
    }

    /// Gives the wallet `faucet_amount` of one test coin, at most once per hour per coin.
    pub fn faucet(ctx: Context<Faucet>, index: u16) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let drip = &mut ctx.accounts.drip;
        require!(drip.last_ts == 0 || now - drip.last_ts >= FAUCET_EVERY_S, DemoError::FaucetTooSoon);
        drip.last_ts = now;
        let amount = ctx.accounts.coin.faucet_amount;
        mint_from_pool(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.user_token.to_account_info(),
            &ctx.accounts.pool,
            ctx.bumps.pool,
            amount,
        )?;
        let _ = index;
        Ok(())
    }

    /// A public wallet transfer into the pool. The note tells the executor, encrypted, which
    /// device key to credit. Anyone can see the wallet, the coin and the amount.
    pub fn deposit(ctx: Context<Deposit>, index: u16, amount: u64, note: [u8; NOTE_LEN]) -> Result<()> {
        require!(amount > 0, DemoError::ZeroAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.user_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.wallet.to_account_info(),
                },
            ),
            amount,
        )?;
        let config = &mut ctx.accounts.config;
        let d = &mut ctx.accounts.deposit;
        d.id = config.next_deposit;
        d.depositor = ctx.accounts.wallet.key();
        d.index = index;
        d.amount = amount;
        d.note = note;
        d.ts = Clock::get()?.unix_timestamp;
        d.bump = ctx.bumps.deposit;
        config.next_deposit += 1;
        emit!(Deposited { id: d.id, index, amount });
        Ok(())
    }

    /// The executor has credited a deposit. Closing it gives the rent back to the depositor.
    pub fn credit(_ctx: Context<Credit>, _id: u64) -> Result<()> {
        Ok(())
    }

    /// Writes one chunk of a balance document into the buffer that readers do not use now.
    /// The last chunk switches readers to it.
    pub fn write_balance(
        ctx: Context<WriteBalance>,
        tag: [u8; 32],
        seq: u64,
        offset: u16,
        total: u16,
        chunk: Vec<u8>,
    ) -> Result<()> {
        let end = offset as usize + chunk.len();
        require!(total as usize <= BALANCE_BUF && end <= total as usize, DemoError::BalanceTooLarge);
        let mut b = match ctx.accounts.balance.load_mut() {
            Ok(b) => b,
            Err(_) => ctx.accounts.balance.load_init()?,
        };
        if b.tag == [0u8; 32] {
            b.tag = tag;
            b.bump = ctx.bumps.balance;
        }
        require!(seq > b.seq, DemoError::OldBalance);
        let next = (1 - b.active) as usize;
        let buf = if next == 0 { &mut b.buf0 } else { &mut b.buf1 };
        buf[offset as usize..end].copy_from_slice(&chunk);
        if end == total as usize {
            b.len[next] = total;
            b.seq = seq;
            b.active = next as u8;
        }
        Ok(())
    }

    /// Pays out of a vault into any token account of the same coin. Used for withdrawals.
    pub fn payout(ctx: Context<Payout>, index: u16, amount: u64) -> Result<()> {
        let bump = [ctx.bumps.pool];
        let seeds: &[&[u8]] = &[POOL_SEED, &bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.dest.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        emit!(PaidOut { index, amount });
        Ok(())
    }

    /// Mints test coins into a vault. The house (the earn strategy) uses this on devnet to fill
    /// the market leg, because devnet has no Jupiter.
    pub fn mint_house(ctx: Context<MintHouse>, _index: u16, amount: u64) -> Result<()> {
        mint_from_pool(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.pool,
            ctx.bumps.pool,
            amount,
        )
    }

    /// The public result of a round. The net trade per coin is public by design.
    pub fn post_round(ctx: Context<PostRound>, id: u64, result: RoundResultData) -> Result<()> {
        require!(result.net.len() <= MAX_NET, DemoError::TooManyCoins);
        let config = &mut ctx.accounts.config;
        require!(id == config.next_round, DemoError::WrongRoundId);
        config.next_round += 1;
        let r = &mut ctx.accounts.round;
        r.id = id;
        r.data = result;
        r.bump = ctx.bumps.round;
        Ok(())
    }

    pub fn close_round(_ctx: Context<CloseRound>, _id: u64) -> Result<()> {
        Ok(())
    }
}

fn mint_from_pool<'info>(
    token_program: &Program<'info, Token>,
    mint: &Account<'info, Mint>,
    to: &AccountInfo<'info>,
    pool: &UncheckedAccount<'info>,
    pool_bump: u8,
    amount: u64,
) -> Result<()> {
    let bump = [pool_bump];
    let seeds: &[&[u8]] = &[POOL_SEED, &bump];
    token::mint_to(
        CpiContext::new_with_signer(
            token_program.key(),
            MintTo { mint: mint.to_account_info(), to: to.clone(), authority: pool.to_account_info() },
            &[seeds],
        ),
        amount,
    )
}

// ---------- accounts ----------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub executor: Pubkey,
    pub executor_x25519: [u8; 32],
    pub fee_inside_bps: u16,
    pub fee_market_bps: u16,
    pub coin_count: u16,
    pub next_deposit: u64,
    pub next_round: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Coin {
    pub index: u16,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub symbol: [u8; 16],
    pub faucet_amount: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Drip {
    pub last_ts: i64,
}

#[account]
#[derive(InitSpace)]
pub struct DepositNote {
    pub id: u64,
    pub depositor: Pubkey,
    pub index: u16,
    pub amount: u64,
    pub note: [u8; NOTE_LEN],
    pub ts: i64,
    pub bump: u8,
}

/// The user's balance document, encrypted to the user's device key. Two buffers: `active`
/// names the one to read, with `len[active]` bytes.
#[account(zero_copy)]
#[repr(C)]
pub struct Balance {
    pub tag: [u8; 32],
    pub seq: u64,
    pub len: [u16; 2],
    pub active: u8,
    pub bump: u8,
    pub _pad: [u8; 2],
    pub buf0: [u8; BALANCE_BUF],
    pub buf1: [u8; BALANCE_BUF],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct NetTrade {
    pub coin: u16,
    /// Base units. Positive: the round bought this coin on net. Negative: it sold.
    pub amount: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct RoundResultData {
    pub open_ts: i64,
    pub close_ts: i64,
    pub orders: u16,
    pub parts: u16,
    /// Volume in micro-USD: pairs, rings, earn, market.
    pub volume: [u64; 4],
    #[max_len(16)]
    pub net: Vec<NetTrade>,
}

#[account]
#[derive(InitSpace)]
pub struct RoundResult {
    pub id: u64,
    pub data: RoundResultData,
    pub bump: u8,
}

// ---------- contexts ----------

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetExecutor<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(index: u16)]
pub struct AddCoin<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    /// CHECK: the pool PDA signs for mints and vaults. It holds no data.
    #[account(seeds = [POOL_SEED], bump)]
    pub pool: UncheckedAccount<'info>,
    #[account(init, payer = authority, space = 8 + Coin::INIT_SPACE, seeds = [COIN_SEED, &index.to_le_bytes()], bump)]
    pub coin: Account<'info, Coin>,
    #[account(init, payer = authority, seeds = [MINT_SEED, &index.to_le_bytes()], bump,
        mint::decimals = DECIMALS, mint::authority = pool)]
    pub mint: Account<'info, Mint>,
    #[account(init, payer = authority, seeds = [VAULT_SEED, &index.to_le_bytes()], bump,
        token::mint = mint, token::authority = pool)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u16)]
pub struct Faucet<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(seeds = [COIN_SEED, &index.to_le_bytes()], bump = coin.bump, has_one = mint)]
    pub coin: Account<'info, Coin>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    /// CHECK: the pool PDA, mint authority.
    #[account(seeds = [POOL_SEED], bump)]
    pub pool: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = wallet, associated_token::mint = mint, associated_token::authority = wallet)]
    pub user_token: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = wallet, space = 8 + Drip::INIT_SPACE,
        seeds = [DRIP_SEED, wallet.key().as_ref(), &index.to_le_bytes()], bump)]
    pub drip: Account<'info, Drip>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u16)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [COIN_SEED, &index.to_le_bytes()], bump = coin.bump, has_one = vault)]
    pub coin: Account<'info, Coin>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = coin.mint, token::authority = wallet)]
    pub user_token: Account<'info, TokenAccount>,
    #[account(init, payer = wallet, space = 8 + DepositNote::INIT_SPACE,
        seeds = [DEPOSIT_SEED, &config.next_deposit.to_le_bytes()], bump)]
    pub deposit: Account<'info, DepositNote>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Credit<'info> {
    pub executor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = executor @ DemoError::NotExecutor)]
    pub config: Account<'info, Config>,
    /// CHECK: gets the rent back; must be the depositor.
    #[account(mut, address = deposit.depositor)]
    pub depositor: UncheckedAccount<'info>,
    #[account(mut, close = depositor, seeds = [DEPOSIT_SEED, &id.to_le_bytes()], bump = deposit.bump)]
    pub deposit: Account<'info, DepositNote>,
}

#[derive(Accounts)]
#[instruction(tag: [u8; 32])]
pub struct WriteBalance<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = executor @ DemoError::NotExecutor)]
    pub config: Account<'info, Config>,
    #[account(init_if_needed, payer = executor, space = 8 + std::mem::size_of::<Balance>(),
        seeds = [BALANCE_SEED, &tag], bump)]
    pub balance: AccountLoader<'info, Balance>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u16)]
pub struct Payout<'info> {
    pub executor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = executor @ DemoError::NotExecutor)]
    pub config: Account<'info, Config>,
    #[account(seeds = [COIN_SEED, &index.to_le_bytes()], bump = coin.bump, has_one = vault)]
    pub coin: Account<'info, Coin>,
    /// CHECK: the pool PDA, vault authority.
    #[account(seeds = [POOL_SEED], bump)]
    pub pool: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = coin.mint)]
    pub dest: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(index: u16)]
pub struct MintHouse<'info> {
    pub executor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = executor @ DemoError::NotExecutor)]
    pub config: Account<'info, Config>,
    #[account(seeds = [COIN_SEED, &index.to_le_bytes()], bump = coin.bump, has_one = vault, has_one = mint)]
    pub coin: Account<'info, Coin>,
    /// CHECK: the pool PDA, mint authority.
    #[account(seeds = [POOL_SEED], bump)]
    pub pool: UncheckedAccount<'info>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct PostRound<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = executor @ DemoError::NotExecutor)]
    pub config: Account<'info, Config>,
    #[account(init, payer = executor, space = 8 + RoundResult::INIT_SPACE,
        seeds = [ROUND_SEED, &id.to_le_bytes()], bump)]
    pub round: Account<'info, RoundResult>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CloseRound<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = executor @ DemoError::NotExecutor)]
    pub config: Account<'info, Config>,
    #[account(mut, close = executor, seeds = [ROUND_SEED, &id.to_le_bytes()], bump = round.bump)]
    pub round: Account<'info, RoundResult>,
}

#[event]
pub struct Deposited {
    pub id: u64,
    pub index: u16,
    pub amount: u64,
}

#[event]
pub struct PaidOut {
    pub index: u16,
    pub amount: u64,
}

#[error_code]
pub enum DemoError {
    #[msg("Only the executor can do this")]
    NotExecutor,
    #[msg("Coins must be added in order")]
    WrongCoinIndex,
    #[msg("The faucet gives each coin once per hour")]
    FaucetTooSoon,
    #[msg("Amount must be more than zero")]
    ZeroAmount,
    #[msg("The balance document is too large")]
    BalanceTooLarge,
    #[msg("This balance write is older than the stored one")]
    OldBalance,
    #[msg("Too many coins in one round result")]
    TooManyCoins,
    #[msg("Round results must be posted in order")]
    WrongRoundId,
}
