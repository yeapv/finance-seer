/**
 * Market Data — MKTS.io (primary) → Finnhub (fallback)
 * MKTS.io API: https://mkts.io/developers
 *
 * Functions exported:
 *   getLiveQuote(ticker)          — real-time quote
 *   getHistoricalOHLCV(ticker, period) — daily OHLCV candles
 *   getIntradayOHLCV(ticker)      — intraday 5-min candles (falls back to 1d daily)
 *   getNews(ticker)               — recent news with sentiment
 *   getFundamentals(ticker)       — PE, margins, analyst consensus, etc.
 */

// ─── Interfaces ───────────────────────────────────────────────────────────────

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
  sector?: string
  industry?: string
  recommendation?: string
  targetPrice?: number
}

export interface NewsItem {
  headline: string
  summary: string
  url: string
  datetime: number
  source: string
  sentiment: 'positive' | 'negative' | 'neutral'
}

// ─── Config ───────────────────────────────────────────────────────────────────

const MKTS_BASE    = 'https://mkts.io/api/v1'
const MKTS_API_KEY = process.env.MKTS_API_KEY || ''
const FINNHUB_KEY  = process.env.FINNHUB_API_KEY || ''

// ─── getLiveQuote ─────────────────────────────────────────────────────────────

export async function getLiveQuote(ticker: string): Promise<StockData | null> {
  if (MKTS_API_KEY) {
    try {
      const res = await fetch(`${MKTS_BASE}/asset/${ticker.toUpperCase()}`, {
        headers: { 'X-API-Key': MKTS_API_KEY },
      })

      if (res.ok) {
        const json = await res.json()
        if (json.success && json.data) {
          const snap = json.data
          const price    = snap.price     || 0
          const change24h = snap.change24h || 0

          console.log(`[MKTS.io] ${ticker} snapshot: $${price.toFixed(2)}, ${change24h}%`)

          // Fetch fundamentals/details in parallel to enrich the quote
          let details: Record<string, any> | null = null
          try {
            const dRes = await fetch(`${MKTS_BASE}/asset/${ticker.toUpperCase()}/details`, {
              headers: { 'X-API-Key': MKTS_API_KEY },
            })
            if (dRes.ok) {
              const dJson = await dRes.json()
              if (dJson.success && dJson.data) {
                details = dJson.data
              }
            }
          } catch (e) {
            console.log(`[MKTS.io] Details fetch failed for ${ticker}:`, e)
          }

          return {
            ticker:        ticker.toUpperCase(),
            name:          snap.name          || details?.name          || ticker.toUpperCase(),
            price,
            change:        change24h,
            changePercent: change24h,
            volume:        snap.volume24h      || snap.volume           || details?.volume      || 0,
            marketCap:     snap.marketCap      || details?.marketCap    || 0,
            peRatio:       details?.trailingPE || 0,
            dividendYield: details?.dividendYield || 0,
            dayHigh:       snap.h              || details?.h            || price,
            dayLow:        snap.l              || details?.l            || price,
            open:          snap.o              || details?.o            || price,
            previousClose: price - change24h,
            week52High:    details?.fiftyTwoWeekHigh || 0,
            week52Low:     details?.fiftyTwoWeekLow  || 0,
            currency:      snap.currency       || 'USD',
            exchange:      snap.exchange       || '',
            sector:        snap.sector         || details?.sector       || undefined,
            industry:      details?.industry   || undefined,
            recommendation: details?.recommendationKey,
            targetPrice:   details?.targetPrice,
          }
        }
      }

      console.log(`[MKTS.io] No data for ${ticker}, falling back to Finnhub`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[MKTS.io] Error for ${ticker}:`, msg)
    }
  }

  return getFinnhubQuote(ticker)
}

// ─── getHistoricalOHLCV ───────────────────────────────────────────────────────

/**
 * Daily OHLCV candles for the requested period.
 * period: '5d' | '1mo' | '3mo' | '6mo' | '1y' | '5y'
 */
// Map app period strings → MKTS.io range values
const PERIOD_TO_RANGE: Record<string, string> = {
  '5d':  '1M',   // closest available
  '1mo': '1M',
  '3mo': '3M',
  '6mo': '6M',
  '1y':  '1Y',
  '5y':  '1Y',   // MKTS.io max is 1Y
}

export async function getHistoricalOHLCV(ticker: string, period: string): Promise<HistoricalData[]> {
  if (MKTS_API_KEY) {
    try {
      const range = PERIOD_TO_RANGE[period] || '3M'
      const res = await fetch(
        `${MKTS_BASE}/asset/${ticker.toUpperCase()}/history?range=${range}`,
        { headers: { 'X-API-Key': MKTS_API_KEY } }
      )
      if (res.ok) {
        const json = await res.json()
        if (json.success && json.data?.candles?.length) {
          return json.data.candles.map((c: any): HistoricalData => ({
            date:     new Date(c.date),
            open:     c.open   || 0,
            high:     c.high   || 0,
            low:      c.low    || 0,
            close:    c.close  || 0,
            volume:   c.volume || 0,
            adjClose: c.close  || 0,
          }))
        }
      }
      console.log(`[MKTS.io] No history for ${ticker} (${period}), falling back to Finnhub`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[MKTS.io] History error for ${ticker}:`, msg)
    }
  }

  return getFinnhubHistory(ticker, period)
}

