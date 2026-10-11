// Bonding curve math. OWNER: curve module.
//
// Constant product on virtual reserves (pump.fun style), u128 intermediates,
// every rounding in the protocol's favor. Pure functions only — no account access —
// so they can be property-tested in isolation.
