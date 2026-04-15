import { NextRequest, NextResponse } from 'next/server'
import { getLiveQuote, getHistoricalOHLCV } from '@/lib/market-data'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Add cache-busting headers for real-time data
const headers = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
  'Surrogate-Control': 'no-store',
  'Pragma': 'no-cache',
  'Expires': '0',
}

export async function GET(req: NextRequest, { params }: { params: { ticker: string } }) {
  try {
    const ticker = (params.ticker as string).toUpperCase()
    const data = await getLiveQuote(ticker)
    if (!data) return NextResponse.json({ error: 'Stock not found' }, { status: 404, headers })

    return NextResponse.json(data, { headers })
  } catch (error) {
    console.error('Stock fetch failed:', error)
    return NextResponse.json({ error: 'Failed to fetch stock data' }, { status: 500, headers })
  }
}
