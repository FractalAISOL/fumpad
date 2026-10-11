# FUMPAD — Design Brief

## The product
FUMPAD is a Solana token launchpad (like pump.fun) with one twist: **it pays sellers back when they fumble.**
Sell a coin through FUMPAD, and if that coin later holds 10x your sell price (after it graduates from the bonding curve),
you can claim 10% of the tokens you sold — paid in the coin, from that coin's own reward pool. Claims expire 90 days after the sell.

Full concept: `../docs/concept-overview.pdf` (read it).

Core emotional idea: **a fumble becomes a trophy.** Selling too early is the most painful moment in memecoin trading.
Every other tool rubs it in ("you missed $40k"). FUMPAD turns that regret into a game and sometimes a payout.
Sellers become holders again — and the loudest promoters.

## Mechanics the UI must express
- Bonding curve → graduates at ~85 SOL → liquidity moves to PumpSwap. Claims open only after graduation.
- Every sell ≥ $50 through FUMPAD creates a **fumble ticket**: amount, sell price (SOL), time.
- Ticket progress: current time-averaged price (30-min median) vs 10x the sell price. Show "how close to 10x".
- Claim = 10% of tokens sold. Token count is fixed, so waiting longer can be worth more.
- Per-coin **reward pool** (5% supply at launch + 50% of every 1% trade fee buys the coin into the pool).
- Fee split: 50% pool buyback / 30% platform / 20% creator.
- If the pool is short, claims **queue**. Smaller claims that fit can skip ahead; queued claims don't expire while waiting.
- A single claim can take at most 10% of the pool.
- Anti-abuse: rebuy within 7 days shrinks the reward; 10-min min hold; max 5 open tickets per wallet per coin; creators can't claim; flagged wallets left off leaderboards.

## Screens (priority order)
1. **Home / Feed** — X-style live social feed: launches, big sells ("fumbles"), 10x crossings, graduations, claims. Trending coins.
2. **Coin page** — chart, buy/sell panel, curve progress (pre-grad) or pool stats (post-grad), reward pool size, claim queue, holders, recent fumbles.
3. **Claim dashboard ("My Fumbles")** — every ticket: sold amount, sell price, progress to 10x, claimable now, days left, claim button; queue position if pending.
4. **The "claim unlocked" moment** — the signature celebration when a ticket crosses 10x / when you claim. Must be screenshot-worthy.
5. **Shareable fumble/claim card** — OG image-style card for posting on X.
6. **Leaderboards & profile** — biggest fumbles, top claimers, diamond hands, levels, achievements.
7. **Launch a coin** flow.

## Bar
"Billion-dollar" product quality: the craft level of Linear, Arc, Phantom, Robinhood, Rainbow, Stripe — but with its own identity,
not a clone. Memecoin culture is loud and fun; FUMPAD should feel *premium AND playful*, trustworthy with money, and instantly recognizable.
Avoid generic crypto tropes (purple-blue gradients on black, glassmorphism everywhere, rocket emojis, Inter-on-dark templates).

Must have: real-looking data (plausible coin names, tickers, SOL amounts, timestamps), mobile-first + desktop, motion with purpose,
empty/loading states where relevant, accessible contrast.
