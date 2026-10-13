/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/fumpad_lp_locker.json`.
 */
export type FumpadLpLocker = {
  "address": "8TkV5aWsBJ9bHr96HV5iQXrCJ51XvHTTtxnufMQmEaY9",
  "metadata": {
    "name": "fumpadLpLocker",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "FUMPAD immutable LP locker: holds PumpSwap LP forever, skims fee growth only"
  },
  "instructions": [
    {
      "name": "lock",
      "discriminator": [
        21,
        19,
        208,
        43,
        237,
        62,
        255,
        87
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "fumpadAuthority",
          "docs": [
            "FUMPAD's pool-authority PDA: only FUMPAD can sign for it (only `graduate` does)."
          ],
          "signer": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                64,
                158,
                20,
                209,
                64,
                82,
                24,
                122,
                116,
                122,
                255,
                47,
                165,
                201,
                136,
                238,
                64,
                56,
                175,
                173,
                86,
                30,
                135,
                74,
                1,
                203,
                182,
                44,
                21,
                202,
                239
              ]
            }
          }
        },
        {
          "name": "pool",
          "docs": [
            "creator checked in the handler."
          ]
        },
        {
          "name": "lpMint"
        },
        {
          "name": "sourceLp",
          "writable": true
        },
        {
          "name": "lock",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "lpVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "authority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "lpMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "poolBaseVault"
        },
        {
          "name": "poolQuoteVault"
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "skim",
      "docs": [
        "remaining_accounts = PumpSwap `withdraw` accounts in PumpSwap order (user = `authority`,",
        "user_base = lock.base_dest, user_quote = lock.quote_dest, user_pool = lock.lp_vault)."
      ],
      "discriminator": [
        238,
        120,
        221,
        138,
        82,
        60,
        100,
        218
      ],
      "accounts": [
        {
          "name": "lock",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "lock.pool",
                "account": "lock"
              }
            ]
          }
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "pumpswapProgram",
          "address": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "lock",
      "discriminator": [
        8,
        255,
        36,
        202,
        210,
        22,
        57,
        137
      ]
    }
  ],
  "events": [
    {
      "name": "locked",
      "discriminator": [
        188,
        53,
        118,
        62,
        64,
        12,
        198,
        84
      ]
    },
    {
      "name": "skimmed",
      "discriminator": [
        25,
        39,
        18,
        44,
        46,
        131,
        59,
        76
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notFumpadPool",
      "msg": "Not a FUMPAD PumpSwap pool"
    },
    {
      "code": 6001,
      "name": "wrongAccount",
      "msg": "Wrong account"
    },
    {
      "code": 6002,
      "name": "nothingToLock",
      "msg": "No LP to lock"
    },
    {
      "code": 6003,
      "name": "nothingToSkim",
      "msg": "Fee growth below the skim threshold"
    },
    {
      "code": 6004,
      "name": "principalViolated",
      "msg": "Skim would touch the principal"
    },
    {
      "code": 6005,
      "name": "badReserves",
      "msg": "Empty or invalid pool reserves"
    },
    {
      "code": 6006,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6007,
      "name": "unknownPoolLayout",
      "msg": "Unknown PumpSwap pool layout"
    }
  ],
  "types": [
    {
      "name": "lock",
      "docs": [
        "One per FUMPAD pool, PDA [\"lock\", pool]. Never closed."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "lpMint",
            "type": "pubkey"
          },
          {
            "name": "lpVault",
            "type": "pubkey"
          },
          {
            "name": "baseDest",
            "docs": [
              "FUMPAD [\"reward_vault\", mint]."
            ],
            "type": "pubkey"
          },
          {
            "name": "quoteDest",
            "docs": [
              "ATA(FUMPAD [\"coin\", mint], WSOL)."
            ],
            "type": "pubkey"
          },
          {
            "name": "principalNum",
            "docs": [
              "Principal P = principal_num / lp_supply_at_lock √k units (= held₀ · ⌈√k₀⌉ / L₀)."
            ],
            "type": "u128"
          },
          {
            "name": "lpSupplyAtLock",
            "type": "u64"
          },
          {
            "name": "lpLocked",
            "type": "u64"
          },
          {
            "name": "lockedAt",
            "type": "i64"
          },
          {
            "name": "lpSkimmed",
            "type": "u64"
          },
          {
            "name": "baseSkimmed",
            "type": "u64"
          },
          {
            "name": "quoteSkimmed",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "locked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "lpLocked",
            "type": "u64"
          },
          {
            "name": "lpSupply",
            "type": "u64"
          },
          {
            "name": "sqrtK",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "skimmed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "lpWithdrawn",
            "type": "u64"
          },
          {
            "name": "baseOut",
            "type": "u64"
          },
          {
            "name": "quoteOut",
            "type": "u64"
          },
          {
            "name": "lpHeld",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
