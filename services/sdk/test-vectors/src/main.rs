//! Emits JSON test vectors computed by the fumpad program's own pure functions.
//! Every number is a decimal string (u128-safe). Deterministic (xorshift seed).

use anchor_lang::prelude::Pubkey;
use fumpad::{
    external::pyth::{lamports_to_usd_cents, UsdPrice},
    instructions::rewards::logic,
    math::{
        curve::{initial_reserves, quote_buy, quote_sell, sol_for_tokens, CurveReserves},
        fees::compute_fee,
        price::{lamports_for, meets_multiple, mul_div_ceil, price_q64},
        reference::{ticket_price_q64, ReferencePrice, Touch},
    },
    state::{Observations, Params, Position, TicketStatus},
};
use serde_json::{json, Value};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    /// Log-uniform in [1, max].
    fn amount(&mut self, max: u64) -> u64 {
        let bits = (self.next() % 64) as u32;
        let cap = if bits >= 63 { max } else { max.min((1u64 << (bits + 1)) - 1) };
        1 + self.next() % cap.max(1)
    }
    fn wide(&mut self) -> u128 {
        let hi = self.next() as u128;
        let lo = self.next() as u128;
        let shift = self.next() % 128;
        ((hi << 64) | lo) >> shift
    }
}

fn s<T: ToString>(v: T) -> Value {
    Value::String(v.to_string())
}
fn opt<T: ToString>(v: Option<T>) -> Value {
    v.map(s).unwrap_or(Value::Null)
}
fn res(r: &CurveReserves) -> Value {
    json!({ "virtualSol": s(r.virtual_sol), "virtualToken": s(r.virtual_token), "realSol": s(r.real_sol), "realToken": s(r.real_token) })
}

fn curve(rng: &mut Rng) -> Value {
    let p = Params::default();
    let mut r = initial_reserves(p.initial_virtual_sol, p.initial_virtual_token, p.curve_supply);
    let mut steps = vec![];
    let mut held: u64 = 0;
    for i in 0..400 {
        let before = r;
        if i % 3 != 2 || held == 0 {
            let sol_in = rng.amount(if i % 50 == 49 { 100_000_000_000 } else { 3_000_000_000 });
            let q = quote_buy(&r, sol_in).unwrap();
            r.apply_buy(&q).unwrap();
            held += q.tokens_out;
            steps.push(json!({ "op": "buy", "before": res(&before), "solIn": s(sol_in), "solUsed": s(q.sol_used), "tokensOut": s(q.tokens_out), "completes": q.completes, "spotQ64": opt(before.spot_price_q64()) }));
            if q.completes {
                break;
            }
        } else {
            let t = 1 + rng.next() % held;
            let out = quote_sell(&r, t);
            if let Some(o) = out {
                r.apply_sell(t, o).unwrap();
                held -= t;
            }
            steps.push(json!({ "op": "sell", "before": res(&before), "tokensIn": s(t), "solOut": opt(out), "spotQ64": opt(before.spot_price_q64()) }));
        }
    }
    let mut inverse = vec![];
    let fresh = initial_reserves(p.initial_virtual_sol, p.initial_virtual_token, p.curve_supply);
    for t in [1u64, 1_000_000, 35_000_000_000_000, p.curve_supply - 1, p.curve_supply, p.curve_supply + 1] {
        inverse.push(json!({ "reserves": res(&fresh), "tokensOut": s(t), "sol": opt(sol_for_tokens(&fresh, t)) }));
    }
    json!({ "steps": steps, "inverse": inverse })
}

fn fees(rng: &mut Rng) -> Value {
    let p = Params::default().coin_fees();
    let mut v = vec![];
    for amt in [0u64, 1, 99, 100, 101, 12_345_678, 10_000_000_000, u64::MAX / 10_000] {
        let f = compute_fee(amt, &p).unwrap();
        v.push(json!({ "amount": s(amt), "total": s(f.total), "pool": s(f.pool), "platform": s(f.platform), "creator": s(f.creator) }));
    }
    for _ in 0..200 {
        let amt = rng.amount(u64::MAX / 10_000);
        let f = compute_fee(amt, &p).unwrap();
        v.push(json!({ "amount": s(amt), "total": s(f.total), "pool": s(f.pool), "platform": s(f.platform), "creator": s(f.creator) }));
    }
    Value::Array(v)
}

