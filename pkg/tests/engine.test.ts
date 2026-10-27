import { test } from "node:test";
import assert from "node:assert/strict";
import { freshEngine } from "./helpers.js";
import type { MatchedLevel, MatchedOrder } from "../index.js";

// The book is reported as price levels, each carrying its individual
// orders. These helpers flatten the levels back to the individual orders.
const flatten = (levels: MatchedLevel[]): MatchedOrder[] => levels.flatMap((l) => l.orders);
const sumProceeds = (orders: MatchedOrder[]) =>
    orders.reduce((acc, o) => acc + Number(o.proceeds), 0);

// ─── Configuration & state invariants ────────────────────────────────────

test("defaults: baseDecimals=8, feeE4=50, pool=(0,0)", async () => {
    const e = await freshEngine();
    assert.deepEqual(e.getConfig(), { baseDecimals: 8, feeE4: 50 });
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
    assert.equal(e.getConfig().feeE4, 50); // unchanged
});

// ─── Order deletion ──────────────────────────────────────────────────────

test("deleteBuyAt returns the deleted order", async () => {
    const e = await freshEngine({ baseDecimals: 3 });
    e.setPool({ base: "100", quote: "200" });
    e.addBuy({ limit: "1", amount: "5" });
    e.addBuy({ limit: "1", amount: "3" });   // same limit, stays a separate order
    e.addSell({ limit: "2", amount: "4" });
    // The book is reported as price levels: the two buys at limit 1 are one
    // level holding two orders.
    assert.equal(e.match().buys.length, 1);
    assert.equal(e.match().buys[0].orders.length, 2);
    assert.equal(e.match().sells.length, 1);

    const r = e.deleteBuyAt(0);
    assert.deepEqual(r, { amount: "5.00000000", caption: "", limit: "1", limitBits: 5292880 });
    assert.equal(e.match().buys.length, 1);
    assert.equal(e.match().buys[0].orders.length, 1);
    assert.equal(e.match().sells.length, 1);
});

test("deleteSellAt returns the deleted order", async () => {
    const e = await freshEngine({ baseDecimals: 3 });
    e.setPool({ base: "100", quote: "200" });
    e.addBuy({ limit: "2", amount: "5" });
    e.addSell({ limit: "1", amount: "5" });
    e.addSell({ limit: "1", amount: "3" });  // same limit, stays a separate order
    assert.equal(e.match().buys.length, 1);
    assert.equal(e.match().sells.length, 1);
    assert.equal(e.match().sells[0].orders.length, 2);

    const r = e.deleteSellAt(0);
    assert.deepEqual(r, { amount: "5.000", caption: "", limit: "1", limitBits: 5292880 });
    assert.equal(e.match().buys.length, 1);
    assert.equal(e.match().sells.length, 1);
    assert.equal(e.match().sells[0].orders.length, 1);
});

// ─── Per-order lookup (getBuyAt, getSellAt) ────────────────────────────

test("getBuyAt returns the order at the given index", async () => {
    const e = await freshEngine({ baseDecimals: 3 });
    e.setPool({ base: "100", quote: "200" });
    e.addBuy({ limit: "1", amount: "5" });
    e.addBuy({ limit: "2", amount: "3" });
    const got = e.getBuyAt(0);
    // buys[0] is the highest-limit buy (DESC), so limit=2 comes first
    assert.deepEqual(got, { amount: "3.00000000", caption: "", limit: "2", limitBits: 5358416 });
});

