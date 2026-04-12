/**
 * Market Data — Single source of truth
 */

// Shared interfaces
export interface HistoricalData {
  date: Date
  open: number
  high: number
  low: number
  close: number
  volume: number
  adjClose: number
}

export interface StockData {
  ticker: string
  name: string
  price: number
  change: number
  changePercent: number
  volume: number
  marketCap: number
  peRatio: number
  dividendYield: number
  dayHigh: number
  dayLow: number
  open: number
  previousClose: number
  week52High: number
  week52Low: number
  currency: string
  exchange: string
}

/**
 * Market Data — Single source of truth (continued)
 * 
 * Finnhub (primary):
 *   - Live quotes (price, OHLC, volume)
 *   - Fundamentals (PE, market cap, 52w range, dividend yield)  
 *   - Company profile (name, exchange, currency)
 *   - News & sentiment
 *   - Search
 * 
 * Yahoo Finance (historical OHLCV only):
 *   - Daily candles for technical analysis (RSI, MACD, Bollinger etc.)
 *   - Intraday data for 1D chart
 *   - Note: Finnhub free tier does not provide historical candles
 */

const FINNHUB_BASE = 'https://finnhub.io/api/v1'
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || ''

// Cache disabled — always fetch fresh data
// const quoteCache = new Map<string, { data: any; ts: number }>()
// const historyCache = new Map<string, { data: any[]; ts: number }>()
// const QUOTE_TTL = 60 * 1000       // 1 min
// const HISTORY_TTL = 60 * 60 * 1000 // 1 hour

function finnhubSymbol(ticker: string) {
  return ticker.endsWith('.SI') ? ticker.replace('.SI', ':SP') : ticker
}

// ─── Live Quote + Fundamentals (Finnhub) ─────────────────────────────────────

// Yahoo fallback for SGX and any ticker Finnhub can't price
async function getYahooQuote(ticker: string) {
  try {
    const [chartRes, quoteRes] = await Promise.allSettled([
      fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`, { headers: { 'User-Agent': 'Mozilla/5.0' } }),
      fetch(`https://query2.finance.yahoo.com/v6/finance/quote?symbols=${ticker}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }),
    ])
    const chartData = chartRes.status === 'fulfilled' && chartRes.value.ok ? await chartRes.value.json() : null
    const quoteData = quoteRes.status === 'fulfilled' && quoteRes.value.ok ? await quoteRes.value.json() : null
    const meta = chartData?.chart?.result?.[0]?.meta
    const q = quoteData?.quoteResponse?.result?.[0]
    if (!meta?.regularMarketPrice) return null
    const price = meta.regularMarketPrice
    const prevClose = meta.previousClose || meta.chartPreviousClose || price
    return {
      ticker, name: meta.longName || meta.shortName || q?.longName || ticker,
      price, change: price - prevClose,
      changePercent: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
      volume: meta.regularMarketVolume || 0,
      marketCap: q?.marketCap || 0,
      peRatio: q?.trailingPE || 0,
      dividendYield: q?.dividendYield || 0,
      dayHigh: meta.regularMarketDayHigh || price,
      dayLow: meta.regularMarketDayLow || price,
      open: meta.regularMarketOpen || price,
      previousClose: prevClose,
      week52High: meta.fiftyTwoWeekHigh || 0,
      week52Low: meta.fiftyTwoWeekLow || 0,
      currency: meta.currency || (ticker.endsWith('.SI') ? 'SGD' : 'USD'),
      exchange: meta.exchangeName || '',
      logo: '', weburl: '',
    }
  } catch { return null }
}

export async function getLiveQuote(ticker: string) {
  // Cache disabled — always fetch fresh
  // const cached = quoteCache.get(ticker)
  // if (cached && Date.now() - cached.ts < QUOTE_TTL) return cached.data

  // SGX tickers: Finnhub free tier doesn't support them, use Yahoo directly
  if (ticker.endsWith('.SI')) {
    const data = await getYahooQuote(ticker)
    // Cache disabled — do not cache even for SGX
    return data
  }

  const sym = finnhubSymbol(ticker)
  const [quoteRes, profileRes, metricsRes] = await Promise.all([
    fetch(`${FINNHUB_BASE}/quote?symbol=${sym}&token=${FINNHUB_KEY}`),
    fetch(`${FINNHUB_BASE}/stock/profile2?symbol=${sym}&token=${FINNHUB_KEY}`),
    fetch(`${FINNHUB_BASE}/stock/metric?symbol=${sym}&metric=all&token=${FINNHUB_KEY}`),
  ])

  const [q, p, m] = await Promise.all([
    quoteRes.json(), profileRes.json(),
    metricsRes.ok ? metricsRes.json() : { metric: {} }
  ])

  // Finnhub returned no price — fall back to Yahoo
  if (!q.c) return getYahooQuote(ticker)
  const metrics = m?.metric || {}

  const data = {
    ticker,
    name: p.name || ticker,
    price: q.c,
    change: q.c - q.pc,
    changePercent: q.pc > 0 ? ((q.c - q.pc) / q.pc) * 100 : 0,
    volume: q.v ?? 0,
    marketCap: (p.marketCapitalization || 0) * 1e6,
    peRatio: metrics.peBasicExclExtraTTM || metrics.peNormalizedAnnual || 0,
    dividendYield: metrics.dividendYieldIndicatedAnnual || 0,
    dayHigh: q.h, dayLow: q.l,
    open: q.o, previousClose: q.pc,
    week52High: metrics['52WeekHigh'] || 0,
    week52Low: metrics['52WeekLow'] || 0,
    currency: p.currency || (ticker.endsWith('.SI') ? 'SGD' : 'USD'),
    exchange: p.exchange || '',
    logo: p.logo || '',
    weburl: p.weburl || '',
  }

  // Cache disabled — skip caching
  // quoteCache.set(ticker, { data, ts: Date.now() })
  return data
}