fn price(rng: &mut Rng) -> Value {
    let mut pq = vec![];
    let mut md = vec![];
    let mut mm = vec![];
    let mut lf = vec![];
    for _ in 0..200 {
        let (l, t) = (rng.amount(u64::MAX), rng.amount(u64::MAX));
        pq.push(json!({ "lamports": s(l), "tokens": s(t), "q": opt(price_q64(l, t)) }));
        let (a, b, d) = (rng.wide(), rng.wide(), rng.wide().max(1));
        md.push(json!({ "a": s(a), "b": s(b), "d": s(d), "q": opt(mul_div_ceil(a, b, d)) }));
        let (c, rf) = (rng.wide(), rng.wide());
        let bps = (10_001 + rng.next() % 200_000) as u32;
        mm.push(json!({ "current": s(c), "reference": s(rf), "bps": bps, "ok": meets_multiple(c, rf, bps) }));
        let tok = rng.amount(u64::MAX);
        let pr = rng.wide() >> 40;
        lf.push(json!({ "tokens": s(tok), "priceQ64": s(pr), "lamports": opt(lamports_for(tok, pr)) }));
    }
    // Edge cases.
    pq.push(json!({ "lamports": "5", "tokens": "0", "q": Value::Null }));
    md.push(json!({ "a": s(u128::MAX), "b": s(u128::MAX), "d": s(u128::MAX - 1), "q": opt(mul_div_ceil(u128::MAX, u128::MAX, u128::MAX - 1)) }));
    md.push(json!({ "a": "10", "b": "10", "d": "3", "q": "34" }));
    json!({ "priceQ64": pq, "mulDivCeil": md, "meetsMultiple": mm, "lamportsFor": lf })
}

fn reference(rng: &mut Rng) -> Value {
    let base: u128 = 1 << 64;
    let mut seqs = vec![];
    for k in 0..20 {
        let mut st = ReferencePrice::new(base * (1 + k as u128) / 7, 1_800_000_000);
        let init = st;
        let mut now = 1_800_000_000i64;
        let mut steps = vec![];
        for _ in 0..40 {
            now += (rng.next() % 900) as i64 - if rng.next() % 10 == 0 { 30 } else { 0 };
            let pre = base / 1000 + (rng.wide() % (base * 40));
            let post = base / 1000 + (rng.wide() % (base * 40));
            let (kind, name) = match rng.next() % 4 {
                0 => (Touch::Curve, "curve"),
                1 => (Touch::Venue, "venue"),
                2 => (Touch::KeeperSample, "keeper-sample"),
                _ => (Touch::FallbackSample, "fallback-sample"),
            };
            st.touch(now, pre, post, kind);
            steps.push(json!({ "now": s(now), "pre": s(pre), "post": s(post), "kind": name, "avg": s(st.avg_q64), "last": s(st.last_spot_q64), "updatedAt": s(st.updated_at) }));
        }
        seqs.push(json!({ "init": { "avg": s(init.avg_q64), "last": s(init.last_spot_q64), "updatedAt": s(init.updated_at) }, "steps": steps }));
    }
    let mut tp = vec![];
    for _ in 0..300 {
        let e = rng.wide() >> 20;
        let rf = rng.wide() >> 20;
        let pre = if rng.next() % 10 == 0 { 0 } else { rng.wide() >> 20 };
        tp.push(json!({ "exec": s(e), "reference": s(rf), "pre": s(pre), "ticket": s(ticket_price_q64(e, rf, pre)) }));
    }
    let p = 1u128 << 64;
    for (e, rf, pre) in [(p * 97 / 100, p, p), (p * 49 / 100, p, p), (p * 9 / 10, p, p), (p / 20 * 99 / 100, p, p / 20)] {
        tp.push(json!({ "exec": s(e), "reference": s(rf), "pre": s(pre), "ticket": s(ticket_price_q64(e, rf, pre)) }));
    }
    json!({ "sequences": seqs, "ticketPrice": tp })
}

fn position(matured: u64, pending: u64, pending_since: i64, open_count: u8, last_balance: u64) -> Position {
    Position {
        bump: 0,
        wallet: Pubkey::default(),
        mint: Pubkey::default(),
        matured,
        pending,
        pending_since,
        next_ticket_seq: 0,
        open_tickets: [Pubkey::default(); 5],
        open_count,
        last_balance,
        reserved: [0; 56],
    }
}

