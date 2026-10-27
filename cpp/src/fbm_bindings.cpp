#include "defi/uint64/orderbook.hpp"
#include "defi/uint64/pool.hpp"
#include "defi/uint64/prod.hpp"
#include "general/funds.hpp"
#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <optional>
#include <stdexcept>
#include <stdio.h>
#include <vector>
using namespace std;

using emval = emscripten::val;

/*
 * FBM wasm bindings.
 *
 * Exposes a single `FbmEngine` class via `EMSCRIPTEN_BINDINGS(fbm)`.
 * Each JS-side `new Module.FbmEngine(config)` call constructs an
 * independent instance with its own order book, pool, `baseDecimals`,
 * and `feeE4`. The wasm module is shared; the state is not.
 *
 * Mutators are atomic: input is parsed before any state mutation, and
 * a parse failure returns `{ error: ... }` with **no** state change.
 *
 * `match()` is always safe to call: it returns a full result even with
 * a `(0, 0)` pool.
 *
 * See the `### fair-batch-matching` section in `AGENTS.md` for
 * cross-repo conventions (rename history, two-file TS declaration,
 * `from_string_adjusted` vs `from_string` rationale).
 */

/*
 * Invariant — pool reserves + order amounts are integers that were parsed
 * with the current `baseDecimals` setting. Changing `baseDecimals`
 * silently re-interprets those integers under a different decimal count,
 * producing values that mean something different from what was originally
 * entered. To prevent this, the engine deliberately omits a
 * `setBaseDecimals` method. `baseDecimals` is fixed at construction; to
 * use a different decimal count, construct a new `FbmEngine`.
 */

namespace {

emval make_error(const char* msg)
{
    emval obj = emval::object();
    obj.set("error", emval(std::string(msg)));
    return obj;
}

emval make_error(std::string msg)
{
    emval obj = emval::object();
    obj.set("error", emval(std::move(msg)));
    return obj;
}

emval make_ok()
{
    emval obj = emval::object();
    obj.set("ok", emval(true));
    return obj;
}

// Upper bound of Price_uint64::to_uint32().
constexpr long kMaxLimitBits { 0x7FFFFF };

// Upper bound of an order's caption, in bytes. The caption is a free-form
// label, so this only keeps a stray megabyte-long string out of the heap.
constexpr size_t kMaxCaptionBytes { 256 };

// Returns nullopt when the key is absent, throws when it is present but
// malformed. The type checks are required: a bad cast throws a JS
// exception that C++ cannot catch.
std::optional<long> parse_optional_int_field(emval v, const char* key, long minVal, long maxVal)
{
    if (!v.call<bool>("hasOwnProperty", std::string(key))
        || v[key].isUndefined()
        || v[key].isNull()) {
        return std::nullopt;
    }

    const emval field { v[key] };
    const std::string range { std::string("'") + key + "' must be an integer in "
        + std::to_string(minVal) + ".." + std::to_string(maxVal) };

    if (field.isNumber()) {
        const double n { field.as<double>() };
        if (!std::isfinite(n) || n < static_cast<double>(minVal)
            || n > static_cast<double>(maxVal) || std::trunc(n) != n) {
            throw std::runtime_error(range + ", got " + std::to_string(n));
        }
        return static_cast<long>(n);
    }

    if (field.isString()) {
        const std::string raw { field.as<std::string>() };
        size_t pos { 0 };
        long parsed {};
        try {
            parsed = std::stol(raw, &pos);
        } catch (...) {
            throw std::runtime_error(range + ", got \"" + raw + "\"");
        }
        if (pos != raw.size() || parsed < minVal || parsed > maxVal) {
            throw std::runtime_error(range + ", got \"" + raw + "\"");
        }
        return parsed;
    }

    throw std::runtime_error(range + ", got non-numeric value");
}

} // anonymous namespace

/*
 * ---------------------------------------------------------------------------
 * Node-parity matching
 * ---------------------------------------------------------------------------
 *
 * The engine mirrors the Warthog node's matching pipeline
 * (`MatchProcessor::match` in
 * `core/defi/src/node/chainserver/state/transactions/block_applier.cpp`).
 * The node is the source of truth; keep the two in sync.
 *
 * The node's pipeline is:
 *
 *  1. The order book is aggregated by price level: all orders sharing a
 *     limit price are merged into a single effective entry whose amount is
 *     their sum. The FBM then runs on those levels only.
 *  2. The FBM result is split back to the individual orders. The amount
 *     filled on the input side is handed out greedily (oldest order first
 *     within a price level), while the amount received on the output side
 *     is distributed proportionally with a *floor* division.
 *  3. The floor division leaves a remainder (the "dust") which the node
 *     credits back to the pool reserves, in the currency of the output
 *     side. The dust exists in both currencies independently and it also
 *     arises when the pool is not traded with at all.
 *
 * The node loads the price levels lazily (see `defi::match_lazy`): it
 * loads a partial aggregated book, knowing that the levels it skips
 * cannot influence the result. We aggregate the whole book up front
 * instead, which gives the same outcome: the levels the lazy loader skips
 * are the ones that cannot be filled.
 *
 * Everything below is pure: it computes the outcome of a match, it does
 * not mutate any state.
 */

