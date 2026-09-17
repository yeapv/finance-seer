#!/usr/bin/env python3
"""
Signal performance ledger for Finance Seer.

Records every screener signal (executed or skipped), links executed ones to
trade outcomes, and resolves forward returns at 1/5/20 trading days after the
signal — giving per-setup and per-confidence win-rate evidence.

Storage: data/performance_ledger.json (single JSON file; atomic rewrite).
Price source for resolution: yfinance daily closes (local .SI supported).

Usage:
  python3 performance_ledger.py log   --ticker AAPL --side BUY --price 250.00 \
      --confidence HIGH --setup "Uptrend pullback" --rsi 38.5 --rr 2.4 \
      [--executed] [--shares 10] [--sl 240] [--tp 265] [--reason "..."]
  python3 performance_ledger.py link  --signal-id ID --trade-id TID
  python3 performance_ledger.py resolve            # fill due horizons for open signals
  python3 performance_ledger.py report [--days 90] # win-rate summary
"""
import argparse, json, os, sys, tempfile, urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

LEDGER_PATH = Path(__file__).resolve().parent.parent / 'data' / 'performance_ledger.json'
HORIZONS = [1, 5, 20]           # trading days after signal
CLOSE_AGE_DAYS = 35             # archive signals once all horizons resolvable or this old


def _now():
    return datetime.now(timezone.utc)


def load() -> dict:
    if LEDGER_PATH.exists():
        with open(LEDGER_PATH) as f:
            return json.load(f)
    return {'signals': {}, 'updatedAt': None}


def save(data: dict):
    data['updatedAt'] = _now().isoformat()
    # atomic replace
    fd, tmp = tempfile.mkstemp(dir=str(LEDGER_PATH.parent), suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, LEDGER_PATH)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _signal_id(ticker: str, side: str) -> str:
    return f"{ticker}_{side}_{int(_now().timestamp())}"


def cmd_log(args):
    data = load()
    today = _now().strftime('%Y-%m-%d')
    # same-day dedupe (monitor loops every 10 min)
    for s in data['signals'].values():
        if (s['ticker'] == args.ticker.upper() and s['side'] == args.side.upper()
                and s['signalDate'] == today):
            return None
    sid = _signal_id(args.ticker, args.side)
    data['signals'][sid] = {
        'ticker': args.ticker.upper(), 'side': args.side.upper(),
        'price': float(args.price), 'signalDate': _now().strftime('%Y-%m-%d'),
        'confidence': args.confidence or 'N/A', 'setup': args.setup or 'N/A',
        'rsi': args.rsi, 'rr': args.rr,
        'executed': bool(args.executed), 'shares': args.shares or 0,
        'sl': args.sl, 'tp': args.tp, 'reason': (args.reason or '')[:200],
        'tradeId': None,
        'fwd': {str(h): None for h in HORIZONS},   # pct return at horizon
        'closed': False, 'closedPnl': None,
    }
    save(data)
    return sid


def cmd_link(args):
    data = load()
    sig = data['signals'].get(args.signal_id)
    if not sig:
        print(f'unknown signal {args.signal_id}', file=sys.stderr); sys.exit(1)
    sig['tradeId'] = args.trade_id
    sig['executed'] = True
    save(data)


def _hist_closes(ticker: str):
    """Daily closes as {date_str: close}. Cached per process call."""
    import yfinance as yf
    df = yf.Ticker(ticker).history(period='3mo', interval='1d', auto_adjust=True)
    if df.empty:
        return {}
    return {d.strftime('%Y-%m-%d'): float(c) for d, c in zip(df.index, df['Close'])}


