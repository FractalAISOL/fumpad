//! PumpSwap integration (raw CPI, no crate dependency — see external-idl/pump_amm.json).
//! OWNERS: `create_pool` CPI → curve module (graduation). buy/sell CPI, reserve reads,
//! spot price → venue/oracle module. Put each in its own clearly-marked section.
//!
//! Design rule: PumpSwap has shipped breaking account-list changes several times.
//! Validate only what matters (program id, pool, mints, user token accounts) and
//! measure results by balance deltas, passing the rest through from the client.
