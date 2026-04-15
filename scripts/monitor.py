#!/usr/bin/env python3
"""
Finance Seer Local Monitor — runs every 10 min during NYSE hours
1. Sync portfolio from IBKR
2. Check SL/TP on open positions
3. Scan market for buy opportunities
4. Send Telegram alerts for trades (3-min approval window)
5. Execute approved trades via IBKR
6. Push updated portfolio to KV + GitHub
"""
import json, sys, time, subprocess, urllib.request, urllib.parse
from datetime import datetime, timezone
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
REJECTED_TRADES = Path(__file__).parent / 'rejected_trades.json'
IBKR_HOST    = '172.23.160.1'
IBKR_PORT    = 4002
IBKR_ACCOUNT = 'DU7992310'
PORTFOLIO    = Path(__file__).parent.parent / 'data' / 'portfolio.json'
SCRIPTS      = Path(__file__).parent
IBKR_CLI     = SCRIPTS / 'ibkr_execute.py'  # uses limit orders + commission tracking
SYNC_SCRIPT  = SCRIPTS / 'sync_from_ibkr.py'
KV_URL       = 'https://clean-eagle-92052.upstash.io'
KV_TOKEN     = 'gQAAAAAAAWeUAAIncDFiZmRiYzc1NDY1YjI0NjU3YTYwMzc4Y2Y4ZTIxZWUzNHAxOTIwNTI'
TG_TOKEN     = '8609316971:AAFhvA7fOyXRx5ch5Mm740ajcjMRD5brIr4'
TG_CHAT      = '786437034'
FINANCE_SEER = 'https://finance-seer.vercel.app'

# NYSE market hours (all UTC)
NYSE_OPEN_UTC  = (13, 30)  # 13:30 UTC
NYSE_CLOSE_UTC = (20,  0)  # 20:00 UTC

MAX_POSITIONS    = 8
MIN_CASH_RESERVE = 0.15  # 15% cash reserve
MAX_POSITION_PCT = 0.15  # 15% max per position

# ── Permanent blacklist ───────────────────────────────────────────────
# Stocks that should NEVER be bought regardless of signals
BLACKLIST = {
    'IMFL',   # micro-cap, illiquid, caused stuck short position
}

# Minimum requirements to prevent micro-cap / illiquid stocks
MIN_VOLUME_FLOOR   = 5_000_000   # absolute minimum daily volume
MIN_MARKET_CAP     = 10_000_000_000  # $10B minimum market cap


IBKR_CONNECT_RETRIES = 3
IBKR_CONNECT_DELAY   = 10  # seconds between retries

# ── Helpers ───────────────────────────────────────────────────────────────────
def log(msg): print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def ibkr_connect(client_id: int, timeout: int = 15):
    """Connect to IBKR with retry logic. Returns connected IB instance or None."""
    from ib_insync import IB
    for attempt in range(1, IBKR_CONNECT_RETRIES + 1):
        try:
            ib = IB()
            ib.connect(IBKR_HOST, IBKR_PORT, clientId=client_id, timeout=timeout)
            log(f'  IBKR connected (clientId={client_id}, attempt {attempt})')
            return ib
        except Exception as e:
            log(f'  IBKR connect failed (attempt {attempt}/{IBKR_CONNECT_RETRIES}): {e}')
            if attempt < IBKR_CONNECT_RETRIES:
                log(f'  Retrying in {IBKR_CONNECT_DELAY}s...')
                time.sleep(IBKR_CONNECT_DELAY)
    log(f'  IBKR unavailable after {IBKR_CONNECT_RETRIES} attempts — skipping this cycle')
    send_telegram(f'⚠️ IBKR connection failed after {IBKR_CONNECT_RETRIES} retries. '
                  f'Check IB Gateway / concurrent session conflict.')
    return None

def kv_set(data: dict):
    req = urllib.request.Request(f'{KV_URL}/set/portfolio',
        data=json.dumps(data).encode(),
        headers={'Authorization': f'Bearer {KV_TOKEN}', 'Content-Type': 'application/json'},
        method='POST')
    urllib.request.urlopen(req, timeout=10)

def send_telegram(msg: str, buttons=None) -> int | None:
    try:
        body: dict = {'chat_id': TG_CHAT, 'text': msg, 'parse_mode': 'Markdown'}
        if buttons:
            body['reply_markup'] = {'inline_keyboard': buttons}
        data = json.dumps(body).encode()
        req = urllib.request.Request(f'https://api.telegram.org/bot{TG_TOKEN}/sendMessage',
            data=data, headers={'Content-Type': 'application/json'})
        resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
        return resp.get('result', {}).get('message_id')
    except Exception as e:
        log(f'Telegram send failed: {e}')
        return None

