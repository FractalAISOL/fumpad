/**
 * Compile-time contract: every REST route's payload type is exactly the return type of
 * the matching `FumpadData` method (app/src/data/interface.ts). `tsc -b api` fails if
 * the app's interface and the API drift apart. No runtime code.
 */
import type { ChainReader } from "./chain.js";
import type { FumpadData } from "./generated/app-interface.js";
import type { Repo } from "./repo.js";
import type { systemStatus } from "./status.js";

type R<K extends keyof FumpadData> = Awaited<ReturnType<FumpadData[K]>>;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type ContractCheck = [
  Assert<Same<Awaited<ReturnType<Repo["getStats"]>>, R<"getStats">>>,
  Assert<Same<Awaited<ReturnType<Repo["listCoins"]>>, R<"listCoins">>>,
  Assert<Same<Awaited<ReturnType<Repo["getCoin"]>>, R<"getCoin">>>,
  Assert<Same<Awaited<ReturnType<Repo["getPriceSeries"]>>, R<"getPriceSeries">>>,
  Assert<Same<Awaited<ReturnType<Repo["getCandles"]>>, R<"getCandles">>>,
  Assert<Same<Awaited<ReturnType<Repo["getHolders"]>>, R<"getHolders">>>,
  Assert<Same<Awaited<ReturnType<Repo["getRecentFumbles"]>>, R<"getRecentFumbles">>>,
  Assert<Same<Awaited<ReturnType<Repo["getClaimQueue"]>>, R<"getClaimQueue">>>,
  Assert<Same<Awaited<ReturnType<Repo["getRecentTrades"]>>, R<"getRecentTrades">>>,
  Assert<Same<Awaited<ReturnType<Repo["getParams"]>>, R<"getParams">>>,
  Assert<Same<Awaited<ReturnType<Repo["getFeed"]>>, R<"getFeed">>>,
  Assert<Same<Awaited<ReturnType<Repo["getClosestTo10x"]>>, R<"getClosestTo10x">>>,
  Assert<Same<Awaited<ReturnType<Repo["getTickets"]>>, R<"getTickets">>>,
  Assert<Same<Awaited<ReturnType<Repo["getTicket"]>>, R<"getTicket">>>,
  Assert<Same<Awaited<ReturnType<Repo["getLeaderboard"]>>, R<"getLeaderboard">>>,
  Assert<Same<Awaited<ReturnType<Repo["getProfile"]>>, R<"getProfile">>>,
  Assert<Same<Awaited<ReturnType<Repo["walletFumbles"]>>, R<"getWalletFumbles">>>,
  Assert<Same<Awaited<ReturnType<ChainReader["quote"]>>, R<"quoteTrade">>>,
  Assert<Same<Awaited<ReturnType<ChainReader["balances"]>>, R<"getBalances">>>,
  Assert<Same<Awaited<ReturnType<ChainReader["solUsd"]>>, R<"getSolUsd">>>,
  Assert<Same<Awaited<ReturnType<typeof systemStatus>>, R<"getStatus">>>,
];