// ─── News (Finnhub) ───────────────────────────────────────────────────────────

export async function getNews(ticker: string): Promise<{ headline: string; sentiment: string; source: string; datetime: number }[]> {
  const sym = finnhubSymbol(ticker)
  const to = new Date().toISOString().split('T')[0]
  const from = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]

  try {
    const res = await fetch(`${FINNHUB_BASE}/company-news?symbol=${sym}&from=${from}&to=${to}&token=${FINNHUB_KEY}`)
    if (!res.ok) return []
    const news = await res.json()

    return (news || []).slice(0, 10).map((n: any) => {
      const text = (n.headline + ' ' + (n.summary || '')).toLowerCase()
      const pos = ['upgrade','beat','strong','growth','surge','rally','profit','record','buy','bullish'].filter(w => text.includes(w)).length
      const neg = ['downgrade','miss','weak','decline','fall','loss','cut','sell','bearish','warn'].filter(w => text.includes(w)).length
      return {
        headline: n.headline,
        source: n.source,
        datetime: n.datetime,
        sentiment: pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral'
      }
    })
  } catch { return [] }
}

// ─── Search (Finnhub) ─────────────────────────────────────────────────────────

export async function searchTickers(query: string): Promise<{ symbol: string; description: string; type: string }[]> {
  try {
    const res = await fetch(`${FINNHUB_BASE}/search?q=${encodeURIComponent(query)}&token=${FINNHUB_KEY}`)
    if (!res.ok) return []
    const data = await res.json()
    return (data.result || [])
      .filter((r: any) => r.type === 'Common Stock' || r.type === 'ETP') // equities + ETFs only
      .slice(0, 10)
      .map((r: any) => ({ symbol: r.symbol, description: r.description, type: r.type }))
  } catch { return [] }
}

// ─── Historical OHLCV (Yahoo — Finnhub free tier doesn't provide this) ────────

export async function getHistoricalOHLCV(ticker: string, period: string): Promise<any[]> {
  // Cache disabled — always fetch fresh
  // const cached = historyCache.get(`${ticker}:${period}`)
  // if (cached && Date.now() - cached.ts < HISTORY_TTL) return cached.data

  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=${period}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    })
    if (!res.ok) throw new Error(`Yahoo ${res.status}`)
    const json = await res.json()
    const result = json?.chart?.result?.[0]
    if (!result) throw new Error('No data')

    const ts = result.timestamp || []
    const q = result.indicators.quote[0] || {}
    const adj = result.indicators.adjclose?.[0]?.adjclose || []

    const data = ts.map((t: number, i: number) => ({
      date: new Date(t * 1000),
      open: q.open?.[i] || 0,
      high: q.high?.[i] || 0,
      low: q.low?.[i] || 0,
      close: q.close?.[i] || 0,
      volume: q.volume?.[i] || 0,
      adjClose: adj[i] || q.close?.[i] || 0,
    })).filter((d: any) => d.close > 0)

    // Cache disabled — always return fresh data
    return data
  } catch (e) {
    console.error(`History fetch failed for ${ticker}:`, e)
    return []
  }
}

// ─── Intraday (Yahoo — last complete trading day) ──────────────────────

export async function getIntradayOHLCV(ticker: string): Promise<any[]> {
  try {
    // Use 5d range to get recent data, then filter to last trading day
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=5d`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    })
    if (!res.ok) return []
    const json = await res.json()
    const result = json?.chart?.result?.[0]
    if (!result) return []

    const ts = result.timestamp || []
    const q = result.indicators.quote[0] || {}
    const adj = result.indicators.adjclose?.[0]?.adjclose || []

    // Group by date and get the last complete trading day
    const byDate = new Map<string, any[]>()
    for (let i = 0; i < ts.length; i++) {
      const date = new Date(ts[i] * 1000).toISOString().split('T')[0]
      if (!byDate.has(date)) byDate.set(date, [])
      byDate.get(date).push({
        date: new Date(ts[i] * 1000),
        open: q.open?.[i] || 0,
        high: q.high?.[i] || 0,
        low: q.low?.[i] || 0,
        close: q.close?.[i] || 0,
        volume: q.volume?.[i] || 0,
        adjClose: adj[i] || q.close?.[i] || 0,
      })
    }

    // Get the last trading day (prioritize Friday, then fall back to last available)
    const dates = Array.from(byDate.keys()).sort().reverse()
    
    // Helper: get day of week from UTC date string (0=Sun, 1=Mon, ..., 5=Fri, 6=Sat)
    const getUTCDay = (utcDate: string): number => {
      const [year, month, day] = utcDate.split('-').map(Number)
      const date = new Date(Date.UTC(year, month - 1, day))
      return date.getUTCDay()
    }
    
    // First try to find Friday's data (UTC Friday = day 5)
    const fridayDate = dates.find(d => getUTCDay(d) === 5)
    
    // If Friday exists and has good data, use it
    if (fridayDate && byDate.get(fridayDate)?.length >= 50) {
      const data = byDate.get(fridayDate) || []
      return data.filter((d: any) => d.close > 0)
    }
    
    // Otherwise, use the most recent trading day (skip incomplete today)
    const lastCompleteDay = dates.find(d => {
      const count = byDate.get(d)?.length || 0
      return count >= 50 // At least 50 candles = complete session
    }) || dates[0]

    return (byDate.get(lastCompleteDay) || []).filter((d: any) => d.close > 0)
  } catch {
    return []
  }
}
