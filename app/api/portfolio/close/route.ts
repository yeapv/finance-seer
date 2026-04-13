/**
 * Close Cron — 20:05 UTC (04:05 SGT, next day) Mon-Fri
 * NYSE end-of-day summary — reporting only, no trading
 */
import { NextRequest, NextResponse } from 'next/server'
import { getLiveQuote, getHistoricalOHLCV } from '@/lib/market-data'
import { calculateAllIndicators } from '@/lib/indicators'
import { findSupportResistance, detectPatterns } from '@/lib/patterns'
import { readPortfolio, writePortfolio } from '@/lib/portfolio-store'
import { sendTelegram, NYSE_HOLIDAYS } from '@/lib/telegram'

export const dynamic = 'force-dynamic'

async function getPositionAnalysis(ticker: string): Promise<string> {
  try {
    const history = await getHistoricalOHLCV(ticker, '3mo')
    if (!history || history.length < 30) return ''
    const prices = history.map((h: any) => h.close)
    const highs  = history.map((h: any) => h.high)
    const lows   = history.map((h: any) => h.low)
    const opens  = history.map((h: any) => h.open)
    const ind = calculateAllIndicators(prices, highs, lows)
    const { support, resistance } = findSupportResistance(prices)
    const patterns = detectPatterns(prices, { open: opens, high: highs, low: lows, close: prices })
    const last = (arr: number[] | undefined) => { const v = (arr || []).filter((x: number) => !isNaN(x)); return v[v.length-1] ?? 0 }
    const rsi = last(ind.rsi)
    const macd = last(ind.macd)
    const macdSig = last(ind.macdSignal)
    const sma20 = last(ind.sma20)
    const sma50 = last(ind.sma50)
    const sma200 = last(ind.sma200)
    const currentPrice = prices[prices.length - 1]
    const topPatterns = patterns.slice(0, 2).map((p: any) => `${p.name} (${p.type})`).join(', ')
    const nearSupport = support.filter((s: number) => s < currentPrice).sort((a: number, b: number) => b - a)[0]
    const nearResist  = resistance.filter((r: number) => r > currentPrice).sort((a: number, b: number) => a - b)[0]
    return [
      `RSI ${rsi.toFixed(1)}${rsi < 30 ? ' (oversold)' : rsi > 70 ? ' (overbought)' : ''}`,
      `MACD ${macd > macdSig ? 'bullish' : 'bearish'}`,
      `SMA20 $${sma20.toFixed(2)} SMA200 $${sma200.toFixed(2)}`,
      nearSupport ? `Support $${nearSupport.toFixed(2)}` : '',
      nearResist  ? `Resistance $${nearResist.toFixed(2)}` : '',
      topPatterns || '',
    ].filter(Boolean).join(' | ')
  } catch { return '' }
}

