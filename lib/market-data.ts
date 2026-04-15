/**
 * Market Data — Yahoo Finance as primary source (proven working)
 * MKTS.io available as secondary source for enhanced data
 */

export interface HistoricalData {
  date: Date
  open: number
  high: number
  low: number
  close: number
  volume: number
  adjClose: number
}

const MKTS_BASE = 'https://mkts.io/api/v1'
const MKTS_API_KEY = process.env.MKTS_API_KEY || ''
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || ''

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
  sector?: string
  industry?: string
  recommendation?: string
  targetPrice?: number
}

/**
 * Get live stock data from Yahoo Finance (reliable fallback)
 */
export async function getLiveQuote(ticker: string): Promise<StockData | null> {
  // Try MKTS.io first (if API key configured and working)
  if (MKTS_API_KEY) {
    try {
      const mktsData = await getMKTSQuote(ticker)
      if (mktsData) return mktsData
    } catch (e) {
      console.log(`MKTS.io failed for ${ticker}, falling back to Yahoo Finance`)
    }
  }

  // Fall back to Yahoo Finance (proven to work)
  return await getYahooQuote(ticker)
}

/**
 * Get stock data from MKTS.io
 */
async function getMKTSQuote(ticker: string): Promise<StockData | null> {
  try {
    // MKTS.io API structure needs proper authentication
    // This is a placeholder - actual implementation depends on MKTS API docs
    const res = await fetch(`${MKTS_BASE}/quotes/${ticker.toUpperCase()}`, {
      headers: { 'X-API-Key': MKTS_API_KEY }
    })

    if (!res.ok) return null

    const json = await res.json()
    if (!json.success) return null

    const d = json.data || {}
    const price = d.currentPrice || d.price || 0
    const prevClose = d.previousClose || d.pc || price

    return {
      ticker: ticker.toUpperCase(),
      name: d.name || ticker.toUpperCase(),
      price: price,
      change: price - prevClose,
      changePercent: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
      volume: d.volume || d.avgVolume || 0,
      marketCap: d.marketCap || d.marketCapRaw || 0,
      peRatio: d.trailingPE || d.pe || 0,
      dividendYield: d.dividendYield || d.dy || 0,
      dayHigh: d.dayHigh || d.h || price,
      dayLow: d.dayLow || d.l || price,
      open: d.open || d.o || price,
      previousClose: prevClose,
      week52High: d.fiftyTwoWeekHigh || d.fiftyTwoWkHigh || 0,
      week52Low: d.fiftyTwoWeekLow || d.fiftyTwoWkLow || 0,
      currency: d.currency || 'USD',
      exchange: d.exchange || '',
      sector: d.sector,
      industry: d.industry,
      recommendation: d.recommendationKey,
      targetPrice: d.targetPrice,
    }
  } catch (error) {
    console.error(`MKTS quote fetch failed for ${ticker}:`, error)
    return null
  }
}

/**
 * Get live stock data from Yahoo Finance
 */
async function getYahooQuote(ticker: string): Promise<StockData | null> {
  try {
    const [chartRes, quoteRes] = await Promise.allSettled([
      fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${ticker.toUpperCase()}?interval=1d&range=5d`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      }),
      fetch(`https://query2.finance.yahoo.com/v6/finance/quote?symbols=${ticker.toUpperCase()}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      })
    ])

    const chartData = chartRes.status === 'fulfilled' && chartRes.value.ok ? await chartRes.value.json() : null
    const quoteData = quoteRes.status === 'fulfilled' && quoteRes.value.ok ? await quoteRes.value.json() : null

    const meta = chartData?.chart?.result?.[0]?.meta
    const q = quoteData?.quoteResponse?.result?.[0]

    if (!meta?.regularMarketPrice) return null

    const price = meta.regularMarketPrice
    const prevClose = meta.previousClose || meta.chartPreviousClose || price

    return {
      ticker: ticker.toUpperCase(),
      name: q?.shortName || meta.symbol || ticker.toUpperCase(),
      price: price,
      change: price - prevClose,
      changePercent: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
      volume: q?.regularMarketVolume || meta.volume || 0,
      marketCap: q?.marketCap || 0,
      peRatio: q?.trailingPE || 0,
      dividendYield: q?.dividendYield || 0,
      dayHigh: q?.dayHigh || meta.fiftyTwoWeekHigh || price,
      dayLow: q?.dayLow || meta.fiftyTwoWeekLow || price,
      open: q?.regularMarketOpen || price,
      previousClose: prevClose,
      week52High: meta.fiftyTwoWeekHigh || 0,
      week52Low: meta.fiftyTwoWeekLow || 0,
      currency: meta.currency || 'USD',
      exchange: q?.exchangeName || '',
      sector: q?.sector || undefined,
      industry: q?.industry || undefined,
      recommendation: undefined,
      targetPrice: undefined,
    }
  } catch (error) {
    console.error(`Yahoo Finance quote fetch failed for ${ticker}:`, error)
    return null
  }
}

