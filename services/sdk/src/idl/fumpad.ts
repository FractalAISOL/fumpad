/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/fumpad.json`.
 */
export type Fumpad = {
  "address": "ASVE6Nk8T1c2Uv81vjPeNDnX54nHGWg98G1afYt2j8Cv",
  "metadata": {
    "name": "fumpad",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "buy",
      "discriminator": [
        102,
        6,
        61,
        18,
        1,
        218,
        235,
        234
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "coin",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "coin"
          ]
        },
        {
          "name": "poolAuthority",
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
            ]
          }
        },
        {
          "name": "curveVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "rewardVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "userTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
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
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
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
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "solIn",
          "type": "u64"
        },
        {
          "name": "minTokensOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "claim",
      "discriminator": [
        62,
        198,
        214,
        193,
        213,
        159,
        108,
        210
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "ticket"
          ]
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "coin",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "coin",
            "ticket"
          ]
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "ticket.seq",
                "account": "ticket"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "claimQueue",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  108,
                  97,
                  105,
                  109,
                  95,
                  113,
                  117,
                  101,
                  117,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "observations",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  115,
                  101,
                  114,
                  118,
                  97,
                  116,
                  105,
                  111,
                  110,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "poolAuthority",
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
            ]
          }
        },
        {
          "name": "rewardVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "ownerTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "closeTicket",
      "discriminator": [
        66,
        209,
        114,
        197,
        75,
        27,
        182,
        117
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "ticket.mint",
                "account": "ticket"
              },
              {
                "kind": "account",
                "path": "ticket.owner",
                "account": "ticket"
              },
              {
                "kind": "account",
                "path": "ticket.seq",
                "account": "ticket"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "ticket.mint",
                "account": "ticket"
              },
              {
                "kind": "account",
                "path": "ticket.owner",
                "account": "ticket"
              }
            ]
          }
        },
        {
          "name": "claimQueue",
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  108,
                  97,
                  105,
                  109,
                  95,
                  113,
                  117,
                  101,
                  117,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "ticket.mint",
                "account": "ticket"
              }
            ]
          }
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "createCoin",
      "discriminator": [
        208,
        85,
        34,
        37,
        235,
        182,
        111,
        78
      ],
      "accounts": [
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "mint",
          "docs": [
            "Fresh keypair (allows vanity mints). Metadata lives in the mint itself."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "mintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
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
            ]
          }
        },
        {
          "name": "coin",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "poolAuthority",
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
            ]
          }
        },
        {
          "name": "rewardVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "curveVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "symbol",
          "type": "string"
        },
        {
          "name": "uri",
          "type": "string"
        }
      ]
    },
    {
      "name": "executeBuyback",
      "discriminator": [
        47,
        32,
        19,
        100,
        184,
        96,
        144,
        49
      ],
      "accounts": [
        {
          "name": "cranker",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "coin",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "coin"
          ]
        },
        {
          "name": "observations",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  115,
                  101,
                  114,
                  118,
                  97,
                  116,
                  105,
                  111,
                  110,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "rewardVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "poolAuthority",
          "writable": true,
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
            ]
          }
        },
        {
          "name": "buybackWsol",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "poolAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "wsolMint"
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
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "pumpswapProgram",
          "address": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "maxLamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "graduate",
      "discriminator": [
        45,
        235,
        225,
        181,
        17,
        218,
        64,
        130
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "coin",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "coin"
          ]
        },
        {
          "name": "poolAuthority",
          "writable": true,
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
            ]
          }
        },
        {
          "name": "curveVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "poolAuthorityWsol",
          "docs": [
            "Pool authority's WSOL account: the raised SOL is wrapped here, deposited, and",
            "the account is closed again (rent back to `payer`)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "poolAuthority"
              },
              {
                "kind": "account",
                "path": "quoteTokenProgram"
              },
              {
                "kind": "account",
                "path": "wsolMint"
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
          "name": "ammPool",
          "writable": true
        },
        {
          "name": "ammGlobalConfig",
          "address": "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw"
        },
        {
          "name": "lpMint",
          "writable": true
        },
        {
          "name": "poolAuthorityLp",
          "docs": [
            "created by PumpSwap, emptied into the locker and closed here."
          ],
          "writable": true
        },
        {
          "name": "poolBaseVault",
          "writable": true
        },
        {
          "name": "poolQuoteVault",
          "writable": true
        },
        {
          "name": "ammEventAuthority"
        },
        {
          "name": "ammProgram",
          "address": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
        },
        {
          "name": "lpLock",
          "writable": true
        },
        {
          "name": "lpLockerAuthority"
        },
        {
          "name": "lpVault",
          "docs": [
            "balance verified here."
          ],
          "writable": true
        },
        {
          "name": "lpLockerProgram",
          "address": "8TkV5aWsBJ9bHr96HV5iQXrCJ51XvHTTtxnufMQmEaY9"
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "quoteTokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "initClaimQueue",
      "discriminator": [
        86,
        77,
        235,
        124,
        82,
        148,
        159,
        94
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "coin",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "coin.mint",
                "account": "coin"
              }
            ]
          }
        },
        {
          "name": "claimQueue",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  108,
                  97,
                  105,
                  109,
                  95,
                  113,
                  117,
                  101,
                  117,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "coin.mint",
                "account": "coin"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initObservations",
      "discriminator": [
        37,
        156,
        80,
        94,
        67,
        157,
        84,
        91
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "coin",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "coin.mint",
                "account": "coin"
              }
            ]
          }
        },
        {
          "name": "observations",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  115,
                  101,
                  114,
                  118,
                  97,
                  116,
                  105,
                  111,
                  110,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "coin.mint",
                "account": "coin"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializeGlobal",
      "discriminator": [
        47,
        225,
        15,
        112,
        86,
        51,
        190,
        231
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "program",
          "docs": [
            "Only the program's upgrade authority may initialize (prevents front-running init)."
          ],
          "address": "ASVE6Nk8T1c2Uv81vjPeNDnX54nHGWg98G1afYt2j8Cv"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "admin",
          "type": "pubkey"
        },
        {
          "name": "platformTreasury",
          "type": "pubkey"
        },
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "params"
            }
          }
        }
      ]
    },
    {
      "name": "processQueue",
      "discriminator": [
        178,
        215,
        43,
        144,
        239,
        34,
        170,
        155
      ],
      "accounts": [
        {
          "name": "cranker",
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "coin",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "coin"
          ]
        },
        {
          "name": "claimQueue",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  108,
                  97,
                  105,
                  109,
                  95,
                  113,
                  117,
                  101,
                  117,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "poolAuthority",
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
            ]
          }
        },
        {
          "name": "rewardVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "maxEntries",
          "type": "u8"
        }
      ]
    },
    {
      "name": "recordSamples",
      "discriminator": [
        39,
        8,
        148,
        76,
        109,
        13,
        225,
        129
      ],
      "accounts": [
        {
          "name": "sampler",
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "registerHoldings",
      "discriminator": [
        211,
        230,
        158,
        156,
        2,
        139,
        212,
        195
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "coin",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "coin"
          ]
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "userTokenAccount",
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
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
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "sell",
      "discriminator": [
        51,
        230,
        133,
        164,
        1,
        127,
        131,
        173
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "coin",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "coin"
          ]
        },
        {
          "name": "poolAuthority",
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
            ]
          }
        },
        {
          "name": "curveVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "rewardVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "userTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
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
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "ticket",
          "docs": [
            "`hooks::on_sell` only if the sell qualifies."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "account",
                "path": "position.nextTicketSeq",
                "account": "position"
              }
            ]
          }
        },
        {
          "name": "solUsdPrice"
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "tokensIn",
          "type": "u64"
        },
        {
          "name": "minSolOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setAdmin",
      "discriminator": [
        251,
        163,
        0,
        52,
        91,
        194,
        187,
        92
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "global"
          ]
        },
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        },
        {
          "name": "platformTreasury",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setKeepers",
      "discriminator": [
        135,
        123,
        16,
        243,
        252,
        182,
        46,
        169
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "global"
          ]
        },
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "keepers",
          "type": {
            "array": [
              "pubkey",
              3
            ]
          }
        }
      ]
    },
    {
      "name": "setPause",
      "discriminator": [
        63,
        32,
        154,
        2,
        56,
        103,
        79,
        45
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "global"
          ]
        },
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "u8"
        }
      ]
    },
    {
      "name": "settleLpFees",
      "docs": [
        "D11: unwrap LP fees skimmed by `fumpad_lp_locker` into the Coin's fee counters."
      ],
      "discriminator": [
        73,
        104,
        193,
        33,
        96,
        173,
        26,
        61
      ],
      "accounts": [
        {
          "name": "cranker",
          "docs": [
            "Anyone; receives the ATA's rent reserve."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "coin",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "coin.mint",
                "account": "coin"
              }
            ]
          }
        },
        {
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "lpFeeWsol",
          "docs": [
            "ATA(coin, WSOL): the locker's fixed quote destination for this coin."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "coin"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "wsolMint"
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
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "swapBuy",
      "discriminator": [
        76,
        98,
        154,
        93,
        42,
        113,
        62,
        139
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "coin",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "coin"
          ]
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "userTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "account",
                "path": "token2022Program"
              },
              {
                "kind": "account",
                "path": "mint"
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
          "name": "userWsol",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "wsolMint"
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
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "pumpswapProgram",
          "address": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "solIn",
          "type": "u64"
        },
        {
          "name": "minTokensOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "swapSell",
      "discriminator": [
        176,
        40,
        55,
        165,
        110,
        62,
        84,
        97
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "coin",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "coin"
          ]
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "ticket",
          "docs": [
            "created (only if the sell qualifies) by `hooks::on_sell`."
          ],
          "writable": true
        },
        {
          "name": "solUsdPrice"
        },
        {
          "name": "userTokenAccount",
          "writable": true
        },
        {
          "name": "userWsol",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "wsolMint"
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
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "pumpswapProgram",
          "address": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "tokensIn",
          "type": "u64"
        },
        {
          "name": "minSolOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "updateParams",
      "discriminator": [
        108,
        178,
        190,
        95,
        94,
        203,
        116,
        20
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "global"
          ]
        },
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "params"
            }
          }
        }
      ]
    },
    {
      "name": "withdrawCreatorFees",
      "discriminator": [
        8,
        30,
        213,
        18,
        121,
        105,
        129,
        222
      ],
      "accounts": [
        {
          "name": "creator",
          "writable": true,
          "signer": true,
          "relations": [
            "coin"
          ]
        },
        {
          "name": "coin",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "coin.mint",
                "account": "coin"
              }
            ]
          }
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "withdrawPlatformFees",
      "discriminator": [
        87,
        24,
        138,
        122,
        62,
        146,
        186,
        199
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "coin",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "coin.mint",
                "account": "coin"
              }
            ]
          }
        },
        {
          "name": "platformTreasury",
          "writable": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "claimQueue",
      "discriminator": [
        150,
        219,
        116,
        150,
        46,
        174,
        101,
        6
      ]
    },
    {
      "name": "coin",
      "discriminator": [
        215,
        195,
        53,
        238,
        217,
        196,
        213,
        51
      ]
    },
    {
      "name": "global",
      "discriminator": [
        167,
        232,
        232,
        177,
        200,
        108,
        114,
        127
      ]
    },
    {
      "name": "observations",
      "discriminator": [
        119,
        205,
        13,
        6,
        93,
        29,
        178,
        203
      ]
    },
    {
      "name": "position",
      "discriminator": [
        170,
        188,
        143,
        228,
        122,
        64,
        247,
        208
      ]
    },
    {
      "name": "ticket",
      "discriminator": [
        41,
        228,
        24,
        165,
        78,
        90,
        235,
        200
      ]
    }
  ],
  "events": [
    {
      "name": "buybackExecuted",
      "discriminator": [
        150,
        109,
        157,
        10,
        124,
        24,
        38,
        189
      ]
    },
    {
      "name": "claimPaid",
      "discriminator": [
        212,
        155,
        88,
        118,
        128,
        99,
        132,
        42
      ]
    },
    {
      "name": "claimQueued",
      "discriminator": [
        150,
        147,
        186,
        188,
        101,
        196,
        182,
        225
      ]
    },
    {
      "name": "coinCreated",
      "discriminator": [
        155,
        248,
        204,
        17,
        205,
        237,
        158,
        104
      ]
    },
    {
      "name": "curveCompleted",
      "discriminator": [
        1,
        174,
        164,
        127,
        219,
        129,
        243,
        14
      ]
    },
    {
      "name": "feesWithdrawn",
      "discriminator": [
        234,
        15,
        0,
        119,
        148,
        241,
        40,
        21
      ]
    },
    {
      "name": "graduated",
      "discriminator": [
        51,
        241,
        66,
        50,
        140,
        245,
        156,
        192
      ]
    },
    {
      "name": "holdingsRegistered",
      "discriminator": [
        91,
        3,
        183,
        65,
        135,
        167,
        74,
        96
      ]
    },
    {
      "name": "lpFeesSettled",
      "discriminator": [
        73,
        225,
        84,
        251,
        139,
        49,
        155,
        130
      ]
    },
    {
      "name": "sampleRecorded",
      "discriminator": [
        84,
        131,
        33,
        9,
        193,
        184,
        103,
        242
      ]
    },
    {
      "name": "ticketClosed",
      "discriminator": [
        48,
        69,
        175,
        107,
        31,
        27,
        141,
        71
      ]
    },
    {
      "name": "ticketCreated",
      "discriminator": [
        122,
        222,
        128,
        213,
        63,
        50,
        51,
        110
      ]
    },
    {
      "name": "ticketDebited",
      "discriminator": [
        195,
        94,
        80,
        161,
        117,
        96,
        231,
        150
      ]
    },
    {
      "name": "trade",
      "discriminator": [
        24,
        254,
        218,
        152,
        253,
        43,
        18,
        81
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notImplemented",
      "msg": "Not implemented"
    },
    {
      "code": 6001,
      "name": "unauthorized",
      "msg": "Unauthorized"
    },
    {
      "code": 6002,
      "name": "invalidParams",
      "msg": "Invalid parameters"
    },
    {
      "code": 6003,
      "name": "paused",
      "msg": "Paused"
    },
    {
      "code": 6004,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6005,
      "name": "slippageExceeded",
      "msg": "Slippage exceeded"
    },
    {
      "code": 6006,
      "name": "zeroAmount",
      "msg": "Zero amount"
    },
    {
      "code": 6007,
      "name": "invalidAccount",
      "msg": "Invalid account"
    },
    {
      "code": 6008,
      "name": "wrongCoinStatus",
      "msg": "Wrong coin status for this action"
    },
    {
      "code": 6009,
      "name": "metadataTooLong",
      "msg": "Name, symbol or URI too long"
    },
    {
      "code": 6010,
      "name": "curveExhausted",
      "msg": "Curve has no tokens left"
    },
    {
      "code": 6011,
      "name": "curveNotComplete",
      "msg": "Curve is not complete"
    },
    {
      "code": 6012,
      "name": "insufficientReserves",
      "msg": "Insufficient reserves"
    },
    {
      "code": 6013,
      "name": "emptyMetadata",
      "msg": "Name and symbol must not be empty"
    },
    {
      "code": 6014,
      "name": "graduationMismatch",
      "msg": "PumpSwap pool creation did not move the expected amounts"
    },
    {
      "code": 6015,
      "name": "staleOraclePrice",
      "msg": "Oracle price is stale or invalid"
    },
    {
      "code": 6016,
      "name": "ticketNotOpen",
      "msg": "Ticket is not open"
    },
    {
      "code": 6017,
      "name": "ticketExpired",
      "msg": "Ticket has expired"
    },
    {
      "code": 6018,
      "name": "triggerNotMet",
      "msg": "Price has not held 10x the sell price"
    },
    {
      "code": 6019,
      "name": "insufficientSamples",
      "msg": "Not enough price samples in the window"
    },
    {
      "code": 6020,
      "name": "queueFull",
      "msg": "Claim queue is full"
    },
    {
      "code": 6021,
      "name": "openTicketsMismatch",
      "msg": "Open tickets passed do not match the position"
    },
    {
      "code": 6022,
      "name": "ticketNotClosable",
      "msg": "Ticket cannot be closed yet"
    },
    {
      "code": 6023,
      "name": "lamportInvariant",
      "msg": "Coin lamport accounting invariant violated"
    },
    {
      "code": 6024,
      "name": "wrongVenue",
      "msg": "Wrong venue program or pool"
    },
    {
      "code": 6025,
      "name": "sampleTooSoon",
      "msg": "Sample too soon after the previous one"
    },
    {
      "code": 6026,
      "name": "sampleTxNotIsolated",
      "msg": "Sampling transaction must contain only the sampling instruction"
    },
    {
      "code": 6027,
      "name": "priceDeviation",
      "msg": "Spot price deviates too far from the median"
    },
    {
      "code": 6028,
      "name": "nothingToBuyBack",
      "msg": "Nothing to buy back"
    },
    {
      "code": 6029,
      "name": "nothingToSettle",
      "msg": "No skimmed LP fees to settle"
    }
  ],
  "types": [
    {
      "name": "buybackExecuted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "lamportsIn",
            "type": "u64"
          },
          {
            "name": "tokensOut",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "claimPaid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "fromQueue",
            "type": "bool"
          },
          {
            "name": "medianPriceQ64",
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "claimQueue",
      "docs": [
        "Per-coin claim queue, kept sorted by `sell_ts` ascending (ties by ticket key).",
        "PDA [\"claim_queue\", mint]. Zero-copy; created by `init_claim_queue` after graduation.",
        "Skip-ahead: `process_queue` pays, in order, every entry whose amount fits the",
        "current per-claim cap and pool balance, skipping entries that don't fit.",
        "OWNER: rewards module."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "len",
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                5
              ]
            }
          },
          {
            "name": "totalOwed",
            "type": "u64"
          },
          {
            "name": "entries",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "queueEntry"
                  }
                },
                256
              ]
            }
          }
        ]
      }
    },
    {
      "name": "claimQueued",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "queueLen",
            "type": "u16"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "coin",
      "docs": [
        "One per launched coin. PDA [\"coin\", mint].",
        "",
        "Lamport accounting: this account's lamports always equal",
        "rent_exempt_minimum + real_sol_reserves + creator_fees_unclaimed",
        "+ platform_fees_unclaimed + buyback_lamports",
        "(tested as an invariant). After graduation `real_sol_reserves` is 0."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "coinStatus"
              }
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "virtualSolReserves",
            "type": "u64"
          },
          {
            "name": "virtualTokenReserves",
            "type": "u64"
          },
          {
            "name": "realSolReserves",
            "type": "u64"
          },
          {
            "name": "realTokenReserves",
            "type": "u64"
          },
          {
            "name": "completedAt",
            "type": "i64"
          },
          {
            "name": "graduatedAt",
            "type": "i64"
          },
          {
            "name": "ammPool",
            "docs": [
              "PumpSwap pool, set at graduation."
            ],
            "type": "pubkey"
          },
          {
            "name": "creatorFeesUnclaimed",
            "type": "u64"
          },
          {
            "name": "platformFeesUnclaimed",
            "type": "u64"
          },
          {
            "name": "buybackLamports",
            "docs": [
              "Post-graduation pool share of fees, waiting for `execute_buyback`."
            ],
            "type": "u64"
          },
          {
            "name": "volumeLamports",
            "type": "u64"
          },
          {
            "name": "tradeCount",
            "type": "u64"
          },
          {
            "name": "ticketsCreated",
            "type": "u64"
          },
          {
            "name": "tokensPaidOut",
            "type": "u64"
          },
          {
            "name": "reference",
            "docs": [
              "D10 reference price (ticket sell-price floor), see `math/reference.rs`.",
              "Initialized at `create_coin` to the initial curve price; updated by every curve",
              "buy/sell, router swap and `record_samples`; carried unchanged through graduation.",
              "Occupies 40 bytes of the former 128-byte `reserved` (account size unchanged)."
            ],
            "type": {
              "defined": {
                "name": "referencePrice"
              }
            }
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                88
              ]
            }
          }
        ]
      }
    },
    {
      "name": "coinCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "symbol",
            "type": "string"
          },
          {
            "name": "uri",
            "type": "string"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "coinStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "curve"
          },
          {
            "name": "complete"
          },
          {
            "name": "graduated"
          }
        ]
      }
    },
    {
      "name": "curveCompleted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "feesWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "creator",
            "docs": [
              "true = creator fees, false = platform fees."
            ],
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "global",
      "docs": [
        "Singleton config. PDA [\"global\"]."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "admin",
            "docs": [
              "Squads multisig in production."
            ],
            "type": "pubkey"
          },
          {
            "name": "platformTreasury",
            "docs": [
              "Receives the platform share of fees on `withdraw_platform_fees`."
            ],
            "type": "pubkey"
          },
          {
            "name": "keepers",
            "docs": [
              "Keys allowed to sign `record_samples`. Pubkey::default() = empty slot."
            ],
            "type": {
              "array": [
                "pubkey",
                3
              ]
            }
          },
          {
            "name": "paused",
            "docs": [
              "Bitmask of `PAUSE_*` flags."
            ],
            "type": "u8"
          },
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "params"
              }
            }
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                128
              ]
            }
          }
        ]
      }
    },
    {
      "name": "graduated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "solDeposited",
            "type": "u64"
          },
          {
            "name": "tokensDeposited",
            "type": "u64"
          },
          {
            "name": "lpLocked",
            "docs": [
              "LP tokens moved into the immutable `fumpad_lp_locker` (D11)."
            ],
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "holdingsRegistered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "added",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "lpFeesSettled",
      "docs": [
        "D11: skimmed LP-fee SOL unwrapped from ATA(coin, WSOL) and credited to the Coin.",
        "(The skim itself — LP withdrawn, base tokens sent to the reward vault — is logged by",
        "the locker's own `Skimmed` event.)"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "platform",
            "type": "u64"
          },
          {
            "name": "creator",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "observation",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ts",
            "type": "i64"
          },
          {
            "name": "fallback",
            "docs": [
              "1 if recorded through the permissionless fallback path."
            ],
            "type": "u64"
          },
          {
            "name": "priceQ64",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "observations",
      "docs": [
        "Ring buffer of PumpSwap spot-price samples for one graduated coin.",
        "PDA [\"observations\", mint]. Zero-copy; created by `init_observations` after graduation.",
        "OWNER: venue/oracle module."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "head",
            "docs": [
              "Index the next sample will be written to."
            ],
            "type": "u16"
          },
          {
            "name": "len",
            "docs": [
              "Number of valid samples (≤ capacity)."
            ],
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                3
              ]
            }
          },
          {
            "name": "lastKeeperSampleTs",
            "type": "i64"
          },
          {
            "name": "samples",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "observation"
                  }
                },
                256
              ]
            }
          }
        ]
      }
    },
    {
      "name": "params",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "totalSupply",
            "type": "u64"
          },
          {
            "name": "rewardPoolSupply",
            "type": "u64"
          },
          {
            "name": "curveSupply",
            "type": "u64"
          },
          {
            "name": "lpSupply",
            "type": "u64"
          },
          {
            "name": "initialVirtualSol",
            "type": "u64"
          },
          {
            "name": "initialVirtualToken",
            "type": "u64"
          },
          {
            "name": "graduationLamports",
            "type": "u64"
          },
          {
            "name": "graduationFeeLamports",
            "docs": [
              "Taken from raised SOL at graduation (covers account rent; may include a platform fee)."
            ],
            "type": "u64"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "feePoolShareBps",
            "type": "u16"
          },
          {
            "name": "feePlatformShareBps",
            "type": "u16"
          },
          {
            "name": "feeCreatorShareBps",
            "type": "u16"
          },
          {
            "name": "triggerMultipleBps",
            "type": "u32"
          },
          {
            "name": "claimBps",
            "type": "u16"
          },
          {
            "name": "maxClaimPoolBps",
            "type": "u16"
          },
          {
            "name": "minSellUsdCents",
            "type": "u64"
          },
          {
            "name": "minHoldSecs",
            "type": "i64"
          },
          {
            "name": "rebuyWindowSecs",
            "type": "i64"
          },
          {
            "name": "claimWindowSecs",
            "type": "i64"
          },
          {
            "name": "maxOpenTickets",
            "type": "u8"
          },
          {
            "name": "oracleWindowSecs",
            "type": "i64"
          },
          {
            "name": "oracleMinSpacingSecs",
            "type": "i64"
          },
          {
            "name": "oracleMinSamples",
            "type": "u16"
          },
          {
            "name": "keeperStaleSecs",
            "type": "i64"
          },
          {
            "name": "buybackMaxDeviationBps",
            "type": "u16"
          },
          {
            "name": "buybackMaxPoolBps",
            "type": "u16"
          },
          {
            "name": "solUsdFeedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "maxPriceAgeSecs",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "position",
      "docs": [
        "A wallet's reward-eligibility state for one coin. PDA [\"position\", mint, wallet].",
        "Created (init_if_needed, paid by the user) on the first FUMPAD trade or `register_holdings`.",
        "",
        "Eligibility uses two buckets so a new buy doesn't reset the clock on tokens already held:",
        "- `matured`: tokens held ≥ min_hold_secs (eligible for tickets)",
        "- `pending`: tokens added at `pending_since`; they move to `matured` once",
        "`now - pending_since >= min_hold_secs` (lazily, in `settle`).",
        "Adding while `pending` hasn't matured merges into `pending` and restarts its clock.",
        "Eligible amounts are always capped by the wallet's actual token balance at sell time."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "matured",
            "type": "u64"
          },
          {
            "name": "pending",
            "type": "u64"
          },
          {
            "name": "pendingSince",
            "type": "i64"
          },
          {
            "name": "nextTicketSeq",
            "docs": [
              "Next ticket PDA seed."
            ],
            "type": "u64"
          },
          {
            "name": "openTickets",
            "docs": [
              "Open/queued ticket accounts (Pubkey::default() = empty). Buys must pass all of",
              "them so the rebuy rule can be applied."
            ],
            "type": {
              "array": [
                "pubkey",
                5
              ]
            }
          },
          {
            "name": "openCount",
            "type": "u8"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "queueEntry",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "sellTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "referencePrice",
      "docs": [
        "Stored in `Coin.reference` (40 bytes carved out of the old `Coin.reserved`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "avgQ64",
            "docs": [
              "The reference average: lamports per base unit, Q64.64."
            ],
            "type": "u128"
          },
          {
            "name": "lastSpotQ64",
            "docs": [
              "Spot recorded at the last touch point (post-trade / sampled), Q64.64."
            ],
            "type": "u128"
          },
          {
            "name": "updatedAt",
            "docs": [
              "Time of the last touch point; 0 = never initialized."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "sampleRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "priceQ64",
            "type": "u128"
          },
          {
            "name": "fallback",
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "ticket",
      "docs": [
        "A fumble ticket: one qualifying sell. PDA [\"ticket\", mint, wallet, seq.to_le_bytes()].",
        "Rent paid by the seller; refunded to `owner` on `close_ticket`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "seq",
            "type": "u64"
          },
          {
            "name": "tokens",
            "docs": [
              "Tokens credited to this ticket, after rebuy debits."
            ],
            "type": "u64"
          },
          {
            "name": "originalTokens",
            "docs": [
              "Tokens credited at creation."
            ],
            "type": "u64"
          },
          {
            "name": "sellPriceQ64",
            "docs": [
              "Execution price of the sell, before FUMPAD's fee: lamports per base unit, Q64.64."
            ],
            "type": "u128"
          },
          {
            "name": "sellUsdCents",
            "type": "u64"
          },
          {
            "name": "sellTs",
            "type": "i64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "ticketStatus"
              }
            }
          },
          {
            "name": "queuedAt",
            "docs": [
              "Set when the ticket enters the claim queue (expiry stops counting from here)."
            ],
            "type": "i64"
          },
          {
            "name": "claimAmount",
            "docs": [
              "Tokens owed, fixed at queue entry or payout (claim_bps of `tokens`)."
            ],
            "type": "u64"
          },
          {
            "name": "claimedAt",
            "type": "i64"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "ticketClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "finalStatus",
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "ticketCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "tokens",
            "type": "u64"
          },
          {
            "name": "sellPriceQ64",
            "type": "u128"
          },
          {
            "name": "sellUsdCents",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "ticketDebited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "debited",
            "type": "u64"
          },
          {
            "name": "remaining",
            "type": "u64"
          },
          {
            "name": "voided",
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "ticketStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "queued"
          },
          {
            "name": "claimed"
          },
          {
            "name": "expired"
          },
          {
            "name": "voided"
          }
        ]
      }
    },
    {
      "name": "trade",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "isBuy",
            "type": "bool"
          },
          {
            "name": "onAmm",
            "docs": [
              "false = bonding curve, true = PumpSwap via router."
            ],
            "type": "bool"
          },
          {
            "name": "tokenAmount",
            "type": "u64"
          },
          {
            "name": "solAmount",
            "docs": [
              "SOL side before FUMPAD's fee."
            ],
            "type": "u64"
          },
          {
            "name": "feePool",
            "type": "u64"
          },
          {
            "name": "feePlatform",
            "type": "u64"
          },
          {
            "name": "feeCreator",
            "type": "u64"
          },
          {
            "name": "poolTokensBought",
            "docs": [
              "Tokens bought into the reward pool by this trade (curve: inline buyback)."
            ],
            "type": "u64"
          },
          {
            "name": "priceQ64",
            "type": "u128"
          },
          {
            "name": "virtualSolReserves",
            "type": "u64"
          },
          {
            "name": "virtualTokenReserves",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "claimQueueSeed",
      "type": "bytes",
      "value": "[99, 108, 97, 105, 109, 95, 113, 117, 101, 117, 101]"
    },
    {
      "name": "coinSeed",
      "type": "bytes",
      "value": "[99, 111, 105, 110]"
    },
    {
      "name": "curveVaultSeed",
      "type": "bytes",
      "value": "[99, 117, 114, 118, 101, 95, 118, 97, 117, 108, 116]"
    },
    {
      "name": "globalSeed",
      "type": "bytes",
      "value": "[103, 108, 111, 98, 97, 108]"
    },
    {
      "name": "mintAuthoritySeed",
      "type": "bytes",
      "value": "[109, 105, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121]"
    },
    {
      "name": "observationsSeed",
      "type": "bytes",
      "value": "[111, 98, 115, 101, 114, 118, 97, 116, 105, 111, 110, 115]"
    },
    {
      "name": "poolAuthoritySeed",
      "type": "bytes",
      "value": "[112, 111, 111, 108, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121]"
    },
    {
      "name": "positionSeed",
      "type": "bytes",
      "value": "[112, 111, 115, 105, 116, 105, 111, 110]"
    },
    {
      "name": "rewardVaultSeed",
      "type": "bytes",
      "value": "[114, 101, 119, 97, 114, 100, 95, 118, 97, 117, 108, 116]"
    },
    {
      "name": "ticketSeed",
      "type": "bytes",
      "value": "[116, 105, 99, 107, 101, 116]"
    }
  ]
};
