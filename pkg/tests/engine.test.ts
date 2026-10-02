import { test } from "node:test";
import assert from "node:assert/strict";
import { freshEngine } from "./helpers.js";

// ─── Configuration & state invariants ────────────────────────────────────

test("defaults: baseDecimals=8, feeE4=5, pool=(0,0)", async () => {
    const e = await freshEngine();
    assert.deepEqual(e.getConfig(), { baseDecimals: 8, feeE4: 5 });
    // FundsDecimal::to_string returns "0" (no decimal padding) when value is 0.
    assert.equal(e.getPoolBase(), "0");
    assert.equal(e.getPoolQuote(), "0");
});

test("constructor with custom config", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 10 });
    assert.deepEqual(e.getConfig(), { baseDecimals: 3, feeE4: 10 });
    assert.equal(e.getPoolBase(), "0"); // formatted with baseDecimals=3
});

test("multiple instances are independent", async () => {
    const a = await freshEngine();
    const b = await freshEngine();
    a.setPoolBase({ value: "100" });
    b.setPoolBase({ value: "200" });
    assert.equal(a.getPoolBase(), "100.00000000");
    assert.equal(b.getPoolBase(), "200.00000000");
    a.reset();
    assert.equal(a.getPoolBase(), "0");
    assert.equal(b.getPoolBase(), "200.00000000");
});

// ─── Reset semantics ──────────────────────────────────────────────────────

test("reset() and reset({}) are equivalent", async () => {
    const e1 = await freshEngine({ baseDecimals: 3, feeE4: 7 });
    const e2 = await freshEngine({ baseDecimals: 3, feeE4: 7 });
    e1.setPoolBase({ value: "100" });
    e2.setPoolBase({ value: "100" });
    e1.reset();
    e2.reset({});
    assert.equal(e1.getPoolBase(), e2.getPoolBase());
    assert.equal(e1.getPoolQuote(), e2.getPoolQuote());
    assert.deepEqual(e1.getConfig(), e2.getConfig());
});

test("reset() clears book + pool, preserves config", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 7 });
    e.setPoolBase({ value: "100" });
    e.setPoolQuote({ value: "200" });
    e.addSell({ price: "1", amount: "10" });
    e.reset();
    assert.equal(e.getPoolBase(), "0");
    assert.equal(e.getPoolQuote(), "0");
    assert.deepEqual(e.getConfig(), { baseDecimals: 3, feeE4: 7 });
});

test("reset({baseDecimals: 3}) preserves feeE4", async () => {
    const e = await freshEngine({ baseDecimals: 8, feeE4: 10 });
    e.reset({ baseDecimals: 3 });
    assert.deepEqual(e.getConfig(), { baseDecimals: 3, feeE4: 10 });
});

test("reset({feeE4: 50}) preserves baseDecimals", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 5 });
    e.reset({ feeE4: 50 });
    assert.deepEqual(e.getConfig(), { baseDecimals: 3, feeE4: 50 });
});

test("reset({baseDecimals: 'oops'}) is atomic — config unchanged", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 5 });
    e.setPoolBase({ value: "100" });
    e.setPoolQuote({ value: "200" });
    const cfgBefore = e.getConfig();
    const poolBefore = e.getPoolBase();
    // Bypass the type check to feed a bad value at runtime.
    const r = e.reset({ baseDecimals: "oops" } as unknown as { baseDecimals?: number });
    assert.ok("error" in r);
    assert.deepEqual(e.getConfig(), cfgBefore);
    assert.equal(e.getPoolBase(), poolBefore);
});

// ─── Mutator atomicity ────────────────────────────────────────────────────

test("setPoolBase({value: 'garbage'}) is atomic", async () => {
    const e = await freshEngine();
    e.setPoolBase({ value: "100" });
    const before = e.getPoolBase();
    const r = e.setPoolBase({ value: "garbage" });
    assert.ok("error" in r);
    assert.equal(e.getPoolBase(), before);
});

test("setPoolQuote({value: 'garbage'}) is atomic", async () => {
    const e = await freshEngine();
    e.setPoolQuote({ value: "500" });
    const before = e.getPoolQuote();
    const r = e.setPoolQuote({ value: "garbage" });
    assert.ok("error" in r);
    assert.equal(e.getPoolQuote(), before);
});

// ─── Pure-parse validators (no state change) ───────────────────────────

test("validatePrice accepts well-formed input", async () => {
    const e = await freshEngine();
    const r = e.validatePrice({ price: "1.5" });
    assert.deepEqual(r, { ok: true });
});

test("validatePrice rejects missing", async () => {
    const e = await freshEngine();
    const r = e.validatePrice({});
    assert.ok("error" in r);
});

test("validatePrice rejects bad price", async () => {
    const e = await freshEngine();
    const r = e.validatePrice({ price: "oops" });
    assert.ok("error" in r);
});

test("validateBaseAmount parses WART (8 decimals)", async () => {
    const e = await freshEngine();
    assert.deepEqual(e.validateBaseAmount({ amount: "100" }), { ok: true });
    assert.ok("error" in e.validateBaseAmount({ amount: "garbage" }));
});

test("validateQuoteAmount parses with current baseDecimals", async () => {
    const e = await freshEngine({ baseDecimals: 3 });
    assert.deepEqual(e.validateQuoteAmount({ amount: "100" }), { ok: true });
    assert.ok("error" in e.validateQuoteAmount({ amount: "garbage" }));
});

test("validators do NOT mutate state", async () => {
    const e = await freshEngine();
    e.validatePrice({ price: "1.5" });
    e.validateBaseAmount({ amount: "100" });
    e.validateQuoteAmount({ amount: "50" });
    assert.equal(e.match().buys.length, 0);
    assert.equal(e.match().sells.length, 0);
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
    e.setPoolBase({ value: "1000" });
    e.setPoolQuote({ value: "5000" }); // pool price = 5 WART/token
    e.addSell({ price: "3", amount: "100" }); // below pool — routes to pool
    e.addSell({ price: "4", amount: "200" }); // at pool — routes to pool
    e.addSell({ price: "7", amount: "300" }); // above pool — needs buyer at 7+
    e.addBuy({ price: "4", amount: "400" }); // below pool price — no counterparty
    e.addBuy({ price: "6", amount: "600" }); // matches sells at 7
    e.addBuy({ price: "8", amount: "800" }); // matches sells at 7 fully, then via pool
    const m = e.match();
    assert.deepEqual(m, {
        buys: [
            {
                amount: "800.00000000",
                filled: "800.00000000",
                limit: 8,
            },
            {
                amount: "600.00000000",
                filled: "600.00000000",
                limit: 6.000000000000001,
            },
            {
                amount: "400.00000000",
                filled: "0",
                limit: 4,
            },
        ],
        filled: {
            inBaseBuyer: "287.209",
            inQuoteSeller: "1463.08413581",
            outBaseSeller: "300.000",
            outQuoteBuyer: "1400.00000000",
            priceBuyer: 4.874499058177147,
            priceSeller: 4.876947119366667,
        },
        matched: {
            base: "287.209",
            price: 4.874499058177147,
            quote: "1400.00000000",
        },
        poolAfter: {
            base: "1012.791",
            price: 4.874565299444801,
            quote: "4936.91586419",
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
                limit: 7.000000000000001,
            },
            {
                amount: "200.000",
                filled: "200.000",
                limit: 4,
            },
            {
                amount: "100.000",
                filled: "100.000",
                limit: 3.0000000000000004,
            },
        ],
        toPool: {
            base: "12.791",
            isQuote: false,
            price: 4.931915863497772,
            quote: "63.08413581",
        },
    } as typeof m);
});