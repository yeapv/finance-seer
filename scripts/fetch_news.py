#!/usr/bin/env python3
"""
News & sentiment fetcher for Finance Seer.
Primary source: IBKR (Briefing.com + Dow Jones + Analyst Actions)
Fallback: Finnhub

Used by:
  - monitor.py (Option 1): per-ticker news for trade proposals
  - morning_briefing.py (Option 2): daily market summary
  - on-demand: python3 fetch_news.py [TICKER]
"""
import json, os, re, urllib.request, urllib.parse
from datetime import datetime, timezone, timedelta

FINNHUB_KEY  = os.environ.get('FINNHUB_API_KEY', '')
TAVILY_KEY   = os.environ.get('TAVILY_API_KEY', '')
TAVILY_URL   = 'https://api.tavily.com/search'
LLM_URL      = os.environ.get('OPENAI_API_URL', 'http://192.168.10.163:8000/v1') + '/chat/completions'  # GX10 vLLM
LLM_MODEL    = os.environ.get('AI_MODEL', 'qwen3.8-flash-next')
IBKR_HOST    = os.environ.get('IBKR_HOST', 'host.docker.internal')
IBKR_PORT    = int(os.environ.get('IBKR_PORT', '4002'))  # paper account

# IBKR news providers (ordered by quality)
IBKR_PROVIDERS_TICKER  = 'BRFUPDN,BRFG,DJ-RTG'   # analyst actions first, then general
IBKR_PROVIDERS_MARKET  = 'DJ-RTG,DJ-RTPRO,BRFG'  # global/pro for market-wide news


def clean_headline(raw: str) -> str:
    """Strip IBKR metadata prefix like {A:800015:L:en:K:0.97:C:0.97}"""
    return re.sub(r'^\{[^}]+\}!?', '', raw).strip()


# ── IBKR News ─────────────────────────────────────────────────────────────────

def get_ibkr_ticker_news(ticker: str, days: int = 3, limit: int = 6) -> list[dict]:
    """Fetch ticker news from IBKR via ib_insync."""
    try:
        from ib_insync import IB, Stock
        ib = IB()
        ib.connect(IBKR_HOST, IBKR_PORT, clientId=5, timeout=12)  # fixed: news ticker
        contract = Stock(ticker, 'SMART', 'USD')
        ib.qualifyContracts(contract)
        articles = ib.reqHistoricalNews(
            contract.conId,
            providerCodes=IBKR_PROVIDERS_TICKER,
            startDateTime='', endDateTime='',
            totalResults=limit
        )
        ib.disconnect()
        return [{'headline': clean_headline(a.headline),
                 'source': a.providerCode,
                 'time': str(a.time)} for a in articles if a.headline]
    except Exception as e:
        return []


def get_ibkr_market_news(limit: int = 8) -> list[dict]:
    """Fetch general market news from IBKR (Dow Jones)."""
    try:
        from ib_insync import IB
        ib = IB()
        ib.connect(IBKR_HOST, IBKR_PORT, clientId=6, timeout=12)  # fixed: news market
        # Use a broad ETF as proxy for market news
        from ib_insync import Stock
        contract = Stock('SPY', 'SMART', 'USD')
        ib.qualifyContracts(contract)
        articles = ib.reqHistoricalNews(
            contract.conId,
            providerCodes=IBKR_PROVIDERS_MARKET,
            startDateTime='', endDateTime='',
            totalResults=limit
        )
        ib.disconnect()
        return [{'headline': clean_headline(a.headline),
                 'source': a.providerCode,
                 'time': str(a.time)} for a in articles if a.headline]
    except Exception as e:
        return []


# ── Tavily search ────────────────────────────────────────────────────────────

def get_tavily_ticker_news(ticker: str, limit: int = 5) -> list[dict]:
    """Fetch live news for a ticker using Tavily search API."""
    try:
        query = f'{ticker} stock news earnings analyst price target 2026'
        body = json.dumps({
            'api_key': TAVILY_KEY,
            'query': query,
            'search_depth': 'basic',
            'include_answer': False,
            'max_results': limit,
            'topic': 'finance',
        }).encode()
        req = urllib.request.Request(TAVILY_URL, data=body,
            headers={'Content-Type': 'application/json', 'User-Agent': 'FinanceSeer/1.0'})
        resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
        results = resp.get('results', [])
        return [{'headline': r.get('title', ''), 'source': 'Tavily',
                 'time': r.get('published_date', ''), 'url': r.get('url', ''),
                 'snippet': r.get('content', '')[:200]}
                for r in results if r.get('title')]
    except Exception as e:
        return []


def get_tavily_market_news(limit: int = 8) -> list[dict]:
    """Fetch live market/macro news using Tavily."""
    try:
        body = json.dumps({
            'api_key': TAVILY_KEY,
            'query': 'US stock market Wall Street news today 2026 S&P 500 Fed rates earnings',
            'search_depth': 'basic',
            'include_answer': False,
            'max_results': limit,
            'topic': 'finance',
        }).encode()
        req = urllib.request.Request(TAVILY_URL, data=body,
            headers={'Content-Type': 'application/json', 'User-Agent': 'FinanceSeer/1.0'})
        resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
        results = resp.get('results', [])
        return [{'headline': r.get('title', ''), 'source': 'Tavily',
                 'time': r.get('published_date', ''), 'snippet': r.get('content', '')[:200]}
                for r in results if r.get('title')]
    except Exception as e:
        return []


# ── Finnhub fallback ──────────────────────────────────────────────────────────

