#!/usr/bin/env python3
"""
Finance Seer — Market Update
Sends portfolio snapshot at market open, mid-session, and close.
Called by cron:
  21:30 SGT Mon-Fri = 13:30 UTC (NYSE open)
  01:00 SGT Mon-Fri = 17:00 UTC (mid-session)
  04:05 SGT Mon-Fri = 20:05 UTC (NYSE close)
"""
import os, json, sys, urllib.request, subprocess
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS   = Path(__file__).parent
PORTFOLIO = SCRIPTS.parent / 'data' / 'portfolio.json'
TG_TOKEN  = os.environ.get('TELEGRAM_BOT_TOKEN', '')
TG_CHAT   = '786437034'

IBKR_HOST    = os.environ.get('IBKR_HOST', 'host.docker.internal')
IBKR_PORT    = int(os.environ.get('IBKR_PORT', '4002'))
IBKR_ACCOUNT = 'DU7992310'

LABELS = {
    'open': '🔔 Market Open',
    'mid':  '📊 Mid-Session',
    'close': '🔒 Market Close',
}

def send_telegram(msg: str):
    try:
        body = json.dumps({'chat_id': TG_CHAT, 'text': msg, 'parse_mode': 'Markdown'}).encode()
        req = urllib.request.Request(
            f'https://api.telegram.org/bot{TG_TOKEN}/sendMessage',
            data=body, headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f'Telegram error: {e}')

def sync_portfolio():
    """Sync from IBKR before generating report."""
    sync = SCRIPTS / 'sync_from_ibkr.py'
    try:
        subprocess.run([sys.executable, str(sync)], capture_output=True, timeout=60)
    except Exception as e:
        print(f'Sync error: {e}')

def get_live_prices(tickers: list) -> dict:
    """Get live prices from IBKR for open positions."""
    prices = {}
    if not tickers:
        return prices
    try:
        from ib_insync import IB, Stock
        ib = IB()
        ib.connect(IBKR_HOST, IBKR_PORT, clientId=9, timeout=15)
        for ticker in tickers:
            try:
                contract = Stock(ticker, 'SMART', 'USD')
                ib.qualifyContracts(contract)
                td = ib.reqMktData(contract, '', False, False)
                ib.sleep(2)
                p = td.last or td.close or None
                if p:
                    prices[ticker] = float(p)
                ib.cancelMktData(contract)
            except:
                pass
        ib.disconnect()
    except Exception as e:
        print(f'IBKR price error: {e}')
    return prices

