/**
 * Market Screener — Full universe scan
 * Scans US markets (NYSE/NASDAQ) during NYSE hours
 * Returns ranked opportunities based on technical + fundamental + sentiment scores
 */

const FINNHUB_BASE = 'https://finnhub.io/api/v1'

// Cache to avoid hammering Finnhub
const screenCache = new Map<string, { data: any; timestamp: number }>()
const CACHE_TTL = 30 * 60 * 1000 // 30 min

// ─── US Market Universe ───────────────────────────────────────────────────────
// Large/mid cap equities + major ETFs — expanded, not fixed
const US_LARGE_CAP = [
  // Tech
  'AAPL','MSFT','NVDA','GOOGL','GOOG','META','AMZN','TSLA','AMD','INTC',
  'ORCL','CRM','ADBE','NFLX','QCOM','TXN','AVGO','MU','AMAT','LRCX',
  'SNOW','PLTR','NET','DDOG','ZS','CRWD','PANW','OKTA','MDB','COIN',
  // Finance
  'JPM','BAC','GS','MS','WFC','C','BLK','SCHW','V','MA','AXP','PYPL',
  // Healthcare
  'JNJ','PFE','MRK','ABBV','LLY','TMO','ABT','DHR','BMY','AMGN','GILD',
  // Consumer
  'COST','WMT','TGT','AMZN','HD','LOW','NKE','SBUX','MCD','YUM',
  // Energy
  'XOM','CVX','COP','SLB','EOG','PXD','OXY','VLO','PSX',
  // Industrial
  'CAT','DE','HON','GE','RTX','LMT','NOC','BA','UPS','FDX',
  // ETFs (equities/broad market only)
  'SPY','QQQ','IWM','DIA','XLK','XLF','XLE','XLV','XLY','ARKK',
  'VTI','VOO','VGT','SOXX','GDX','XBI','IBB','IYR','XLP','XLU',
]

export function getCurrentMarketSession(): 'NYSE' | 'CLOSED' {
  const now = new Date()
  const utcHour = now.getUTCHours()
  const utcMin  = now.getUTCMinutes()
  const utcTime = utcHour * 100 + utcMin
  const dayOfWeek = now.getUTCDay() // 0=Sun, 6=Sat

  if (dayOfWeek === 0 || dayOfWeek === 6) return 'CLOSED'

  // NYSE trading hours: 13:30-20:00 UTC (buffer to 20:05 for closing data feed)
  const nyseOpen = utcTime >= 1330 && utcTime < 2005
  return nyseOpen ? 'NYSE' : 'CLOSED'
}

export function getTickersForSession(session: 'NYSE'): string[] {
  return US_LARGE_CAP
}

interface ScreenResult {
  ticker: string
  price: number
  change: number
  changePct: number
  currency: string
  score: number        // composite score -100 to +100
  signal: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL'
  reasons: string[]
}

export async function screenMarket(
  session: 'NYSE',
  apiKey: string,
  limit = 60
): Promise<ScreenResult[]> {
  const cacheKey = `screen:${session}`
  const cached = screenCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data
  }

  const tickers = getTickersForSession(session).slice(0, limit)
  const results: ScreenResult[] = []

  // Batch fetch quotes — Finnhub rate limit is 60/min on free tier
  // Process in chunks of 20 with small delay
  const CHUNK = 20
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const chunk = tickers.slice(i, i + CHUNK)
    const quotes = await Promise.allSettled(
      chunk.map(ticker => fetchQuoteAndScore(ticker, apiKey))
    )
    for (const q of quotes) {
      if (q.status === 'fulfilled' && q.value) results.push(q.value)
    }
    if (i + CHUNK < tickers.length) {
      await new Promise(r => setTimeout(r, 1100)) // ~1s between chunks
    }
  }

  // Sort by absolute score (strongest signals first)
  results.sort((a, b) => Math.abs(b.score) - Math.abs(a.score))

  screenCache.set(cacheKey, { data: results, timestamp: Date.now() })
  return results
}

