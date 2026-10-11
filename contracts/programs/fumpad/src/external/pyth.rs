//! Pyth PriceUpdateV2 parsing (no crate dependency). OWNER: rewards module.
//! Must check: account owner == PYTH_RECEIVER_PROGRAM_ID, discriminator, feed id ==
//! global.params.sol_usd_feed_id, verification level Full, publish_time staleness
//! ≤ max_price_age_secs, sane confidence.