def format_update(label: str, p: dict, live_prices: dict) -> str:
    now_sgt = datetime.now(timezone.utc).strftime('%A, %B %d, %Y')
    positions = p.get('positions', [])
    cash      = p['cashByValue'].get('USD', 0)

    lines = [f'───', f'', f'{label} — {now_sgt}', '']

    # Portfolio value
    pos_value = sum(
        live_prices.get(pos['ticker'], pos.get('currentPrice') or pos.get('avgCost') or 0) * pos['shares']
        for pos in positions
    )
    total = cash + pos_value
    start = p.get('startValue', 100000)
    total_ret_pct = ((total - start) / start) * 100 if start else 0
    total_ret_usd = total - start

    # Position summary for header line
    pos_summary = ' | '.join(
        f"{pos['ticker']} {'+' if (live_prices.get(pos['ticker'], pos.get('avgCost',0)) - pos.get('avgCost', pos.get('buyPrice',0))) >= 0 else ''}"
        f"{((live_prices.get(pos['ticker'], pos.get('avgCost',0)) - pos.get('avgCost', pos.get('buyPrice',0))) / pos.get('avgCost', pos.get('buyPrice',1)) * 100):.2f}%"
        for pos in positions if pos.get('avgCost') or pos.get('buyPrice')
    ) if positions else 'No open positions'

    lines.append(f"Portfolio: ${total:,.0f} | {pos_summary} | Cash: ${cash:,.0f}")
    lines.append('')

    if positions:
        lines.append('Open Positions:')
        for pos in positions:
            ticker    = pos['ticker']
            shares    = pos['shares']
            cost      = pos.get('avgCost') or pos.get('buyPrice') or 0
            cur_price = live_prices.get(ticker, pos.get('currentPrice') or cost)
            pnl_usd   = (cur_price - cost) * shares
            pnl_pct   = ((cur_price - cost) / cost * 100) if cost else 0
            sl        = pos.get('stopLoss', 0)
            tp        = pos.get('takeProfit', 0)
            sl_away   = ((cur_price - sl) / cur_price * 100) if sl and cur_price else 0
            tp_away   = ((tp - cur_price) / cur_price * 100) if tp and cur_price else 0
            pnl_sign  = '+' if pnl_usd >= 0 else ''
            lines.append(
                f"• {ticker} — {shares} shares @ ${cur_price:.2f} (cost ${cost:.2f}) | "
                f"P/L: {pnl_sign}${pnl_usd:.0f} ({pnl_sign}{pnl_pct:.2f}%) | "
                f"SL ${sl:.2f} ({sl_away:.1f}% away) | TP ${tp:.2f} ({tp_away:.1f}% away)"
            )
    else:
        lines.append('No open positions.')

    lines.append('')
    lines.append('Totals:')
    lines.append(f"• Total Portfolio Value: ${total:,.0f}")
    lines.append(f"• Total Return: {'+' if total_ret_pct >= 0 else ''}{total_ret_pct:.2f}% / {'+' if total_ret_usd >= 0 else ''}${total_ret_usd:,.0f}")

    realized   = p.get('realizedPnL', 0)
    unrealized = sum(
        (live_prices.get(pos['ticker'], pos.get('currentPrice') or pos.get('avgCost') or 0) -
         (pos.get('avgCost') or pos.get('buyPrice') or 0)) * pos['shares']
        for pos in positions
    )
    lines.append(f"• Realized P/L: {'+' if realized >= 0 else ''}${realized:,.0f} | Unrealized P/L: {'+' if unrealized >= 0 else ''}${unrealized:,.0f}")

    # SL/TP proximity alert
    alerts = []
    for pos in positions:
        ticker    = pos['ticker']
        cur_price = live_prices.get(ticker, pos.get('currentPrice') or pos.get('avgCost') or 0)
        sl        = pos.get('stopLoss', 0)
        tp        = pos.get('takeProfit', 0)
        if sl and cur_price:
            sl_away = (cur_price - sl) / cur_price * 100
            if sl_away < 2:
                alerts.append(f'⚠️ {ticker} within {sl_away:.1f}% of stop-loss!')
        if tp and cur_price:
            tp_away = (tp - cur_price) / cur_price * 100
            if tp_away < 2:
                alerts.append(f'🎯 {ticker} within {tp_away:.1f}% of take-profit!')

    lines.append('')
    if alerts:
        lines.append('Stop/TP Alerts: ' + ' | '.join(alerts))
    else:
        lines.append('Stop/TP Alerts: ✅ No positions within 2% of stop-loss or take-profit.')

    lines.append('')
    lines.append('───')
    return '\n'.join(lines)

def main():
    session_type = sys.argv[1] if len(sys.argv) > 1 else 'update'
    label = LABELS.get(session_type, '📊 Portfolio Update')

    # Sync from IBKR first
    sync_portfolio()

    try:
        with open(PORTFOLIO) as f:
            p = json.load(f)
    except Exception as e:
        send_telegram(f'⚠️ Market update failed: could not read portfolio — {e}')
        return

    positions = p.get('positions', [])
    tickers   = [pos['ticker'] for pos in positions]
    live_prices = get_live_prices(tickers) if tickers else {}

    msg = format_update(label, p, live_prices)
    send_telegram(msg)
    print(f'Sent {session_type} update')

if __name__ == '__main__':
    main()
