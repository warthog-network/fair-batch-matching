#include "defi/uint64/orderbook.hpp"
#include "general/funds.hpp"
#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <optional>
#include <stdio.h>
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
 * Applies to `setPool` and `setFee`.
 *
 * `match()` is the only state-reading operation and is always safe to
 * call — it returns a full result even with a `(0, 0)` pool.
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

/*
 * Strict-range int parser used by baseDecimals / feeE4 / setFee.
 * Returns:
 *   - emval::null() if the field is missing or null (caller decides default).
 *   - emval { error } if the field is present but malformed / out of range.
 *   - emval::null() with *out set on success.
 *
 * Coerces via isNumber()/isString() + double/stod because Embind's
 * toWireType<int>/toWireType<std::string> throw JS TypeErrors on
 * non-matching types that C++ try/catch can't unwind.
 */
emval parse_strict_int_field(emval v, const char* key, long minVal, long maxVal, long* out)
{
    if (!v.call<bool>("hasOwnProperty", std::string(key))
        || v[key].isUndefined()
        || v[key].isNull()) {
        return emval::null();
    }
    emval field { v[key] };
    auto rangeStr = std::string("'") + key + "' must be an integer in "
        + std::to_string(minVal) + ".." + std::to_string(maxVal);
    if (field.isNumber()) {
        double n = field.as<double>();
        long rounded = static_cast<long>(n);
        if (n != n || n < static_cast<double>(minVal)
            || n > static_cast<double>(maxVal)
            || static_cast<double>(rounded) != n) {
            return make_error(rangeStr + ", got " + std::to_string(rounded));
        }
        *out = rounded;
        return emval::null();
    }
    if (field.isString()) {
        std::string raw;
        try {
            raw = field.as<std::string>();
        } catch (...) {
            return make_error(rangeStr + ", got non-string value");
        }
        try {
            size_t pos = 0;
            long parsed = std::stol(raw, &pos);
            if (pos != raw.size() || parsed < minVal || parsed > maxVal) {
                return make_error(rangeStr + ", got \"" + raw + "\"");
            }
            *out = parsed;
            return emval::null();
        } catch (...) {
            return make_error(rangeStr + ", got \"" + raw + "\"");
        }
    }
    return make_error(rangeStr + ", got non-numeric value");
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
    defi::Order_uint64 parse_order(emval v, TokenDecimals decimals)
    {
        if (v["limit"].isUndefined())
            throw std::runtime_error("Missing 'limit' field");
        if (v["amount"].isUndefined())
            throw std::runtime_error("Missing 'amount' field");
        Funds_uint64 amount { [&]() {
            try {
                std::string s { v["amount"].as<std::string>() };
                if (auto o { Funds_uint64::parse(s, decimals) })
                    return *o;
            } catch (...) {
            }
            throw std::runtime_error("Cannot parse amount");
        }() };
        Price_uint64 price { [&]() {
            try {
                return Price_uint64::from_string_adjusted(v["limit"].as<std::string>(), baseDecimals_).value();
            } catch (...) {
                throw std::runtime_error("Cannot get limit");
            }
        }() };
        return { amount, price };
    }

public:
    // Default constructor: applies member-initializer defaults
    // (baseDecimals=8, feeE4=5, pool=0/0, empty book).
    FbmEngine() = default;

    // Config constructor: accepts an emval (possibly undefined/null/{}).
    // Missing fields use member-initializer defaults.
    // Bad fields throw std::runtime_error, surfaced to JS as a BindingError.
    explicit FbmEngine(emval config)
    {
        if (config.isUndefined() || config.isNull()) {
            return;
        }

        long bd { 8 };
        if (auto err = parse_strict_int_field(config, "baseDecimals", 0, 18, &bd);
            !err.isNull()) {
            throw std::runtime_error(err["error"].as<std::string>());
        }
        baseDecimals_ = TokenDecimals { static_cast<uint8_t>(bd) };

        long fee { 5 };
        if (auto err = parse_strict_int_field(config, "feeE4", 0, 9999, &fee);
            !err.isNull()) {
            throw std::runtime_error(err["error"].as<std::string>());
        }
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
                return make_error(
                    "setPool: cannot parse \"" + raw + "\" as WART amount");
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
            bso_.insert_quote(order);
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
            bso_.insert_base(order);
        } catch (std::runtime_error& e) {
            return make_error(e.what());
        } catch (...) {
            return make_error("Failed to add sell order.");
        }
        return make_ok();
    }

    emval deleteBuyAt(long index)
    {
        if (index < 0 || static_cast<size_t>(index) >= bso_.quote_desc_buy().size()) {
            return emval::null();
        }
        // Copy the order before deleting — the reference would be
        // invalidated by the delete.
        defi::Order_uint64 order { bso_.quote_desc_buy()[static_cast<size_t>(index)] };
        bso_.delete_quote(static_cast<size_t>(index));
        return make_order(order, /*is_buy=*/true);
    }

    emval deleteSellAt(long index)
    {
        if (index < 0 || static_cast<size_t>(index) >= bso_.base_asc_sell().size()) {
            return emval::null();
        }
        // Sells are exposed in DESC order (most expensive first);
        // bso_.base_asc_sell() is ASC, so reverse the index.
        const size_t real { bso_.base_asc_sell().size() - 1 - static_cast<size_t>(index) };
        defi::Order_uint64 order { bso_.base_asc_sell()[real] };
        bso_.delete_base(static_cast<size_t>(index));
        return make_order(order, /*is_buy=*/false);
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
        obj.set("quote", emval(poolWart_.as_wart().to_string()));
        return obj;
    }

    emval getBuyAt(long index) const
    {
        if (index < 0 || static_cast<size_t>(index) >= bso_.quote_desc_buy().size()) {
            return emval::null();
        }
        return make_order(bso_.quote_desc_buy()[static_cast<size_t>(index)], /*is_buy=*/true);
    }

    emval getSellAt(long index) const
    {
        if (index < 0 || static_cast<size_t>(index) >= bso_.base_asc_sell().size()) {
            return emval::null();
        }
        // Sells are exposed in DESC order; bso_.base_asc_sell() is ASC.
        const size_t real { bso_.base_asc_sell().size() - 1 - static_cast<size_t>(index) };
        return make_order(bso_.base_asc_sell()[real], /*is_buy=*/false);
    }

    // ─── Match ────────────────────────────────────────────────────────────
    //
    // Always returns a full MatchResult. (0, 0) pool is valid; the result
    // simply has all-zero pool snapshots + no fills. The JS side is
    // responsible for gating when to call this (e.g. only when both pool
    // fields have been successfully set).

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

    // Formats an Order_uint64 as the unified `{ amount, limit }` JS
    // object. `is_buy` controls the amount's decimal formatting: WART
    // (8 dp) for buys, `baseDecimals` for sells. The limit is rendered
    // as a decimal string via `std::to_string(to_double_adjusted(...))`,
    // which gives at least 6 significant digits — sufficient for FBM
    // limits (mantissa precision is 16 bits, well within double range).
    emval make_order(const defi::Order_uint64& order, bool is_buy) const
    {
        emval obj = emval::object();
        obj.set("amount", is_buy
            ? emval(order.amount.as_wart().to_string())
            : emval(order.amount.to_decimal(baseDecimals_).to_string()));
        obj.set("limit", emval(std::to_string(order.limit.to_double_adjusted(baseDecimals_))));
        return obj;
    }

    emval compute_match() const
    {
        const defi::PoolLiquidity_uint64 p { poolToken_, poolWart_ };
        auto pTmp { p };
        auto match_res { bso_.match(p) };
        emval buys = emval::array();

        auto fquote { match_res.filled.quote };
        for (size_t i = 0; i < bso_.quote_desc_buy().size(); ++i) {
            auto order { bso_.quote_desc_buy()[i] };
            auto filled { std::min(order.amount, fquote) };
            fquote.subtract_assert(filled);
            emval row = make_order(order, /*is_buy=*/true);
            row.set("filled", emval(filled.as_wart().to_string()));
            buys.call<void>("push", row);
        }

        emval sells = emval::array();
        auto J { bso_.base_asc_sell().size() };
        auto fbase { match_res.filled.base };
        for (size_t j = 0; j < J; ++j) {
            auto order { bso_.base_asc_sell()[j] };
            auto filled { std::min(fbase, order.amount) };
            fbase.subtract_assert(filled);
            emval row = make_order(order, /*is_buy=*/false);
            row.set("filled", emval(filled.to_decimal(baseDecimals_).to_string()));
            sells.call<void>("push", row);
        }
        sells.call<void>("reverse");

        auto price_val = [&](const defi::BaseQuote_uint64& bq) -> emval {
            return emval(bq.price_double(baseDecimals_, TokenDecimals::WART.value()));
        };

        const auto& toPool { match_res.toPool };
        auto poolBaseQuote { [&]() -> defi::BaseQuote_uint64 {
            if (toPool) {
                if (toPool->is_quote())
                    return {
                        pTmp.buy(toPool->amount(), feeE4_),
                        toPool->amount()
                    };
                else {
                    return {
                        toPool->amount(),
                        pTmp.sell(toPool->amount(), feeE4_),
                    };
                }
            }
            return { 0, 0 };
        }() };

        auto matched { match_res.filled };
        if (auto& toPool { match_res.toPool }) {
            if (toPool->is_quote()) {
                matched.quote.subtract_assert(toPool->amount());
            } else {
                matched.base.subtract_assert(toPool->amount());
            }
        }

        auto toPoolVal = [&]() -> emval {
            if (toPool) {
                emval obj = emval::object();
                obj.set("isQuote", emval(toPool->is_quote()));
                obj.set("base", emval(poolBaseQuote.base.to_decimal(baseDecimals_).to_string()));
                obj.set("quote", emval(poolBaseQuote.quote.as_wart().to_string()));
                obj.set("price", price_val(poolBaseQuote));
                return obj;
            }
            return emval::null();
        };

        auto filledBuyer { matched };
        auto filledSeller { matched };
        if (toPool) {
            if (toPool->is_quote()) {
                filledBuyer.add_assert(poolBaseQuote);
            } else {
                filledSeller.add_assert(poolBaseQuote);
            }
        }

        emval filledObj = emval::object();
        filledObj.set("outBaseSeller", emval(filledSeller.base.to_decimal(baseDecimals_).to_string()));
        filledObj.set("inQuoteSeller", emval(filledSeller.quote.as_wart().to_string()));
        filledObj.set("priceSeller", price_val(filledSeller));
        filledObj.set("outQuoteBuyer", emval(filledBuyer.quote.as_wart().to_string()));
        filledObj.set("inBaseBuyer", emval(filledBuyer.base.to_decimal(baseDecimals_).to_string()));
        filledObj.set("priceBuyer", price_val(filledBuyer));

        emval matchedObj = emval::object();
        matchedObj.set("base", emval(matched.base.to_decimal(baseDecimals_).to_string()));
        matchedObj.set("quote", emval(matched.quote.as_wart().to_string()));
        matchedObj.set("price", matched.quote.is_zero() ? emval::null() : price_val(matched));

        emval matchObj = emval::object();
        matchObj.set("buys", buys);
        matchObj.set("sells", sells);
        matchObj.set("poolBefore", pool_val(p));
        matchObj.set("toPool", toPoolVal());
        matchObj.set("filled", filledObj);
        matchObj.set("matched", matchedObj);
        matchObj.set("poolAfter", pool_val(pTmp));
        return matchObj;
    }

    defi::Orderbook_uint64 bso_;
    Funds_uint64 poolToken_ { 0 };
    Funds_uint64 poolWart_ { 0 };
    uint32_t feeE4_ { 5 };
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
        .function("validateLimit", &FbmEngine::validateLimit)
        .function("validateBaseAmount", &FbmEngine::validateBaseAmount)
        .function("validateQuoteAmount", &FbmEngine::validateQuoteAmount)
        .function("getConfig", &FbmEngine::getConfig)
        .function("getPool", &FbmEngine::getPool)
        .function("getBuyAt", &FbmEngine::getBuyAt)
        .function("getSellAt", &FbmEngine::getSellAt)
        .function("match", &FbmEngine::match);
}