/**
 * Get historical OHLCV data from MKTS.io
 */
export async function getHistoricalOHLCV(ticker: string, period: string): Promise<HistoricalData[]> {
  try {
    const res = await fetch(`${MKTS_BASE}/asset/${ticker.toUpperCase()}/history?period=${period}`, {
      headers: { 'X-API-Key': MKTS_API_KEY }
    })

    if (!res.ok) return []

    const json = await res.json()
    if (!json.success) return []

    const data = json.data || []
    return data.map((item: any) => ({
      date: new Date(item.date || item.timestamp),
      open: item.open || item.O,
      high: item.high || item.H,
      low: item.low || item.L,
      close: item.close || item.C,
      volume: item.volume || item.V,
      adjClose: item.adjClose || item.AC || item.close || item.C,
    }))
  } catch (error) {
    console.error(`MKTS history fetch failed for ${ticker}:`, error)
    return []
  }
}

/**
 * Get fundamentals data from MKTS.io (cached for 1 hour)
 */
export async function getFundamentals(ticker: string) {
  const cacheKey = `fundamentals:${ticker}`
  const cached = cache.get(cacheKey)
  
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) {
    return cached.data
  }

  try {
    const res = await fetch(`${MKTS_BASE}/asset/${ticker.toUpperCase()}/details`, {
      headers: { 'X-API-Key': MKTS_API_KEY }
    })

    if (!res.ok) return null

    const json = await res.json()
    if (!json.success) return null

    const d = json.data || {}
    const result = {
      ticker: ticker.toUpperCase(),
      name: d.name,
      sector: d.sector,
      industry: d.industry,
      recommendation: d.recommendationKey,
      targetPrice: d.targetPrice,
      numberOfAnalysts: d.numberOfAnalysts,
      trailingPE: d.trailingPE,
      forwardPE: d.forwardPE,
      priceToBook: d.priceToBook,
      dividendYield: d.dividendYield,
      beta: d.beta,
      revenueGrowth: d.revenueGrowth,
      earningsGrowth: d.earningsGrowth,
      grossMargins: d.grossMargins,
      operatingMargins: d.operatingMargins,
      profitMargins: d.profitMargins,
      returnOnEquity: d.returnOnEquity,
      returnOnAssets: d.returnOnAssets,
      totalDebt: d.totalDebt,
      debtToEquity: d.debtToEquity,
      freeCashflow: d.freeCashflow,
      fiftyTwoWeekHigh: d.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: d.fiftyTwoWeekLow,
      calendarEvents: d.calendarEvents,
      recommendationTrend: d.recommendationTrend?.slice(0, 4) || [],
    }

    cache.set(cacheKey, { data: result, ts: Date.now() })
    return result
  } catch (error) {
    console.error(`MKTS fundamentals fetch failed for ${ticker}:`, error)
    return null
  }
}

/**
 * Search stocks by name or ticker
 */
export async function searchStocks(query: string) {
  try {
    const res = await fetch(`${MKTS_BASE}/search?q=${encodeURIComponent(query)}`, {
      headers: { 'X-API-Key': MKTS_API_KEY }
    })

    if (!res.ok) return []

    const json = await res.json()
    if (!json.success) return []

    return (json.data || []).slice(0, 10).map((item: any) => ({
      symbol: item.symbol,
      name: item.name,
      exchange: item.exchange,
      type: item.type,
    }))
  } catch (error) {
    console.error(`MKTS search failed for ${query}:`, error)
    return []
  }
}

/**
 * Get news for a stock
 */
export async function getStockNews(ticker: string) {
  try {
    const res = await fetch(`${MKTS_BASE}/asset/${ticker.toUpperCase()}/news`, {
      headers: { 'X-API-Key': MKTS_API_KEY }
    })

    if (!res.ok) return []

    const json = await res.json()
    if (!json.success) return []

    return (json.data || []).slice(0, 10)
  } catch (error) {
    console.error(`MKTS news fetch failed for ${ticker}:`, error)
    return []
  }
}

/**
 * Get intraday OHLCV data from MKTS.io (last complete trading day)
 */
export async function getIntradayOHLCV(ticker: string): Promise<any[]> {
  try {
    const res = await fetch(`${MKTS_BASE}/asset/${ticker.toUpperCase()}/intraday`, {
      headers: { 'X-API-Key': MKTS_API_KEY }
    })

    if (!res.ok) return []

    const json = await res.json()
    if (!json.success) return []

    return (json.data || [])
  } catch (error) {
    console.error(`MKTS intraday fetch failed for ${ticker}:`, error)
    return []
  }
}

/**
 * Get news for a stock (alias for getStockNews for backwards compatibility)
 */
export async function getNews(ticker: string) {
  return getStockNews(ticker)
}

// Simple cache for fundamentals
const cache = new Map<string, { data: any; ts: number }>()