namespace {

// One order in the book, as seen by the matcher.
struct BookOrder_uint64 {
    BookOrder_uint64(Funds_uint64 a, Price_uint64 l)
        : amount { a }
        , limit { l }
    {
    }
    Funds_uint64 amount; // remaining amount of the order
    Price_uint64 limit;
    // A free-form label for the order. It is metadata only: it is never
    // passed to the matcher and never influences the matching. Captions
    // are not unique, several orders may carry the same one.
    std::string caption;
};

// The result of distributing the match over the individual orders.
struct OrderFill_uint64 {
    // Amount filled on the input side: base for a sell order, quote for a
    // buy order.
    Funds_uint64 filled { 0 };
    // Amount received on the output side: quote for a sell order, base for
    // a buy order. This is the floor-rounded proportional share.
    Funds_uint64 proceeds { 0 };
};

// The amounts a match moved into and out of the pool reserves.
struct PoolSwap_uint64 {
    // true: quote was pushed into the pool and base was taken out of it.
    // false: base was pushed into the pool and quote was taken out of it.
    bool isQuote { false };
    // Amount pushed into the pool.
    Funds_uint64 in { 0 };
    // Amount taken out of the pool.
    Funds_uint64 out { 0 };
};

// The rounding dust a match credited back to the pool reserves.
struct PoolDust_uint64 {
    Funds_uint64 base { 0 };
    Funds_uint64 quote { 0 };
};

// One order of a price level, with what the match did to it.
struct LevelOrder_uint64 {
    Funds_uint64 amount { 0 };
    OrderFill_uint64 fill;
    std::string caption;
};

// One price level of the book: the orders sharing a limit price, with
// their amounts summed.
struct BookLevel_uint64 {
    Price_uint64 limit;
    // Sum of the amounts of the orders at this level.
    Funds_uint64 amount { 0 };
    // Sum of the amounts filled at this level.
    Funds_uint64 filled { 0 };
    // Sum of the amounts received at this level.
    Funds_uint64 proceeds { 0 };
    // The individual orders at this level, oldest first.
    std::vector<LevelOrder_uint64> orders;
};

// The complete outcome of a match.
struct NodeMatchResult_uint64 {
    // Per-order fill, in the same order as the input book.
    std::vector<OrderFill_uint64> sellFills;
    std::vector<OrderFill_uint64> buyFills;

    // The price levels, in the same order as the input book.
    std::vector<BookLevel_uint64> sellLevels;
    std::vector<BookLevel_uint64> buyLevels;

    // The FBM result, verbatim.
    defi::MatchResult_uint64 m { {}, { 0, 0 } };

    // The amounts exchanged between the orders, counting what the pool
    // contributed (`exchangeBetweenOrders` in the node).
    defi::BaseQuote_uint64 exchange { 0, 0 };

    // The pool interaction, absent when the pool was not traded with.
    std::optional<PoolSwap_uint64> swap;

    // The dust credited back to the pool reserves.
    PoolDust_uint64 dust;