test("getSellAt returns the highest-limit sell first", async () => {
    const e = await freshEngine({ baseDecimals: 3 });
    e.setPool({ base: "100", quote: "200" });
    e.addSell({ limit: "1", amount: "5" });
    e.addSell({ limit: "2", amount: "3" });
    const got = e.getSellAt(0);
    // sells[0] is the highest-limit sell (DESC), so limit=2 comes first
    assert.deepEqual(got, { amount: "3.000", caption: "", limit: "2", limitBits: 5358416 });
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
    assert.deepEqual(m.pool.before, { base: "0", quote: "0", price: NaN });
    assert.deepEqual(m.pool.after, { base: "0", quote: "0", price: NaN });
    assert.equal(m.pool.swap, null);
    assert.deepEqual(m.pool.dust, { base: "0", quote: "0" });
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
    // Regenerated for the node-parity matching pipeline: the book is
    // aggregated by price level, the matched amounts are distributed back
    // to the individual orders, and the rounding dust that the floor
    // division leaves is credited back to the pool.
    //
    // The book is reported as price levels, each carrying its individual
    // orders.
    assert.deepEqual(m, {
        buys: [
            {
                amount: "800.00000000",
                filled: "800.00000000",
                limit: "8",
                limitBits: 5489488,
                orders: [
                    {
                        amount: "800.00000000",
                        caption: "",
                        filled: "800.00000000",
                        proceeds: "183.988",
                    },
                ],
                proceeds: "183.988",
            },
            {
                amount: "600.00000000",
                filled: "600.00000000",
                limit: "6",
                limitBits: 5476988,
                orders: [
                    {
                        amount: "600.00000000",
                        caption: "",
                        filled: "600.00000000",
                        proceeds: "137.991",
                    },
                ],
                proceeds: "137.991",
            },
            {
                amount: "400.00000000",
                filled: "297.55156325",
                limit: "4",
                limitBits: 5423952,
                orders: [
                    {
                        amount: "400.00000000",
                        caption: "",
                        filled: "297.55156325",
                        proceeds: "68.432",
                    },
                ],
                proceeds: "68.432",
            },
        ],
        filled: {
            inBaseBuyer: "390.411",
            inQuoteSeller: "1200.00000000",
            outBaseSeller: "300.000",
            outQuoteBuyer: "1697.55156325",
            priceBuyer: 4.3481140727336065,
            priceSeller: 4,
        },
        matched: {
            base: "390.413",
            price: 3.073668141173578,
            quote: "1200.00000000",
        },
        pool: {
            after: {
                base: "909.589",
                price: 6.043995214596921,
                quote: "5497.55156325",
            },
            before: {
                base: "1000.000",
                price: 5,
                quote: "5000.00000000",
            },
            dust: {
                base: "0.002",
                quote: "0",
            },
            swap: {
                in: "497.55156325",
                isQuote: true,
                out: "90.413",
                price: 5.503097599349651,
            },
        },
        sells: [
            {
                amount: "300.000",
                filled: "0",
                limit: "7",
                limitBits: 5483238,
                orders: [
                    {
                        amount: "300.000",
                        caption: "",
                        filled: "0",
                        proceeds: "0",
                    },
                ],
                proceeds: "0",
            },
            {
                amount: "200.000",
                filled: "200.000",
                limit: "4",
                limitBits: 5423952,
                orders: [
                    {
                        amount: "200.000",
                        caption: "",
                        filled: "200.000",
                        proceeds: "800.00000000",
                    },
                ],
                proceeds: "800.00000000",
            },
            {
                amount: "100.000",
                filled: "100.000",
                limit: "3",
                limitBits: 5411452,
                orders: [
                    {
                        amount: "100.000",
                        caption: "",
                        filled: "100.000",
                        proceeds: "400.00000000",
                    },
                ],
                proceeds: "400.00000000",
            },
        ],
    } as typeof m);
});

// ─── Rounding dust (node parity) ──────────────────────────────────────────
//
// The node distributes a match back to the individual orders with a *floor*
// division on the output side, so a few units are lost. The node credits
// that remainder ("dust") back to the pool reserves. The engine reports it
// as `pool.dust` and includes it in `pool.after`.

test("dust: floor division leaves a remainder that goes to the pool", async () => {
    // 7 base sold against 34 quote bought.
    //   seller proceeds: floor(3*34/7)=14.57142857, floor(4*34/7)=19.42857142
    //     -> 33.99999999, i.e. 1 E8 of dust
    //   buyer  proceeds: floor(20*7/34)=4.117, floor(14*7/34)=2.882
    //     -> 6.999, i.e. 0.001 of dust
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addSell({ limit: "1", amount: "3" });
    e.addSell({ limit: "1", amount: "4" });
    e.addBuy({ limit: "10", amount: "20" });
    e.addBuy({ limit: "10", amount: "14" });
    const m = e.match();

    assert.deepEqual(m.pool.dust, { base: "0.001", quote: "0.00000001" });
    // The pool was not traded with at all, but it still got the dust.
    assert.equal(m.pool.swap, null);
    assert.deepEqual(m.pool.before, { base: "0", quote: "0", price: NaN });
    assert.deepEqual(m.pool.after, { base: "0.001", quote: "0.00000001", price: 0.000009999999999999997 });
});

