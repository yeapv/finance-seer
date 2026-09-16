#!/usr/bin/env python3
"""
Propose a trade via Telegram with enriched company info.
Execution is handled by the main OpenClaw session.

Usage: python3 propose_trade.py BUY AAPL 50 258.82 245.00 284.00 "RSI oversold at support" 62.5 1234567
       args: action ticker shares price sl tp reason rsi volume
"""
import os, sys, json, urllib.request, time
from datetime import datetime
from pathlib import Path

TG_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
TG_CHAT  = '786437034'

def send(msg, buttons=None):
    try:
        body = {'chat_id': TG_CHAT, 'text': msg, 'parse_mode': 'Markdown'}
        if buttons:
            body['reply_markup'] = {'inline_keyboard': buttons}
        req = urllib.request.Request(
            f'https://api.telegram.org/bot{TG_TOKEN}/sendMessage',
            data=json.dumps(body).encode(),
            headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f'Telegram error: {e}', file=sys.stderr)

def get_company_info(ticker: str) -> dict:
    """Fetch company name, description and volume from mkts.io"""
    try:
        url = f'https://mkts.io/api/v1/asset/{ticker}/details'
        req = urllib.request.Request(url, headers={
            'X-API-Key': 'mk_live_8450d775799772d110ffb37be94c82f55d8ddc471747ff3a0c070c32f2d1ba0e'
        })
        resp = json.loads(urllib.request.urlopen(req, timeout=8).read())
        d = resp.get('data', {})
        return {
            'name':        d.get('name', ticker),
            'sector':      d.get('sector', ''),
            'industry':    d.get('industry', ''),
            'description': (d.get('description') or '')[:150],
            'volume':      d.get('volume', 0),
            'avgVolume':   d.get('averageVolume', 0),
            'marketCap':   d.get('marketCap', 0),
        }
    except:
        return {'name': ticker, 'sector': '', 'industry': '', 'description': '', 'volume': 0, 'avgVolume': 0, 'marketCap': 0}

def fmt_volume(v: float) -> str:
    if not v: return 'N/A'
    if v >= 1e9: return f'{v/1e9:.1f}B'
    if v >= 1e6: return f'{v/1e6:.1f}M'
    if v >= 1e3: return f'{v/1e3:.0f}K'
    return str(int(v))

def fmt_mcap(v: float) -> str:
    if not v: return 'N/A'
    if v >= 1e12: return f'${v/1e12:.1f}T'
    if v >= 1e9:  return f'${v/1e9:.1f}B'
    if v >= 1e6:  return f'${v/1e6:.1f}M'
    return f'${v:,.0f}'

if __name__ == '__main__':
    action = sys.argv[1].upper()
    ticker = sys.argv[2].upper()
    shares = int(sys.argv[3])
    price  = float(sys.argv[4])
    sl     = float(sys.argv[5])
    tp     = float(sys.argv[6])
    reason       = sys.argv[7] if len(sys.argv) > 7 else ''
    rsi          = float(sys.argv[8]) if len(sys.argv) > 8 else 0
    volume       = int(sys.argv[9]) if len(sys.argv) > 9 else 0
    news_context = sys.argv[10] if len(sys.argv) > 10 else ''

    cost = shares * price
    risk = abs(price - sl)
    reward = abs(tp - price)
    rr = round(reward / risk, 1) if risk > 0 else 0

    # Fetch company info
    info = get_company_info(ticker)
    name = info['name'] if info['name'] != ticker else ticker
    sector = info['sector'] or info['industry'] or ''
    desc = info['description']
    vol = volume or info['volume']
    avg_vol = info['avgVolume']
    mcap = info['marketCap']

    # Volume vs average
    vol_note = ''
    if vol and avg_vol:
        ratio = vol / avg_vol
        if ratio >= 2:   vol_note = f'🔥 Volume {ratio:.1f}x avg — unusual surge'
        elif ratio >= 1.3: vol_note = f'📈 Volume {ratio:.1f}x avg — above average'
        else:              vol_note = f'Volume {fmt_volume(vol)} (avg {fmt_volume(avg_vol)})'
    elif vol:
        vol_note = f'Volume: {fmt_volume(vol)}'

    emoji = '🟢' if action == 'BUY' else '🔴'
    lines = [
        f"⚡ *{action} Signal: {shares}x {ticker}*",
        f"*{name}*{f' | {sector}' if sector else ''}",
    ]
    if desc:
        lines.append(f"_{desc}_")
    lines += [
        f"",
        f"Price: ${price:.2f} | Cost: ~${cost:,.0f}",
        f"SL: ${sl:.2f} | TP: ${tp:.2f} | R/R: 1:{rr}",
    ]
    if rsi: lines.append(f"RSI: {rsi:.0f}")
    if vol_note: lines.append(vol_note)
    if mcap:   lines.append(f"Market Cap: {fmt_mcap(mcap)}")
    lines += [
        f"",
        f"_{reason[:120]}_",
    ]
    if news_context:
        lines.append(f"📰 _{news_context[:200]}_")
    lines += [
        f"",
        f"Tap ✅ to execute or ❌ to reject. Expires in 30 min if no action.",
    ]

    send('\n'.join(lines), buttons=[[
        {'text': '✅ Execute Now', 'callback_data': f'APPROVE_{action}_{ticker}'},
        {'text': '❌ Reject',      'callback_data': f'REJECT_{action}_{ticker}'},
    ]])
    # Store pending trade so approval_handler.py can execute it
    try:
        portfolio_path = Path(__file__).parent.parent / 'data' / 'portfolio.json'
        with open(portfolio_path) as f:
            p = json.load(f)
        trade_id = f'{action}_{ticker}_{int(time.time())}'
        p.setdefault('pendingTrades', {})[trade_id] = {
            'action': action, 'ticker': ticker, 'shares': shares,
            'price': price, 'sl': sl, 'tp': tp, 'reason': reason,
            'status': 'pending', 'createdAt': datetime.now().isoformat()
        }
        with open(portfolio_path, 'w') as f:
            json.dump(p, f, indent=2)
    except Exception as e:
        print(f'Warning: could not store pending trade: {e}', file=sys.stderr)

    print(json.dumps({'sent': True, 'action': action, 'ticker': ticker,
                      'shares': shares, 'price': price, 'sl': sl, 'tp': tp,
                      'reason': reason, 'name': name}))