    // The pool reserves after the match, including the dust.
    defi::PoolLiquidity_uint64 poolAfter { 0, 0 };
};

/*
 * Runs the node's matching pipeline on the given book.
 *
 * `sellsAsc` is the sell side (base orders) sorted by price ascending,
 * `buysDesc` is the buy side (quote orders) sorted by price descending.
 * Within a price level the order of the entries decides who is filled
 * first, which mirrors the node's "first orders first at same price, id
 * ascending" rule.
 *
 * `feeE4` is the pool fee in 1/10000 units.
 */
[[nodiscard]] NodeMatchResult_uint64 node_match(
    const std::vector<BookOrder_uint64>& sellsAsc,
    const std::vector<BookOrder_uint64>& buysDesc,
    const defi::PoolLiquidity_uint64& poolBefore,
    uint32_t feeE4)
{
    NodeMatchResult_uint64 res;

    // 1. Aggregate the book by price level and run the FBM on the levels.
    //
    //    The node feeds the FBM with lazily loaded price levels (see
    //    `defi::match_lazy`), merging the orders of a level into one
    //    entry. We aggregate the whole book up front instead: the mirror's
    //    `insert_base` / `insert_quote` merge the orders of a level, so
    //    the resulting book holds one entry per price level. Matching the
    //    full book gives the same result as the node's lazy matching: the
    //    levels that the lazy loader skips are the ones that cannot be
    //    filled, so they do not influence the outcome.
    defi::Orderbook_uint64 ob;
    for (const auto& o : sellsAsc) {
        ob.insert_base(defi::Order_uint64 { o.amount, o.limit });
    }
    for (const auto& o : buysDesc) {
        ob.insert_quote(defi::Order_uint64 { o.amount, o.limit });
    }
    const auto m { ob.match(poolBefore) };
    res.m = m;

    // 2. Pool interaction. The node computes `exchangeBetweenOrders`: the
    //    amounts that changed hands between the orders, after removing what
    //    was pushed into the pool and adding what the pool gave back.
    defi::PoolLiquidity_uint64 pool { poolBefore };
    defi::BaseQuote_uint64 exchange { m.filled };
    if (m.toPool) {
        auto pa { m.toPool->amount() };
        PoolSwap_uint64 swap;
        swap.isQuote = m.toPool->is_quote();
        if (swap.isQuote) {
            exchange.quote.subtract_assert(pa);
            auto fromPool { pool.buy(pa, feeE4) };
            swap.in = pa;
            swap.out = fromPool;
            if (!fromPool.is_zero()) {
                exchange.base.add_assert(fromPool);
            }
        } else {
            exchange.base.subtract_assert(pa);
            auto fromPool { pool.sell(pa, feeE4) };
            swap.in = pa;
            swap.out = fromPool;
            if (!fromPool.is_zero()) {
                exchange.quote.add_assert(fromPool);
            }
        }
        res.swap = swap;
    }
    res.exchange = exchange;

    // 3. Distribution over the individual orders.
    //
    //    The input side is filled greedily, the output side is distributed
    //    proportionally with a floor division. The floor division loses up
    //    to (number of orders - 1) units, the remainder is the dust.
    //
    //    The greedy walk goes in book order, and the book keeps the orders
    //    of a price level in insertion order (oldest first). So the oldest
    //    order at a level is filled first and the latest added one is
    //    filled last: it has the least priority at that level. This is the
    //    node's rule too, it fills the orders at a price level in id
    //    ascending order.
    res.sellFills.resize(sellsAsc.size());
    res.buyFills.resize(buysDesc.size());

    if (m.filled.base != 0) { // seller match
        const Nonzero_uint64 filledBase { m.filled.base.value() };
        Funds_uint64 quoteDistributed { 0 };
        auto remainingInBase { m.filled.base };
        for (size_t i = 0; i < sellsAsc.size(); ++i) {
            if (remainingInBase == 0)
                break;
            auto& fill { res.sellFills[i] };
            auto b { std::min(remainingInBase, sellsAsc[i].amount) };
            fill.filled = b;
            remainingInBase.subtract_assert(b);

            // compute return of that order
            auto q { Prod128(b, exchange.quote).divide_floor(filledBase) };
            assert(q.has_value());
            quoteDistributed.add_assert(*q);
            fill.proceeds = *q;
        }
        assert(remainingInBase == 0);

        // add remaining dust from floored rounding to pool
        res.dust.quote = diff_assert(exchange.quote, quoteDistributed);
    }
    if (m.filled.quote != 0) { // buyer match
        const Nonzero_uint64 filledQuote { m.filled.quote.value() };
        Funds_uint64 baseDistributed { 0 };
        auto remainingInQuote { m.filled.quote };
        for (size_t i = 0; i < buysDesc.size(); ++i) {
            if (remainingInQuote == 0)
                break;
            auto& fill { res.buyFills[i] };
            auto q { std::min(remainingInQuote, buysDesc[i].amount) };
            fill.filled = q;
            remainingInQuote.subtract_assert(q);

            // compute return of that order
            auto b { Prod128(q, exchange.base).divide_floor(filledQuote) };
            assert(b.has_value());
            baseDistributed.add_assert(*b);
            fill.proceeds = *b;
        }
        assert(remainingInQuote == 0);

        // add remaining dust from floored rounding to pool
        res.dust.base = diff_assert(exchange.base, baseDistributed);
    }

    // 4. The pool reserves after the match: the swap plus the dust.
    res.poolAfter = pool;
    res.poolAfter.base.add_assert(res.dust.base);
    res.poolAfter.quote.add_assert(res.dust.quote);

    // 5. The price levels, for rendering the aggregated book.
    //
    //    The levels are the units the FBM actually matched on. Each level
    //    holds its individual orders, with what the match did to them, and
    //    the sums over them. The sums are exact: the amounts of the orders
    //    at a level, the amounts filled there, and the amounts they
    //    received. Note that the proceeds of a level are the sum of the
    //    per-order proceeds, not the floor-rounded share of the level
    //    total: the difference between the two is part of the dust.
    auto aggregate = [](const std::vector<BookOrder_uint64>& orders,
                        const std::vector<OrderFill_uint64>& fills) {
        std::vector<BookLevel_uint64> levels;
        for (size_t i = 0; i < orders.size(); ++i) {
            const auto& o { orders[i] };
            if (levels.empty() || levels.back().limit != o.limit) {
                levels.push_back(BookLevel_uint64 { o.limit, 0, 0, 0, {} });
            }
            auto& level { levels.back() };
            level.amount.add_assert(o.amount);
            level.filled.add_assert(fills[i].filled);
            level.proceeds.add_assert(fills[i].proceeds);
            level.orders.push_back(LevelOrder_uint64 { o.amount, fills[i], o.caption });
        }
        return levels;
    };
    res.sellLevels = aggregate(sellsAsc, res.sellFills);
    res.buyLevels = aggregate(buysDesc, res.buyFills);
    return res;
}

} // anonymous namespace