test("dust: the proceeds sum to the matched amount minus the dust", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addSell({ limit: "1", amount: "3" });
    e.addSell({ limit: "1", amount: "4" });
    e.addBuy({ limit: "10", amount: "20" });
    e.addBuy({ limit: "10", amount: "14" });
    const m = e.match();

    // The sums are decimal strings, so compare with a tolerance.
    const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    assert.ok(close(sumProceeds(flatten(m.sells)), Number(m.matched.quote) - Number(m.pool.dust.quote)));
    assert.ok(close(sumProceeds(flatten(m.buys)), Number(m.matched.base) - Number(m.pool.dust.base)));
});

test("dust: pool.after is pool.before plus the swap and the dust", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 10 });
    e.setPool({ base: "1000", quote: "5000" });
    e.addSell({ limit: "3", amount: "100" });
    e.addSell({ limit: "4", amount: "200" });
    e.addSell({ limit: "7", amount: "300" });
    e.addBuy({ limit: "4", amount: "400" });
    e.addBuy({ limit: "6", amount: "600" });
    e.addBuy({ limit: "8", amount: "800" });
    const m = e.match();

    const before = m.pool.before;
    const after = m.pool.after;
    const swap = m.pool.swap!;
    assert.notEqual(swap, null);

    // The swap moved quote in and base out of the reserves; the dust was
    // credited on top of that. The amounts are decimal strings, so compare
    // with a tolerance.
    const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    if (swap.isQuote) {
        assert.ok(close(Number(after.quote), Number(before.quote) + Number(swap.in) + Number(m.pool.dust.quote)));
        assert.ok(close(Number(after.base), Number(before.base) - Number(swap.out) + Number(m.pool.dust.base)));
    } else {
        assert.ok(close(Number(after.base), Number(before.base) + Number(swap.in) + Number(m.pool.dust.base)));
        assert.ok(close(Number(after.quote), Number(before.quote) - Number(swap.out) + Number(m.pool.dust.quote)));
    }
});

test("dust: a single order on each side leaves no dust", async () => {
    // One seller and one buyer: the floor division is exact, so nothing is
    // lost and the pool keeps its reserves.
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addSell({ limit: "1", amount: "3" });
    e.addBuy({ limit: "10", amount: "30" });
    const m = e.match();
    assert.deepEqual(m.pool.dust, { base: "0", quote: "0" });
    assert.equal(flatten(m.sells)[0].proceeds, "30.00000000");
    assert.equal(flatten(m.buys)[0].proceeds, "3.000");
});

test("match() does not mutate the pool or the book", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 10 });
    e.setPool({ base: "1000", quote: "5000" });
    e.addSell({ limit: "3", amount: "100" });
    e.addBuy({ limit: "8", amount: "800" });
    const poolBefore = e.getPool();
    const first = e.match();
    const second = e.match();
    assert.deepEqual(e.getPool(), poolBefore);
    assert.deepEqual(first, second);
});

// ─── Price levels ──────────────────────────────────────────────────────────
//
// The engine keeps one entry per order, but the FBM matches on price
// levels: the orders sharing a limit price are aggregated into one entry
// before the matching runs. The match result carries both views.

