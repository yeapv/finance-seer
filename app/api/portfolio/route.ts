import { NextResponse } from 'next/server'
import { getLiveQuote } from '@/lib/market-data'
import { readPortfolio } from '@/lib/portfolio-store'

export const dynamic = 'force-dynamic'

// Company name lookup
const COMPANY_NAMES: Record<string, string> = {
  // Tech
  AAPL: 'Apple Inc.', MSFT: 'Microsoft Corp.', NVDA: 'NVIDIA Corp.', GOOGL: 'Alphabet Inc.',
  META: 'Meta Platforms', AMZN: 'Amazon.com', TSLA: 'Tesla Inc.', AMD: 'Advanced Micro Devices',
  INTC: 'Intel Corp.', SNOW: 'Snowflake Inc.', ADSK: 'Autodesk', CRWV: 'CoreWeave',
  NBIS: 'Nebius', PLTR: 'Palantir', CRM: 'Salesforce', ADBE: 'Adobe',
  ORCL: 'Oracle', QCOM: 'Qualcomm', AVGO: 'Broadcom', MU: 'Micron',
  AMAT: 'Applied Materials', LRCX: 'Lam Research', NET: 'Cloudflare', DDOG: 'Datadog',
  ZS: 'Zscaler', CRWD: 'CrowdStrike', PANW: 'Palo Alto Networks',
  COIN: 'Coinbase', PYPL: 'PayPal', NFLX: 'Netflix', TSM: 'Taiwan Semiconductor',
  // Finance
  JPM: 'JPMorgan Chase', BAC: 'Bank of America', GS: 'Goldman Sachs',
  MS: 'Morgan Stanley', WFC: 'Wells Fargo', C: 'Citigroup', BLK: 'BlackRock',
  SCHW: 'Charles Schwab', V: 'Visa', MA: 'Mastercard', AXP: 'Amex',
  // Healthcare
  JNJ: 'Johnson & Johnson', PFE: 'Pfizer', MRK: 'Merck', ABBV: 'AbbVie',
  LLY: 'Eli Lilly', TMO: 'Thermo Fisher', ABT: 'Abbott Labs', UNH: 'UnitedHealth',
  // Consumer
  COST: 'Costco Wholesale', WMT: 'Walmart', TGT: 'Target', HD: 'Home Depot',
  LOW: "Lowe's", NKE: 'Nike', SBUX: 'Starbucks', MCD: "McDonald's",
  // Industrials / Energy
  CAT: 'Caterpillar Inc.', DE: 'Deere & Company', HON: 'Honeywell', GE: 'GE Aerospace',
  RTX: 'RTX Corp.', LMT: 'Lockheed Martin', BA: 'Boeing', UPS: 'UPS', FDX: 'FedEx',
  XOM: 'ExxonMobil', CVX: 'Chevron', COP: 'ConocoPhillips', SLB: 'SLB',
  // ETFs
  SPY: 'S&P 500 ETF', QQQ: 'Nasdaq 100 ETF', IWM: 'Russell 2000 ETF',
  DIA: 'Dow Jones ETF', VTI: 'Vanguard Total Market', VOO: 'Vanguard S&P 500',
  VGT: 'Vanguard Tech ETF', SOXX: 'Semiconductor ETF', ARKK: 'ARK Innovation ETF',
  XLK: 'Tech Select ETF', XLF: 'Financial Select ETF', XLE: 'Energy Select ETF',
  XLV: 'Health Care ETF', XLY: 'Consumer Discr. ETF', XLP: 'Consumer Staples ETF',
  GLD: 'SPDR Gold ETF', SLV: 'iShares Silver ETF', GDX: 'Gold Miners ETF',
  USO: 'US Oil Fund', UNG: 'US Natural Gas Fund',
  // Crypto
  BTC: 'Bitcoin (Spot)', IBIT: 'iShares Bitcoin ETF', GBTC: 'Grayscale Bitcoin',
  FBTC: 'Fidelity Bitcoin ETF', BITO: 'Bitcoin Strategy ETF',
}