class FbmEngine {
private:
    // Parses a buy/sell order. `decimals` selects the token-decimal count
    // for the amount field: WART (8 dp) for buy orders, baseDecimals_
    // for sell orders. The limit is parsed with `from_string_adjusted`
    // (not `from_string`) so the stored mantissa+exponent accounts for
    // the WART-vs-baseToken precision difference. Without `_adjusted`,
    // the stored value would round-trip through `to_double_adjusted`
    // as a tiny number (~0.00005) instead of the user-entered value (5).
    // limitBits is exact, the decimal limit is snapped onto the grid.
    Price_uint64 parse_limit(emval v, std::optional<long> limitBits) const
    {
        if (limitBits) {
            const auto price { Price_uint64::from_uint32(static_cast<uint32_t>(*limitBits)) };
            if (!price)
                throw std::runtime_error("Invalid limitBits value " + std::to_string(*limitBits));
            return *price;
        }
        const std::string raw { v["limit"].as<std::string>() };
        const auto price { Price_uint64::from_string_adjusted(raw, baseDecimals_) };
        if (!price)
            throw std::runtime_error("Cannot parse limit \"" + raw + "\"");
        return *price;
    }

    // Parses the optional caption of an order.
    //
    // The caption is a free-form label: metadata only, it never influences
    // the matching, and it is not unique, several orders may carry the
    // same one. A missing caption is an empty one.
    static std::string parse_caption(emval v)
    {
        const emval field { v["caption"] };
        if (field.isUndefined() || field.isNull()) {
            return {};
        }
        if (!field.isString()) {
            throw std::runtime_error("'caption' must be a string");
        }
        const std::string caption { field.as<std::string>() };
        if (caption.size() > kMaxCaptionBytes) {
            throw std::runtime_error("'caption' must be at most "
                + std::to_string(kMaxCaptionBytes) + " bytes");
        }
        return caption;
    }

    defi::Order_uint64 parse_order(emval v, TokenDecimals decimals)
    {
        // Type checks first: emval::as<std::string> on a non-string throws
        // a JS exception that C++ cannot catch. limitBits wins when both
        // are given.
        if (v.isNull() || v.typeOf().as<std::string>() != "object")
            throw std::runtime_error("Order must be an object");

        const auto limitBits { parse_optional_int_field(v, "limitBits", 0, kMaxLimitBits) };

        if (v["limit"].isUndefined() && !limitBits)
            throw std::runtime_error("Missing 'limit' field");
        if (v["amount"].isUndefined())
            throw std::runtime_error("Missing 'amount' field");
        if (!limitBits && !v["limit"].isString())
            throw std::runtime_error("'limit' must be a string");
        if (!v["amount"].isString())
            throw std::runtime_error("'amount' must be a string");

        const std::string amountRaw { v["amount"].as<std::string>() };
        const auto amount { Funds_uint64::parse(amountRaw, decimals) };
        if (!amount)
            throw std::runtime_error("Cannot parse amount \"" + amountRaw + "\"");

        return { *amount, parse_limit(v, limitBits) };
    }

    // Inserts an order into a book that is kept sorted by price. Orders of
    // equal price keep their insertion order (oldest first), which mirrors
    // the node's "first orders first at same price, id ascending" rule.
    //
    // The insert is stable: the new order goes *after* the orders already
    // at its price, never before them. Since the distribution walks the
    // book in this order, the oldest order at a price level is filled
    // first and the latest added one is filled last, i.e. it has the
    // least priority at that level.
    //
    // `descending` selects the sort direction: sells are kept ascending
    // (cheapest first), buys descending (most expensive first).
    static void insert_sorted(std::vector<BookOrder_uint64>& book, BookOrder_uint64 order, bool descending)
    {
        if (descending) {
            // First element with a strictly lower price; equal prices stay
            // in front of the new order.
            auto it { std::find_if(book.begin(), book.end(), [&](const BookOrder_uint64& o) {
                return o.limit < order.limit;
            }) };
            book.insert(it, std::move(order));
        } else {
            // First element with a strictly higher price; equal prices stay
            // in front of the new order.
            auto it { std::find_if(book.begin(), book.end(), [&](const BookOrder_uint64& o) {
                return order.limit < o.limit;
            }) };
            book.insert(it, std::move(order));
        }
    }