def get_recent_messages(since_ts: float) -> list[str]:
    """Poll Telegram for recent messages since timestamp"""
    try:
        url = f'https://api.telegram.org/bot{TG_TOKEN}/getUpdates?timeout=1&allowed_updates=["message","callback_query"]'
        resp = json.loads(urllib.request.urlopen(url, timeout=5).read())
        messages = []
        for update in resp.get('result', []):
            msg = update.get('message', {})
            cb  = update.get('callback_query', {})
            ts  = msg.get('date', 0) or cb.get('message', {}).get('date', 0)
            if ts >= since_ts:
                text = msg.get('text', '') or cb.get('data', '')
                if text:
                    messages.append(text.upper())
        return messages
    except:
        return []

def ibkr_trade(action: str, ticker: str, shares: int, price: float) -> dict:
    """Execute limit order via IBKR. price is required (no market orders)."""
    if not price or price <= 0:
        return {'error': 'Price required for limit orders'}
    args = [sys.executable, str(IBKR_CLI), action, ticker, str(shares), str(round(price, 2))]
    result = subprocess.run(args, capture_output=True, text=True, timeout=60)
    try:
        return json.loads(result.stdout)
    except:
        return {'error': result.stderr or result.stdout or 'Unknown'}

def get_live_price(ticker: str) -> float | None:
    """Get live price from IBKR"""
    try:
        from ib_insync import Stock
        ib = ibkr_connect(1, timeout=10)  # fixed: live price
        if not ib: return None
        contract = Stock(ticker, 'SMART', 'USD')
        ib.qualifyContracts(contract)
        ticker_data = ib.reqMktData(contract, '', False, False)
        ib.sleep(2)
        price = ticker_data.last or ticker_data.close or None
        ib.cancelMktData(contract)
        ib.disconnect()
        return float(price) if price else None
    except:
        return None

def push_portfolio(p: dict):
    """Save to local file, KV, and git"""
    with open(PORTFOLIO, 'w') as f:
        json.dump(p, f, indent=2)
    kv_set(p)
    try:
        repo = str(PORTFOLIO.parent.parent)
        subprocess.run(['git', 'add', '-f', 'data/portfolio.json'], cwd=repo, capture_output=True)
        subprocess.run(['git', 'commit', '-m', 'Portfolio update via local monitor'], cwd=repo, capture_output=True)
        subprocess.run(['git', 'push', 'origin', 'master'], cwd=repo, capture_output=True)
    except:
        pass

def get_news_context(ticker: str) -> str:
    """Fetch recent news + sentiment for a ticker and return a 1-2 sentence blurb."""
    try:
        import sys
        sys.path.insert(0, str(SCRIPTS))
        from fetch_news import get_ticker_news, get_ticker_sentiment, summarise_ticker_news
        news = get_ticker_news(ticker, days=2, limit=4)
        sentiment = get_ticker_sentiment(ticker)
        if not news:
            return ''
        return summarise_ticker_news(ticker, news, sentiment)
    except Exception as e:
        log(f'  News fetch error for {ticker}: {e}')
        return ''

def propose_trade(action: str, ticker: str, shares: int, price: float, sl: float, tp: float, reason: str, rsi: float = 0, volume: int = 0, news_context: str = ''):
    """Auto-execute trade via IBKR immediately, then notify via Telegram."""
    import subprocess
    log(f'  Auto-executing: {action} {shares}x {ticker} @ ${price:.2f}')

    # Execute immediately via IBKR
    result = ibkr_trade(action, ticker, shares, price)
    order_id = result.get('orderId', '?')
    status   = result.get('status', 'unknown')
    err      = result.get('error', '')

    if err:
        log(f'  Trade error: {err}')
        send_telegram(
            f'⚠️ *{action} {ticker}* failed\n'
            f'Shares: {shares} @ ${price:.2f}\n'
            f'Error: {err}'
        )
        return

    # Update portfolio.json with SL/TP + pending trade record
    try:
        with open(PORTFOLIO) as f:
            p = json.load(f)
        trade_id = f'{ticker}_{action}_{int(datetime.now(timezone.utc).timestamp())}'
        if 'pendingTrades' not in p:
            p['pendingTrades'] = {}
        p['pendingTrades'][trade_id] = {
            'ticker': ticker, 'action': action, 'shares': shares,
            'price': price, 'sl': sl, 'tp': tp,
            'status': 'executed', 'orderId': order_id,
            'createdAt': datetime.now(timezone.utc).isoformat(),
            'reason': reason[:120]
        }
        push_portfolio(p)
    except Exception as e:
        log(f'  Portfolio update error after trade: {e}')

    # Notify Vincent
    news_line = f'\n📰 _{news_context[:150]}_' if news_context else ''
    rsi_line  = f' | RSI {rsi:.0f}' if rsi else ''
    cost      = shares * price
    emoji     = '🟢' if action == 'BUY' else '🔴'
    send_telegram(
        f'{emoji} *{action} {ticker}* — Auto-executed\n'
        f'Shares: {shares} @ ${price:.2f} (${cost:,.0f})\n'
        f'SL: ${sl:.2f} | TP: ${tp:.2f}{rsi_line}\n'
        f'Order #{order_id} | Status: {status}\n'
        f'Reason: {reason[:100]}'
        f'{news_line}'
    )

