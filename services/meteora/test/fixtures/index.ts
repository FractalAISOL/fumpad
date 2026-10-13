/**
 * Real mainnet transactions (fetched by scripts/fetch-fixtures.ts). Every scenario's expected values
 * are asserted in test/parse.test.ts and were checked by hand against the token-balance deltas.
 */
export interface FixtureSpec {
  name: string;
  signature: string;
  scenario: string;
  encoding?: "json" | "jsonParsed";
}

export const FIXTURES: FixtureSpec[] = [
  { name: "dbc_direct_buy_quote_fee", signature: "3dMJcUQB1DHmR6rsbYfsknNdKu13FxJVforSNosqAvKNBQrU5QiihRABoAXhRjD5duW3DckeQj2XJhKLRQ66Hhju", scenario: "DBC direct buy, fee in quote on input (CollectFeeMode::QuoteToken)" },
  { name: "dbc_direct_buy_base_fee", signature: "21ghtCKEoyLoiuSYAT5Pfhafmvt6MoGSBQ4AiTcow5yLLuJMqQvQzP1Tffr3wREkuEo5aCtHkFEp4b6xt8q5tkst", scenario: "DBC direct buy, fee in base on output (CollectFeeMode::OutputToken)" },
  { name: "dbc_direct_sell", signature: "21NZRduMndquTgiA5whiCLWmE81sKd9Y687ycj3ySxnf3oY3supsn8c67PSdwaz1yhHEsTzWuE25p15foBsqSgys", scenario: "DBC direct sell" },
  { name: "dbc_curve_complete", signature: "2sroj9SipN12nkwFLXNpEWoGPmPJXxM1H8cWsoxuSPtYhvP2jbgUpKdUpWmWMr1LnCdizJftXJCakuWzYMJUH2jB", scenario: "DBC swap that completes the curve (EvtCurveComplete)" },
  { name: "dbc_axiom_sell_v1", signature: "24DfnibaSiTMWJUiy6eUAQAg44ar28zGK4zE73SQTaBgkxq6nmL1gaUJtrSEz4G8Wd4aUrzsWdjxr4HT87St73v2", scenario: "DBC sell via Axiom (FLASHX…), version-1 tx, referral" },
  { name: "dbc_okx_sell", signature: "3z7m2wJdTcEU1EVF7rK2Z3T76XxgiQvm3nwCGPwMjXTrGXRHQDfc5wLwTHmKqVaanNfz8dTo1pqN3TFfdyoWpKxc", scenario: "DBC sell via OKX (intermediate accounts; fee payer ≠ trader)" },
  { name: "dbc_okx_buy", signature: "67GJGT5eDS1uTfPf7kD8qxuVrWA97iApPhfc76rbe14jgiFKh72mEECRzZMSUWyapT19PyprHXTPmMkUm3kqJoGZ", scenario: "DBC buy via OKX (intermediate accounts)" },
  { name: "dbc_dflow_sell", signature: "4fet8jd1WvjzLMQZuaTPvK2trmppZ9JD8JbXGZ2dBy7gpQ8XbkuxFCzZxv6NSPaBN9sNVRWZgqqTUCvBP4P86UeY", scenario: "DBC sell via DFlow" },
  { name: "dbc_jupiter_buy", signature: "27Aeybireg4GjvnzEUczFfz87Q7wErN7w1BzLJHGc8J5vc3yasnPG4QVwx9wf2d9Q9T7KDaSBSqidBQvfNSspfQd", scenario: "DBC buy via Jupiter (v0, lookup tables)" },
  { name: "dbc_jupiter_buy_parsed", signature: "27Aeybireg4GjvnzEUczFfz87Q7wErN7w1BzLJHGc8J5vc3yasnPG4QVwx9wf2d9Q9T7KDaSBSqidBQvfNSspfQd", scenario: "same, jsonParsed encoding", encoding: "jsonParsed" },
  { name: "dbc_jupiter_sell_v1", signature: "2JAS3PqYA3D3EHP6dwnMbgA4HGZjzpoK2W2iMudp4UwsXnKV96JrJaZEZpA4Vu6aE4ANS7u9wNSqP5ZeWKrWqPE9", scenario: "DBC sell via Jupiter, version-1 tx" },
  { name: "dbc_failed", signature: "c6ye2ExJXUbQofkogbYnkmNKQrkM9J63grhn7ePzvpZuKGsWUSv92pQR52Y8hwxN663BPqdb9X8wPUhqDFmbQTP", scenario: "failed DBC swap tx" },
  { name: "dbc_pool_init", signature: "3YAQ6dVPDCrQxxQzQb8MzDaiXnoMSpRYuJyTtsbCap6q7YFMV8KM6eVAVsubWQyHt9BbaALCpCKSgsDkefkWXFMf", scenario: "DBC pool creation (EvtInitializePool)" },
  { name: "dbc_migration_damm_v2", signature: "42d2dbzx6cRtC2zKzz87b4n9ZTx22qY9WPCZBdptUpuHtj9ckvovJNNtnXbxHtSQ8dzs4Hg5mAUVaEqQDwDceSRV", scenario: "DBC → DAMM v2 migration of the curve completed in dbc_curve_complete" },
  { name: "damm_graduated_direct_buy", signature: "57eSnTPThN8HtgjhN8MHPEW8x887jncwDkFijLwnEU6r6aiprT1k6gSWoRUaM7XemVvKHPTS8hnw7akVBh7Ty66D", scenario: "DAMM v2 direct buy on the pool created by dbc_migration_damm_v2" },
  { name: "damm_direct_sol_is_a", signature: "21W3Vz2MtL7neHoQ48eGUDyGdRAkgM4E3A273jFDd27btXgGjUZdG3wM5sUqQwVVLuLy8UHMLnkNUtRQJDFhJgrD", scenario: "DAMM v2 direct swap on a pool with WSOL as token A (orientation)" },
  { name: "damm_direct_sell", signature: "24aXoH34nuLW1kgGt4Jq64P5cJCQ6dtMc9gboSYaiJrGpRpVF966ejjd9qtLz5MyizB3c3SARz36iNX4a6gBUHHo", scenario: "DAMM v2 direct sell" },
  { name: "damm_jupiter_buy", signature: "2Nrzi3FgFUSdLgcNHVVTsbgsFyuUAgv8KagbgZcMvA586osfwcXwuVyMd78oy58bt4rHLJ3wq2kUdZXJpLWi3B7B", scenario: "DAMM v2 buy via Jupiter (Jupiter-owned intermediate accounts)" },
  { name: "damm_axiom_buy_v1", signature: "3dkhTYijUwQBoRvfBNP7EhLDUpmnoNjhg2dG1GtQKA4j2SN2LsSpeVGvvRHWkqvVSrRWpzP1ZAqAhX4M3DTojtF5", scenario: "DAMM v2 buy via Axiom, version-1 tx" },
  { name: "damm_axiom_buy_v1_parsed", signature: "3dkhTYijUwQBoRvfBNP7EhLDUpmnoNjhg2dG1GtQKA4j2SN2LsSpeVGvvRHWkqvVSrRWpzP1ZAqAhX4M3DTojtF5", scenario: "same, jsonParsed encoding", encoding: "jsonParsed" },
  { name: "damm_axiom_sell_v1", signature: "4rgfE4Bjs9MnH1NZTJhq5pr7wtAfdURPaY2HX6iUSo9ouana9wvBy2QHRPtf8nRbjdfupL2VFhYMK1EniWYZD1A6", scenario: "DAMM v2 sell via Axiom, version-1 tx, referral" },
  { name: "damm_two_swaps", signature: "26W1cnP44k6Dhvap8dT6bEk3e9bbvM54QpqU5A4Gg7WjHvhvi8g5SEnrbVU9RUyQfWtZHJWU6d4LKkMPDU9u9PHC", scenario: "two DAMM v2 swaps in one tx (top-level)" },
  { name: "damm_router_two_swaps", signature: "4caDxHaay5cLw1LXpbWwqExwsAbS7x6agAxBWE9XAt9LJ1pVYowUpgqpCDr1PVkAtGkAJb1tydooJ4YgfCiJ7A2g", scenario: "two DAMM v2 swaps inside one unlabelled router program (multi-hop)" },
  { name: "damm_program_seller_v1", signature: "61kWjKViWgH6GRtp6vRwkdieXXWjmKyiXdHU7wgSp291xQzjiebx4bn2BGKePwx8m7pPmRY6CkDwZ9unT84ChhX8", scenario: "DAMM v2 sell by a program PDA (seller didn't sign): ambiguous trader" },
  { name: "damm_legacy_tx", signature: "z7nn62J2neERdntGpibapRgnivDbJajpWHN4NnATkfhX7Y28KawyCUyGBX9RhnyzExJDPLmpsrD7P9qSfq1AvKX", scenario: "DAMM v2 buy in a legacy-format tx" },
];