    // Maps a display index of the sell side to its index in the internal
    // book.
    //
    // Internally the sells are kept ascending by price (cheapest first),
    // which is the order the node fills them in. They are displayed
    // descending (most expensive first). Within a price level the oldest
    // order comes first in both views, so the mapping is not a plain
    // reversal: it skips to the start of the price level.
    [[nodiscard]] size_t sell_display_to_storage(size_t displayIndex) const
    {
        // Walk the price levels from the most expensive one down, counting
        // the orders in each level, until the display index is inside.
        size_t remaining { displayIndex };
        size_t levelStart { sells_.size() };
        while (levelStart > 0) {
            // The level ending at levelStart (exclusive) is the price level
            // of sells_[levelStart - 1].
            const auto limit { sells_[levelStart - 1].limit };
            size_t levelBegin { levelStart - 1 };
            while (levelBegin > 0 && sells_[levelBegin - 1].limit == limit) {
                --levelBegin;
            }
            const size_t levelSize { levelStart - levelBegin };
            if (remaining < levelSize) {
                // The oldest order of the level comes first in the display.
                return levelBegin + remaining;
            }
            remaining -= levelSize;
            levelStart = levelBegin;
        }
        return sells_.size(); // out of range
    }

public:
    // Default constructor: applies member-initializer defaults
    // (baseDecimals=8, feeE4=50, pool=0/0, empty book).
    FbmEngine() = default;

    // Config constructor: accepts an emval (possibly undefined/null/{}).
    // Missing fields use member-initializer defaults.
    // Bad fields throw std::runtime_error, surfaced to JS as a BindingError.
    explicit FbmEngine(emval config)
    {
        if (config.isUndefined() || config.isNull()) {
            return;
        }

        const long bd { parse_optional_int_field(config, "baseDecimals", 0, 18).value_or(8) };
        baseDecimals_ = TokenDecimals { static_cast<uint8_t>(bd) };

        const long fee { parse_optional_int_field(config, "feeE4", 0, 9999).value_or(50) };
        feeE4_ = static_cast<uint32_t>(fee);
    }

    // ─── Mutators ────────────────────────────────────────────────────────
    //
    // Each returns { ok } on success or { error } on failure. They never
    // return a match result — that's `match()`'s job.

    emval setPool(emval v)
    {
        // Validate first, mutate last. Both fields are optional; missing
        // ones leave the corresponding reserve untouched. If any provided
        // field is invalid, the whole call is rejected and neither
        // reserve changes.

        std::optional<Funds_uint64> newBase;
        std::optional<Wart> newQuote;

        if (v.call<bool>("hasOwnProperty", std::string("base"))
            && !v["base"].isUndefined()
            && !v["base"].isNull()) {
            std::string raw;
            try {
                raw = v["base"].as<std::string>();
            } catch (...) {
                return make_error("setPool: 'base' must be a string");
            }
            auto parsed = Funds_uint64::parse(raw, baseDecimals_);
            if (!parsed) {
                return make_error(
                    "setPool: cannot parse \"" + raw + "\" as base token amount");
            }
            newBase = *parsed;
        }

        if (v.call<bool>("hasOwnProperty", std::string("quote"))
            && !v["quote"].isUndefined()
            && !v["quote"].isNull()) {
            std::string raw;
            try {
                raw = v["quote"].as<std::string>();
            } catch (...) {
                return make_error("setPool: 'quote' must be a string");
            }
            Result<Wart> parsed = Wart::try_parse(raw);
            if (!parsed.has_value()) {
                return make_error("setPool: cannot parse \"" + raw + "\" as WART amount");
            }
            newQuote = parsed.value();
        }

        if (newBase) {
            poolToken_ = *newBase;
        }
        if (newQuote) {
            poolWart_ = *newQuote;
        }
        return make_ok();
    }

    emval setFeeE4(long e4)
    {
        if (e4 < 0 || e4 > 9999) {
            return make_error("setFeeE4: 'e4' must be an integer in 0..9999");
        }
        feeE4_ = static_cast<uint32_t>(e4);
        return make_ok();
    }

    emval addBuy(emval v)
    {
        try {
            auto order { parse_order(v, TokenDecimals::WART) };
            BookOrder_uint64 bookOrder { order.amount, order.limit };
            bookOrder.caption = parse_caption(v);
            insert_sorted(buys_, std::move(bookOrder), /*descending=*/true);
        } catch (std::runtime_error& e) {
            return make_error(e.what());
        } catch (...) {
            return make_error("Failed to add buy order.");
        }
        return make_ok();
    }

    emval addSell(emval v)
    {
        try {
            auto order { parse_order(v, baseDecimals_) };
            BookOrder_uint64 bookOrder { order.amount, order.limit };
            bookOrder.caption = parse_caption(v);
            insert_sorted(sells_, std::move(bookOrder), /*descending=*/false);
        } catch (std::runtime_error& e) {
            return make_error(e.what());
        } catch (...) {
            return make_error("Failed to add sell order.");
        }
        return make_ok();
    }

    emval deleteBuyAt(long index)
    {
        if (index < 0 || static_cast<size_t>(index) >= buys_.size()) {
            return emval::null();
        }
        // Copy the order before deleting — the reference would be
        // invalidated by the delete.
        const BookOrder_uint64 order { buys_[static_cast<size_t>(index)] };
        buys_.erase(buys_.begin() + static_cast<size_t>(index));
        return make_order(order, /*is_buy=*/true);
    }