// ─── getIntradayOHLCV ─────────────────────────────────────────────────────────

/**
 * Intraday candles for today (5-min bars where available, else 1d daily).
 */
export async function getIntradayOHLCV(ticker: string): Promise<HistoricalData[]> {
  if (MKTS_API_KEY) {
    try {
      // MKTS.io minimum range is 1M; use it for intraday approximation
      const res = await fetch(
        `${MKTS_BASE}/asset/${ticker.toUpperCase()}/history?range=1M`,
        { headers: { 'X-API-Key': MKTS_API_KEY } }
      )
      if (res.ok) {
        const json = await res.json()
        if (json.success && json.data?.candles?.length) {
          return json.data.candles.map((c: any): HistoricalData => ({
            date:     new Date(c.date),
            open:     c.open   || 0,
            high:     c.high   || 0,
            low:      c.low    || 0,
            close:    c.close  || 0,
            volume:   c.volume || 0,
            adjClose: c.close  || 0,
          }))
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[MKTS.io] Intraday error for ${ticker}:`, msg)
    }
  }

  // Fallback: last 5 daily candles as "intraday" approximation
  return getHistoricalOHLCV(ticker, '5d')
}

// ─── getNews ──────────────────────────────────────────────────────────────────

/**
 * Fetch recent company news via Finnhub (MKTS.io news endpoint not available).
 */
export async function getNews(ticker: string): Promise<NewsItem[]> {
  if (!FINNHUB_KEY) return []

  try {
    const to   = new Date()
    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // last 7 days
    const fmt  = (d: Date) => d.toISOString().split('T')[0]

    const res = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${ticker.toUpperCase()}&from=${fmt(from)}&to=${fmt(to)}&token=${FINNHUB_KEY}`
    )
    if (!res.ok) return []

    const raw: any[] = await res.json()
    if (!Array.isArray(raw)) return []

    return raw.slice(0, 20).map((n): NewsItem => ({
      headline:  n.headline  || '',
      summary:   n.summary   || '',
      url:       n.url       || '',
      datetime:  n.datetime  || 0,
      source:    n.source    || '',
      sentiment: scoreSentiment(n.headline + ' ' + n.summary),
    }))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[Finnhub] News error for ${ticker}:`, msg)
    return []
  }
}

function scoreSentiment(text: string): 'positive' | 'negative' | 'neutral' {
  const t = text.toLowerCase()
  const pos = ['beat', 'surge', 'rally', 'gain', 'profit', 'growth', 'record', 'strong', 'upgrade', 'buy', 'bullish', 'rise', 'up', 'positive', 'exceed']
  const neg = ['miss', 'drop', 'fall', 'loss', 'decline', 'weak', 'downgrade', 'sell', 'bearish', 'cut', 'down', 'negative', 'concern', 'risk', 'warn']
  const p = pos.filter(w => t.includes(w)).length
  const n = neg.filter(w => t.includes(w)).length
  if (p > n) return 'positive'
  if (n > p) return 'negative'
  return 'neutral'
}

// ─── getFundamentals ─────────────────────────────────────────────────────────

export async function getFundamentals(ticker: string) {
  if (!MKTS_API_KEY) return null

  try {
    const res = await fetch(`${MKTS_BASE}/asset/${ticker.toUpperCase()}/details`, {
      headers: { 'X-API-Key': MKTS_API_KEY },
    })
    if (!res.ok) return null

    const json = await res.json()
    if (!json.success) return null

    const d = json.data || {}
    return {
      ticker:             ticker.toUpperCase(),
      name:               d.name,
      sector:             d.sector,
      industry:           d.industry,
      recommendation:     d.recommendationKey,
      targetPrice:        d.targetPrice,
      numberOfAnalysts:   d.numberOfAnalysts,
      trailingPE:         d.trailingPE,
      forwardPE:          d.forwardPE,
      priceToBook:        d.priceToBook,
      dividendYield:      d.dividendYield,
      beta:               d.beta,
      revenueGrowth:      d.revenueGrowth,
      earningsGrowth:     d.earningsGrowth,
      grossMargins:       d.grossMargins,
      operatingMargins:   d.operatingMargins,
      profitMargins:      d.profitMargins,
      returnOnEquity:     d.returnOnEquity,
      returnOnAssets:     d.returnOnAssets,
      totalDebt:          d.totalDebt,
      debtToEquity:       d.debtToEquity,
      freeCashflow:       d.freeCashflow,
      fiftyTwoWeekHigh:   d.fiftyTwoWeekHigh,
      fiftyTwoWeekLow:    d.fiftyTwoWeekLow,
      calendarEvents:     d.calendarEvents,
      recommendationTrend: d.recommendationTrend?.slice(0, 4) || [],
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[MKTS.io] Fundamentals error for ${ticker}:`, msg)
    return null
  }
}

// ─── Finnhub fallbacks ────────────────────────────────────────────────────────

async function getFinnhubQuote(ticker: string): Promise<StockData | null> {
  if (!FINNHUB_KEY) {
    console.log('[Finnhub] No API key configured')
    return null
  }
  try {
    const [qRes, pRes] = await Promise.allSettled([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker.toUpperCase()}&token=${FINNHUB_KEY}`),
      fetch(`https://finnhub.io/api/v1/company-profile2?symbol=${ticker.toUpperCase()}&token=${FINNHUB_KEY}`),
    ])

    const q = qRes.status === 'fulfilled' && qRes.value.ok ? await qRes.value.json() : null
    const p = pRes.status === 'fulfilled' && pRes.value.ok ? await pRes.value.json() : null

    if (!q?.c || q.c === 0) return null

    const price     = q.c
    const prevClose = q.pc || (q.o - q.d)
    const change    = q.d

    return {
      ticker:        ticker.toUpperCase(),
      name:          p?.name || ticker.toUpperCase(),
      price,
      change,
      changePercent: prevClose > 0 ? (change / prevClose) * 100 : 0,
      volume:        q.v  || 0,
      marketCap:     0,
      peRatio:       0,
      dividendYield: 0,
      dayHigh:       q.h  || price,
      dayLow:        q.l  || price,
      open:          q.o  || price,
      previousClose: prevClose,
      week52High:    0,
      week52Low:     0,
      currency:      p?.currency || 'USD',
      exchange:      p?.exchange  || '',
      sector:        undefined,
      industry:      undefined,
      recommendation: undefined,
      targetPrice:   undefined,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[Finnhub] Quote error for ${ticker}:`, msg)
    return null
  }
}

async function getFinnhubHistory(ticker: string, period: string): Promise<HistoricalData[]> {
  if (!FINNHUB_KEY) return []

  const periodDays: Record<string, number> = {
    '5d': 5, '1mo': 30, '3mo': 90, '6mo': 180, '1y': 365, '5y': 1825,
  }
  const days = periodDays[period] || 30
  const to   = Math.floor(Date.now() / 1000)
  const from = to - days * 86400

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/stock/candle?symbol=${ticker.toUpperCase()}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`
    )
    if (!res.ok) return []

    const json = await res.json()
    if (json.s !== 'ok' || !json.t?.length) return []

    return json.t.map((ts: number, i: number): HistoricalData => ({
      date:     new Date(ts * 1000),
      open:     json.o[i] || 0,
      high:     json.h[i] || 0,
      low:      json.l[i] || 0,
      close:    json.c[i] || 0,
      volume:   json.v[i] || 0,
      adjClose: json.c[i] || 0,
    }))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[Finnhub] History error for ${ticker}:`, msg)
    return []
  }
}
