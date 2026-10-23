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
    assert.deepEqual(r, { amount: "8.00000000", limit: "1", limitBits: 5292880 });
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
    assert.deepEqual(r, { amount: "8.000", limit: "1", limitBits: 5292880 });
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
    assert.deepEqual(got, { amount: "3.00000000", limit: "2", limitBits: 5358416 });
});

test("getSellAt returns the highest-limit sell first", async () => {
    const e = await freshEngine({ baseDecimals: 3 });
    e.setPool({ base: "100", quote: "200" });
    e.addSell({ limit: "1", amount: "5" });
    e.addSell({ limit: "2", amount: "3" });
    const got = e.getSellAt(0);
    // sells[0] is the highest-limit sell (DESC), so limit=2 comes first
    assert.deepEqual(got, { amount: "3.000", limit: "2", limitBits: 5358416 });
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
                limit: "8",
                limitBits: 5489488,
            },
            {
                amount: "600.00000000",
                filled: "600.00000000",
                limit: "6",
                limitBits: 5476988,
            },
            {
                amount: "400.00000000",
                filled: "297.55156325",
                limit: "4",
                limitBits: 5423952,
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
                limit: "7",
                limitBits: 5483238,
            },
            {
                amount: "200.000",
                filled: "200.000",
                limit: "4",
                limitBits: 5423952,
            },
            {
                amount: "100.000",
                filled: "100.000",
                limit: "3",
                limitBits: 5411452,
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
// ─── Limit round-trip (regression) ───────────────────────────────────────
//
// `make_order` used to render limits with `std::to_string`, i.e. 6 fixed
// decimal places. Reading an order back out and re-adding it then moved
// the price, because printing rounds to nearest while `from_double` floors
// onto the 16-bit mantissa grid: a save/restore cycle shifted limits down
// by up to two grid steps, and at small magnitudes every distinct price
// printed as "0.000000". Limits must be a fixed point of
// `parse(print(limit))` so a book can be exported and restored exactly.

test("getBuyAt / addBuy round-trip is exact", async () => {
    const e = await freshEngine();
    e.addBuy({ limit: "1.732153", amount: "10" });
    const original = e.getBuyAt(0)!;

    const restored = await freshEngine();
    restored.addBuy(original);

    assert.deepEqual(restored.getBuyAt(0), original);
});

test("getSellAt / addSell round-trip is exact", async () => {
    const e = await freshEngine();
    e.addSell({ limit: "0.8000049", amount: "10" });
    const original = e.getSellAt(0)!;

    const restored = await freshEngine();
    restored.addSell(original);

    assert.deepEqual(restored.getSellAt(0), original);
});

test("limits survive a restore at small magnitudes", async () => {
    // Every one of these used to print as "0.000000" under the old
    // 6-decimal rendering, so the whole book collapsed to one price.
    const limits = ["0.000015259", "0.000015260", "0.000015261", "0.000015262"];
    const e = await freshEngine();
    for (const limit of limits) e.addSell({ limit, amount: "1" });

    const before = e.match().sells;
    assert.equal(before.length, limits.length);

    const restored = await freshEngine();
    for (const order of before) {
        restored.addSell({ limit: order.limit, amount: order.amount });
    }
    assert.deepEqual(restored.match().sells, before);
});

test("a full book and pool survive a save/restore cycle", async () => {
    const e = await freshEngine();
    e.setPool({ base: "100", quote: "200" });
    // Off-grid limits: these are the ones that drifted before the fix.
    e.addBuy({ limit: "1.732153", amount: "20" });
    e.addBuy({ limit: "1.9", amount: "15" });
    e.addSell({ limit: "0.8000049", amount: "20" });
    e.addSell({ limit: "2.1", amount: "10" });
    const before = e.match();

    const restored = await freshEngine();
    restored.setPool(e.getPool());
    for (const o of before.buys) restored.addBuy({ limit: o.limit, amount: o.amount });
    for (const o of before.sells) restored.addSell({ limit: o.limit, amount: o.amount });

    assert.deepEqual(restored.match(), before);
});

test("limits are the shortest round-trip decimal, not 6 fixed places", async () => {
    const e = await freshEngine();
    e.addBuy({ limit: "1", amount: "1" });
    e.addBuy({ limit: "1.5", amount: "1" });
    assert.equal(e.getBuyAt(0)!.limit, "1.5");
    assert.equal(e.getBuyAt(1)!.limit, "1");
});

// ─── Input validation errors (regression) ────────────────────────────────
//
// `parse_order` used to call `.value()` on a possibly-empty optional and to
// cast with `emval::as<std::string>` before checking the JS type. An
// unparsable limit surfaced as "Cannot get limit", and a non-string limit
// threw an uncatchable JS BindingError out of `addBuy` instead of returning
// `{ error }`.

test("unparsable limit returns an error instead of throwing", async () => {
    const e = await freshEngine();
    const r = e.addBuy({ limit: "1e999", amount: "1" });
    assert.ok("error" in r);
    assert.match(r.error, /Cannot parse limit "1e999"/);
    assert.equal(e.match().buys.length, 0);
});

test("non-string fields return an error instead of throwing", async () => {
    const e = await freshEngine();
    for (const bad of [
        { limit: 5 as unknown as string, amount: "1" },
        { limit: null as unknown as string, amount: "1" },
        { limit: "1", amount: 5 as unknown as string },
    ]) {
        const r = e.addBuy(bad);
        assert.ok("error" in r, JSON.stringify(bad));
    }
    assert.equal(e.match().buys.length, 0);
});

test("non-object order returns an error instead of throwing", async () => {
    const e = await freshEngine();
    const r = e.addSell(undefined as never);
    assert.ok("error" in r);
});

// ─── Raw price-grid bits (limitBits) ────────────────────────────────────
//
// The decimal `limit` string is a rendering of the price grid: parsing
// it back re-snaps it, and at baseDecimals != 8 the scaling through a
// double can drop a grid cell. `limitBits` carries the grid value
// itself (mantissa | exponent << 16), so an order restored from bits is
// identical to the original, whatever the decimal count is.

test("limitBits round-trips exactly through addBuy / addSell", async () => {
    const e = await freshEngine();
    e.addBuy({ limit: "1.732153", amount: "10" });
    e.addSell({ limit: "0.8000049", amount: "20" });

    const restored = await freshEngine();
    restored.addBuy({ limitBits: e.getBuyAt(0)!.limitBits, amount: e.getBuyAt(0)!.amount });
    restored.addSell({ limitBits: e.getSellAt(0)!.limitBits, amount: e.getSellAt(0)!.amount });

    assert.deepEqual(restored.getBuyAt(0), e.getBuyAt(0));
    assert.deepEqual(restored.getSellAt(0), e.getSellAt(0));
});

test("limitBits is exact at baseDecimals != 8, where the decimal string is not", async () => {
    const e = await freshEngine({ baseDecimals: 3 });
    e.addBuy({ limit: "2.2125", amount: "10" });
    const original = e.getBuyAt(0)!;

    const restored = await freshEngine({ baseDecimals: 3 });
    restored.addBuy({ limitBits: original.limitBits, amount: original.amount });

    assert.deepEqual(restored.getBuyAt(0), original);
});

test("every order accessor exposes limitBits", async () => {
    const e = await freshEngine();
    e.addBuy({ limit: "1.5", amount: "1" });
    e.addSell({ limit: "2.5", amount: "1" });

    for (const o of [e.getBuyAt(0)!, e.getSellAt(0)!, ...e.match().buys, ...e.match().sells]) {
        assert.equal(typeof o.limitBits, "number");
        assert.ok(Number.isInteger(o.limitBits));
        assert.ok(o.limitBits >= 0 && o.limitBits <= 0x7fffff);
    }
});

test("limitBits wins over a conflicting decimal limit", async () => {
    const e = await freshEngine();
    e.addBuy({ limit: "1.5", amount: "1" });
    const bits = e.getBuyAt(0)!.limitBits;

    const other = await freshEngine();
    other.addBuy({ limit: "9.9", limitBits: bits, amount: "1" });

    assert.equal(other.getBuyAt(0)!.limit, "1.5");
});

test("an invalid limitBits returns an error instead of throwing", async () => {
    const e = await freshEngine();
    // 0 is not a valid mantissa/exponent pair, so it cannot name a price.
    const r = e.addBuy({ limitBits: 0, amount: "1" });
    assert.ok("error" in r);
    assert.equal(e.match().buys.length, 0);
});

test("a whole book restored from limitBits is identical", async () => {
    const e = await freshEngine();
    e.setPool({ base: "100", quote: "200" });
    e.addBuy({ limit: "1.732153", amount: "20" });
    e.addBuy({ limit: "1.9", amount: "15" });
    e.addSell({ limit: "0.8000049", amount: "20" });
    e.addSell({ limit: "2.1", amount: "10" });
    const before = e.match();

    const restored = await freshEngine();
    restored.setPool(e.getPool());
    for (const o of before.buys) restored.addBuy({ limitBits: o.limitBits, amount: o.amount });
    for (const o of before.sells) restored.addSell({ limitBits: o.limitBits, amount: o.amount });

    assert.deepEqual(restored.match(), before);
});
