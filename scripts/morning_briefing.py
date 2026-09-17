#!/usr/bin/env python3
"""
Morning Briefing — fires at NYSE open (13:30 UTC / 21:30 SGT) Mon-Fri.
Sends a market summary + watchlist sentiment to Telegram.
Cron: 30 13 * * 1-5
"""
import os, json, urllib.request
from datetime import datetime, timezone
from fetch_news import get_market_news, get_ticker_news, get_ticker_sentiment, summarise_market_news, summarise_ticker_news, groq_summarise, FINNHUB_KEY

TG_TOKEN  = os.environ.get('TELEGRAM_BOT_TOKEN', '')
TG_CHAT   = os.environ.get('TELEGRAM_CHAT_ID', '786437034')
WATCHLIST = ['ADSK', 'MSFT', 'NVDA', 'INTC', 'AMD', 'CRWV', 'NBIS', 'AAPL']

def send_telegram(msg: str):
    body = json.dumps({'chat_id': TG_CHAT, 'text': msg, 'parse_mode': 'Markdown'}).encode()
    req = urllib.request.Request(
        f'https://api.telegram.org/bot{TG_TOKEN}/sendMessage',
        data=body, headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f'Telegram error: {e}')

def get_price_change(ticker: str) -> tuple[float, float] | tuple[None, None]:
    """Get current price and % change from Yahoo Finance."""
    try:
        url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=2d'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        d = json.loads(urllib.request.urlopen(req, timeout=8).read())
        meta = d['chart']['result'][0]['meta']
        price = meta['regularMarketPrice']
        prev  = meta.get('previousClose') or meta.get('chartPreviousClose')
        pct   = ((price - prev) / prev * 100) if prev else 0
        return price, pct
    except:
        return None, None

def main():
    now_sgt = datetime.now(timezone.utc)
    date_str = now_sgt.strftime('%a %d %b %Y')

    print(f'Running morning briefing for {date_str}')

    # 1. General market news + sentiment
    market_news = get_market_news(limit=10)
    market_summary = summarise_market_news(market_news)

    # 2. Watchlist snapshot
    watchlist_lines = []
    mover_news = {}
    for ticker in WATCHLIST:
        price, pct = get_price_change(ticker)
        if price is None:
            continue
        arrow = '🟢' if pct >= 0 else '🔴'
        watchlist_lines.append(f'{arrow} *{ticker}* ${price:.2f} ({pct:+.1f}%)')
        # Fetch news for big movers (>2% either way)
        if abs(pct) >= 2:
            news = get_ticker_news(ticker, days=1, limit=3)
            sentiment = get_ticker_sentiment(ticker)
            if news:
                mover_news[ticker] = summarise_ticker_news(ticker, news, sentiment)

    # 3. SGX dividend shortlist (report-only; daily cached screen)
    sgx_block = []
    try:
        import sgx_screen
        shortlist = sgx_screen.digest_text(top=6)
        if shortlist:
            sgx_block = ['', shortlist]
    except Exception as e:
        print(f'SGX screen skipped: {e}')

    # 4. Build message
    lines = [
        f'☀️ *Morning Briefing — {date_str}*',
        f'NYSE Open 🔔',
        '',
        f'📰 *Market Theme*',
        market_summary,
        '',
        f'📊 *Watchlist*',
    ] + watchlist_lines

    if mover_news:
        lines += ['', '🔍 *Big Movers*']
        for ticker, blurb in mover_news.items():
            lines.append(f'*{ticker}:* {blurb}')

    lines += sgx_block
    lines += ['', '_Finance Seer • Screener running_']

    send_telegram('\n'.join(lines))
    print('Briefing sent.')

if __name__ == '__main__':
    main()