test("levels: orders at the same limit are aggregated into one level", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addSell({ limit: "1", amount: "3" });
    e.addSell({ limit: "1", amount: "4" });
    e.addSell({ limit: "5", amount: "2" });
    e.addBuy({ limit: "10", amount: "20" });
    e.addBuy({ limit: "10", amount: "14" });
    const m = e.match();

    // Two sell orders at limit 1, one at limit 5.
    assert.equal(m.sells.length, 2);
    assert.deepEqual(m.sells[0], {
        amount: "2.000",
        filled: "0",
        limit: "5",
        limitBits: 5436452,
        orders: [
            { amount: "2.000", caption: "", filled: "0", proceeds: "0" },
        ],
        proceeds: "0",
    });
    assert.equal(m.sells[1].limit, "1");
    assert.equal(m.sells[1].orders.length, 2);
    assert.equal(m.sells[1].amount, "7.000");
    assert.equal(m.sells[1].filled, "7.000");
    // The level's proceeds are the sum of the per-order proceeds, which is
    // slightly less than the matched quote: that difference is the dust.
    assert.equal(m.sells[1].proceeds, "33.99999999");
    assert.equal(m.pool.dust.quote, "0.00000001");
});

test("levels: a level's amounts are the sums of its orders", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addSell({ limit: "1", amount: "3" });
    e.addSell({ limit: "1", amount: "4" });
    e.addBuy({ limit: "10", amount: "20" });
    e.addBuy({ limit: "10", amount: "14" });
    const m = e.match();

    const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

    assert.equal(m.buys.length, 1);
    assert.equal(m.buys[0].orders.length, 2);
    assert.equal(m.buys[0].amount, "34.00000000");
    assert.equal(m.buys[0].filled, "34.00000000");
    assert.ok(close(sumProceeds(flatten(m.buys)), Number(m.buys[0].proceeds)));
    assert.ok(close(sumProceeds(flatten(m.sells)), Number(m.sells[0].proceeds)));
});

test("levels: the levels are descending by limit", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addSell({ limit: "1", amount: "3" });
    e.addSell({ limit: "5", amount: "2" });
    e.addSell({ limit: "9", amount: "1" });
    e.addBuy({ limit: "10", amount: "20" });
    const m = e.match();

    const limits = (levels: MatchedLevel[]) => levels.map((l) => l.limit);
    assert.deepEqual(limits(m.sells), ["9", "5", "1"]);
    assert.deepEqual(limits(m.buys), ["10"]);
});

test("levels: the flat book index of an order follows from the levels", async () => {
    // The levels partition the book in display order, so the flat index of
    // an order is the number of orders in the preceding levels plus its
    // position within its level. That is how a consumer addresses a single
    // order with `getBuyAt` / `deleteBuyAt`.
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addSell({ limit: "1", amount: "3" });
    e.addSell({ limit: "1", amount: "4" });
    e.addSell({ limit: "5", amount: "2" });
    e.addBuy({ limit: "10", amount: "20" });
    e.addBuy({ limit: "10", amount: "14" });
    e.addBuy({ limit: "12", amount: "5" });
    const m = e.match();

    let flatIndex = 0;
    for (const level of m.sells) {
        for (const order of level.orders) {
            const flat = e.getSellAt(flatIndex);
            assert.ok(flat, "the flat index must address an order");
            assert.equal(flat.amount, order.amount);
            assert.equal(flat.limit, level.limit);
            flatIndex += 1;
        }
    }
    assert.equal(flatIndex, 3);

    flatIndex = 0;
    for (const level of m.buys) {
        for (const order of level.orders) {
            const flat = e.getBuyAt(flatIndex);
            assert.ok(flat, "the flat index must address an order");
            assert.equal(flat.amount, order.amount);
            assert.equal(flat.limit, level.limit);
            flatIndex += 1;
        }
    }
    assert.equal(flatIndex, 3);
});

// ─── Priority within a price level ─────────────────────────────────────────
//
// The orders of a price level are kept in insertion order, oldest first,
// and the match fills them in that order. So the oldest order at a level is
// filled first and the latest added one is filled last: it has the least
// priority at that level. This is the node's rule too, it fills the orders
// at a price level in id ascending order.
//
// Note that the priority shows in the *input* fill of a level, which is
// only partial when the counterparty binds. When the counterparty does not
// take everything, the excess is pushed into the pool, and the level's
// input fill reads as complete.

test("priority: the oldest order at a level is filled first (sells)", async () => {
    // Three 100-base sells at limit 1, and a buyer that can only take 150.
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addSell({ limit: "1", amount: "100", caption: "first" });
    e.addSell({ limit: "1", amount: "100", caption: "second" });
    e.addSell({ limit: "1", amount: "100", caption: "third" });
    e.addBuy({ limit: "2", amount: "150" });

    const m = e.match();
    assert.equal(m.sells.length, 1);
    assert.deepEqual(m.sells[0].orders.map((o) => o.filled), ["100.000", "50.000", "0"]);
});

