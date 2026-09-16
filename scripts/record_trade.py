#!/usr/bin/env python3
"""
Record a completed IBKR trade into Finance Seer portfolio.json + KV.
Called after ibkr_execute.py confirms a fill.

Usage:
  python3 record_trade.py BUY AAPL 50 258.80 318.29 1.45
  args: action ticker shares limitPrice avgFillPrice commission
"""
import os, sys, json, urllib.request
from datetime import datetime
from pathlib import Path

PORTFOLIO = Path(__file__).parent.parent / 'data' / 'portfolio.json'
KV_URL    = os.environ.get('UPSTASH_REDIS_URL', 'https://clean-eagle-92052.upstash.io')
KV_TOKEN  = os.environ.get('UPSTASH_REDIS_TOKEN', '')

def kv_set(data):
    req = urllib.request.Request(f'{KV_URL}/set/portfolio',
        data=json.dumps(data).encode(),
        headers={'Authorization': f'Bearer {KV_TOKEN}', 'Content-Type': 'application/json'},
        method='POST')
    urllib.request.urlopen(req, timeout=10)

def main():
    if len(sys.argv) < 7:
        print(json.dumps({'error': 'Usage: record_trade.py ACTION TICKER SHARES LIMIT_PRICE AVG_FILL COMMISSION'}))
        sys.exit(1)

    action     = sys.argv[1].upper()
    ticker     = sys.argv[2].upper()
    shares     = int(sys.argv[3])
    limit_price = float(sys.argv[4])
    avg_fill   = float(sys.argv[5])
    commission = float(sys.argv[6])
    today      = datetime.now().strftime('%Y-%m-%d')

    with open(PORTFOLIO) as f:
        p = json.load(f)

    if action == 'BUY':
        gross_cost = avg_fill * shares
        total_cost = gross_cost + commission

        # Deduct from cash
        p['cashByValue']['USD'] = round(p['cashByValue']['USD'] - total_cost, 2)

        # Add position
        sl = round(avg_fill * 0.92, 2)
        tp = round(avg_fill * 1.15, 2)
        p.setdefault('positions', []).append({
            'ticker': ticker, 'shares': shares,
            'avgCost': avg_fill, 'buyPrice': avg_fill, 'currentPrice': avg_fill,
            'buyDate': today, 'stopLoss': sl, 'takeProfit': tp,
            'signal': 'BUY', 'currency': 'USD',
            'reason': f'Bought via IBKR limit @ ${limit_price:.2f}, filled @ ${avg_fill:.2f}',
        })

        # Record in history with commission
        p.setdefault('history', []).append({
            'date': today, 'action': 'BUY', 'ticker': ticker,
            'shares': shares, 'price': avg_fill,
            'total': gross_cost, 'commission': commission, 'netCost': total_cost,
            'currency': 'USD',
            'reason': f'Limit order filled @ ${avg_fill:.2f} (limit: ${limit_price:.2f}). Commission: ${commission:.4f}',
        })
        p.setdefault('strategyNotes', []).append({
            'date': datetime.now().isoformat(),
            'note': f'BUY {shares} {ticker} @ ${avg_fill:.2f} (-${total_cost:,.2f} incl. ${commission:.2f} commission). SL ${sl} | TP ${tp}.'
        })
        print(f'Recorded BUY {shares}x {ticker} @ ${avg_fill:.2f} | commission ${commission:.4f} | net cost ${total_cost:,.2f}')

    elif action == 'SELL':
        gross_proceeds = avg_fill * shares
        net_proceeds   = gross_proceeds - commission

        # Find position
        pos = next((x for x in p.get('positions',[]) if x['ticker'] == ticker), None)
        buy_price = pos['buyPrice'] if pos else avg_fill
        pnl = net_proceeds - (buy_price * shares)
        pnl_pct = (pnl / (buy_price * shares)) * 100 if buy_price else 0

        # Add proceeds to cash
        p['cashByValue']['USD'] = round(p['cashByValue']['USD'] + net_proceeds, 2)

        # Remove position
        p['positions'] = [x for x in p.get('positions',[]) if x['ticker'] != ticker]

        # Record in closed positions and history
        p.setdefault('closedPositions', []).append({
            'ticker': ticker, 'shares': shares,
            'buyDate': pos.get('buyDate', today) if pos else today,
            'buyPrice': buy_price, 'sellDate': today, 'sellPrice': avg_fill,
            'commission': commission, 'netProceeds': net_proceeds,
            'pnl': round(pnl, 2), 'pnlPct': round(pnl_pct, 2), 'currency': 'USD',
            'reason': f'Sold via IBKR limit @ ${limit_price:.2f}, filled @ ${avg_fill:.2f}',
        })
        p.setdefault('history', []).append({
            'date': today, 'action': 'SELL', 'ticker': ticker,
            'shares': shares, 'price': avg_fill,
            'total': gross_proceeds, 'commission': commission, 'netProceeds': net_proceeds,
            'pnl': round(pnl, 2), 'pnlPct': round(pnl_pct, 2), 'currency': 'USD',
            'reason': f'Limit order filled @ ${avg_fill:.2f}. Commission: ${commission:.4f}. Net P&L: ${pnl:+,.2f} ({pnl_pct:+.2f}%)',
        })
        print(f'Recorded SELL {shares}x {ticker} @ ${avg_fill:.2f} | commission ${commission:.4f} | net P&L ${pnl:+,.2f}')

    # Save
    with open(PORTFOLIO, 'w') as f:
        json.dump(p, f, indent=2)
    kv_set(p)
    print(f'Cash now: ${p["cashByValue"]["USD"]:,.2f}')

if __name__ == '__main__':
    main()