fn rewards(rng: &mut Rng) -> Value {
    let p = Params::default();
    let mut ps = vec![];
    for _ in 0..300 {
        let matured = if rng.next() % 4 == 0 { 0 } else { rng.amount(1_000_000_000_000) };
        let pending = if rng.next() % 3 == 0 { 0 } else { rng.amount(1_000_000_000_000) };
        let since = 1_000 + (rng.next() % 1_000) as i64;
        let open = (rng.next() % 6) as u8;
        let creator = rng.next() % 10 == 0;
        let sold = rng.amount(2_000_000_000_000);
        let bal = sold + if rng.next() % 2 == 0 { 0 } else { rng.amount(1_000_000_000_000) };
        let now = since + (rng.next() % 1_300) as i64;
        // last_balance: legacy 0, exactly tracked, or below/above the current balance.
        let last = match rng.next() % 4 { 0 => 0, 1 => matured + pending, 2 => bal / 2, _ => bal + rng.amount(1_000_000) };
        let mut pos = position(matured, pending, since, open, last);
        let r = logic::plan_sell(&mut pos, &p, creator, sold, bal, now);
        let (tokens, reason) = match r {
            Ok(t) => (Value::String(t.to_string()), Value::Null),
            Err(e) => (Value::Null, Value::String(format!("{e:?}"))),
        };
        ps.push(json!({ "matured": s(matured), "pending": s(pending), "pendingSince": s(since), "openCount": open, "lastBalance": s(last), "isCreator": creator, "sold": s(sold), "balance": s(bal), "now": s(now), "tokens": tokens, "reason": reason }));
    }
    let mut rb = vec![];
    let statuses = [TicketStatus::Open, TicketStatus::Queued, TicketStatus::Claimed, TicketStatus::Voided];
    for _ in 0..200 {
        let n = 1 + rng.next() % 5;
        let now = 2_000_000i64;
        let tickets: Vec<logic::RebuyView> = (0..n)
            .map(|i| logic::RebuyView {
                sell_ts: now - (rng.next() % (9 * 86_400)) as i64,
                seq: i,
                tokens: if rng.next() % 8 == 0 { 0 } else { rng.amount(1_000_000_000) },
                status: statuses[(rng.next() % 4) as usize],
            })
            .collect();
        let amount = rng.amount(3_000_000_000);
        let d = logic::plan_rebuy(&tickets, amount, now, p.rebuy_window_secs);
        let tj: Vec<Value> = tickets
            .iter()
            .map(|t| json!({ "sellTs": s(t.sell_ts), "seq": s(t.seq), "tokens": s(t.tokens), "status": format!("{:?}", t.status).to_lowercase() }))
            .collect();
        rb.push(json!({ "tickets": tj, "amount": s(amount), "now": s(now), "window": s(p.rebuy_window_secs), "debits": d.iter().map(|x| s(*x)).collect::<Vec<_>>() }));
    }
    let mut claims = vec![];
    for _ in 0..100 {
        let t = rng.amount(u64::MAX / 2);
        let pool = rng.amount(u64::MAX / 2);
        let amt = logic::claim_amount(t, p.claim_bps);
        claims.push(json!({ "tokens": s(t), "pool": s(pool), "claimAmount": s(amt), "claimCap": s(logic::claim_cap(pool, p.max_claim_pool_bps)), "fits": logic::fits(amt, pool, p.max_claim_pool_bps) }));
    }
    let mut usd = vec![];
    for _ in 0..100 {
        let l = rng.amount(1_000_000_000_000_000);
        let price = 1 + rng.next() % 50_000_000_000;
        let e = -((rng.next() % 10) as i32);
        usd.push(json!({ "lamports": s(l), "price": s(price), "exponent": e, "cents": opt(lamports_to_usd_cents(l, &UsdPrice { price, exponent: e })) }));
    }
    json!({ "planSell": ps, "planRebuy": rb, "claims": claims, "usdCents": usd })
}

fn median(rng: &mut Rng) -> Value {
    let mut cases = vec![];
    for _ in 0..24 {
        let mut o: Box<Observations> = Box::new(bytemuck::Zeroable::zeroed());
        let window = [120i64, 600, 1_800][(rng.next() % 3) as usize];
        let spacing = 1 + (rng.next() % (window as u64 / 20)) as i64;
        let n = 10 + rng.next() % 300;
        let mut t = 1_000_000i64;
        let mut samples = vec![];
        for _ in 0..n {
            t += spacing + if rng.next() % 9 == 0 { (rng.next() % (window as u64 / 3)) as i64 } else { 0 };
            let price = 1 + (rng.wide() >> 40);
            let fallback = rng.next() % 5 == 0;
            o.push(t, price, fallback);
            samples.push(json!({ "ts": s(t), "price": s(price), "fallback": fallback }));
        }
        let min = [3u16, 20, 84][(rng.next() % 3) as usize];
        let now = t + (rng.next() % 30) as i64;
        // Only the ring's surviving samples (last 256) matter.
        let keep = samples.len().saturating_sub(256);
        cases.push(json!({ "samples": samples[keep..].to_vec(), "now": s(now), "window": s(window), "min": min, "median": opt(o.median_price_q64(now, window, min)) }));
    }
    Value::Array(cases)
}

fn main() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let out = json!({
        "generatedBy": "services/sdk/test-vectors (fumpad crate math)",
        "params": { "feeBps": 100, "feePoolShareBps": 5000, "feePlatformShareBps": 3000, "feeCreatorShareBps": 2000 },
        "curve": curve(&mut rng),
        "fees": fees(&mut rng),
        "price": price(&mut rng),
        "reference": reference(&mut rng),
        "rewards": rewards(&mut rng),
        "median": median(&mut rng),
    });
    println!("{}", serde_json::to_string(&out).unwrap());
}
