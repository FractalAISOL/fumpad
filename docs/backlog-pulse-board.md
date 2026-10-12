# Launches page (formerly Coins): live three-column board ("Pulse")

Decided with the user 2026-10-11. Start after the live-updates work lands (needs its per-coin WS stream).

- Three live columns: **New** (curve < 50%, newest first) · **Final Stretch** (curve ≥ 50%, sorted by curve progress) · **Graduated** (PumpSwap, sorted by volume/recency). Mobile: tabs.
- Row: image, ticker + name, age, `…fmbL` address (copy), socials, MC, volume, tx count, holders, curve progress bar (New / Final Stretch), reward pool size, open tickets, "closest ticket to 10x" on graduated rows.
- Quick-buy ⚡ button: one user-set preset in the board header, default 0.1 SOL, remembered per browser.
- Per-column filters: min MC, volume, holders, curve %, age, hide flagged creators.
- Signal design (not the dark terminal look of the reference): calm, monospace numbers, orange only for money moments (10x crossings, live payouts), new coins slide in without layout jumps.
- No 4th column; "closest to 10x" lives inside rows.
- v2 (later): risk badges — top-10 holders %, dev holding %, snipers %, bundled wallets % (indexer analysis).