async function getAICommentary(positionData: string, spyPct: number, totalValue: number, totalReturnPct: number): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  const apiUrl = process.env.OPENAI_API_URL || 'https://api.groq.com/openai/v1/chat/completions'
  if (!apiKey) return ''
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'user',
          content: `You are a senior portfolio manager writing end-of-day flags for a trader.

Portfolio: $${totalValue.toFixed(2)} | Return: ${totalReturnPct >= 0 ? '+' : ''}${totalReturnPct.toFixed(2)}%
Market: SPY ${spyPct >= 0 ? '+' : ''}${spyPct.toFixed(2)}% today

Positions with full technical context:
${positionData}

Write 3-5 concise flag bullets. For each position near SL or TP, give specific actionable commentary referencing RSI, patterns, support/resistance by price. Include bull/bear case. Be direct, like a senior trader briefing a client. Plain text only.`
        }],
        temperature: 0.4,
        max_tokens: 500
      })
    })
    if (!res.ok) return ''
    const data = await res.json()
    return data.choices?.[0]?.message?.content?.trim() || ''
  } catch { return '' }
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
    const positions = portfolio.positions || []
    const today = new Date().toISOString().split('T')[0]
    const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) + ' (UTC)'

    // Fetch closing prices + technicals for all positions
    const positionDetails: any[] = []
    for (const pos of positions) {
      const quote = await getLiveQuote(pos.ticker)
      const price = quote?.price || pos.currentPrice || pos.buyPrice
      const pnl = (price - pos.buyPrice) * pos.shares
      const pnlPct = ((price - pos.buyPrice) / pos.buyPrice) * 100
      const distToTP = pos.takeProfit ? ((pos.takeProfit - price) / price * 100) : null
      const distToSL = pos.stopLoss ? ((price - pos.stopLoss) / price * 100) : null
      const tech = await getPositionAnalysis(pos.ticker)
      const held = Math.floor((Date.now() - new Date(pos.buyDate || today).getTime()) / 86400000)

      // Update current price
      const idx = portfolio.positions.findIndex((p: any) => p.ticker === pos.ticker)
      if (idx >= 0) portfolio.positions[idx].currentPrice = price

      positionDetails.push({ ...pos, price, pnl, pnlPct, distToTP, distToSL, tech, held })
    }

    // SPY for market mood
    let spyPct = 0
    let marketMood = ''
    try {
      const spy = await getLiveQuote('SPY')
      if (spy) {
        spyPct = spy.changePercent
        if (spyPct <= -2) marketMood = `📉 SPY ${spyPct.toFixed(2)}% — broad selloff, screener in conservative mode`
        else if (spyPct <= -1) marketMood = `📉 SPY ${spyPct.toFixed(2)}% — weak session`
        else if (spyPct >= 2) marketMood = `📈 SPY +${spyPct.toFixed(2)}% — strong rally`
        else if (spyPct >= 1) marketMood = `📈 SPY +${spyPct.toFixed(2)}% — positive session`
        else marketMood = `➡️ SPY ${spyPct >= 0 ? '+' : ''}${spyPct.toFixed(2)}% — flat/mixed`
      }
    } catch { /* skip */ }

    const cashUSD = portfolio.cashByValue?.USD || 0
    const posValue = positionDetails.reduce((s, p) => s + p.price * p.shares, 0)
    const totalValue = cashUSD + posValue
    const startingCapital = portfolio.startingCapital || 100000
    const totalReturn = totalValue - startingCapital
    const totalReturnPct = (totalReturn / startingCapital) * 100

    // Update value history
    const lastEntry = (portfolio.valueHistory || []).slice(-1)[0]
    if (!lastEntry || lastEntry.date !== today) {
      portfolio.valueHistory = [...(portfolio.valueHistory || []), { date: today, value: totalValue }]
    } else {
      portfolio.valueHistory[portfolio.valueHistory.length - 1].value = totalValue
    }
    await writePortfolio(portfolio)

    // Build AI commentary with full technical context
    const positionData = positionDetails.map(p =>
      `- ${p.ticker} (${p.shares}sh): $${p.price.toFixed(2)} | P&L ${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(2)}% ($${p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(0)}) | SL $${p.stopLoss?.toFixed(2)} (${p.distToSL?.toFixed(1)}% away) | TP $${p.takeProfit?.toFixed(2)} (${p.distToTP?.toFixed(1)}% away) | Held ${p.held}d\n  Technicals: ${p.tech}`
    ).join('\n')

    const aiFlags = await getAICommentary(positionData, spyPct, totalValue, totalReturnPct)

    // Build Telegram message
    let msg = `*📅 End-of-Day Summary — ${dateStr}*\n`
    msg += `Portfolio: *$${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}* | Return: ${totalReturnPct >= 0 ? '+' : ''}${totalReturnPct.toFixed(2)}% since ${portfolio.startDate || '2026-03-29'}\n`
    if (marketMood) msg += `${marketMood}\n`
    msg += '\n'

    // Position table
    if (positionDetails.length > 0) {
      msg += `*Open Positions:*\n`
      for (const p of positionDetails) {
        const emoji = p.pnlPct >= 0 ? '🟢' : '🔴'
        msg += `${emoji} *${p.ticker}* (${p.shares}sh) @ $${p.price.toFixed(2)} | ${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(2)}% ($${p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(0)}) | ${p.held}d held\n`
        msg += `   SL $${p.stopLoss?.toFixed(2)} | TP $${p.takeProfit?.toFixed(2)}`
        if (p.trailingStop) msg += ` | Trail $${p.trailingStop?.toFixed(2)}`
        if (p.distToTP !== null && p.distToTP < 2) msg += ` | ⚠️ ${p.distToTP.toFixed(2)}% from TP`
        else if (p.distToSL !== null && p.distToSL < 5) msg += ` | ⚠️ ${p.distToSL.toFixed(2)}% from SL`
        msg += '\n'
      }
      msg += `💵 Cash: $${cashUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n\n`
    } else {
      msg += `No open positions.\n💵 Cash: $${cashUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n\n`
    }

    if (aiFlags) msg += `*⚠️ Flags:*\n${aiFlags}\n\n`

    msg += `_finance-seer.vercel.app/portfolio_`
    await sendTelegram(msg)

    return NextResponse.json({ success: true, totalValue, positions: positionDetails.length })
  } catch (e) {
    console.error('Close cron error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