export async function GET() {
  try {
    const portfolio = await readPortfolio()

    // Fetch current prices for all position + watchlist tickers
    const positions = portfolio.positions || []
    const watchlistItems = portfolio.watchlist || []
    const positionTickers = positions.map((p: any) => p.ticker)
    const watchlistTickers = watchlistItems.map((w: any) => w.ticker)
    const allTickers = [...new Set([...positionTickers, ...watchlistTickers])]
    
    // Fetch live prices via market-data (Finnhub primary)
    const priceResults = await Promise.allSettled(
      allTickers.map(async (ticker: unknown) => { const t = ticker as string;
        const q = await getLiveQuote(t)
        return { ticker: t.toUpperCase(), price: q?.price || null, changePct: q?.changePercent ?? null, name: q?.name || null }
      })
    )
    const priceMap: Record<string, number> = {}
    const changePctMap: Record<string, number> = {}
    const nameMap: Record<string, string> = {}
    priceResults.forEach(r => {
      if (r.status === 'fulfilled' && r.value.price) {
        priceMap[r.value.ticker] = r.value.price
        if (r.value.changePct !== null) changePctMap[r.value.ticker] = r.value.changePct
        if (r.value.name) nameMap[r.value.ticker] = r.value.name
      }
    })

    // Update positions with live prices, fall back to avgCost if unavailable
    const updatedPositions = positions.map((pos: any) => {
      const livePrice = priceMap[pos.ticker.toUpperCase()] || pos.avgCost
      return {
        ...pos,
        currentPrice: livePrice,
      }
    })

    // Calculate portfolio value (this IS the capital ceiling)
    const positionsValue = updatedPositions.reduce(
      (sum: number, pos: any) => sum + pos.shares * pos.currentPrice,
      0
    )
    
    // Total cash (USD only)
    const cashByValue = portfolio.cashByValue || { USD: portfolio.cash || 0 }
    const totalCash = cashByValue.USD || 0
    
    const totalValue = totalCash + positionsValue
    const totalReturn = totalValue - portfolio.startingCapital
    const totalReturnPct = (totalReturn / portfolio.startingCapital) * 100
    const now = new Date()
    const daysSinceStart = Math.floor((now.getTime() - new Date(portfolio.startDate).getTime()) / (1000 * 60 * 60 * 24))

    // Compute performance from closed positions
    const closedPositions: any[] = portfolio.closedPositions || []
    const winners = closedPositions.filter((cp: any) => cp.pnl > 0)
    const losers = closedPositions.filter((cp: any) => cp.pnl <= 0)
    const performance = {
      totalReturn: Math.round(totalReturn * 100) / 100,
      totalReturnPct: Math.round(totalReturnPct * 100) / 100,
      winRate: closedPositions.length > 0 ? Math.round((winners.length / closedPositions.length) * 10000) / 100 : 0,
      avgWinPct: winners.length > 0 ? Math.round((winners.reduce((s: number, p: any) => s + p.pnlPct, 0) / winners.length) * 100) / 100 : 0,
      avgLossPct: losers.length > 0 ? Math.round((losers.reduce((s: number, p: any) => s + p.pnlPct, 0) / losers.length) * 100) / 100 : 0,
      bestTrade: closedPositions.length > 0 ? closedPositions.reduce((best: any, cp: any) => (!best || cp.pnlPct > best.pnlPct) ? cp : best, null) : null,
      worstTrade: closedPositions.length > 0 ? closedPositions.reduce((worst: any, cp: any) => (!worst || cp.pnlPct < worst.pnlPct) ? cp : worst, null) : null,
      totalTrades: closedPositions.length,
      profitableTrades: winners.length,
    }

    // Build per-position trade indicators
    const tradeIndicators = updatedPositions.map((pos: any) => {
      const daysHeld = Math.floor((now.getTime() - new Date(pos.buyDate).getTime()) / (1000 * 60 * 60 * 24))
      const unrealizedPnl = (pos.currentPrice - pos.avgCost) * pos.shares
      const unrealizedPct = pos.avgCost > 0 ? ((pos.currentPrice - pos.avgCost) / pos.avgCost) * 100 : 0
      return {
        ticker: pos.ticker,
        currentPrice: Math.round(pos.currentPrice * 100) / 100,
        avgCost: pos.avgCost,
        unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
        unrealizedPct: Math.round(unrealizedPct * 100) / 100,
        daysHeld,
        signal: pos.signal,
        currency: pos.currency || 'USD',
      }
    })

    // Strategy notes: last 30 days only
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const recentStrategyNotes = (portfolio.strategyNotes || []).filter((n: any) => {
      const noteDate = (n.date || '').substring(0, 10)
      return noteDate >= thirtyDaysAgo
    })

    // Trade history: last 3 years only
    const threeYearsAgo = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const recentHistory = (portfolio.history || []).filter((t: any) => (t.date || '') >= threeYearsAgo)

    // Cooldowns removed — no longer used

    // Value history for chart
    // Rules:
    // 1. Only show trading days (Mon-Fri) — strip any weekend entries
    // 2. Past trading day snapshots written by cron are locked — never overwrite
    // 3. If today is a trading day and cron hasn't run yet, inject live value
    const NYSE_HOLIDAYS = [
      '2025-01-01','2025-01-20','2025-02-17','2025-04-18','2025-05-26',
      '2025-06-19','2025-07-04','2025-09-01','2025-11-27','2025-12-25',
      '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25',
      '2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25'
    ]
    const isTradeDay = (dateStr: string) => {
      const d = new Date(dateStr)
      const dow = d.getUTCDay() // 0=Sun, 6=Sat
      if (dow === 0 || dow === 6) return false
      if (NYSE_HOLIDAYS.includes(dateStr)) return false
      return true
    }

    const utcNow  = new Date()
    const todayUTC = utcNow.toISOString().split('T')[0]
    const utcHour  = utcNow.getUTCHours()
    const utcMin   = utcNow.getUTCMinutes()
    const utcTime  = utcHour * 100 + utcMin
    const utcDow   = utcNow.getUTCDay() // 0=Sun, 6=Sat
    const todaySGT = todayUTC // use UTC date for consistency

    // NYSE trading hours: 13:30-20:00 UTC (21:30-04:00 SGT)
    const inNYSE = utcDow >= 1 && utcDow <= 5 && utcTime >= 1330 && utcTime < 2005
    const marketsOpen = inNYSE

    // Strip non-trading days from history (in case any crept in)
    const valueHistory: any[] = (portfolio.valueHistory || []).filter((e: any) => isTradeDay(e.date))
    const lastEntry = valueHistory[valueHistory.length - 1]

    if (isTradeDay(todaySGT)) {
      if (marketsOpen) {
        // During trading hours: always show live value (overwrite any existing today entry)
        if (lastEntry && lastEntry.date === todaySGT) {
          valueHistory[valueHistory.length - 1] = { date: todaySGT, value: Math.round(totalValue * 100) / 100 }
        } else {
          valueHistory.push({ date: todaySGT, value: Math.round(totalValue * 100) / 100 })
        }
      } else if (!lastEntry || lastEntry.date !== todaySGT) {
        // After hours, no cron snapshot yet for today — inject live as best effort
        valueHistory.push({ date: todaySGT, value: Math.round(totalValue * 100) / 100 })
      }
      // After hours + cron already wrote today's snapshot → leave it locked
    }

    // Enrich history with company names; for SELL trades, attach buy context and P&L
    const enrichedHistory = recentHistory.map((trade: any) => {
      const companyName = COMPANY_NAMES[trade.ticker] || trade.ticker
      const enriched: any = { ...trade, companyName }

      if (trade.action === 'SELL') {
        // Find matching closed position for P&L
        const closed = closedPositions.find(
          (cp: any) => cp.ticker === trade.ticker && cp.sellDate === trade.date
        )
        if (closed) {
          enriched.buyDate = closed.buyDate
          enriched.buyPrice = closed.buyPrice
          enriched.pnl = closed.pnl
          enriched.pnlPct = closed.pnlPct
          enriched.buyTotal = closed.buyPrice * closed.shares
        }
      }

      return enriched
    })

    // Enrich closed positions with company names
    const enrichedClosed = closedPositions.map((cp: any) => ({
      ...cp,
      companyName: COMPANY_NAMES[cp.ticker] || cp.ticker,
    }))

    // Enrich positions with company names
    const enrichedPositions = updatedPositions.map((pos: any) => ({
      ...pos,
      companyName: COMPANY_NAMES[pos.ticker] || pos.ticker,
    }))

    // Open orders from portfolio.json (populated by sync_from_ibkr.py)
    const openOrders = (portfolio.openOrders || []).map((o: any) => ({
      ...o,
      companyName: COMPANY_NAMES[o.ticker] || o.ticker,
    }))

    return NextResponse.json({
      ...portfolio,
      openOrders,
      positions: enrichedPositions,
      history: enrichedHistory,
      closedPositions: enrichedClosed,
      strategyNotes: recentStrategyNotes,
      watchlist: watchlistItems.map((w: any) => ({
        ...w,
        lastPrice: priceMap[w.ticker] ?? w.lastPrice ?? null,
        changePct: changePctMap[w.ticker] ?? w.changePct ?? null,
        companyName: COMPANY_NAMES[w.ticker] || (nameMap[w.ticker] && nameMap[w.ticker] !== w.ticker ? nameMap[w.ticker] : null) || w.companyName || null,
        lastChecked: new Date().toISOString(),
      })),
      cooldowns: {},
      valueHistory,
      cashByValue: {
        USD: cashByValue.USD || 0,
      },
      summary: {
        totalValue: Math.round(totalValue * 100) / 100,
        capitalCeiling: Math.round(totalValue * 100) / 100,
        cash: Math.round(totalCash * 100) / 100,
        cashUSD: Math.round((cashByValue.USD || 0) * 100) / 100,
        positionsValue: Math.round(positionsValue * 100) / 100,
        totalReturn: Math.round(totalReturn * 100) / 100,
        totalReturnPct: Math.round(totalReturnPct * 100) / 100,
        positionCount: updatedPositions.length,
        startDate: portfolio.startDate,
        daysSinceStart,
      },
      performance,
      tradeIndicators,
    })
  } catch (error) {
    console.error('Portfolio error:', error)
    return NextResponse.json({ error: 'Failed to load portfolio', debug: String(error) }, { status: 500 })
  }
}
