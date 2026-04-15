import { NextRequest, NextResponse } from 'next/server'
import { getLiveQuote, getHistoricalOHLCV } from '@/lib/market-data'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Explicitly disable all caching
export const fetchCache = 'no-cache'
export const runtime = 'edge'

export async function GET(req: NextRequest, { params }: { params: { ticker: string } }) {
  // Add aggressive cache-busting headers for real-time data
  const headers = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'Surrogate-Control': 'no-store',
    'Pragma': 'no-cache',
    'Expires': '0',
  }

  try {
    const ticker = (params.ticker as string).toUpperCase()
    const data = await getLiveQuote(ticker, true) // Force fresh data
    if (!data) return NextResponse.json({ error: 'Stock not found' }, { status: 404, headers })

    // Finnhub free tier doesn't return volume — get it from last candle
    if (!data.volume) {
      const history = await getHistoricalOHLCV(ticker, '5d')
      if (history.length > 0) {
        data.volume = history[history.length - 1].volume || 0
      }
    }

    return NextResponse.json(data, { headers })
  } catch (error) {
    console.error('Stock fetch failed:', error)
    return NextResponse.json({ error: 'Failed to fetch stock data' }, { status: 500, headers })
  }
}
