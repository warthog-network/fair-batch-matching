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
    e.setPool({ base: "1000", quote: "5000" }); // pool price = 5 WART/token
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