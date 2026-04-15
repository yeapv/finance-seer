/**
 * Market Data — MKTS.io as primary source
 * MKTS.io provides:
 *   - Real-time quotes (price, OHLC, volume)
 *   - Historical OHLCV data
 *   - Fundamentals (PE, market cap, margins, etc.)
 *   - Analyst consensus (targets, recommendations)
 *   - News and sentiment
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
 * Get live stock data from MKTS.io
 */
export async function getLiveQuote(ticker: string): Promise<StockData | null> {
  try {
    const res = await fetch(`${MKTS_BASE}/asset/${ticker.toUpperCase()}/price`, {
      headers: { 'X-API-Key': MKTS_API_KEY }
    })

    if (!res.ok) return null

    const json = await res.json()
    if (!json.success) return null

    const d = json.data || {}
    
    // Extract current price data
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
    console.error(`MKTS price fetch failed for ${ticker}:`, error)
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