# ── Local Screener (IBKR-native) ───────────────────────────────────────────────
def calc_rsi(closes: list, period=14) -> float:
    gains, losses = [], []
    for i in range(1, len(closes)):
        d = closes[i] - closes[i-1]
        gains.append(max(d,0)); losses.append(max(-d,0))
    if len(gains) < period: return 50.0
    ag = sum(gains[-period:]) / period
    al = sum(losses[-period:]) / period
    return 100 - (100 / (1 + ag/al)) if al > 0 else 100.0

def calc_sma(closes: list, period: int) -> float:
    return sum(closes[-period:]) / period if len(closes) >= period else 0.0

def calc_atr(bars: list, period=14) -> float:
    trs = [max(b.high-b.low, abs(b.high-bars[i-1].close), abs(b.low-bars[i-1].close))
           for i,b in enumerate(bars) if i > 0]
    return sum(trs[-period:]) / period if len(trs) >= period else 0.0

def get_ibkr_technicals(ib, ticker: str) -> dict | None:  # ib passed in from caller
    """Get live quote + historical indicators from IBKR"""
    try:
        from ib_insync import Stock
        contract = Stock(ticker, 'SMART', 'USD')
        ib.qualifyContracts(contract)
        # Historical bars for indicators
        bars = ib.reqHistoricalData(contract, endDateTime='', durationStr='6 M',
            barSizeSetting='1 day', whatToShow='ADJUSTED_LAST', useRTH=True)
        if not bars or len(bars) < 30:
            return None
        closes = [b.close for b in bars]
        price  = closes[-1]
        rsi_val  = calc_rsi(closes)
        sma50    = calc_sma(closes, 50)
        sma200   = calc_sma(closes, 200)
        atr      = calc_atr(bars)
        # Simple MACD: EMA12 - EMA26
        def ema(data, p):
            k = 2/(p+1); e = data[0]
            for v in data[1:]: e = v*k + e*(1-k)
            return e
        macd     = ema(closes, 12) - ema(closes, 26)
        macd_sig = ema([ema(closes[:i+1], 12) - ema(closes[:i+1], 26) for i in range(len(closes))], 9)
        return {
            'price':    price,
            'rsi':      rsi_val,
            'sma50':    sma50,
            'sma200':   sma200,
            'atr':      atr,
            'macd':     macd,
            'macd_sig': macd_sig,
        }
    except:
        return None

