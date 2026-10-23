import { test } from "node:test";
import assert from "node:assert/strict";
import { freshEngine } from "./helpers.js";

// ─── Configuration & state invariants ────────────────────────────────────

test("defaults: baseDecimals=8, feeE4=5, pool=(0,0)", async () => {
    const e = await freshEngine();
    assert.deepEqual(e.getConfig(), { baseDecimals: 8, feeE4: 5 });
    // FundsDecimal::to_string returns "0" (no decimal padding) when value is 0.
    assert.deepEqual(e.getPool(), { base: "0", quote: "0" });
});

test("constructor with custom config", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 10 });
    assert.deepEqual(e.getConfig(), { baseDecimals: 3, feeE4: 10 });
    assert.equal(e.getPool().base, "0"); // formatted with baseDecimals=3
});

test("multiple instances are independent", async () => {
    const a = await freshEngine();
    const b = await freshEngine();
    a.setPool({ base: "100" });
    b.setPool({ base: "200" });
    assert.equal(a.getPool().base, "100.00000000");
    assert.equal(b.getPool().base, "200.00000000");
    a.setPool({ base: "0", quote: "0" });
    assert.equal(a.getPool().base, "0");
    assert.equal(b.getPool().base, "200.00000000");
});

// ─── setPool semantics ────────────────────────────────────────────────────

test("setPool({}) is a no-op", async () => {
    const e = await freshEngine();
    e.setPool({ base: "100", quote: "200" });
    const before = e.getPool();
    const r = e.setPool({});
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(e.getPool(), before);
});

test("setPool({base}) updates only base", async () => {
    const e = await freshEngine();
    e.setPool({ base: "100", quote: "200" });
    const r = e.setPool({ base: "300" });
    assert.deepEqual(r, { ok: true });
    assert.equal(e.getPool().base, "300.00000000");
    assert.equal(e.getPool().quote, "200.00000000");
});

test("setPool({quote}) updates only quote", async () => {
    const e = await freshEngine();
    e.setPool({ base: "100", quote: "200" });
    const r = e.setPool({ quote: "500" });
    assert.deepEqual(r, { ok: true });
    assert.equal(e.getPool().base, "100.00000000");
    assert.equal(e.getPool().quote, "500.00000000");
});

// ─── Mutator atomicity ────────────────────────────────────────────────────

test("setPool({base: 'garbage'}) is atomic — neither changes", async () => {
    const e = await freshEngine();
    e.setPool({ base: "100", quote: "200" });
    const before = e.getPool();
    const r = e.setPool({ base: "garbage" });
    assert.ok("error" in r);
    assert.deepEqual(e.getPool(), before);
});

test("setPool({quote: 'garbage'}) is atomic — neither changes", async () => {
    const e = await freshEngine();
    e.setPool({ base: "100", quote: "200" });
    const before = e.getPool();
    const r = e.setPool({ quote: "garbage" });
    assert.ok("error" in r);
    assert.deepEqual(e.getPool(), before);
});

test("setPool({base: 'ok', quote: 'garbage'}) is atomic — neither changes", async () => {
    const e = await freshEngine();
    e.setPool({ base: "100", quote: "200" });
    const before = e.getPool();
    const r = e.setPool({ base: "999", quote: "garbage" });
    assert.ok("error" in r);
    assert.deepEqual(e.getPool(), before);
});

// ─── Pure-parse validators (no state change) ───────────────────────────

test("validateLimit accepts well-formed input", async () => {
    const e = await freshEngine();
    const r = e.validateLimit("1.5");
    assert.deepEqual(r, { ok: true });
});

test("validateLimit rejects empty", async () => {
    const e = await freshEngine();
    const r = e.validateLimit("");
    assert.ok("error" in r);
});

test("validateLimit rejects bad limit", async () => {
    const e = await freshEngine();
    const r = e.validateLimit("oops");
    assert.ok("error" in r);
});

test("validateBaseAmount parses WART (8 decimals)", async () => {
    const e = await freshEngine();
    assert.deepEqual(e.validateBaseAmount("100"), { ok: true });
    assert.ok("error" in e.validateBaseAmount("garbage"));
});

test("validateQuoteAmount parses with current baseDecimals", async () => {
    const e = await freshEngine({ baseDecimals: 3 });
    assert.deepEqual(e.validateQuoteAmount("100"), { ok: true });
    assert.ok("error" in e.validateQuoteAmount("garbage"));
});

test("validators do NOT mutate state", async () => {
    const e = await freshEngine();
    e.validateLimit("1.5");
    e.validateBaseAmount("100");
    e.validateQuoteAmount("50");
    assert.equal(e.match().buys.length, 0);
    assert.equal(e.match().sells.length, 0);
});

// ─── setFeeE4 ────────────────────────────────────────────────────────────

test("setFeeE4 accepts valid range", async () => {
    const e = await freshEngine();
    const r = e.setFeeE4(30);
    assert.deepEqual(r, { ok: true });
    assert.equal(e.getConfig().feeE4, 30);
});

test("setFeeE4 rejects out-of-range", async () => {
    const e = await freshEngine();
    const r = e.setFeeE4(10000);
    assert.ok("error" in r);
    assert.equal(e.getConfig().feeE4, 5); // unchanged
});

// ─── Order deletion ──────────────────────────────────────────────────────