async function fetchQuoteAndScore(ticker: string, apiKey: string): Promise<ScreenResult | null> {
  try {
    const symbol = ticker
    const currency = 'USD'

    // Fetch quote
    const qRes = await fetch(`${FINNHUB_BASE}/quote?symbol=${symbol}&token=${apiKey}`)
    if (!qRes.ok) return null
    const q = await qRes.json()
    if (!q.c || q.c === 0) return null

    const price = q.c
    const prevClose = q.pc || price
    const change = price - prevClose
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0

    // Quick scoring based on price action (no historical data needed for screening)
    let score = 0
    const reasons: string[] = []

    // Price momentum
    if (changePct > 3) { score += 20; reasons.push(`Strong up day +${changePct.toFixed(1)}%`) }
    else if (changePct > 1) { score += 10; reasons.push(`Up day +${changePct.toFixed(1)}%`) }
    else if (changePct < -3) { score -= 20; reasons.push(`Strong down day ${changePct.toFixed(1)}%`) }
    else if (changePct < -1) { score -= 10; reasons.push(`Down day ${changePct.toFixed(1)}%`) }

    // 52-week position
    const week52High = q['52WeekHigh'] || q.h || price
    const week52Low = q['52WeekLow'] || q.l || price
    const range = week52High - week52Low
    if (range > 0) {
      const pos = (price - week52Low) / range
      if (pos < 0.15) { score += 25; reasons.push(`Near 52-week low (${(pos*100).toFixed(0)}% of range) — potential value`) }
      else if (pos > 0.90) { score -= 15; reasons.push(`Near 52-week high — limited upside`) }
      else if (pos > 0.75) { score += 10; reasons.push(`Upper range breakout territory`) }
    }

    // Intraday range — high volatility = opportunity
    const intradayRange = ((q.h - q.l) / q.l) * 100
    if (intradayRange > 4) { score += 5; reasons.push(`High intraday volatility ${intradayRange.toFixed(1)}%`) }

    let signal: ScreenResult['signal']
    if (score >= 30) signal = 'STRONG_BUY'
    else if (score >= 15) signal = 'BUY'
    else if (score <= -30) signal = 'STRONG_SELL'
    else if (score <= -15) signal = 'SELL'
    else signal = 'HOLD'

    return { ticker, price, change, changePct, currency, score, signal, reasons }
  } catch {
    return null
  }
}

export async function getDetailedAnalysis(
  ticker: string,
  apiKey: string
): Promise<{
  prices: number[]
  highs: number[]
  lows: number[]
  volumes: number[]
  currentPrice: number
  newsHeadlines: string[]
  sentimentScore: number
} | null> {
  try {
    const symbol = ticker
    const to = Math.floor(Date.now() / 1000)
    const from = to - 180 * 24 * 60 * 60 // 6 months

    const [candleRes, newsRes] = await Promise.allSettled([
      fetch(`${FINNHUB_BASE}/stock/candle?symbol=${symbol}&resolution=D&from=${from}&to=${to}&token=${apiKey}`),
      fetch(`${FINNHUB_BASE}/company-news?symbol=${symbol}&from=new Date(Date.now()-7*86400000).toISOString().split('T')[0]&to=${new Date().toISOString().split('T')[0]}&token=${apiKey}`)
    ])

    let prices: number[] = [], highs: number[] = [], lows: number[] = [], volumes: number[] = [], currentPrice = 0
    if (candleRes.status === 'fulfilled' && candleRes.value.ok) {
      const data = await candleRes.value.json()
      if (data.s === 'ok' && data.c?.length > 0) {
        prices = data.c; highs = data.h; lows = data.l; volumes = data.v
        currentPrice = data.c[data.c.length - 1]
      }
    }

    if (!currentPrice) return null

    let newsHeadlines: string[] = []
    let sentimentScore = 0
    if (newsRes.status === 'fulfilled' && newsRes.value.ok) {
      const newsData = await newsRes.value.json()
      newsHeadlines = (newsData || []).slice(0, 10).map((n: any) => n.headline || '')
      const pos = newsHeadlines.filter(h => /upgrade|beat|strong|growth|surge|rally|profit|record|buy|bullish/i.test(h)).length
      const neg = newsHeadlines.filter(h => /downgrade|miss|weak|decline|fall|loss|cut|sell|bearish|warn/i.test(h)).length
      sentimentScore = newsHeadlines.length > 0 ? (pos - neg) / newsHeadlines.length : 0
    }

    return { prices, highs, lows, volumes, currentPrice, newsHeadlines, sentimentScore }
  } catch {
    return null
  }
}
