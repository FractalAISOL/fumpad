/**
 * Expected records per fixture. Every number was checked by hand against the transaction's token-balance
 * deltas (vaults, the trader's token accounts, and lamports for WSOL wrapped/unwrapped in the tx); the
 * invariants in parse.test.ts re-check them mechanically.
 */
export interface ExpectedTrade {
  ixKey: number; topIx: number; innerIx: number; venue: "dbc" | "damm_v2"; side: "buy" | "sell"; app: string; pool: string; baseMint: string; quoteMint: string;
  trader: string | null; traderSource: string; feePayer: string; swapAuthority: string;
  baseAmount: bigint; quoteGross: bigint; quoteNet: bigint;
  fee: { token: "base" | "quote"; onInput: boolean; total: bigint; trading: bigint; protocol: bigint; referral: bigint; compounding: bigint };
  referralTokenAccount: string | null; curveComplete: { baseReserve: bigint; quoteReserve: bigint } | null;
}

export const EXPECTED: Record<string, { version: number | "legacy"; trades: ExpectedTrade[] }> = {
  dbc_direct_buy_quote_fee: { version: "legacy", trades: [
    { ixKey: 131072, topIx: 2, innerIx: -1, venue: "dbc", side: "buy", app: "direct", pool: "9B6FefDLxHUHwfbezaVbzgdVjyK6qhjepN6qEJDeMqcd", baseMint: "HSdsExXG5JH5uwtBXHDXSBk41tF9kt1jX2X9jW76moon", quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      trader: "AZqfbE9mLurnAEBd9oH7kFodbrVm8NcSStof1p2SM6Fu", traderSource: "base_owner_signer", feePayer: "AZqfbE9mLurnAEBd9oH7kFodbrVm8NcSStof1p2SM6Fu", swapAuthority: "AZqfbE9mLurnAEBd9oH7kFodbrVm8NcSStof1p2SM6Fu",
      baseAmount: 192316836805n, quoteGross: 6881437n, quoteNet: 6916018n, fee: { token: "quote", onInput: true, total: 34581n, trading: 27665n, protocol: 6916n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
  ] },
  dbc_direct_buy_base_fee: { version: 0, trades: [
    { ixKey: 327680, topIx: 5, innerIx: -1, venue: "dbc", side: "buy", app: "direct", pool: "DD1CzjkgmCBQbQMqXVjpKTu6JcLf9S7ys91eu12aZ2G6", baseMint: "9moD2Hw3rtdDeQoULNqEde3rhZ7LP3EPQUfvVGQou3cQ", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "AcvE4uKUz7kUYQsVbajhBBi4Xx3kg979zPsJvjsLMNeJ", traderSource: "base_owner_signer", feePayer: "AcvE4uKUz7kUYQsVbajhBBi4Xx3kg979zPsJvjsLMNeJ", swapAuthority: "AcvE4uKUz7kUYQsVbajhBBi4Xx3kg979zPsJvjsLMNeJ",
      baseAmount: 359326689376n, quoteGross: 171041733n, quoteNet: 171041733n, fee: { token: "base", onInput: false, total: 900568144n, trading: 720454516n, protocol: 180113628n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
  ] },
  dbc_direct_sell: { version: 0, trades: [
    { ixKey: 196608, topIx: 3, innerIx: -1, venue: "dbc", side: "sell", app: "direct", pool: "DD1CzjkgmCBQbQMqXVjpKTu6JcLf9S7ys91eu12aZ2G6", baseMint: "9moD2Hw3rtdDeQoULNqEde3rhZ7LP3EPQUfvVGQou3cQ", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "AcvE4uKUz7kUYQsVbajhBBi4Xx3kg979zPsJvjsLMNeJ", traderSource: "base_owner_signer", feePayer: "AcvE4uKUz7kUYQsVbajhBBi4Xx3kg979zPsJvjsLMNeJ", swapAuthority: "AcvE4uKUz7kUYQsVbajhBBi4Xx3kg979zPsJvjsLMNeJ",
      baseAmount: 73303042279n, quoteGross: 35025992n, quoteNet: 34938427n, fee: { token: "quote", onInput: false, total: 87565n, trading: 70052n, protocol: 17513n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
  ] },
  dbc_curve_complete: { version: 0, trades: [
    { ixKey: 65536, topIx: 1, innerIx: -1, venue: "dbc", side: "buy", app: "direct", pool: "7wqGhpe3rVqCYFxV5f3ninfmRLRsE4GvVBkCrBPLK6Rp", baseMint: "BQqBiNLXNVB3Y3h6yqGMvTgEfrYjFzUa2KHPUsaUpump", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "HSsUqEp3eZ5EckgEB7gEPitunLqnegRmhQT5PpaoQuCk", traderSource: "base_owner_signer", feePayer: "HSsUqEp3eZ5EckgEB7gEPitunLqnegRmhQT5PpaoQuCk", swapAuthority: "HSsUqEp3eZ5EckgEB7gEPitunLqnegRmhQT5PpaoQuCk",
      baseAmount: 219999968000913n, quoteGross: 10000n, quoteNet: 10026n, fee: { token: "quote", onInput: true, total: 26n, trading: 21n, protocol: 5n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: { baseReserve: 780000031999087n, quoteReserve: 10000n } },
  ] },
  dbc_axiom_sell_v1: { version: 1, trades: [
    { ixKey: 131073, topIx: 2, innerIx: 0, venue: "dbc", side: "sell", app: "axiom", pool: "AVZm7nm3BESA2Rwsd8bZq8ezjhCrkKghdCJBUbKejETH", baseMint: "6WsNG3SMhfsMu31rm8sBTtNLq13wAoeniVpRKDt4BAGS", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "DFCeLdv3GSzWcRuupbM3pemKVHjk9ULHoGXGuoj2F5LE", traderSource: "base_owner_signer", feePayer: "DFCeLdv3GSzWcRuupbM3pemKVHjk9ULHoGXGuoj2F5LE", swapAuthority: "DFCeLdv3GSzWcRuupbM3pemKVHjk9ULHoGXGuoj2F5LE",
      baseAmount: 440626057461590n, quoteGross: 245077643n, quoteNet: 240176090n, fee: { token: "quote", onInput: false, total: 4901553n, trading: 3921243n, protocol: 784248n, referral: 196062n, compounding: 0n },
      referralTokenAccount: "6YiwFTtFA9gd2eUmvV8bS9tEVRnJJwkKd39TMLMQDbj2", curveComplete: null },
  ] },
  dbc_okx_sell: { version: 0, trades: [
    { ixKey: 262146, topIx: 4, innerIx: 1, venue: "dbc", side: "sell", app: "okx", pool: "6K2YNiHy3rbCFHrrN3D7A5p2QT4fYfGM9NYkkMjY9Kiu", baseMint: "6w7XACzrPQbWqqLimjLqkd2vUhJKwpvmSy1sZyWWKgan", quoteMint: "CWZ6BsdnjkDVTGkmL6bGbJXXig6ceef12KvyGQW14cMt",
      trader: "pUmRA7YqWiKX67zxRP6XLYfGsVYB5SQk9ZMLMH2qAbG", traderSource: "signer_net_base", feePayer: "6R7CgGouGM8jLZkoWoKEx8E1ffLgt2WbM3Ye4Ngawh3X", swapAuthority: "ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn",
      baseAmount: 3482356952436n, quoteGross: 110557653n, quoteNet: 109353856n, fee: { token: "quote", onInput: false, total: 1203797n, trading: 963038n, protocol: 240759n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
  ] },
  dbc_okx_buy: { version: 0, trades: [
    { ixKey: 458760, topIx: 7, innerIx: 7, venue: "dbc", side: "buy", app: "okx", pool: "6F7ivMJmmkRJkBDbCMk43Wfvoxr1xK3vUTsp9jdoso4t", baseMint: "EkmoF5zSfdVfps1Lqoc4kjxYzdn2WV9FbsuEKLFn1AJN", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "923RHEknR2Agm7PJYCYgBsLdKDMzVJUbBdpt91hEE1yV", traderSource: "signer_net_base", feePayer: "923RHEknR2Agm7PJYCYgBsLdKDMzVJUbBdpt91hEE1yV", swapAuthority: "ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn",
      baseAmount: 11521654744n, quoteGross: 5183950n, quoteNet: 5183950n, fee: { token: "base", onInput: false, total: 28876328n, trading: 23101063n, protocol: 5775265n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
  ] },
  dbc_dflow_sell: { version: 0, trades: [
    { ixKey: 131073, topIx: 2, innerIx: 0, venue: "dbc", side: "sell", app: "dflow", pool: "F3Xvi7fMaDMs9QDringo6LeZPjS5ksK6rEvKedzTfNN3", baseMint: "AJvpZMCv6WpPqfYHnLoe4DyJ7oMEocDNzoAaCRoJjups", quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      trader: "GqdnmA29naoBv1JhzRNB83wK7iaLSKKamR2FzGw8KVYd", traderSource: "base_owner_signer", feePayer: "GqdnmA29naoBv1JhzRNB83wK7iaLSKKamR2FzGw8KVYd", swapAuthority: "GqdnmA29naoBv1JhzRNB83wK7iaLSKKamR2FzGw8KVYd",
      baseAmount: 3427679914036n, quoteGross: 22576567n, quoteNet: 22350800n, fee: { token: "quote", onInput: false, total: 225767n, trading: 180614n, protocol: 45153n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
  ] },
  dbc_jupiter_buy: { version: 0, trades: [
    { ixKey: 262150, topIx: 4, innerIx: 5, venue: "dbc", side: "buy", app: "jupiter", pool: "FEspH9Mw6RNk1KrWBQEw7LKoegYXKMw6iH8TRBZvSbGk", baseMint: "GjLBKhiAZQg1rfgp76pz6cbp3LPKwoptmK1wCZVQfgan", quoteMint: "CWZ6BsdnjkDVTGkmL6bGbJXXig6ceef12KvyGQW14cMt",
      trader: "Gf2AW3xcPo8cHK7uTFPexYr7Qq47bmhqUUHpTzwrtabn", traderSource: "base_owner_signer", feePayer: "Gf2AW3xcPo8cHK7uTFPexYr7Qq47bmhqUUHpTzwrtabn", swapAuthority: "Gf2AW3xcPo8cHK7uTFPexYr7Qq47bmhqUUHpTzwrtabn",
      baseAmount: 7080461984070n, quoteGross: 807149473n, quoteNet: 815413820n, fee: { token: "quote", onInput: true, total: 8264347n, trading: 6611478n, protocol: 1652869n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
  ] },
  dbc_jupiter_sell_v1: { version: 1, trades: [
    { ixKey: 65537, topIx: 1, innerIx: 0, venue: "dbc", side: "sell", app: "jupiter", pool: "GPZShaLMqTcrDsAhfWh8bdRdnNcWyXMJHCuvNiFPdFp2", baseMint: "mEUGth3K77cnxG21pfqbVCar3Qv1fkofMHLFdZeLofo", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "7TguL7g2P9dBiGriugBb9SS7W7vKsjvMJm2RhFSeT5Bt", traderSource: "base_owner_signer", feePayer: "7TguL7g2P9dBiGriugBb9SS7W7vKsjvMJm2RhFSeT5Bt", swapAuthority: "7TguL7g2P9dBiGriugBb9SS7W7vKsjvMJm2RhFSeT5Bt",
      baseAmount: 25531878350066228n, quoteGross: 694822494n, quoteNet: 680926044n, fee: { token: "quote", onInput: false, total: 13896450n, trading: 11117160n, protocol: 2779290n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
  ] },
  damm_graduated_direct_buy: { version: 0, trades: [
    { ixKey: 327680, topIx: 5, innerIx: -1, venue: "damm_v2", side: "buy", app: "direct", pool: "ApxZdXkBjKWomGyWBA3LcCzUkjhq4UcoiT2kVaj7WDUk", baseMint: "BQqBiNLXNVB3Y3h6yqGMvTgEfrYjFzUa2KHPUsaUpump", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "F4EdghvYnhtUhSvPoffPweZpg7nHuxTgaWUDrfuWXdEb", traderSource: "base_owner_signer", feePayer: "F4EdghvYnhtUhSvPoffPweZpg7nHuxTgaWUDrfuWXdEb", swapAuthority: "F4EdghvYnhtUhSvPoffPweZpg7nHuxTgaWUDrfuWXdEb",
      baseAmount: 8758788n, quoteGross: 29970n, quoteNet: 30000n, fee: { token: "quote", onInput: true, total: 30n, trading: 24n, protocol: 6n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
  ] },
  damm_direct_sol_is_a: { version: 0, trades: [
    { ixKey: 393216, topIx: 6, innerIx: -1, venue: "damm_v2", side: "buy", app: "direct", pool: "HKFNpHWZ1FpbkmU5o655uAiDKZ4XwWnniGE5NfWBdVXa", baseMint: "APetq1ouSjgQx126tdx6L929t2Wp2Y1mubcUHFNXDYr9", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "4ynFSZYSF4wJbouyBLDJxoeJm2QeCQjRb4sc4myv761u", traderSource: "base_owner_signer", feePayer: "4ynFSZYSF4wJbouyBLDJxoeJm2QeCQjRb4sc4myv761u", swapAuthority: "4ynFSZYSF4wJbouyBLDJxoeJm2QeCQjRb4sc4myv761u",
      baseAmount: 316347100n, quoteGross: 99085n, quoteNet: 99085n, fee: { token: "base", onInput: false, total: 31638n, trading: 25311n, protocol: 6327n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
  ] },
  damm_direct_sell: { version: 0, trades: [
    { ixKey: 196608, topIx: 3, innerIx: -1, venue: "damm_v2", side: "sell", app: "direct", pool: "6uuQDEnDWrNMbu7tvAdyDzESSRv92QYnDLKTux1H2fzF", baseMint: "AHdeKQ2nUg3BtEcKvS8LHfNmwpc26G6xBd1hZSziYUh9", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "GPzzcq6gStrdooUYdmLWeA4APAnHmmn8gYCsrJpRhn3u", traderSource: "base_owner_signer", feePayer: "GPzzcq6gStrdooUYdmLWeA4APAnHmmn8gYCsrJpRhn3u", swapAuthority: "GPzzcq6gStrdooUYdmLWeA4APAnHmmn8gYCsrJpRhn3u",
      baseAmount: 76679668817n, quoteGross: 63215568n, quoteNet: 63152352n, fee: { token: "quote", onInput: false, total: 63216n, trading: 50573n, protocol: 12643n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
  ] },
  damm_jupiter_buy: { version: 0, trades: [
    { ixKey: 327693, topIx: 5, innerIx: 12, venue: "damm_v2", side: "buy", app: "jupiter", pool: "5Tyakzwn8BF9cqXE5NZB9C5FJPn5UapAZMGCpXcPvU1u", baseMint: "7KEPApdbBMByrmqihz3bht2uMhFQcatjfSFQCKq66kH3", quoteMint: "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS",
      trader: "C14MB9NQDPefm3n9fYrm9o4Dg96gWDbRX675VFGg4Qu9", traderSource: "signer_net_base", feePayer: "C14MB9NQDPefm3n9fYrm9o4Dg96gWDbRX675VFGg4Qu9", swapAuthority: "GP8StUXNYSZjPikyRsvkTbvRV1GBxMErb59cpeCJnDf1",
      baseAmount: 550131095n, quoteGross: 116608n, quoteNet: 117786n, fee: { token: "quote", onInput: true, total: 1178n, trading: 849n, protocol: 235n, referral: 0n, compounding: 94n },
      referralTokenAccount: null, curveComplete: null },
  ] },
  damm_axiom_buy_v1: { version: 1, trades: [
    { ixKey: 131073, topIx: 2, innerIx: 0, venue: "damm_v2", side: "buy", app: "axiom", pool: "6uuQDEnDWrNMbu7tvAdyDzESSRv92QYnDLKTux1H2fzF", baseMint: "AHdeKQ2nUg3BtEcKvS8LHfNmwpc26G6xBd1hZSziYUh9", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "5W6rTrRVxjmBSq8aBkiuATFTfLEWRsnCY9nSbmxuPDXv", traderSource: "base_owner_signer", feePayer: "5W6rTrRVxjmBSq8aBkiuATFTfLEWRsnCY9nSbmxuPDXv", swapAuthority: "5W6rTrRVxjmBSq8aBkiuATFTfLEWRsnCY9nSbmxuPDXv",
      baseAmount: 24286171840n, quoteGross: 19800000n, quoteNet: 19800000n, fee: { token: "base", onInput: false, total: 24310483n, trading: 19448387n, protocol: 4862096n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
  ] },
  damm_axiom_sell_v1: { version: 1, trades: [
    { ixKey: 65537, topIx: 1, innerIx: 0, venue: "damm_v2", side: "sell", app: "axiom", pool: "6WWr9tJKEv8xzZfuNsi2ZG51HMfRdAeb3Cj4Fwb6S5Dn", baseMint: "G4SgMuvaViFd4wMca6msTVBJu77s3tzrSkLJMJRrNqBG", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "38NSxQ4qhczZiuhhxYtppSyH5doBFiRGa6XKnbY58J9e", traderSource: "base_owner_signer", feePayer: "38NSxQ4qhczZiuhhxYtppSyH5doBFiRGa6XKnbY58J9e", swapAuthority: "38NSxQ4qhczZiuhhxYtppSyH5doBFiRGa6XKnbY58J9e",
      baseAmount: 35516644330n, quoteGross: 15860409n, quoteNet: 15844548n, fee: { token: "quote", onInput: false, total: 15861n, trading: 12689n, protocol: 2538n, referral: 634n, compounding: 0n },
      referralTokenAccount: "BsN4r2PaBEtWUzuEiENRU6A7D61pzvqed19iAaLom5bC", curveComplete: null },
  ] },
  damm_two_swaps: { version: 0, trades: [
    { ixKey: 327680, topIx: 5, innerIx: -1, venue: "damm_v2", side: "buy", app: "direct", pool: "8Q88H2GNWuZputSAobsdnc9zCCHvBKLVvTxNqjrQzaDv", baseMint: "ezq3bNyXdAEh2X4RA4D5kkeL2NT6kSGabJyQy9qhvvd", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "8keq5DyeDApcnRVSPFE44wh7bFpJ9XE5CxaJdjD8ai9a", traderSource: "base_owner_signer", feePayer: "8keq5DyeDApcnRVSPFE44wh7bFpJ9XE5CxaJdjD8ai9a", swapAuthority: "8keq5DyeDApcnRVSPFE44wh7bFpJ9XE5CxaJdjD8ai9a",
      baseAmount: 50845944624879n, quoteGross: 8633338950n, quoteNet: 8633338950n, fee: { token: "base", onInput: false, total: 5085102973n, trading: 4068082379n, protocol: 1017020594n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
    { ixKey: 589824, topIx: 9, innerIx: -1, venue: "damm_v2", side: "sell", app: "direct", pool: "8Q88H2GNWuZputSAobsdnc9zCCHvBKLVvTxNqjrQzaDv", baseMint: "ezq3bNyXdAEh2X4RA4D5kkeL2NT6kSGabJyQy9qhvvd", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "8keq5DyeDApcnRVSPFE44wh7bFpJ9XE5CxaJdjD8ai9a", traderSource: "base_owner_signer", feePayer: "8keq5DyeDApcnRVSPFE44wh7bFpJ9XE5CxaJdjD8ai9a", swapAuthority: "8keq5DyeDApcnRVSPFE44wh7bFpJ9XE5CxaJdjD8ai9a",
      baseAmount: 50845944624879n, quoteGross: 8631732058n, quoteNet: 8631732058n, fee: { token: "base", onInput: true, total: 5084594463n, trading: 4067675571n, protocol: 1016918892n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
  ] },
  damm_router_two_swaps: { version: 0, trades: [
    { ixKey: 327681, topIx: 5, innerIx: 0, venue: "damm_v2", side: "buy", app: "unknown_program", pool: "2EoLY22PDPxHEkgxThaRHxAcMuYvyW26vgLaUR89Yf2H", baseMint: "5NJfQ6UQ1LJTxtKLrsZQcbiSUWequSD6aZLNJaN7Zviv", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "FREAKwChR4Vbs41nvAg3MW92tqzbPe45nn5cRDgfJ6dh", traderSource: "base_owner_signer", feePayer: "FREAKwChR4Vbs41nvAg3MW92tqzbPe45nn5cRDgfJ6dh", swapAuthority: "FREAKwChR4Vbs41nvAg3MW92tqzbPe45nn5cRDgfJ6dh",
      baseAmount: 20164153n, quoteGross: 227972n, quoteNet: 228549n, fee: { token: "quote", onInput: true, total: 577n, trading: 324n, protocol: 115n, referral: 0n, compounding: 138n },
      referralTokenAccount: null, curveComplete: null },
    { ixKey: 327685, topIx: 5, innerIx: 4, venue: "damm_v2", side: "sell", app: "unknown_program", pool: "4mUW4xaY6ApeB3bF8ZNqnex9VTfLeqvb734iYULDry7k", baseMint: "5NJfQ6UQ1LJTxtKLrsZQcbiSUWequSD6aZLNJaN7Zviv", quoteMint: "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D",
      trader: "FREAKwChR4Vbs41nvAg3MW92tqzbPe45nn5cRDgfJ6dh", traderSource: "base_owner_signer", feePayer: "FREAKwChR4Vbs41nvAg3MW92tqzbPe45nn5cRDgfJ6dh", swapAuthority: "FREAKwChR4Vbs41nvAg3MW92tqzbPe45nn5cRDgfJ6dh",
      baseAmount: 20164153n, quoteGross: 23638n, quoteNet: 23400n, fee: { token: "quote", onInput: false, total: 238n, trading: 191n, protocol: 47n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
  ] },
  damm_program_seller_v1: { version: 1, trades: [
    { ixKey: 8, topIx: 0, innerIx: 7, venue: "damm_v2", side: "sell", app: "unknown_program", pool: "ApxZdXkBjKWomGyWBA3LcCzUkjhq4UcoiT2kVaj7WDUk", baseMint: "BQqBiNLXNVB3Y3h6yqGMvTgEfrYjFzUa2KHPUsaUpump", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "HWGoJ1HaMFUiDgfD7FVxMaYJAE2A5JjF7si6CgWSvRFQ", traderSource: "base_owner_unsigned", feePayer: "HuTshmtwcQkWBLzgW3m4uwcmik7Lmz4YFpYcTqMJpXiP", swapAuthority: "HWGoJ1HaMFUiDgfD7FVxMaYJAE2A5JjF7si6CgWSvRFQ",
      baseAmount: 9632484n, quoteGross: 49940n, quoteNet: 49890n, fee: { token: "quote", onInput: false, total: 50n, trading: 40n, protocol: 8n, referral: 2n, compounding: 0n },
      referralTokenAccount: "6pUWpTcTNPsqpxjX6pGm7CFfxGy8e61tfweDyJqn8iVW", curveComplete: null },
  ] },
  damm_legacy_tx: { version: "legacy", trades: [
    { ixKey: 65536, topIx: 1, innerIx: -1, venue: "damm_v2", side: "buy", app: "direct", pool: "ApxZdXkBjKWomGyWBA3LcCzUkjhq4UcoiT2kVaj7WDUk", baseMint: "BQqBiNLXNVB3Y3h6yqGMvTgEfrYjFzUa2KHPUsaUpump", quoteMint: "So11111111111111111111111111111111111111112",
      trader: "3KcPSJ8ouE7H1feoWHmhDwXhLnXhpxP6R6713uytFmBM", traderSource: "base_owner_signer", feePayer: "3KcPSJ8ouE7H1feoWHmhDwXhLnXhpxP6R6713uytFmBM", swapAuthority: "3KcPSJ8ouE7H1feoWHmhDwXhLnXhpxP6R6713uytFmBM",
      baseAmount: 9644958n, quoteGross: 49950n, quoteNet: 50000n, fee: { token: "quote", onInput: true, total: 50n, trading: 40n, protocol: 10n, referral: 0n, compounding: 0n },
      referralTokenAccount: null, curveComplete: null },
  ] },
};
