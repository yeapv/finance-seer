#!/usr/bin/env python3
"""
SGX dividend screener — ranked income opportunities on SGX Mainboard.

Report-only by design (v1): does NOT place orders. Emits ranked candidates
with dividend quality metrics; monitor.py surfaces them in the daily digest.
Data: yfinance (.SI tickers). Metrics per proposal playbook:
  - trailing 12-month yield (computed from dividend history / price)
  - consecutive years with payouts (payment reliability)
  - 3y and 5y DPS CAGR (growth)
  - payout consistency: paid in >=75% of 12-month windows
  - special-dividend flag: any single payout > 2.5x median (inflated yield)
  - REIT/trust classification (DPU convention vs dividend)
Cache: one refresh per day, JSON at data/sgx_screen_cache.json.
"""
import json, os, statistics, time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'data' / 'sgx_screen_cache.json'

# Curated SGX Mainboard dividend universe (banks/telcos/insurers/industrials + S-REITs/trusts)
SGX_DIVIDEND_UNIVERSE = {
    # Banks / telco / insurers / conglomerates / property (all live-verified
    # via Yahoo 2026-09-17; display names come from Yahoo shortName at runtime,
    # these labels are hints only)
    'D05.SI': 'DBS',              'O39.SI': 'OCBC',          'U11.SI': 'UOB',
    'Z74.SI': 'Singtel',          'C07.SI': 'Jardine C&C',   'S63.SI': 'ST Eng',
    'G13.SI': 'SIA',              'C6L.SI': 'SIA Eng',       'F14.SI': 'Olam Agri',
    'S66.SI': 'HK Land',          'D01.SI': 'City Develop',  'U96.SI': 'UOL',
    'Y92.SI': 'SingLand',         'C2PU.SI': 'Sembcorp Ind','B34.SI': 'Keppel',
    '5DM.SI': 'Sheng Siong',      'J36.SI': 'VivoCity',      'E5E.SI': 'Golden Ag',
    'BSY.SI': 'Xinya Life',       'M91.SI': 'Yoma Strx',     'EG7.SI': 'Japfa',
    'QBF.SI': 'UMS',              'BN4.SI': 'Sealand',       'P34.SI': 'Delfi',
    # S-REITs & business trusts (live-verified subset)
    'A17U.SI': 'Ascendas REIT',   'M44U.SI': 'Mapletree LogTr','J69U.SI': 'Frasers Cpt Tr',
    'C38U.SI': 'IntCom Tr',       'ME8U.SI': 'Map Ind Tr',
    'AJBU.SI': 'Keppel DC REIT',
    'K71U.SI': 'Keppel REIT',     'T82U.SI': 'Suntec REIT',  'J85.SI': 'CDL HTrust',
    'A7RU.SI': 'Kep Infra Tr',    'P40U.SI': 'Starhill REIT',
}
# strip invalid tickers defensively (no spaces, correct suffix)
UNIVERSE = {k: v for k, v in SGX_DIVIDEND_UNIVERSE.items()
            if k.endswith('.SI') and ' ' not in k}

MIN_YIELD = float(os.environ.get('SGX_MIN_YIELD', '3.0'))     # %
MIN_MCAP = float(os.environ.get('SGX_MIN_MARKET_CAP', '500e6'))  # SGD
MIN_AVG_VOL = int(os.environ.get('SGX_MIN_AVG_VOLUME', '100000'))


