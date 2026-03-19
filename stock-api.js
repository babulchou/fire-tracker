/**
 * 实时股票行情模块
 * 支持美股（NASDAQ/NYSE）和港股（HKEX）
 * 使用多个免费 API 源，带降级策略和缓存
 */

const StockAPI = (() => {
    // ==================== 缓存管理 ====================
    const CACHE_KEY = 'fire_stock_cache';
    const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存（行情数据）
    const DAILY_SNAPSHOT_KEY = 'fire_daily_snapshot';

    function getCache() {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch { return {}; }
    }

    function setCache(ticker, data) {
        try {
            const cache = getCache();
            cache[ticker] = { ...data, _ts: Date.now() };
            localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        } catch {}
    }

    function getCachedPrice(ticker) {
        const cache = getCache();
        const entry = cache[ticker];
        if (entry && (Date.now() - entry._ts) < CACHE_TTL) {
            return entry;
        }
        return null;
    }

    // ==================== API 源 ====================

    /**
     * 源1: Yahoo Finance v8 API (通过 CORS proxy)
     * 最全面，支持美股+港股
     */
    async function fetchYahoo(tickers) {
        // Yahoo Finance ticker format: 美股直接用 ticker，港股用 XXXX.HK
        const symbols = tickers.join(',');
        const proxyUrls = [
            `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,currency,shortName,marketState`)}`,
            `https://corsproxy.io/?${encodeURIComponent(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`)}`,
        ];

        for (const url of proxyUrls) {
            try {
                const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
                if (!resp.ok) continue;
                const json = await resp.json();
                const results = json.quoteResponse?.result;
                if (!results || results.length === 0) continue;

                const out = {};
                for (const q of results) {
                    out[q.symbol] = {
                        price: q.regularMarketPrice,
                        change: q.regularMarketChange,
                        changePct: q.regularMarketChangePercent,
                        prevClose: q.regularMarketPreviousClose,
                        open: q.regularMarketOpen,
                        high: q.regularMarketDayHigh,
                        low: q.regularMarketDayLow,
                        currency: q.currency,
                        name: q.shortName || q.longName,
                        marketState: q.marketState, // PRE, REGULAR, POST, CLOSED
                        source: 'yahoo',
                    };
                }
                return out;
            } catch (e) {
                console.log('Yahoo API failed:', e.message);
            }
        }
        return null;
    }

    /**
     * 源2: Finnhub API (免费额度 60次/分)
     * 仅支持美股
     */
    async function fetchFinnhub(ticker) {
        // Finnhub 免费 API 无需 key 的报价端点已关闭，需要 API key
        // 使用 sandbox 作为备用
        const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=sandbox`;
        try {
            const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
            if (!resp.ok) return null;
            const q = await resp.json();
            if (!q.c || q.c === 0) return null;
            return {
                price: q.c,          // current
                change: q.d,          // change
                changePct: q.dp,      // change percent
                prevClose: q.pc,
                open: q.o,
                high: q.h,
                low: q.l,
                source: 'finnhub',
            };
        } catch { return null; }
    }

    /**
     * 源3: Google Finance 非官方 (通过 CORS proxy)
     * 备用方案
     */
    async function fetchGoogleFinance(ticker) {
        try {
            const url = `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://www.google.com/finance/quote/${ticker}:NASDAQ`)}`;
            const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (!resp.ok) return null;
            const html = await resp.text();
            // 从 HTML 中提取价格 (粗略解析)
            const priceMatch = html.match(/data-last-price="([\d.]+)"/);
            if (priceMatch) {
                return {
                    price: parseFloat(priceMatch[1]),
                    source: 'google',
                };
            }
        } catch {}
        return null;
    }

    // ==================== 主要接口 ====================

    /**
     * 获取多只股票的实时报价
     * @param {Array<{ticker: string, market: 'us'|'hk'}>} stocks
     * @returns {Object} { ticker: { price, change, changePct, ... } }
     */
    async function fetchQuotes(stocks) {
        const results = {};
        const uncached = [];

        // 先检查缓存
        for (const s of stocks) {
            const yahooTicker = s.market === 'hk' ? formatHKTicker(s.ticker) : s.ticker;
            const cached = getCachedPrice(yahooTicker);
            if (cached) {
                results[s.ticker] = cached;
            } else {
                uncached.push({ ...s, yahooTicker });
            }
        }

        if (uncached.length === 0) return results;

        // 尝试 Yahoo Finance 批量获取
        const yahooTickers = uncached.map(s => s.yahooTicker);
        const yahooResults = await fetchYahoo(yahooTickers);

        if (yahooResults) {
            for (const s of uncached) {
                const data = yahooResults[s.yahooTicker];
                if (data) {
                    results[s.ticker] = data;
                    setCache(s.yahooTicker, data);
                }
            }
        }

        // 对没拿到的美股，逐个用 Finnhub 补充
        for (const s of uncached) {
            if (!results[s.ticker] && s.market === 'us') {
                const data = await fetchFinnhub(s.ticker);
                if (data) {
                    results[s.ticker] = data;
                    setCache(s.yahooTicker, data);
                }
            }
        }

        return results;
    }

    /**
     * 将本地 ticker 转换为 Yahoo Finance 格式
     * 港股: 00700 -> 0700.HK
     */
    function formatHKTicker(ticker) {
        // 移除 .HK 后缀（如果有），统一处理
        let num = ticker.replace('.HK', '').replace(/^0+/, '');
        if (num.length < 4) num = num.padStart(4, '0');
        return num + '.HK';
    }

    /**
     * 从 Yahoo 格式转回本地格式
     * 0700.HK -> 00700
     */
    function parseHKTicker(yahooTicker) {
        return yahooTicker.replace('.HK', '').padStart(5, '0');
    }

    // ==================== 每日快照 ====================

    /**
     * 获取昨日/上次快照
     */
    function getDailySnapshot() {
        try {
            const raw = localStorage.getItem(DAILY_SNAPSHOT_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }

    /**
     * 保存当日快照
     * @param {Object} data - 完整的 financial_data
     * @param {Object} quotes - 当前行情数据
     */
    function saveDailySnapshot(data, quotes) {
        const today = new Date().toISOString().split('T')[0];
        const snapshot = {
            date: today,
            timestamp: Date.now(),
            total_financial_assets_cny: data.fire_summary.total_financial_assets_cny,
            total_financial_assets_usd: data.fire_summary.total_financial_assets_usd,
            net_worth_cny: data.fire_summary.net_worth_cny,
            stocks: {},
            cash: {},
            exchange_rates: {
                usd_cny: data.assumptions.usd_cny_rate,
                usd_hkd: data.assumptions.usd_hkd_rate,
            },
        };

        // 保存每只股票的快照
        for (const s of data.assets.us_stocks) {
            const q = quotes[s.ticker];
            snapshot.stocks[s.ticker] = {
                market: 'us',
                shares: s.shares,
                price: q ? q.price : s.current_price,
                market_value: q ? q.price * s.shares : s.market_value,
                currency: 'USD',
            };
        }
        for (const s of data.assets.hk_stocks) {
            const q = quotes[s.ticker];
            snapshot.stocks[s.ticker] = {
                market: 'hk',
                shares: s.shares,
                price: q ? q.price : s.current_price,
                market_value_hkd: q ? q.price * s.shares : (s.market_value_hkd || s.market_value),
                currency: 'HKD',
            };
        }

        // 保存现金快照
        for (const c of data.assets.cash) {
            snapshot.cash[c.account] = { amount: c.amount, currency: c.currency };
        }

        localStorage.setItem(DAILY_SNAPSHOT_KEY, JSON.stringify(snapshot));
        return snapshot;
    }

    /**
     * 计算当日资金变动
     * @param {Object} currentData - 当前 financial_data（已更新实时价格后）
     * @param {Object} quotes - 当前行情
     * @returns {Object|null} 变动详情
     */
    function calcDailyChanges(currentData, quotes) {
        const snapshot = getDailySnapshot();
        if (!snapshot) return null;

        const today = new Date().toISOString().split('T')[0];
        if (snapshot.date === today) {
            // 同一天，对比快照
        }

        const changes = {
            snapshot_date: snapshot.date,
            current_date: today,
            items: [],
            total_change_cny: 0,
        };

        const rate = currentData.assumptions.usd_cny_rate;
        const hkRate = currentData.assumptions.usd_hkd_rate;

        // 股票价格变动
        for (const s of currentData.assets.us_stocks) {
            const q = quotes[s.ticker];
            const currentPrice = q ? q.price : s.current_price;
            const prevData = snapshot.stocks[s.ticker];
            if (prevData) {
                const prevValue = prevData.market_value;
                const currentValue = currentPrice * s.shares;
                const changeUSD = currentValue - prevValue;
                const changeCNY = changeUSD * rate;
                if (Math.abs(changeUSD) > 0.01) {
                    changes.items.push({
                        ticker: s.ticker,
                        name: s.name,
                        market: 'us',
                        prev_price: prevData.price,
                        current_price: currentPrice,
                        price_change: currentPrice - prevData.price,
                        price_change_pct: prevData.price > 0 ? ((currentPrice - prevData.price) / prevData.price * 100) : 0,
                        shares: s.shares,
                        value_change_usd: changeUSD,
                        value_change_cny: changeCNY,
                        currency: 'USD',
                    });
                    changes.total_change_cny += changeCNY;
                }
            }
        }

        for (const s of currentData.assets.hk_stocks) {
            const q = quotes[s.ticker];
            const currentPrice = q ? q.price : s.current_price;
            const prevData = snapshot.stocks[s.ticker];
            if (prevData) {
                const prevValueHKD = prevData.market_value_hkd;
                const currentValueHKD = currentPrice * s.shares;
                const changeHKD = currentValueHKD - prevValueHKD;
                const changeCNY = changeHKD / hkRate * rate;
                if (Math.abs(changeHKD) > 0.01) {
                    changes.items.push({
                        ticker: s.ticker,
                        name: s.name,
                        market: 'hk',
                        prev_price: prevData.price,
                        current_price: currentPrice,
                        price_change: currentPrice - prevData.price,
                        price_change_pct: prevData.price > 0 ? ((currentPrice - prevData.price) / prevData.price * 100) : 0,
                        shares: s.shares,
                        value_change_hkd: changeHKD,
                        value_change_cny: changeCNY,
                        currency: 'HKD',
                    });
                    changes.total_change_cny += changeCNY;
                }
            }
        }

        // 总资产变动
        const prevTotal = snapshot.total_financial_assets_cny || 0;
        const currentTotal = currentData.fire_summary.total_financial_assets_cny || 0;
        changes.total_assets_change_cny = currentTotal - prevTotal;

        return changes;
    }

    // ==================== 历史变动记录 ====================
    const DAILY_LOG_KEY = 'fire_daily_changes_log';

    function getDailyLog() {
        try {
            const raw = localStorage.getItem(DAILY_LOG_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch { return []; }
    }

    function appendDailyLog(entry) {
        const log = getDailyLog();
        // 如果今天已有记录，更新它
        const today = entry.date;
        const idx = log.findIndex(l => l.date === today);
        if (idx >= 0) {
            log[idx] = entry;
        } else {
            log.push(entry);
        }
        // 只保留最近90天
        while (log.length > 90) log.shift();
        localStorage.setItem(DAILY_LOG_KEY, JSON.stringify(log));
    }

    /**
     * 检查是否需要新建今日快照（0点后首次访问）
     */
    function shouldCreateNewSnapshot() {
        const snapshot = getDailySnapshot();
        if (!snapshot) return true;
        const today = new Date().toISOString().split('T')[0];
        return snapshot.date !== today;
    }

    // ==================== 市场状态 ====================

    /**
     * 判断市场是否开盘中
     */
    function getMarketStatus() {
        const now = new Date();
        const utcH = now.getUTCHours();
        const utcM = now.getUTCMinutes();

        // 美股: 9:30 - 16:00 ET = 14:30 - 21:00 UTC (冬令时) / 13:30 - 20:00 UTC (夏令时)
        // 简化处理，认为 13:30 - 21:00 UTC 区间可能开盘
        const usOpen = (utcH > 13 || (utcH === 13 && utcM >= 30)) && utcH < 21;

        // 港股: 9:30 - 16:00 HKT = 1:30 - 8:00 UTC
        const hkOpen = (utcH > 1 || (utcH === 1 && utcM >= 30)) && utcH < 8;

        return { us: usOpen, hk: hkOpen };
    }

    return {
        fetchQuotes,
        getCachedPrice,
        getDailySnapshot,
        saveDailySnapshot,
        calcDailyChanges,
        getDailyLog,
        appendDailyLog,
        shouldCreateNewSnapshot,
        getMarketStatus,
        formatHKTicker,
        parseHKTicker,
    };
})();