    emval deleteSellAt(long index)
    {
        if (index < 0 || static_cast<size_t>(index) >= sells_.size()) {
            return emval::null();
        }
        // Sells are exposed in DESC order (most expensive first);
        // sells_ is ASC, so map the index.
        const size_t real { sell_display_to_storage(static_cast<size_t>(index)) };
        if (real >= sells_.size()) {
            return emval::null();
        }
        const BookOrder_uint64 order { sells_[real] };
        sells_.erase(sells_.begin() + static_cast<long>(real));
        return make_order(order, /*is_buy=*/false);
    }

    // Removes every order at the given price level.
    //
    // `limitBits` is the exact price-grid value of the level, as reported
    // by `limitBits` on an order or on a level row. Returns the number of
    // orders that were removed.
    emval deleteBuysAtPrice(long limitBits)
    {
        if (limitBits < 0 || limitBits > 0xFFFFFFFFL) {
            return make_error("deleteBuysAtPrice: 'limitBits' is out of range");
        }
        const auto limit { Price_uint64::from_uint32(static_cast<uint32_t>(limitBits)) };
        if (!limit) {
            return make_error("deleteBuysAtPrice: invalid limitBits value");
        }
        const size_t before { buys_.size() };
        buys_.erase(std::remove_if(buys_.begin(), buys_.end(),
                         [&](const BookOrder_uint64& o) { return o.limit == *limit; }),
            buys_.end());
        emval obj = emval::object();
        obj.set("ok", emval(true));
        obj.set("deleted", emval(static_cast<int>(before - buys_.size())));
        return obj;
    }

    emval deleteSellsAtPrice(long limitBits)
    {
        if (limitBits < 0 || limitBits > 0xFFFFFFFFL) {
            return make_error("deleteSellsAtPrice: 'limitBits' is out of range");
        }
        const auto limit { Price_uint64::from_uint32(static_cast<uint32_t>(limitBits)) };
        if (!limit) {
            return make_error("deleteSellsAtPrice: invalid limitBits value");
        }
        const size_t before { sells_.size() };
        sells_.erase(std::remove_if(sells_.begin(), sells_.end(),
                         [&](const BookOrder_uint64& o) { return o.limit == *limit; }),
            sells_.end());
        emval obj = emval::object();
        obj.set("ok", emval(true));
        obj.set("deleted", emval(static_cast<int>(before - sells_.size())));
        return obj;
    }

    // ─── Pure-parse validators (no state change) ──────────────────────

    emval validateLimit(std::string s)
    {
        if (!Price_uint64::from_string_adjusted(s, baseDecimals_).has_value())
            return make_error("Cannot parse limit");
        return make_ok();
    }

    emval validateBaseAmount(std::string s)
    {
        if (!Funds_uint64::parse(s, TokenDecimals::WART).has_value())
            return make_error("Cannot parse amount");
        return make_ok();
    }

    emval validateQuoteAmount(std::string s)
    {
        if (!Funds_uint64::parse(s, baseDecimals_).has_value())
            return make_error("Cannot parse amount");
        return make_ok();
    }

    // ─── Getters ──────────────────────────────────────────────────────────

    emval getConfig() const
    {
        emval obj = emval::object();
        obj.set("baseDecimals", emval(static_cast<int>(baseDecimals_.value())));
        obj.set("feeE4", emval(static_cast<int>(feeE4_)));
        return obj;
    }

    emval getPool() const
    {
        emval obj = emval::object();
        obj.set("base", emval(poolToken_.to_decimal(baseDecimals_).to_string()));
        obj.set("quote", emval(poolWart_.to_string()));
        return obj;
    }

    emval getBuyAt(long index) const
    {
        if (index < 0 || static_cast<size_t>(index) >= buys_.size()) {
            return emval::null();
        }
        return make_order(buys_[static_cast<size_t>(index)], /*is_buy=*/true);
    }

    emval getSellAt(long index) const
    {
        if (index < 0 || static_cast<size_t>(index) >= sells_.size()) {
            return emval::null();
        }
        // Sells are exposed in DESC order (most expensive first);
        // sells_ is ASC, so map the index.
        const size_t real { sell_display_to_storage(static_cast<size_t>(index)) };
        if (real >= sells_.size()) {
            return emval::null();
        }
        return make_order(sells_[real], /*is_buy=*/false);
    }

    // ─── Match ────────────────────────────────────────────────────────────
    //
    // Always returns a full MatchResult. (0, 0) pool is valid; the result
    // simply has all-zero pool snapshots + no fills. The JS side is
    // responsible for gating when to call this (e.g. only when both pool
    // fields have been successfully set).
    //
    // The match is node-parity: the pool reserves are aggregated by price
    // level, the matched amounts are distributed back to the individual
    // orders proportionally with a floor division, and the rounding dust
    // that this leaves is credited back to the pool. `match()` does not
    // mutate any state.

    emval match() const
    {
        return compute_match();
    }

private:
    emval pool_val(const defi::PoolLiquidity_uint64& pool) const
    {
        auto baseTotal { pool.base.to_decimal(baseDecimals_) };
        auto quoteTotal { pool.quote.as_wart() };
        emval obj = emval::object();
        obj.set("base", emval(baseTotal.to_string()));
        obj.set("quote", emval(quoteTotal.to_string()));
        obj.set("price", emval(quoteTotal.to_double() / baseTotal.to_double()));
        return obj;
    }