def tv_bulk_screen(held: list) -> list:
    """Fast bulk screen using tvscreener — returns pre-filtered tickers with indicators."""
    try:
        from tvscreener import StockScreener, StockField, Market, FilterOperator
        import math

        def clean(v):
            try: return None if math.isnan(float(v)) else float(v)
            except: return None

        sc = StockScreener()
        sc.set_markets(Market.AMERICA)
        # Base filters: price $25+, volume 5M+ (raised floor), market cap $10B+
        sc.add_filter(StockField.PRICE, FilterOperator.ABOVE, 25)
        sc.add_filter(StockField.VOLUME, FilterOperator.ABOVE, MIN_VOLUME_FLOOR)
        sc.add_filter(StockField.MARKET_CAPITALIZATION, FilterOperator.ABOVE, MIN_MARKET_CAP)
        df = sc.get()
        if df.empty:
            return []

        results = []
        for _, row in df.iterrows():
            sym = str(row.get('Name', '')).strip()
            if not sym or sym in held or not sym.isalpha() or len(sym) > 5:
                continue
            # Permanent blacklist check
            if sym.upper() in BLACKLIST:
                continue

            price   = clean(row.get('Price'))
            rsi     = clean(row.get('Relative Strength Index (14)'))
            sma50   = clean(row.get('Simple Moving Average (50)'))
            sma200  = clean(row.get('Simple Moving Average (200)'))
            macd    = clean(row.get('MACD Level (12, 26)'))
            macd_s  = clean(row.get('MACD Signal (12, 26)'))
            atr     = clean(row.get('Average True Range (14)'))
            volume  = clean(row.get('Volume')) or 0
            avg_vol = clean(row.get('Average Volume (10 day)')) or clean(row.get('Volume*10')) or 0

            if not price or not rsi or not sma200 or not atr:
                continue

            above_sma200 = price > sma200
            above_sma50  = sma50 and price > sma50
            macd_bullish = (macd or 0) > (macd_s or 0)
            vol_ratio    = (volume / avg_vol) if avg_vol and avg_vol > 0 else 0

            # HARD GATES — skip if any fail:
            # 1. RSI genuinely oversold
            oversold = rsi < 30
            if not oversold: continue

            # 2. MACD must be bullish (momentum confirming bounce, not still falling)
            if not macd_bullish: continue

            # 3. Volume quality: >= 1.5x 10-day average (institutional accumulation)
            if avg_vol > 0 and vol_ratio < 1.5: continue

            # 4. Absolute volume floor — reject illiquid micro-caps
            if volume < MIN_VOLUME_FLOOR: continue

            # TWO-TIER CONFIDENCE based on SMA200:
            # HIGH  — above SMA200 (uptrend intact, oversold pullback)
            # MEDIUM — below SMA200 but SMA50 is turning up (recovery play)
            # SKIP  — below both SMA200 and SMA50 (still a falling knife)
            if above_sma200:
                confidence = 'HIGH'
            elif above_sma50:
                # Below SMA200 but SMA50 recovering — early turnaround
                confidence = 'MEDIUM'
            else:
                # Below both — too early, skip
                continue

            # ATR-based SL/TP (more realistic than fixed %)
            # SL = 1.5x ATR below price, TP = 3x ATR above (R/R >= 2)
            if not atr or atr <= 0: continue
            sl = round(price - 1.5 * atr, 2)
            tp = round(price + 3.0 * atr, 2)
            risk = price - sl
            reward = tp - price
            rr = round(reward / risk, 1) if risk > 0 else 0
            if rr < 2.0: continue

            setup = 'Uptrend pullback' if above_sma200 else 'Recovery play'
            results.append({'ticker': sym, 'price': price, 'rsi': rsi,
                             'sl': sl, 'tp': tp, 'rr': rr, 'atr': atr,
                             'volume': int(volume), 'avg_vol': int(avg_vol), 'vol_ratio': round(vol_ratio, 2),
                             'confidence': confidence, 'setup': setup,
                             'above_sma200': above_sma200, 'above_sma50': above_sma50 or False,
                             'oversold': oversold, 'macd_bullish': macd_bullish})

        results.sort(key=lambda x: x['rr'], reverse=True)
        return results
    except Exception as e:
        log(f'tvscreener error: {e}')
        return []

def load_rejected_trades() -> dict:
    """Load rejected trades for today's session only.
    Clears the file if it was written on a previous trading day."""
    try:
        if REJECTED_TRADES.exists():
            with open(REJECTED_TRADES) as f:
                data = json.load(f)
            # Check session_date — if it's a different date, wipe and start fresh
            session_date = data.get('_session_date', '')
            today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
            if session_date != today:
                log(f'  New trading day ({today}) — clearing rejected trades from {session_date or "unknown"}')
                REJECTED_TRADES.write_text('{}')
                return {}
            # Return without the meta key
            return {k: v for k, v in data.items() if not k.startswith('_')}
    except:
        pass
    return {}

