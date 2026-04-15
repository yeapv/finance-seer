/**
 * TradingView-style technical data for a ticker
 * Uses Finnhub + Yahoo Finance for data (no Python dependency)
 * Returns: RSI, MACD, MAs, ATR, BB, Stochastic, ratings
 */
import { NextRequest, NextResponse } from 'next/server'
import { getLiveQuote, getHistoricalOHLCV } from '@/lib/market-data'
import { calculateAllIndicators } from '@/lib/indicators'
import { detectPatterns } from '@/lib/patterns'

const cache = new Map<string, { data: any; ts: number }>()
const CACHE_TTL = 10 * 60 * 1000 // 10 min

function clean(v: any): any {
  if (v == null) return null
  if (typeof v === 'number' && isNaN(v)) return null
  return v
}

function calculateRatings(
  rsi: number,
  sma20: number,
  sma50: number,
  sma200: number,
  macd: number,
  macdSignal: number
): { tv_rating: number; ma_rating: number; osc_rating: number } {
  // TV-style ratings (-1=strong sell, 0=neutral, +1=strong buy)
  let tvScore = 0
  let maScore = 0
  let oscScore = 0

  // Moving Average ratings
  const price = sma20 // use latest close as reference
  if (price && sma20) {
    if (price > sma20) maScore++
    if (price > sma50) maScore++
    if (price > sma200) maScore++
  }

  // Oscillator ratings
  if (rsi && rsi > 50) oscScore++
  if (rsi && rsi < 30) oscScore--
  if (macd && macdSignal && macd > macdSignal) oscScore++
  if (macd && macdSignal && macd < macdSignal) oscScore--

  return {
    tv_rating: Math.max(-1, Math.min(1, (maScore + oscScore) / 4)), // normalized
    ma_rating: maScore >= 3 ? 1 : maScore <= -3 ? -1 : 0,
    osc_rating: oscScore >= 2 ? 1 : oscScore <= -2 ? -1 : 0,
  }
}

function calculateTechnicalIndicators(history: any[]): any {
  try {
    const prices = history.map(d => d.close)
    const highs = history.map(d => d.high)
    const lows = history.map(d => d.low)
    
    const indicators = calculateAllIndicators(prices, highs, lows)
    const patterns = detectPatterns(prices)

    // Extract latest values from flat indicator structure
    const latest = history[history.length - 1]
    const idx = history.length - 1

    return {
      rsi: clean(indicators.rsi[idx]),
      macd: clean(indicators.macd[idx]),
      macd_signal: clean(indicators.macdSignal[idx]),
      macd_hist: clean(indicators.macdHistogram[idx]),
      sma20: clean(indicators.sma20[idx]),
      sma50: clean(indicators.sma50[idx]),
      sma200: clean(indicators.sma200[idx]),
      ema20: clean(indicators.ema12[idx]),
      ema200: clean(indicators.ema26[idx]),
      bb_upper: clean(indicators.bollingerBands[idx]?.upper),
      bb_lower: clean(indicators.bollingerBands[idx]?.lower),
      stoch_k: clean(indicators.stochastic[idx]?.k),
      stoch_d: clean(indicators.stochastic[idx]?.d),
      atr: clean(latest?.atr),
      week52_high: clean(latest?.week52High),
      week52_low: clean(latest?.week52Low),
      patterns: Object.keys(patterns).reduce((acc: Record<string, number>, key: string) => {
        const val = (patterns as unknown as Record<string, unknown>)[key]
        if (val && val !== 'none') {
          acc[key] = 1
        }
        return acc
      }, {} as Record<string, number>),
    }
  } catch (e) {
    return { error: String(e) }
  }
}

export const dynamic = 'force-dynamic'

export async function GET(_: NextRequest, { params }: { params: { ticker: string } }) {
  const ticker = (params.ticker as string).toUpperCase()

  const cached = cache.get(ticker)
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data)
  }

  try {
    // Get latest quote
    const quote = await getLiveQuote(ticker)
    if (!quote) {
      return NextResponse.json(
        { error: `Could not fetch data for ${ticker}` },
        { status: 404 }
      )
    }

    // Get historical data for indicators (1 year)
    const history = await getHistoricalOHLCV(ticker, '1y')
    if (!history || history.length === 0) {
      return NextResponse.json(
        { error: `No historical data for ${ticker}` },
        { status: 404 }
      )
    }

    // Calculate technical indicators
    const techIndicators = calculateTechnicalIndicators(history)
    
    // Calculate ratings based on indicators
    const ratings = calculateRatings(
      techIndicators.rsi,
      techIndicators.sma20,
      techIndicators.sma50,
      techIndicators.sma200,
      techIndicators.macd,
      techIndicators.macd_signal
    )

    const data = {
      ticker: ticker,
      price: clean(quote.price),
      change_pct: clean(quote.changePercent),
      volume: clean(quote.volume),
      ...techIndicators,
      ...ratings,
    }

    cache.set(ticker, { data, ts: Date.now() })
    return NextResponse.json(data)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