    // Formats an Order_uint64 as the unified `{ amount, limit, limitBits }`
    // JS object. `is_buy` controls the amount's decimal formatting: WART
    // (8 dp) for buys, `baseDecimals` for sells.
    //
    // to_chars gives the shortest round-trip string, so an order read back
    // and re-added keeps its exact price. limitBits is the same value, raw.
    // Renders a limit price as the shortest string that parses back to the
    // same value, so an order or a level read back and re-added keeps its
    // exact price.
    emval make_limit(Price_uint64 limit) const
    {
        std::array<char, 32> buf {};
        const double value { limit.to_double_adjusted(baseDecimals_) };
        auto [ptr, ec] = std::to_chars(buf.data(), buf.data() + buf.size(), value);
        return emval(ec == std::errc {} ? std::string(buf.data(), ptr) : std::string());
    }

    emval make_order(const BookOrder_uint64& order, bool is_buy) const
    {
        emval obj = emval::object();
        obj.set("amount", is_buy
            ? emval(order.amount.as_wart().to_string())
            : emval(order.amount.to_decimal(baseDecimals_).to_string()));

        obj.set("limit", make_limit(order.limit));
        obj.set("limitBits", emval(static_cast<uint32_t>(order.limit.to_uint32())));
        obj.set("caption", emval(order.caption));

        return obj;
    }

    // Renders one matched order: the order's own size, the amount filled
    // on the input side, the amount received on the output side, and the
    // caption. The price is not repeated here, the price level carries it.
    emval make_matched_order(const LevelOrder_uint64& order, bool is_buy) const
    {
        emval row = emval::object();
        row.set("amount", emval(is_buy
            ? order.amount.as_wart().to_string()
            : order.amount.to_decimal(baseDecimals_).to_string()));
        row.set("filled", emval(is_buy
            ? order.fill.filled.as_wart().to_string()
            : order.fill.filled.to_decimal(baseDecimals_).to_string()));
        row.set("proceeds", emval(is_buy
            ? order.fill.proceeds.to_decimal(baseDecimals_).to_string()
            : order.fill.proceeds.as_wart().to_string()));
        row.set("caption", emval(order.caption));
        return row;
    }

    // Renders one price level: the limit, the summed amounts of the
    // orders at that level, and the individual orders themselves.
    emval make_matched_level(const BookLevel_uint64& level, bool is_buy) const
    {
        emval row = emval::object();
        row.set("limit", make_limit(level.limit));
        row.set("limitBits", emval(static_cast<uint32_t>(level.limit.to_uint32())));
        row.set("amount", emval(is_buy
            ? level.amount.as_wart().to_string()
            : level.amount.to_decimal(baseDecimals_).to_string()));
        row.set("filled", emval(is_buy
            ? level.filled.as_wart().to_string()
            : level.filled.to_decimal(baseDecimals_).to_string()));
        row.set("proceeds", emval(is_buy
            ? level.proceeds.to_decimal(baseDecimals_).to_string()
            : level.proceeds.as_wart().to_string()));
        emval orders = emval::array();
        for (const auto& order : level.orders) {
            orders.call<void>("push", make_matched_order(order, is_buy));
        }
        row.set("orders", orders);
        return row;
    }