test("priority: the oldest order at a level is filled first (buys)", async () => {
    // Three 100-quote buys at limit 10, and 20 base of supply at the same
    // limit, so only 200 of the 300 quote can be filled.
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addBuy({ limit: "10", amount: "100", caption: "first" });
    e.addBuy({ limit: "10", amount: "100", caption: "second" });
    e.addBuy({ limit: "10", amount: "100", caption: "third" });
    e.addSell({ limit: "10", amount: "20" });

    const m = e.match();
    assert.equal(m.buys.length, 1);
    const fills = m.buys[0].orders.map((o) => Number(o.filled));
    // The oldest is filled in full, the newest gets nothing, the one in
    // between gets what is left.
    assert.equal(fills[0], 100);
    assert.equal(fills[2], 0);
    assert.ok(fills[1] > 0 && fills[1] < 100, `the middle order filled ${fills[1]}`);
});

test("priority: the orders of a level are listed oldest first", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    // Interleaved limits, so the levels are not added in one go.
    e.addSell({ limit: "1", amount: "100", caption: "A1" });
    e.addSell({ limit: "2", amount: "100", caption: "B2" });
    e.addSell({ limit: "1", amount: "100", caption: "A2" });
    e.addSell({ limit: "2", amount: "100", caption: "B2b" });
    e.addBuy({ limit: "10", amount: "100", caption: "C10" });
    e.addBuy({ limit: "8", amount: "100", caption: "D8" });
    e.addBuy({ limit: "10", amount: "100", caption: "C10b" });

    const m = e.match();
    const sellLevel = (limit: string) => m.sells.find((l) => l.limit === limit)!;
    const buyLevel = (limit: string) => m.buys.find((l) => l.limit === limit)!;
    assert.deepEqual(sellLevel("1").orders.map((o) => o.caption), ["A1", "A2"]);
    assert.deepEqual(sellLevel("2").orders.map((o) => o.caption), ["B2", "B2b"]);
    assert.deepEqual(buyLevel("10").orders.map((o) => o.caption), ["C10", "C10b"]);
});

test("priority: a newly added order goes last at its level", async () => {
    // The insert is stable: it goes after the orders already at that price,
    // also after some of them were deleted.
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addSell({ limit: "1", amount: "100", caption: "A" });
    e.addSell({ limit: "1", amount: "100", caption: "B" });
    e.addSell({ limit: "1", amount: "100", caption: "C" });
    e.deleteSellAt(1); // remove B
    e.addSell({ limit: "1", amount: "100", caption: "D" });

    const m = e.match();
    assert.equal(m.sells.length, 1);
    assert.deepEqual(m.sells[0].orders.map((o) => o.caption), ["A", "C", "D"]);
});

// ─── Deleting a whole price level ──────────────────────────────────────────

test("deleteBuysAtPrice removes every order at that price", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addBuy({ limit: "10", amount: "20" });
    e.addBuy({ limit: "10", amount: "14" });
    e.addBuy({ limit: "12", amount: "5" });
    const level = e.match().buys.find((l) => l.limit === "10")!;
    assert.equal(level.orders.length, 2);

    const res = e.deleteBuysAtPrice(level.limitBits);
    assert.deepEqual(res, { ok: true, deleted: 2 });
    const m = e.match();
    assert.equal(m.buys.length, 1);
    assert.equal(m.buys[0].limit, "12");
});

test("deleteSellsAtPrice removes every order at that price", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addSell({ limit: "1", amount: "3" });
    e.addSell({ limit: "1", amount: "4" });
    e.addSell({ limit: "5", amount: "2" });
    const level = e.match().sells.find((l) => l.limit === "1")!;
    assert.equal(level.orders.length, 2);

    const res = e.deleteSellsAtPrice(level.limitBits);
    assert.deepEqual(res, { ok: true, deleted: 2 });
    const m = e.match();
    assert.equal(m.sells.length, 1);
    assert.equal(m.sells[0].limit, "5");
});

