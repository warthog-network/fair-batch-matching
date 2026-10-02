#include "defi/uint64/orderbook.hpp"
#include "general/funds.hpp"
#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <stdio.h>
using namespace std;

// global variables
std::optional<Funds_uint64> poolToken;
std::optional<Funds_uint64> poolWart;
defi::Orderbook_uint64 bso;
uint32_t feeE4 { 5 };
TokenDecimals baseDecimals { 3 };

using emval = emscripten::val;

static emval pool_val(const defi::PoolLiquidity_uint64& pool)
{
    auto baseTotal { pool.base.to_decimal(baseDecimals) };
    auto quoteTotal { pool.quote.as_wart() };
    emval obj = emval::object();
    obj.set("base", emval(baseTotal.to_string()));
    obj.set("quote", emval(quoteTotal.to_string()));
    obj.set("price", emval(quoteTotal.to_double() / baseTotal.to_double()));
    return obj;
}

static emval make_error(const char* msg)
{
    emval obj = emval::object();
    obj.set("error", emval(std::string(msg)));
    return obj;
}

static emval make_error(std::string msg)
{
    emval obj = emval::object();
    obj.set("error", emval(std::move(msg)));
    return obj;
}

emval match_result()
{
    if (!poolToken || !poolWart) {
        return emval::null();
    }

    const defi::PoolLiquidity_uint64 p { *poolToken, *poolWart };
    auto pTmp { p };
    auto match_res { bso.match(p) };
    emval buys = emval::array();

    auto fquote { match_res.filled.quote };
    for (size_t i = 0; i < bso.quote_desc_buy().size(); ++i) {
        auto order { bso.quote_desc_buy()[i] };
        auto filled { std::min(order.amount, fquote) };
        fquote.subtract_assert(filled);
        emval row = emval::object();
        row.set("amount", emval(order.amount.as_wart().to_string()));
        row.set("filled", emval(filled.as_wart().to_string()));
        row.set("limit", emval(order.limit.to_double_adjusted(baseDecimals)));
        buys.call<void>("push", row);
    }

    emval sells = emval::array();
    auto J { bso.base_asc_sell().size() };
    auto fbase { match_res.filled.base };
    for (size_t j = 0; j < J; ++j) {
        auto order { bso.base_asc_sell()[j] };
        auto filled { std::min(fbase, order.amount) };
        fbase.subtract_assert(filled);
        emval row = emval::object();
        row.set("amount", emval(order.amount.to_decimal(baseDecimals).to_string()));
        row.set("filled", emval(filled.to_decimal(baseDecimals).to_string()));
        row.set("limit", emval(order.limit.to_double_adjusted(baseDecimals)));
        sells.call<void>("push", row);
    }
    sells.call<void>("reverse");

    auto price_val = [](const defi::BaseQuote_uint64& bq) -> emval {
        return emval(bq.price_double(baseDecimals, TokenDecimals::WART.value()));
    };

    const auto& toPool { match_res.toPool };
    auto poolBaseQuote { [&]() -> defi::BaseQuote_uint64 {
        if (toPool) {
            if (toPool->is_quote())
                return {
                    pTmp.buy(toPool->amount(), feeE4),
                    toPool->amount()
                };
            else {
                return {
                    toPool->amount(),
                    pTmp.sell(toPool->amount(), feeE4),
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
            obj.set("base", emval(poolBaseQuote.base.to_decimal(baseDecimals).to_string()));
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
    filledObj.set("outBaseSeller", emval(filledSeller.base.to_decimal(baseDecimals).to_string()));
    filledObj.set("inQuoteSeller", emval(filledSeller.quote.as_wart().to_string()));
    filledObj.set("priceSeller", price_val(filledSeller));
    filledObj.set("outQuoteBuyer", emval(filledBuyer.quote.as_wart().to_string()));
    filledObj.set("inBaseBuyer", emval(filledBuyer.base.to_decimal(baseDecimals).to_string()));
    filledObj.set("priceBuyer", price_val(filledBuyer));

    emval matchedObj = emval::object();
    matchedObj.set("base", emval(matched.base.to_decimal(baseDecimals).to_string()));
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

    emval out = emval::object();
    out.set("match", matchObj);
    return out;
}

static std::string get_string_or_empty(emval v, const char* key)
{
    emval field { v[key] };
    if (field.isUndefined() || field.isNull())
        return std::string();
    return field.as<std::string>();
}

defi::Order_uint64 parse_order(emval v, TokenDecimals decimals)
{
    if (v["price"].isUndefined())
        throw std::runtime_error("Missing 'price' field");
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
            return Price_uint64::from_string(v["price"].as<std::string>()).value();
        } catch (...) {
            throw std::runtime_error("Cannot get price");
        }
    }() };
    return { amount, price };
}

emval edit_pool(emval v)
{
    bool tokenOk = true;
    bool wartOk = true;
    try {
        auto opt = Funds_uint64::parse(get_string_or_empty(v, "token"), baseDecimals);
        if (opt)
            poolToken = opt;
        else {
            poolToken.reset();
            tokenOk = false;
        }
    } catch (...) {
        poolToken.reset();
        tokenOk = false;
    }
    try {
        Result<Wart> result = Wart::try_parse(get_string_or_empty(v, "wart"));
        if (result.has_value())
            poolWart = result.value();
        else {
            poolWart.reset();
            wartOk = false;
        }
    } catch (...) {
        poolWart.reset();
        wartOk = false;
    }
    if (!tokenOk && !wartOk)
        return make_error("Cannot parse token or wart");
    if (!tokenOk)
        return make_error("Cannot parse token");
    if (!wartOk)
        return make_error("Cannot parse wart");
    return match_result();
}

emval delete_order(emval v)
{
    if (v["base"].isUndefined() || v["index"].isUndefined())
        return make_error("Missing 'base' or 'index'");
    try {
        bool base = v["base"].as<bool>();
        auto i = v["index"].as<size_t>();
        if (base)
            bso.delete_base(i);
        else
            bso.delete_quote(i);
    } catch (...) {
        return make_error("'index' must be a non-negative integer");
    }
    return match_result();
}

emval add_buy(emval v)
{
    try {
        auto order { parse_order(v, TokenDecimals::WART) };
        bso.insert_quote(order);
    } catch (std::runtime_error& e) {
        return make_error(e.what());
    } catch (...) {
        return make_error("Failed to add buy order.");
    }
    return match_result();
}

emval add_sell(emval v)
{
    try {
        auto order { parse_order(v, baseDecimals) };
        bso.insert_base(order);
    } catch (std::runtime_error& e) {
        return make_error(e.what());
    } catch (...) {
        return make_error("Failed to add sell order.");
    }
    return match_result();
}

emval set_fee(emval v)
{
    if (v["E4"].isUndefined())
        return make_error("Missing 'E4' field");
    int e4 = 0;
    try {
        e4 = v["E4"].as<int>();
    } catch (...) {
        return make_error("'E4' must be an integer in 0..9999, got " + std::to_string(e4));
    }
    if (e4 >= 0 && e4 < 10000) {
        feeE4 = e4;
        return match_result();
    }
    return make_error("'E4' must be an integer in 0..9999");
}

emval clear_and_set_base_decimals(emval v)
{
    poolToken.reset();
    poolWart.reset();
    bso.clear();

    std::optional<int> baseDecimalsOpt;
    if (v.call<bool>("hasOwnProperty", std::string("baseDecimals"))
        && !v["baseDecimals"].isUndefined()
        && !v["baseDecimals"].isNull()) {
        emval field { v["baseDecimals"] };
        // Branch on JS type to dodge the strict toWireType<int>() / std::string
        // JS exceptions raised during val::as<Type>(). These can't be caught by
        // C++ try/catch, so we coerce via methods that succeed for any input.
        if (field.isNumber()) {
            double n = field.as<double>();
            long rounded = static_cast<long>(n);
            if (n != n || n < 0 || n > 18 || static_cast<double>(rounded) != n)
                return make_error(
                    "'baseDecimals' must be an integer in 0..18, got "
                    + std::to_string(rounded));
            baseDecimalsOpt = static_cast<int>(rounded);
        } else if (field.isString()) {
            std::string raw = field.as<std::string>();
            try {
                size_t pos = 0;
                long parsed = std::stol(raw, &pos);
                if (pos != raw.size() || parsed < 0 || parsed > 18)
                    return make_error(
                        "'baseDecimals' must be an integer in 0..18, got \""
                        + raw + "\"");
                baseDecimalsOpt = static_cast<int>(parsed);
            } catch (...) {
                return make_error(
                    "'baseDecimals' must be an integer in 0..18, got \""
                    + raw + "\"");
            }
        } else {
            // Anything else (boolean, object, ...) is a type error.
            return make_error(
                "'baseDecimals' must be an integer in 0..18, got non-numeric value");
        }
    }

    if (baseDecimalsOpt) {
        const int d = *baseDecimalsOpt;
        auto success = false;
        // The 0..18 range is enforced by TokenDecimals::from_number (max = 18).
        // We also reject negative values explicitly to avoid wraparound on the
        // uint8_t cast inside the constructor.
        if (d >= 0 && d <= 18) {
            Result<TokenDecimals> td { TokenDecimals::from_number(static_cast<uint8_t>(d)) };
            if (td.has_value()) {
                baseDecimals = td.value();
                success = true;
            }
        }
        if (!success)
            return make_error("'baseDecimals' must be an integer in 0..18, got " + std::to_string(d));
    }
    return match_result();
}

EMSCRIPTEN_BINDINGS(demo)
{
    emscripten::function("addBuy", &add_buy);
    emscripten::function("addSell", &add_sell);
    emscripten::function("editPool", &edit_pool);
    emscripten::function("deleteOrder", &delete_order);
    emscripten::function("setFee", &set_fee);
    emscripten::function("clearAndSetBaseDecimals", &clear_and_set_base_decimals);
}
