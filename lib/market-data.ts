/**
 * Get live stock data from MKTS.io (primary) → Finnhub (fallback)
 * MKTS.io API: https://mkts.io/developers
 * Deployed: 2026-04-15 22:36 UTC - Force cache bust
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
 * Get live stock data from MKTS.io (primary) → Finnhub (fallback)
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
          const snapshotData = json.data
          const price = snapshotData.price || 0
          const change24h = snapshotData.change24h || 0
        
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
            name: snapshotData.name || details?.name || ticker.toUpperCase(),
            price: price,
            change: change24h,
            changePercent: change24h,
            volume: snapshotData.volume24h || snapshotData.volume || details?.volume || 0,
            marketCap: snapshotData.marketCap || details?.marketCap || 0,
            peRatio: details?.trailingPE || 0,
            dividendYield: details?.dividendYield || 0,
            dayHigh: snapshotData.h || details?.h || price,
            dayLow: snapshotData.l || details?.l || price,
            open: snapshotData.o || details?.o || price,
            previousClose: price - change24h,
            week52High: details?.fiftyTwoWeekHigh || 0,
            week52Low: details?.fiftyTwoWeekLow || 0,
            currency: snapshotData.currency || 'USD',
            exchange: snapshotData.exchange || '',
            sector: snapshotData.sector || details?.sector || undefined,
            industry: details?.industry || undefined,
            recommendation: details?.recommendationKey,
            targetPrice: details?.targetPrice,
          }
        }
      }
      
      console.log(`[MKTS.io] No data for ${ticker}, trying Finnhub fallback`)
    } catch (error) {
      console.log(`[MKTS.io] Error for ${ticker}:`, error.message)
    }
  }

  // Fallback to Finnhub (your existing API)
  return await getFinnhubQuote(ticker)
}

/**
 * Get stock data from Finnhub (fallback)
 */
async function getFinnhubQuote(ticker: string): Promise<StockData | null> {
  if (!FINNHUB_KEY) {
    console.log('[Finnhub] No API key configured, cannot fetch data')
    return null
  }

  try {
    const [quoteRes, chartRes] = await Promise.allSettled([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker.toUpperCase()}&token=${FINNHUB_KEY}`),
      fetch(`https://finnhub.io/api/v1/company-profile2?symbol=${ticker.toUpperCase()}&token=${FINNHUB_KEY}`)
    ])

    const quoteData = quoteRes.status === 'fulfilled' && quoteRes.value.ok ? await quoteRes.value.json() : null
    const profileData = chartRes.status === 'fulfilled' && chartRes.value.ok ? await chartRes.value.json() : null

    if (!quoteData?.c || quoteData.c === 0) return null

    const price = quoteData.c
    const prevClose = quoteData.o - quoteData.d
    const change = quoteData.d

    return {
      ticker: ticker.toUpperCase(),
      name: profileData?.Name || ticker.toUpperCase(),
      price: price,
      change: change,
      changePercent: prevClose > 0 ? (change / prevClose) * 100 : 0,
      volume: quoteData?.v || 0,
      marketCap: 0, // Not available in Finnhub quote API
      peRatio: 0, // Not available in quote API
      dividendYield: 0, // Not available in quote API
      dayHigh: quoteData?.h || price,
      dayLow: quoteData?.l || price,
      open: quoteData?.o || price,
      previousClose: prevClose,
      week52High: profileData?.FiftyTwoWeekHigh || 0,
      week52Low: profileData?.FiftyTwoWeekLow || 0,
      currency: profileData?.Currency || 'USD',
      exchange: profileData?.StockExchange || '',
      sector: undefined,
      industry: undefined,
      recommendation: undefined,
      targetPrice: undefined,
    }
  } catch (error) {
    console.error(`Finnhub quote fetch failed for ${ticker}:`, error)
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