def save_rejected_trade(ticker: str, side: str, price: float):
    """Persist a rejected trade for the current trading day."""
    try:
        data = {}
        if REJECTED_TRADES.exists():
            try:
                data = json.loads(REJECTED_TRADES.read_text())
            except:
                data = {}
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        # Wipe if stale day
        if data.get('_session_date', today) != today:
            data = {}
        data['_session_date'] = today
        threshold = round(price * 0.98, 2) if side.upper() == 'BUY' else round(price * 1.02, 2)
        data[ticker.upper()] = {
            'side': side.upper(),
            'rejected_price': price,
            'threshold': threshold,
            'note': f'Re-propose only if price <= ${threshold:.2f} (BUY) or >= ${threshold:.2f} (SELL)'
        }
        REJECTED_TRADES.write_text(json.dumps(data, indent=2))
        log(f'  Saved rejection: {side} {ticker} @ ${price:.2f}, threshold ${threshold:.2f}')
    except Exception as e:
        log(f'  Warning: could not save rejection: {e}')

def is_rejected(ticker: str, side: str, current_price: float, rejected: dict) -> bool:
    """Return True if this trade was rejected and price hasn't moved enough (>=2%) to re-propose."""
    key = ticker.upper()
    if key not in rejected:
        return False
    r = rejected[key]
    if r.get('side', '').upper() != side.upper():
        return False
    rejected_price = r.get('rejected_price', 0)
    if not rejected_price:
        return False
    if side.upper() == 'BUY':
        threshold = rejected_price * 0.98  # must drop >=2%
        return current_price > threshold
    else:
        threshold = rejected_price * 1.02  # must rise >=2%
        return current_price < threshold

def get_open_order_tickers() -> list[str]:
    """Get tickers with open IBKR orders (submitted but not yet filled)."""
    try:
        ib = ibkr_connect(7, timeout=10)  # fixed clientId for order check
        if not ib:
            return []
        # reqAllOpenOrders gives full contract info including symbol
        ib.reqAllOpenOrders()
        ib.sleep(2)
        tickers = [t.contract.symbol.upper() for t in ib.trades()
                   if t.orderStatus.status in ('PreSubmitted', 'Submitted', 'ApiPending')]
        ib.disconnect()
        return list(set(tickers))
    except:
        return []

def local_screen(portfolio: dict, cash_usd: float, total_usd: float) -> list:
    """Screen 100+ stocks via tvscreener bulk, confirm top pick with IBKR"""
    held = [p['ticker'] for p in portfolio.get('positions', [])]

    # Exclude tickers with pending proposals (not yet executed/rejected)
    pending_tickers = [
        v.get('ticker') for v in portfolio.get('pendingTrades', {}).values()
        if v.get('status') == 'pending'
    ]

    # Exclude tickers with open IBKR orders (submitted, awaiting fill)
    open_order_tickers = get_open_order_tickers()

    rejected = load_rejected_trades()
    rejected_tickers = list(rejected.keys())
    excluded = list(set(held + pending_tickers + open_order_tickers + rejected_tickers))
    log(f'  Held: {held} | Pending: {pending_tickers} | Open orders: {open_order_tickers} | Rejected: {rejected_tickers}')

    log('  Running tvscreener bulk scan (100+ stocks)...')
    tv_results = tv_bulk_screen(excluded)
    log(f'  tvscreener: {len(tv_results)} candidates pass filters')

    if not tv_results:
        return []

    candidates = []
    # Take top 5 by R/R and confirm with IBKR for price accuracy
    try:
        ib = ibkr_connect(2, timeout=15)  # fixed: screener
        if not ib:
            raise Exception('IBKR unavailable, using tvscreener prices')

        for r in tv_results[:5]:
            ticker = r['ticker']
            # Get precise price + ATR from IBKR historical data
            tech = get_ibkr_technicals(ib, ticker)
            price = tech['price'] if tech else r['price']
            atr   = tech['atr']   if tech else r['atr']
            if not price or price != price: continue

            # Skip if rejected and price hasn't moved enough
            if is_rejected(ticker, 'BUY', price, rejected):
                rej_price = rejected[ticker.upper()]['rejected_price']
                threshold = rejected[ticker.upper()]['threshold']
                log(f'  ⏩ {ticker} skipped — rejected at ${rej_price:.2f}, needs <=${threshold:.2f} (currently ${price:.2f})')
                continue

            # ATR-based SL/TP: 1.5x ATR stop, 3x ATR target (R/R ~2)
            sl = round(price - 1.5 * atr, 2)
            tp = round(price + 3.0 * atr, 2)
            risk = price - sl
            rr = round((tp - price) / risk, 1) if risk > 0 else 0
            if rr < 2.0: continue

            rsi        = r['rsi']
            confidence = r['confidence']
            setup      = r.get('setup', 'Uptrend pullback')
            above_sma200 = r['above_sma200']
            above_sma50  = r['above_sma50']
            vol_ratio  = r.get('vol_ratio', 0)

            sma_note = 'Above SMA50+200' if above_sma50 and above_sma200 else \
                       'Above SMA200' if above_sma200 else \
                       'Below SMA200, SMA50 recovering'
            reason = (f'[{confidence}] {setup}. RSI {rsi:.0f} (oversold).'
                      f' {sma_note}. Vol {vol_ratio:.1f}x avg. R/R 1:{rr}.')

            candidates.append({'type':'BUY','ticker':ticker,'price':price,
                                'sl':sl,'tp':tp,'reason':reason,'rr':rr,
                                'rsi':rsi,'volume':r['volume'],'confidence':confidence})
            log(f'  ✅ {ticker} @ ${price:.2f} | RSI {rsi:.0f} | Vol {vol_ratio:.1f}x avg | {confidence} | {setup} | R/R 1:{rr}')

        ib.disconnect()
    except Exception as e:
        log(f'IBKR confirmation error: {e}')
        # Fall back to tvscreener prices if IBKR fails
        for r in tv_results[:3]:
            ticker = r['ticker']; rsi = r['rsi']; price = r['price']
            # Skip rejected trades in fallback too
            if is_rejected(ticker, 'BUY', price, rejected):
                log(f'  ⏩ {ticker} skipped (rejected, fallback path)')
                continue
            sl = r['sl']; tp = r['tp']; rr = r['rr']
            confidence = r['confidence']
            setup      = r.get('setup', 'Uptrend pullback')
            vol_ratio  = r.get('vol_ratio', 0)
            reason = f'[{confidence}] {setup}. RSI {rsi:.0f} (oversold). Vol {vol_ratio:.1f}x avg. R/R 1:{rr}.'
            candidates.append({'type':'BUY','ticker':ticker,'price':price,
                                'sl':sl,'tp':tp,'reason':reason,'rr':rr,
                                'rsi':rsi,'volume':r['volume'],'confidence':confidence})

    candidates.sort(key=lambda x: x['rr'], reverse=True)
    return candidates[:1]  # Best candidate only