test("deleteBuyAt returns the deleted order", async () => {
    const e = await freshEngine({ baseDecimals: 3 });
    e.setPool({ base: "100", quote: "200" });
    e.addBuy({ limit: "1", amount: "5" });
    e.addBuy({ limit: "1", amount: "3" });   // merges with previous at limit 1
    e.addSell({ limit: "2", amount: "4" });
    assert.equal(e.match().buys.length, 1);
    assert.equal(e.match().sells.length, 1);

    const r = e.deleteBuyAt(0);
    assert.deepEqual(r, { amount: "8.00000000", limit: "1.000000" });
    assert.equal(e.match().buys.length, 0);
    assert.equal(e.match().sells.length, 1);
});

test("deleteSellAt returns the deleted order", async () => {
    const e = await freshEngine({ baseDecimals: 3 });
    e.setPool({ base: "100", quote: "200" });
    e.addBuy({ limit: "2", amount: "5" });
    e.addSell({ limit: "1", amount: "5" });
    e.addSell({ limit: "1", amount: "3" });  // merges with previous at limit 1
    assert.equal(e.match().buys.length, 1);
    assert.equal(e.match().sells.length, 1);

    const r = e.deleteSellAt(0);
    assert.deepEqual(r, { amount: "8.000", limit: "1.000000" });
    assert.equal(e.match().buys.length, 1);
    assert.equal(e.match().sells.length, 0);
});

// ─── Per-order lookup (getBuyAt, getSellAt) ────────────────────────────

test("getBuyAt returns the order at the given index", async () => {
    const e = await freshEngine({ baseDecimals: 3 });
    e.setPool({ base: "100", quote: "200" });
    e.addBuy({ limit: "1", amount: "5" });
    e.addBuy({ limit: "2", amount: "3" });
    const got = e.getBuyAt(0);
    // buys[0] is the highest-limit buy (DESC), so limit=2 comes first
    assert.deepEqual(got, { amount: "3.00000000", limit: "2.000000" });
});

test("getSellAt returns the highest-limit sell first", async () => {
    const e = await freshEngine({ baseDecimals: 3 });
    e.setPool({ base: "100", quote: "200" });
    e.addSell({ limit: "1", amount: "5" });
    e.addSell({ limit: "2", amount: "3" });
    const got = e.getSellAt(0);
    // sells[0] is the highest-limit sell (DESC), so limit=2 comes first
    assert.deepEqual(got, { amount: "3.000", limit: "2.000000" });
});

// ─── Match ──────────────────────────────────────────────────────────────

test("match() on empty engine returns all-zero result", async () => {
    const e = await freshEngine();
    const m = e.match();
    assert.equal(m.buys.length, 0);
    assert.equal(m.sells.length, 0);
    assert.equal(m.matched.base, "0");
    assert.equal(m.matched.quote, "0");
    assert.equal(m.matched.price, null);
});

test("match() on (0,0) pool with no orders keeps pool untouched", async () => {
    const e = await freshEngine();
    const m = e.match();
    assert.deepEqual(m.poolBefore, { base: "0", quote: "0", price: NaN });
    assert.deepEqual(m.poolAfter, { base: "0", quote: "0", price: NaN });
    assert.equal(m.matched.price, null);
});

// ─── Snapshot: comprehensive order book (locks down the FBM algorithm) ──

test("snapshot: 6 orders + pool (baseDecimals=3, feeE4=10)", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 10 });
    e.setPool({ base: "1000", quote: "5000" }); // pool price = 5 WART/token
    e.addSell({ limit: "3", amount: "100" }); // below pool — routes to pool
    e.addSell({ limit: "4", amount: "200" }); // at pool — routes to pool
    e.addSell({ limit: "7", amount: "300" }); // above pool — needs buyer at 7+
    e.addBuy({ limit: "4", amount: "400" }); // below pool price — no counterparty
    e.addBuy({ limit: "6", amount: "600" }); // matches sells at 7
    e.addBuy({ limit: "8", amount: "800" }); // matches sells at 7 fully, then via pool
    const m = e.match();
    // Regenerated after the matcher change in 6b176fc: the CASE (II) tie-break in
    // `bisect_fixed_price` now splits the buy at limit 4 between the order book
    // and the pool, where it previously filled nothing there.
    assert.deepEqual(m, {
        buys: [
            {
                amount: "800.00000000",
                filled: "800.00000000",
                limit: "8.000000",
            },
            {
                amount: "600.00000000",
                filled: "600.00000000",
                limit: "6.000000",
            },
            {
                amount: "400.00000000",
                filled: "297.55156325",
                limit: "4.000000",
            },
        ],
        filled: {
            inBaseBuyer: "390.413",
            inQuoteSeller: "1200.00000000",
            outBaseSeller: "300.000",
            outQuoteBuyer: "1697.55156325",
            priceBuyer: 4.348091798300774,
            priceSeller: 4,
        },
        matched: {
            base: "300.000",
            price: 4,
            quote: "1200.00000000",
        },
        poolAfter: {
            base: "909.587",
            price: 6.044008504134293,
            quote: "5497.55156325",
        },
        poolBefore: {
            base: "1000.000",
            price: 5,
            quote: "5000.00000000",
        },
        sells: [
            {
                amount: "300.000",
                filled: "0",
                limit: "7.000000",
            },
            {
                amount: "200.000",
                filled: "200.000",
                limit: "4.000000",
            },
            {
                amount: "100.000",
                filled: "100.000",
                limit: "3.000000",
            },
        ],
        toPool: {
            base: "90.413",
            isQuote: true,
            price: 5.503097599349651,
            quote: "497.55156325",
        },
    } as typeof m);
});