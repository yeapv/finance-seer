/**
 * Market Data — MKTS.io as primary source (with Yahoo Finance fallback)
 * MKTS.io API: https://mkts.io/developers
 * 
 * MKTS.io provides:
 *   - Real-time quotes (price, OHLC, volume) via /asset/{symbol}
 *   - Fundamentals via /asset/{symbol}/details
 *   - Historical OHLCV data
 *   - Analyst consensus (targets, recommendations)
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
 * Get live stock data from MKTS.io (primary) or Yahoo Finance (fallback)
 * MKTS.io endpoint: GET /api/v1/asset/{symbol}
 */
export async function getLiveQuote(ticker: string): Promise<StockData | null> {
  // Try MKTS.io first (if API key configured)
  if (MKTS_API_KEY) {
    try {
      const res = await fetch(`${MKTS_BASE}/asset/${ticker.toUpperCase()}`, {
        headers: { 'X-API-Key': MKTS_API_KEY }
      })

      if (res.ok) {
        const json = await res.json()
        if (json.success && json.data) {
          const d = json.data
          const price = d.price || 0
          const change24h = d.change24h || 0
          
          console.log(`[MKTS.io] Retrieved ${ticker} snapshot: $${price.toFixed(2)}, ${change24h}%`)
          
          // Now fetch additional details from /details endpoint
          let details = null
          try {
            const detailsRes = await fetch(`${MKTS_BASE}/asset/${ticker.toUpperCase()}/details`, {
              headers: { 'X-API-Key': MKTS_API_KEY }
            })
            if (detailsRes.ok) {
              const detailsJson = await detailsRes.json()
              if (detailsJson.success && detailsJson.data) {
                details = detailsJson.data
              }
            }
          } catch (e) {
            console.log(`[MKTS.io] Details fetch failed for ${ticker}:`, e)
          }

          return {
            ticker: ticker.toUpperCase(),
            name: d.name || ticker.toUpperCase(),
            price: price,
            change: change24h,
            changePercent: change24h,
            volume: d.volume24h || d.volume || 0,
            marketCap: d.marketCap || 0,
            peRatio: details?.trailingPE || 0,
            dividendYield: details?.dividendYield || 0,
            dayHigh: 0, // Need intraday data
            dayLow: 0, // Need intraday data
            open: 0, // Need intraday data
            previousClose: price - change24h,
            week52High: details?.fiftyTwoWeekHigh || 0,
            week52Low: details?.fiftyTwoWeekLow || 0,
            currency: 'USD',
            exchange: '',
            sector: d.sector || undefined,
            industry: undefined,
            recommendation: details?.recommendationKey,
            targetPrice: details?.targetPrice,
          }
        }
      }
      
      console.log(`[MKTS.io] No data for ${ticker}, trying Yahoo Finance fallback`)
    } catch (error) {
      console.log(`[MKTS.io] Error for ${ticker}:`, error.message)
    }
  }

  // Fallback to Yahoo Finance
  return await getYahooQuote(ticker)
}

/**
 * Get stock data from Yahoo Finance (fallback)
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
 * Get fundamentals data from MKTS.io /details endpoint
 */
export async function getFundamentals(ticker: string) {
  if (!MKTS_API_KEY) return null
  
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

    return result
  } catch (error) {
    console.error(`MKTS fundamentals fetch failed for ${ticker}:`, error)
    return null
  }
}

// Simple cache for fundamentals
const cache = new Map<string, { data: any; ts: number }>()