# ── Main ──────────────────────────────────────────────────────────────────────
def is_market_open() -> bool:
    """Check if NYSE is open based on UTC time."""
    now = datetime.now(timezone.utc)
    dow = now.weekday()  # 0=Mon, 6=Sun
    if dow >= 5:  # Saturday or Sunday
        return False
    h, m = now.hour, now.minute
    open_mins  = NYSE_OPEN_UTC[0]  * 60 + NYSE_OPEN_UTC[1]
    close_mins = NYSE_CLOSE_UTC[0] * 60 + NYSE_CLOSE_UTC[1]
    current_mins = h * 60 + m
    return open_mins <= current_mins < close_mins

def cancel_stale_orders():
    """Cancel any open IBKR orders older than 30 minutes."""
    try:
        ib = ibkr_connect(3, timeout=15)  # fixed: stale orders
        if not ib: return
        open_orders = ib.openOrders()
        now_utc = datetime.now(timezone.utc)
        cancelled = []

        for order in open_orders:
            # Get trade for this order to check submission time
            trades = [t for t in ib.trades() if t.order.orderId == order.orderId]
            if not trades:
                continue
            trade = trades[0]
            # Get time from first log entry
            if not trade.log:
                continue
            submitted_at = trade.log[0].time  # datetime with tz
            if submitted_at.tzinfo is None:
                continue
            age_mins = (now_utc - submitted_at).total_seconds() / 60
            if age_mins >= 30:
                ib.cancelOrder(order)
                ib.sleep(1)
                cancelled.append({
                    'orderId': order.orderId,
                    'ticker': trade.contract.symbol,
                    'action': order.action,
                    'shares': order.totalQuantity,
                    'price': order.lmtPrice,
                    'age_mins': round(age_mins, 1)
                })
                log(f'  Cancelled stale order: {order.action} {order.totalQuantity}x {trade.contract.symbol} @ ${order.lmtPrice} ({age_mins:.0f} min old)')

        ib.disconnect()

        for c in cancelled:
            send_telegram(
                f'⏰ Order #{c["orderId"]} cancelled — not filled within 30 min.\n'
                f'{c["action"]} {int(c["shares"])}x *{c["ticker"]}* @ ${c["price"]:.2f}'
            )

    except Exception as e:
        log(f'Cancel stale orders error: {e}')