test("deleteBuysAtPrice on an unused price removes nothing", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addBuy({ limit: "10", amount: "20" });
    const other = e.match().buys[0];
    // A different price level's bits.
    const res = e.deleteBuysAtPrice(other.limitBits + 0x10000);
    assert.deepEqual(res, { ok: true, deleted: 0 });
    assert.equal(e.match().buys.length, 1);
});

test("deleteBuysAtPrice rejects an invalid limit", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    const res = e.deleteBuysAtPrice(-1);
    assert.ok("error" in res);
});

// ─── Captions ──────────────────────────────────────────────────────────────
//
// A caption is a free-form label on an order. It is metadata only: it never
// influences the matching, and it is not unique, several orders may carry
// the same one.

test("caption: an order carries its caption", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addSell({ limit: "1", amount: "3", caption: "alice" });
    e.addBuy({ limit: "10", amount: "20", caption: "bob" });

    const m = e.match();
    assert.equal(m.sells[0].orders[0].caption, "alice");
    assert.equal(m.buys[0].orders[0].caption, "bob");

    assert.equal(e.getSellAt(0)!.caption, "alice");
    assert.equal(e.getBuyAt(0)!.caption, "bob");
    assert.equal(e.deleteSellAt(0)!.caption, "alice");
});

test("caption: an order without one has an empty caption", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addSell({ limit: "1", amount: "3" });
    assert.equal(e.getSellAt(0)!.caption, "");
    assert.equal(e.match().sells[0].orders[0].caption, "");
});

test("caption: several orders may share a caption", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    e.addSell({ limit: "1", amount: "3", caption: "alice" });
    e.addSell({ limit: "1", amount: "4", caption: "alice" });
    e.addSell({ limit: "1", amount: "1", caption: "bob" });
    e.addBuy({ limit: "10", amount: "20", caption: "alice" });

    const m = e.match();
    const captions = m.sells[0].orders.map((o) => o.caption);
    assert.deepEqual(captions, ["alice", "alice", "bob"]);
    assert.equal(m.buys[0].orders[0].caption, "alice");
});

test("caption: the caption does not influence the matching", async () => {
    // The same book with and without captions must produce the same
    // amounts.
    const book = (e: { addSell: Function; addBuy: Function }, caption?: string) => {
        e.addSell({ limit: "1", amount: "3", ...(caption ? { caption } : {}) });
        e.addSell({ limit: "1", amount: "4", ...(caption ? { caption } : {}) });
        e.addBuy({ limit: "10", amount: "20", ...(caption ? { caption } : {}) });
        e.addBuy({ limit: "10", amount: "14", ...(caption ? { caption } : {}) });
    };
    const plain = await freshEngine({ baseDecimals: 3, feeE4: 10 });
    book(plain);
    const captioned = await freshEngine({ baseDecimals: 3, feeE4: 10 });
    book(captioned, "alice");

    const strip = (m: ReturnType<typeof plain.match>) => ({
        buys: m.buys.map((l) => ({ ...l, orders: l.orders.map((o) => ({ ...o, caption: "" })) })),
        sells: m.sells.map((l) => ({ ...l, orders: l.orders.map((o) => ({ ...o, caption: "" })) })),
        pool: m.pool,
        filled: m.filled,
        matched: m.matched,
    });
    assert.deepEqual(strip(captioned.match()), strip(plain.match()));
});

test("caption: a non-string caption is rejected", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    const res = e.addSell({ limit: "1", amount: "3", caption: 42 as unknown as string });
    assert.ok("error" in res);
    assert.equal(e.match().sells.length, 0);
});

test("caption: an over-long caption is rejected", async () => {
    const e = await freshEngine({ baseDecimals: 3, feeE4: 0 });
    const res = e.addSell({ limit: "1", amount: "3", caption: "x".repeat(257) });
    assert.ok("error" in res);
    assert.equal(e.match().sells.length, 0);

    // 256 bytes is accepted.
    const ok = e.addSell({ limit: "1", amount: "3", caption: "x".repeat(256) });
    assert.deepEqual(ok, { ok: true });
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
