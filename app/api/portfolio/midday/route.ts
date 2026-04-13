/**
 * Midday Cron — 17:30 UTC (01:30 SGT, next day) Mon-Fri
 * NYSE mid-session check with trailing stop logic, min hold days, signal flip
 * Uses UTC 24h format consistently throughout codebase.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getLiveQuote } from '@/lib/market-data'
import { readPortfolio, writePortfolio } from '@/lib/portfolio-store'
import { sendTelegram, NYSE_HOLIDAYS } from '@/lib/telegram'

export const dynamic = 'force-dynamic'

const MIN_HOLD_DAYS = 3
const SETTLEMENT_DAYS = 3

function daysHeld(buyDate: string): number {
  return Math.floor((Date.now() - new Date(buyDate).getTime()) / 86400000)
}

function daysSettled(sellDate: string): number {
  return Math.floor((Date.now() - new Date(sellDate).getTime()) / 86400000)
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const todayUTC = new Date().toISOString().split('T')[0]
  if (NYSE_HOLIDAYS.includes(todayUTC)) {
    return NextResponse.json({ skipped: true, reason: `NYSE holiday: ${todayUTC}` })
  }

  try {
    const portfolio = await readPortfolio()
    const sells: any[] = []
    const today = new Date().toISOString().split('T')[0]

    // Check settlement — cash from recent sells may not be deployable yet
    const recentSells = (portfolio.closedPositions || []).filter((cp: any) =>
      cp.sellDate && daysSettled(cp.sellDate) < SETTLEMENT_DAYS
    )
    const pendingSettlement = recentSells.reduce((s: number, cp: any) =>
      s + cp.sellPrice * cp.shares, 0)

    for (const pos of [...(portfolio.positions || [])]) {
      const quote = await getLiveQuote(pos.ticker)
      if (!quote) continue
      const price = quote.price
      const held = daysHeld(pos.buyDate || today)

      // Update current price
      const idx = portfolio.positions.findIndex((p: any) => p.ticker === pos.ticker)
      if (idx >= 0) portfolio.positions[idx].currentPrice = price

      const pnl = (price - pos.buyPrice) * pos.shares
      const pnlPct = ((price - pos.buyPrice) / pos.buyPrice) * 100
      let sellReason = ''

      // Rule 1: Trailing stop (takes priority)
      if (pos.trailingStop && price <= pos.trailingStop) {
        sellReason = `Trailing stop hit at $${price.toFixed(2)} (trailing: $${pos.trailingStop.toFixed(2)})`
      }
      // Rule 2: Take profit (min hold days)
      else if (held >= MIN_HOLD_DAYS && price >= pos.takeProfit) {
        sellReason = `Take-profit hit at $${price.toFixed(2)} (TP: $${pos.takeProfit.toFixed(2)})`
      }
      // Rule 3: Stop loss (min hold days)
      else if (held >= MIN_HOLD_DAYS && price <= pos.stopLoss) {
        sellReason = `Stop-loss hit at $${price.toFixed(2)} (SL: $${pos.stopLoss.toFixed(2)})`
      }
      // Rule 4: Signal flip — if in profit and held min days
      else if (held >= MIN_HOLD_DAYS && pnlPct > 0 && pos.signal === 'SELL') {
        sellReason = `Signal flipped to SELL while in profit (+${pnlPct.toFixed(1)}%) at $${price.toFixed(2)}`
      }

      if (sellReason) {
        // Execute sell
        const proceeds = price * pos.shares
        portfolio.cashByValue = portfolio.cashByValue || { USD: 0 }
        portfolio.cashByValue['USD'] = (portfolio.cashByValue['USD'] || 0) + proceeds
        portfolio.positions = portfolio.positions.filter((p: any) => p.ticker !== pos.ticker)
        portfolio.closedPositions = portfolio.closedPositions || []
        portfolio.closedPositions.push({
          ticker: pos.ticker, shares: pos.shares,
          buyDate: pos.buyDate, buyPrice: pos.buyPrice,
          sellDate: today, sellPrice: price,
          reason: sellReason, pnl, pnlPct, currency: 'USD'
        })
        portfolio.history = portfolio.history || []
        portfolio.history.push({ date: today, action: 'SELL', ticker: pos.ticker, shares: pos.shares, price, total: proceeds, reason: sellReason, currency: 'USD' })
        sells.push({ ticker: pos.ticker, shares: pos.shares, price, pnl, pnlPct, reason: sellReason })

        const emoji = pnl >= 0 ? '🟢' : '🔴'
        await sendTelegram(`${emoji} Portfolio Trade: SELL ${pos.shares}x *${pos.ticker}* @ $${price.toFixed(2)} — ${sellReason}. P&L: ${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(0)} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%). Portfolio: $${((portfolio.cashByValue?.USD || 0) / 1000).toFixed(1)}K`)
      }

      // Update trailing stop — ratchet up if price moves in our favour (>5% above buy)
      if (!sellReason && pnlPct > 5 && pos.stopLoss) {
        const newTrailing = price * 0.95  // 5% below current
        if (!pos.trailingStop || newTrailing > pos.trailingStop) {
          portfolio.positions[idx].trailingStop = parseFloat(newTrailing.toFixed(2))
        }
      }
    }

    await writePortfolio(portfolio)

    const totalValue = (portfolio.cashByValue?.USD || 0) +
      (portfolio.positions || []).reduce((s: number, p: any) => s + (p.currentPrice || p.buyPrice) * p.shares, 0)

    return NextResponse.json({ success: true, sells, totalValue, pendingSettlement })
  } catch (e) {
    console.error('Midday error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