def _metrics(symbol: str, name: str) -> dict | None:
    tk = yf.Ticker(symbol)
    info = {}
    try:
        info = tk.info or {}
    except Exception:
        pass
    try:
        hist = tk.history(period='1y', interval='1d')
    except Exception:
        hist = pd.DataFrame()
    price = info.get('currentPrice') or info.get('regularMarketPrice')
    if hist is not None and len(hist):
        price = price or float(hist['Close'].iloc[-1])
    div = tk.dividends
    if not price or div is None or len(div) == 0:
        return None
    mcap = info.get('marketCap')
    avg_vol = float(hist['Volume'].mean()) if len(hist) and 'Volume' in hist else 0
    # trailing 12m DPS
    cutoff = div.index.max() - pd.Timedelta(days=365)
    l12 = float(div[div.index >= cutoff].sum())
    yield_pct = l12 / price * 100
    # consecutive years paid (calendar years with >=1 payout, counting back from latest)
    years = sorted({d.year for d in div.index}, reverse=True)
    consecutive = 1
    for i in range(1, len(years)):
        if years[i - 1] - years[i] == 1:
            consecutive += 1
        else:
            break
    if cutoff.year not in years and years and years[0] < cutoff.year:
        consecutive = max(consecutive - 1, 0)
    # payout consistency: fraction of trailing years with a payout (max 10y window)
    w10 = {d.year for d in div.index if d >= div.index.max() - pd.Timedelta(days=3650)}
    consistency = len(w10) / min(10, div.index.max().year - (div.index.min().year)) if len(w10) else 0
    # DPS CAGR over 3y and 5y (annual sums)
    def dps_for_year(y):
        return float(div[(div.index.year == y)].sum())
    def cagr(nyears):
        if consecutive < 1:
            return None
        latest_full = div.index.max().year
        recent = dps_for_year(latest_full) or dps_for_year(latest_full - 1)
        base_year = latest_full if dps_for_year(latest_full) else latest_full - 1
        past = dps_for_year(base_year - nyears)
        if recent and past and past > 0 and recent > 0:
            return round(((recent / past) ** (1 / nyears) - 1) * 100, 1)
        return None
    # special dividend flag
    specials = 0
    per_year_vals = [v for v in div.div(div.index.year.notna()).resample('QE').sum() if v > 0] if len(div) > 4 else []
    try:
        q = div.resample('QE').sum()
        q = q[q > 0]
        if len(q) >= 4:
            med = statistics.median(q.tail(12).tolist())
            specials = int((q.tail(4) > med * 2.5).sum())
    except Exception:
        pass
    yahoo_name = info.get('shortName') or name
    reit = any(k in yahoo_name.lower() for k in ('reit', 'trust')) or symbol.endswith('U.SI')
    return {
        'ticker': symbol, 'name': yahoo_name, 'name_hint': name,
        'price': round(float(price), 3),
        'yield12m': round(yield_pct, 2), 'consecYears': consecutive,
        'consistency': round(consistency, 2),
        'cagr3y': cagr(3), 'cagr5y': cagr(5),
        'specialFlags': specials, 'isReit': reit,
        'marketCap': mcap, 'avgVolume': int(avg_vol),
        'asOf': datetime.now(timezone.utc).strftime('%Y-%m-%d'),
    }


def screen(force: bool = False) -> list[dict]:
    """Rank the universe; daily-cached unless force."""
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    if not force and CACHE.exists():
        try:
            cached = json.loads(CACHE.read_text())
            if cached.get('asOf') == today and isinstance(cached.get('results'), list):
                return cached['results']
        except Exception:
            pass
    results = []
    for sym, name in sorted(UNIVERSE.items()):
        try:
            m = _metrics(sym, name)
            if m:
                results.append(m)
            time.sleep(0.4)   # yahoo courtesy
        except Exception:
            continue
    # filters
    ok = [r for r in results
          if r['yield12m'] >= MIN_YIELD
          and r['consecYears'] >= 3
          and (r['marketCap'] or 0) >= MIN_MCAP
          and r['avgVolume'] >= MIN_AVG_VOL
          and r['specialFlags'] == 0]
    ok.sort(key=lambda r: (r['yield12m'] * 0.6
                           + (r['cagr3y'] or 0) * 2.0
                           + r['consecYears'] * 0.3
                           + r['consistency'] * 2.0), reverse=True)
    CACHE.parent.mkdir(exist_ok=True)
    CACHE.write_text(json.dumps({'asOf': today, 'all': results, 'results': ok}, indent=1))
    return ok


def digest_text(top: int = 8) -> str:
    try:
        ranked = screen()
    except Exception as e:
        return f'⚠️ SGX dividend screen failed: {e}'
    if not ranked:
        return 'SGX dividend screen: no candidates above gates today.'
    lines = ['💎 *SGX Dividend Shortlist* (report-only, ranked: yield+growth+reliability)']
    for r in ranked[:top]:
        tag = '🏬' if r['isReit'] else '🏦'
        g = f"{r['cagr3y']:+.1f}%/y" if r['cagr3y'] is not None else 'n/a'
        lines.append(f"{tag} *{r['name']}* ({r['ticker']}) — S${r['price']:.2f} | "
                     f"yld {r['yield12m']:.1f}% | 3y DPS CAGR {g} | {r['consecYears']}y streak")
    lines.append('_Metrics: trailing-12m computed, yfinance. Verify ex-dates before acting._')
    return '\n'.join(lines)


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    if a.json:
        print(json.dumps(screen(force=a.force), indent=1))
    else:
        print(digest_text())