def cmd_resolve(args):
    data = load()
    hist_cache = {}
    changed = 0
    for sid, s in data['signals'].items():
        if all(v is not None for v in s['fwd'].values()):
            continue
        if s['ticker'] not in hist_cache:
            try:
                hist_cache[s['ticker']] = _hist_closes(s['ticker'])
            except Exception:
                hist_cache[s['ticker']] = {}
        hist = hist_cache[s['ticker']]
        if not hist:
            continue
        dates = sorted(hist)
        base_i = next((i for i, d in enumerate(dates) if d >= s['signalDate']), None)
        if base_i is None:
            continue
        base = hist[dates[base_i]]
        for h in HORIZONS:
            key = str(h)
            if s['fwd'][key] is not None:
                continue
            idx = base_i + h
            if idx < len(dates):
                s['fwd'][key] = round((hist[dates[idx]] / base - 1) * 100, 2)
                changed += 1
        # closed trades carry realized pnl
        if changed:
            pass
    # prune ancient
    cutoff = (_now() - timedelta(days=CLOSE_AGE_DAYS)).strftime('%Y-%m-%d')
    for sid in [k for k, v in data['signals'].items()
                if v['signalDate'] < cutoff
                and all(x is not None for x in v['fwd'].values())]:
        del data['signals'][sid]
        changed += 1
    save(data)
    print(f'resolved/pruned {changed} values; {len(data["signals"])} signals tracked')


def cmd_report(args):
    data = load()
    cutoff = (_now() - timedelta(days=args.days)).strftime('%Y-%m-%d')
    sigs = [s for s in data['signals'].values() if s['signalDate'] >= cutoff]
    if not sigs:
        msg = 'No signals in window — ledger is empty or fresh. It fills as monitor.py proposes.'
        print(msg)
        if getattr(args, 'telegram', False):
            _telegram_send(msg)
        return
    groups = {}
    for s in sigs:
        groups.setdefault(s['setup'], []).append(s)
        groups.setdefault('ALL', []).append(s)

    lines = [f'📊 Signal performance, last {args.days}d ({len(sigs)} signals)']
    for gname in ['ALL'] + [g for g in sorted(groups) if g != 'ALL']:
        grp = groups.get(gname)
        if not grp or gname != 'ALL' and len(grp) < 2:
            continue
        n_exec = sum(1 for s in grp if s['executed'])
        parts = []
        for h in HORIZONS:
            vals = [s['fwd'][str(h)] for s in grp if s['fwd'][str(h)] is not None]
            if vals:
                sign = 1 if grp[0]['side'] == 'BUY' else -1
                wins = sum(1 for v in vals if v * sign > 0)
                avg = sum(vals) / len(vals)
                parts.append(f'{h}d: {100*wins//len(vals)}% win, {avg:+.1f}% avg (n={len(vals)})')
        if parts:
            lines.append(f'  {gname} ({n_exec} executed): ' + ' | '.join(parts))
    report = '\n'.join(lines)
    print(report)
    if getattr(args, 'telegram', False):
        _telegram_send(report)


def _telegram_send(text: str):
    token = os.environ.get('TELEGRAM_BOT_TOKEN', '')
    chat  = os.environ.get('TELEGRAM_CHAT_ID', '')
    if not token or not chat:
        print('telegram: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — skipped', file=sys.stderr)
        return
    body = json.dumps({'chat_id': chat, 'text': text}).encode()
    req = urllib.request.Request(
        f'https://api.telegram.org/bot{token}/sendMessage',
        data=body, headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req, timeout=15)
    except Exception as e:
        print(f'telegram send failed: {e}', file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('log')
    p.add_argument('--ticker', required=True); p.add_argument('--side', required=True)
    p.add_argument('--price', required=True, type=float)
    p.add_argument('--confidence'); p.add_argument('--setup')
    p.add_argument('--rsi', type=float, default=None); p.add_argument('--rr', type=float, default=None)
    p.add_argument('--executed', action='store_true')
    p.add_argument('--shares', type=int, default=0)
    p.add_argument('--sl', type=float); p.add_argument('--tp', type=float)
    p.add_argument('--reason', default='')
    p.set_defaults(fn=cmd_log)
    p = sub.add_parser('link')
    p.add_argument('--signal-id', required=True); p.add_argument('--trade-id', required=True)
    p.set_defaults(fn=cmd_link)
    p = sub.add_parser('resolve'); p.set_defaults(fn=cmd_resolve)
    p = sub.add_parser('report'); p.add_argument('--days', type=int, default=90)
    p.add_argument('--telegram', action='store_true')
    p.set_defaults(fn=cmd_report)
    args = ap.parse_args()
    result = args.fn(args)
    if args.cmd == 'log':
        print(result)


if __name__ == '__main__':
    main()