def finnhub_get(path: str, params: dict) -> dict:
    params['token'] = FINNHUB_KEY
    url = f'https://finnhub.io/api/v1/{path}?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'User-Agent': 'FinanceSeer/1.0'})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=10).read())
    except:
        return {}


def get_finnhub_ticker_news(ticker: str, days: int = 2, limit: int = 5) -> list[dict]:
    today = datetime.now(timezone.utc)
    from_date = (today - timedelta(days=days)).strftime('%Y-%m-%d')
    to_date = today.strftime('%Y-%m-%d')
    data = finnhub_get('company-news', {'symbol': ticker, 'from': from_date, 'to': to_date})
    if isinstance(data, list):
        return [{'headline': n['headline'], 'source': 'Finnhub', 'time': str(n.get('datetime', ''))}
                for n in data[:limit]]
    return []


def get_finnhub_market_news(limit: int = 8) -> list[dict]:
    data = finnhub_get('news', {'category': 'general'})
    if isinstance(data, list):
        return [{'headline': n['headline'], 'source': 'Finnhub', 'time': ''} for n in data[:limit]]
    return []


def get_finnhub_sentiment(ticker: str) -> dict:
    data = finnhub_get('news-sentiment', {'symbol': ticker})
    if data:
        return {
            'bullish': round(data.get('sentiment', {}).get('bullishPercent', 0.5) * 100),
            'bearish': round(data.get('sentiment', {}).get('bearishPercent', 0.5) * 100),
        }
    return {}


# ── Unified getters ───────────────────────────────────────────────────────────

def get_ticker_news(ticker: str, days: int = 3, limit: int = 6) -> list[dict]:
    """Tavily first (live web), then IBKR, then Finnhub fallback."""
    news = get_tavily_ticker_news(ticker, limit=limit)
    if not news:
        news = get_ibkr_ticker_news(ticker, days=days, limit=limit)
    if not news:
        news = get_finnhub_ticker_news(ticker, days=days, limit=limit)
    return news


def get_market_news(limit: int = 8) -> list[dict]:
    """Tavily first (live web), then IBKR, then Finnhub fallback."""
    news = get_tavily_market_news(limit=limit)
    if not news:
        news = get_ibkr_market_news(limit=limit)
    if not news:
        news = get_finnhub_market_news(limit=limit)
    return news


# ── LLM summarisation ─────────────────────────────────────────────────────────

def llm_summarise(prompt: str, max_tokens: int = 300) -> str:
    """Call GX10 vLLM (OpenAI-compatible). Thinking disabled via chat_template_kwargs."""
    body = json.dumps({
        'model': LLM_MODEL,
        'messages': [{'role': 'user', 'content': prompt}],
        'max_tokens': max_tokens,
        'temperature': 0.3,
        'stream': False,
        'chat_template_kwargs': {'enable_thinking': False},
    }).encode()
    req = urllib.request.Request(LLM_URL, data=body,
                                 headers={'Content-Type': 'application/json',
                                          'Authorization': '***'})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            resp = json.loads(r.read())
        msg = resp['choices'][0]['message']
        return (msg.get('content') or msg.get('reasoning') or '').strip()
    except Exception:
        return ''

groq_summarise = llm_summarise  # legacy name kept for callers
get_ticker_sentiment = get_finnhub_sentiment  # legacy name (used by morning_briefing/monitor)


def summarise_market_news(news: list[dict]) -> str:
    if not news:
        return 'No recent market news available.'
    headlines = '\n'.join(f'- [{n["source"]}] {n["headline"]}' for n in news[:8])
    result = groq_summarise(
        f'Summarise these financial news headlines into 2-3 key market themes driving sentiment today. '
        f'Be concise (3-4 sentences). Focus on what matters for US stock investors.\n\n{headlines}',
        max_tokens=200
    )
    return result or '\n'.join(f'• {n["headline"]}' for n in news[:3])


def summarise_ticker_news(ticker: str, news: list[dict], sentiment: dict = {}) -> str:
    if not news:
        return ''
    headlines = '\n'.join(f'- [{n["source"]}] {n["headline"]}' for n in news[:5])
    bull = sentiment.get('bullish', 50)
    result = groq_summarise(
        f'In 1-2 sentences, explain why {ticker} is moving based on these headlines. '
        f'Sentiment: {bull}% bullish. Be direct and trader-focused.\n\n{headlines}',
        max_tokens=100
    )
    # Fallback: just return the top headline if LLM fails
    return result or news[0]['headline']


# ── CLI / on-demand ───────────────────────────────────────────────────────────

if __name__ == '__main__':
    import sys

    if len(sys.argv) > 1:
        ticker = sys.argv[1].upper()
        print(f'\n📰 News & Sentiment: {ticker}')
        print('─' * 45)
        news = get_ticker_news(ticker)
        sentiment = get_finnhub_sentiment(ticker)
        if news:
            for n in news:
                print(f'  [{n["source"]}] {n["headline"]}')
                if n.get('time'): print(f'           {n["time"]}')
        else:
            print('  No recent news found.')
        if sentiment:
            print(f'\nSentiment: {sentiment["bullish"]}% bullish / {sentiment["bearish"]}% bearish')
        summary = summarise_ticker_news(ticker, news, sentiment)
        if summary:
            print(f'\n💡 {summary}')
    else:
        print('\n📰 Market News Summary')
        print('─' * 45)
        news = get_market_news(limit=8)
        for n in news[:5]:
            print(f'  [{n["source"]}] {n["headline"]}')
        print()
        summary = summarise_market_news(news)
        print(f'💡 {summary}')