def process_pending_trades(p: dict) -> bool:
    """Expire stale pending trades — NO auto-execution.
    Trades only execute when Vincent taps ✅ Execute Now in Telegram.
    Proposals older than 30 min are marked expired and cleaned up.
    """
    pending = p.get('pendingTrades', {})
    if not pending:
        return False

    changed = False
    now = datetime.now(timezone.utc)
    EXPIRY_MINS = 30

    for trade_id, trade in list(pending.items()):
        if trade.get('status') != 'pending':
            continue

        try:
            created_dt = datetime.fromisoformat(trade.get('createdAt', ''))
            if created_dt.tzinfo is None:
                created_dt = created_dt.replace(tzinfo=timezone.utc)
            age_mins = (now - created_dt).total_seconds() / 60
        except:
            age_mins = 0

        if age_mins >= EXPIRY_MINS:
            p['pendingTrades'][trade_id]['status'] = 'expired'
            ticker = trade.get('ticker', '?').upper()
            action = trade.get('action', '?').upper()
            price  = trade.get('price', 0)
            log(f'  Expired proposal: {action} {ticker} (age {age_mins:.0f} min — no approval received)')
            send_telegram(f'⏰ {action} *{ticker}* proposal expired — treating as rejected for today.')
            # Treat expiry as rejection — won't re-propose same stock today
            save_rejected_trade(ticker, action, price)
            changed = True

    return changed


def check_portfolio_integrity(p: dict) -> bool:
    """Compare IBKR positions vs portfolio.json at start of each market-hours run.
    If mismatch (ticker missing or qty differs >1): log warning, send Telegram alert,
    and trigger a sync. Uses clientId 8.
    """
    try:
        ib = ibkr_connect(8, timeout=15)
        if not ib:
            log('Integrity check skipped — IBKR unavailable')
            return True

        ibkr_positions = ib.positions(IBKR_ACCOUNT)
        ib.disconnect()

        # Build IBKR position map {ticker: qty}
        ibkr_map = {}
        for pos in ibkr_positions:
            if pos.position != 0:
                ibkr_map[pos.contract.symbol] = int(pos.position)

        # Build local position map {ticker: qty}
        local_map = {pos['ticker']: pos.get('shares', 0) for pos in p.get('positions', [])}

        # Check for mismatches
        mismatches = []
        all_tickers = set(ibkr_map.keys()) | set(local_map.keys())
        for ticker in all_tickers:
            ibkr_qty = ibkr_map.get(ticker, 0)
            local_qty = local_map.get(ticker, 0)
            if abs(ibkr_qty - local_qty) > 1:
                mismatches.append(f'{ticker}: IBKR={ibkr_qty}, local={local_qty}')

        if mismatches:
            detail = '\n'.join(mismatches)
            log(f'⚠️ Portfolio mismatch detected:\n{detail}')
            send_telegram(
                f'⚠️ *Portfolio integrity mismatch* detected:\n{detail}\n\nTriggering sync from IBKR...'
            )
            # Re-sync to fix drift
            sync_result = subprocess.run(
                [sys.executable, str(SYNC_SCRIPT)],
                capture_output=True, text=True, timeout=90
            )
            log(f'Integrity re-sync: {sync_result.stdout.strip() or sync_result.stderr.strip()}')
            return False

        log('Portfolio integrity OK')
        return True
    except Exception as e:
        log(f'Integrity check error: {e}')
        return True  # Don't block on check failure