    emval compute_match() const
    {
        const defi::PoolLiquidity_uint64 p { poolToken_, poolWart_ };
        const auto res { node_match(sells_, buys_, p, feeE4_) };

        // The book, aggregated by price level: the units the FBM actually
        // matched on. Each level carries the limit and the sums over its
        // orders, and the individual orders themselves.
        emval buys = emval::array();
        for (const auto& level : res.buyLevels) {
            buys.call<void>("push", make_matched_level(level, /*is_buy=*/true));
        }
        emval sells = emval::array();
        // Sells are exposed in DESC order (most expensive first).
        for (auto it { res.sellLevels.rbegin() }; it != res.sellLevels.rend(); ++it) {
            sells.call<void>("push", make_matched_level(*it, /*is_buy=*/false));
        }

        auto price_val = [&](const defi::BaseQuote_uint64& bq) -> emval {
            return emval(bq.price_double(baseDecimals_, TokenDecimals::WART.value()));
        };
        // The same price as a plain double, for use in expressions.
        auto price_num = [&](const defi::BaseQuote_uint64& bq) -> double {
            return bq.price_double(baseDecimals_, TokenDecimals::WART.value());
        };

        // The pool part of the match, split into the real exchange with the
        // reserves and the rounding dust credited back to them.
        emval poolObj = emval::object();
        poolObj.set("before", pool_val(p));
        poolObj.set("after", pool_val(res.poolAfter));

        emval swapVal = emval::null();
        if (res.swap) {
            const auto& swap { *res.swap };
            emval obj = emval::object();
            obj.set("isQuote", emval(swap.isQuote));
            obj.set("in", emval(swap.isQuote
                ? swap.in.as_wart().to_string()
                : swap.in.to_decimal(baseDecimals_).to_string()));
            obj.set("out", emval(swap.isQuote
                ? swap.out.to_decimal(baseDecimals_).to_string()
                : swap.out.as_wart().to_string()));
            // The price of the swap: quote per base, in decimal terms.
            // `price_double` scales the raw integer ratio by the decimal
            // difference between the base token and WART. It divides by the
            // base amount, so a swap without a base leg has no price.
            const defi::BaseQuote_uint64 swapBQ { swap.isQuote ? swap.out : swap.in,
                swap.isQuote ? swap.in : swap.out };
            obj.set("price", emval(swapBQ.base.is_zero() ? 0.0 : price_num(swapBQ)));
            swapVal = obj;
        }
        poolObj.set("swap", swapVal);

        emval dustObj = emval::object();
        dustObj.set("base", emval(res.dust.base.to_decimal(baseDecimals_).to_string()));
        dustObj.set("quote", emval(res.dust.quote.as_wart().to_string()));
        poolObj.set("dust", dustObj);

        // The amounts that changed hands between the orders, counting what
        // the pool contributed (`exchangeBetweenOrders` in the node).
        emval matchedObj = emval::object();
        matchedObj.set("base", emval(res.exchange.base.to_decimal(baseDecimals_).to_string()));
        matchedObj.set("quote", emval(res.exchange.quote.as_wart().to_string()));
        matchedObj.set("price", res.exchange.quote.is_zero() ? emval::null() : price_val(res.exchange));

        // Per-side totals. The input side is gross (what the sellers gave
        // and what the buyers paid, including the part that went into the
        // pool), the output side is what they received, i.e. the sum of the
        // per-order proceeds.
        Funds_uint64 quoteReceived { 0 };
        for (const auto& f : res.sellFills) {
            quoteReceived.add_assert(f.proceeds);
        }
        Funds_uint64 baseReceived { 0 };
        for (const auto& f : res.buyFills) {
            baseReceived.add_assert(f.proceeds);
        }

        emval filledObj = emval::object();
        filledObj.set("outBaseSeller", emval(res.m.filled.base.to_decimal(baseDecimals_).to_string()));
        filledObj.set("inQuoteSeller", emval(quoteReceived.as_wart().to_string()));
        // What the sellers got per base they gave (quote per base).
        filledObj.set("priceSeller", emval(res.m.filled.base.is_zero()
            ? 0.0
            : price_num(defi::BaseQuote_uint64 { res.m.filled.base, quoteReceived })));
        filledObj.set("outQuoteBuyer", emval(res.m.filled.quote.as_wart().to_string()));
        filledObj.set("inBaseBuyer", emval(baseReceived.to_decimal(baseDecimals_).to_string()));
        // What the buyers paid per base they got (quote per base).
        filledObj.set("priceBuyer", emval(baseReceived.is_zero()
            ? 0.0
            : price_num(defi::BaseQuote_uint64 { baseReceived, res.m.filled.quote })));

        emval matchObj = emval::object();
        matchObj.set("buys", buys);
        matchObj.set("sells", sells);
        matchObj.set("pool", poolObj);
        matchObj.set("filled", filledObj);
        matchObj.set("matched", matchedObj);
        return matchObj;
    }

    // The book. Sells are kept ascending by price (cheapest first), buys
    // descending (most expensive first); within a price level the oldest
    // order comes first, matching the node's id-ascending rule.
    std::vector<BookOrder_uint64> sells_;
    std::vector<BookOrder_uint64> buys_;

    Funds_uint64 poolToken_ { 0 };
    Wart poolWart_ { 0 };
    uint32_t feeE4_ { 50 };
    TokenDecimals baseDecimals_ { TokenDecimals { 8 } };
};

EMSCRIPTEN_BINDINGS(fbm)
{
    emscripten::class_<FbmEngine>("FbmEngine")
        .constructor<emscripten::val>()
        .function("setPool", &FbmEngine::setPool)
        .function("setFeeE4", &FbmEngine::setFeeE4)
        .function("addBuy", &FbmEngine::addBuy)
        .function("addSell", &FbmEngine::addSell)
        .function("deleteBuyAt", &FbmEngine::deleteBuyAt)
        .function("deleteSellAt", &FbmEngine::deleteSellAt)
        .function("deleteBuysAtPrice", &FbmEngine::deleteBuysAtPrice)
        .function("deleteSellsAtPrice", &FbmEngine::deleteSellsAtPrice)
        .function("validateLimit", &FbmEngine::validateLimit)
        .function("validateBaseAmount", &FbmEngine::validateBaseAmount)
        .function("validateQuoteAmount", &FbmEngine::validateQuoteAmount)
        .function("getConfig", &FbmEngine::getConfig)
        .function("getPool", &FbmEngine::getPool)
        .function("getBuyAt", &FbmEngine::getBuyAt)
        .function("getSellAt", &FbmEngine::getSellAt)
        .function("match", &FbmEngine::match);
}