def main():
    log('Starting monitor run')

    # Guard: skip ALL IBKR connections when market is closed
    # This prevents stale client connections accumulating in IB Gateway
    if not is_market_open():
        log('Market closed (UTC check) — skipping')
        return

    # Market open — check pending trades + stale orders
    try:
        with open(PORTFOLIO) as f:
            p_check = json.load(f)
        if process_pending_trades(p_check):
            push_portfolio(p_check)
    except Exception as e:
        log(f'Pending trade check error: {e}')

    # Cancel any IBKR orders open > 30 min
    cancel_stale_orders()

    # 1. Sync from IBKR (IBKR is master — full replace of positions)
    log('Syncing from IBKR...')
    result = subprocess.run([sys.executable, str(SYNC_SCRIPT)], capture_output=True, text=True, timeout=90)
    try:
        sync = json.loads(result.stdout)
        log(f"Synced: NLV ${sync.get('nlv_usd',0):,.0f}, cash ${sync.get('cash_usd',0):,.0f}, positions: {sync.get('positions',0)} {sync.get('tickers',[])}")
    except Exception:
        log(f'Sync warning: {result.stderr or result.stdout}')

    with open(PORTFOLIO) as f:
        p = json.load(f)

    # 1b. Portfolio integrity check — compare IBKR vs local, alert + re-sync on mismatch
    check_portfolio_integrity(p)

    # Reload after potential integrity re-sync
    with open(PORTFOLIO) as f:
        p = json.load(f)

    positions = p.get('positions', [])
    cash_usd  = p['cashByValue'].get('USD', 0)
    total_usd = cash_usd + sum((pos.get('currentPrice') or pos.get('avgCost') or 0) * pos['shares'] for pos in positions)

    # 2. Check SL/TP on open positions
    # Note: We read current prices from live IBKR data for SL/TP evaluation only.
    # We do NOT write position updates to portfolio.json — sync handles that.
    for pos in list(positions):
        price = get_live_price(pos['ticker'])
        if not price:
            continue

        sl = pos.get('stopLoss')
        tp = pos.get('takeProfit')
        trigger = None
        reason  = ''

        if sl and price <= sl:
            trigger = 'SELL'
            reason  = f'Stop-loss hit at ${price:.2f} (SL: ${sl:.2f})'
        elif tp and price >= tp:
            trigger = 'SELL'
            reason  = f'Take-profit hit at ${price:.2f} (TP: ${tp:.2f})'

        if trigger:
            shares = pos['shares']
            pnl = (price - (pos.get('buyPrice') or pos.get('avgCost') or price)) * shares
            full_reason = f"{reason} P&L if sold: {'+' if pnl>=0 else ''}${pnl:.0f}"
            news_ctx = get_news_context(pos['ticker'])
            propose_trade('SELL', pos['ticker'], shares, price,
                          pos.get('stopLoss', round(price*0.95,2)),
                          pos.get('takeProfit', round(price*1.08,2)),
                          full_reason, news_context=news_ctx)
            log(f'SL/TP signal proposed: SELL {shares}x {pos["ticker"]} @ ${price:.2f}')

    # 3. Scan for buy opportunities
    n_positions = len(p['positions'])
    if n_positions >= MAX_POSITIONS:
        log(f'Max positions ({MAX_POSITIONS}) reached, skipping buy scan')
        return

    # HARD RULE: Never go on margin — cash must be positive before any buy
    if cash_usd <= 0:
        log(f'MARGIN PROTECTION: cash is ${cash_usd:,.2f} — no buys allowed')
        send_telegram('⛔ Margin protection triggered — no new buys until cash is positive.')
        return

    min_cash   = total_usd * MIN_CASH_RESERVE
    deployable = cash_usd - min_cash
    if deployable < 5000:
        log(f'Insufficient deployable cash (${deployable:.0f}), skipping buy scan')
        return

    # Local screener using tvscreener + Groq LLM
    log('Scanning market locally via tvscreener...')
    candidates = local_screen(p, cash_usd, total_usd)
    log(f'Local screener found {len(candidates)} candidates')

    buys_done = 0
    for trade in candidates:
        if trade.get('type') != 'BUY':
            continue
        if buys_done >= 2:
            break
        if n_positions + buys_done >= MAX_POSITIONS:
            break

        ticker = trade['ticker']
        price  = trade.get('price') or get_live_price(ticker) or 0
        if not price or price != price:  # check for NaN
            continue

        max_cost    = total_usd * MAX_POSITION_PCT
        position_sz = min(deployable, max_cost)
        if not price or price != price or price <= 0:
            continue
        shares      = int(position_sz / price)
        if shares <= 0:
            continue
        if shares <= 0:
            continue

        sl = trade.get('sl', round(price * 0.95, 2))
        tp = trade.get('tp', round(price * 1.10, 2))
        reason = trade.get('reason', f'Screener buy signal @ ${price:.2f}')
        cost = shares * price

        # Fetch news context for the proposal
        log(f'  Fetching news context for {ticker}...')
        news_ctx = get_news_context(ticker)

        propose_trade('BUY', ticker, shares, price, sl, tp, reason,
                     rsi=trade.get('rsi', 0), volume=trade.get('volume', 0),
                     news_context=news_ctx)
        log(f'Buy signal proposed: {shares}x {ticker} @ ${price:.2f}')
        buys_done += 1
        deployable -= cost
        n_positions += 1

    log('Monitor run complete')

if __name__ == '__main__':
    # Continuous monitoring loop
    # Runs every 10 minutes during NYSE hours
    while True:
        main()
        time.sleep(600)  # 10 minutes
