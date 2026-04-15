#!/usr/bin/env python3
"""
Sync Finance Seer portfolio.json from IBKR paper account.
IBKR is the single source of truth — positions are WIPED and rebuilt entirely.
Run this to pull actual positions + cash from IBKR and overwrite portfolio.json.

Usage: python3 sync_from_ibkr.py
"""
import json, sys, os, subprocess
import time, math
from datetime import datetime
from pathlib import Path
from ib_insync import IB, Stock

HOST = '172.23.160.1'
PORT = 4002
ACCOUNT = 'DU7992310'
PORTFOLIO_PATH = Path(__file__).parent.parent / 'data' / 'portfolio.json'
KV_URL   = 'https://clean-eagle-92052.upstash.io'
KV_TOKEN = 'gQAAAAAAAWeUAAIncDFiZmRiYzc1NDY1YjI0NjU3YTYwMzc4Y2Y4ZTIxZWUzNHAxOTIwNTI'
SGD_USD_FALLBACK = 0.7854

CLIENT_ID = 4  # fixed clientId for sync


def get_sgd_usd() -> float:
    """Get live SGD/USD rate via exchange-rates skill (XE.com)"""
    try:
        result = subprocess.run(
            ['node', '/home/joobi/.openclaw/workspace/skills/exchange-rates/scripts/xe-rate.mjs', 'SGD', 'USD'],
            capture_output=True, text=True, timeout=15
        )
        data = json.loads(result.stdout)
        rate = float(data.get('rate', 0))
        if rate > 0:
            return rate
    except Exception:
        pass
    return SGD_USD_FALLBACK


def sanitize(obj):
    """Replace NaN/Inf with None recursively."""
    if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
        return None
    if isinstance(obj, dict):
        return {k: sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize(v) for v in obj]
    return obj


def atomic_write(path: Path, data: dict):
    """Write JSON atomically via temp file + rename."""
    tmp = path.with_suffix('.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def push_kv(data: dict):
    import urllib.request as ur
    req = ur.Request(
        f'{KV_URL}/set/portfolio',
        data=json.dumps(data).encode(),
        headers={'Authorization': f'Bearer {KV_TOKEN}', 'Content-Type': 'application/json'},
        method='POST'
    )
    ur.urlopen(req, timeout=10)


# push_git removed — KV (Upstash) is the single source of truth for Vercel.
# Git commits for portfolio data polluted history and triggered unnecessary Vercel rebuilds.
# Heartbeat calls /api/portfolio/sync or runs this script directly; Vercel reads from KV.


def main():
    ib = IB()
    for attempt in range(1, 4):
        try:
            ib.connect(HOST, PORT, clientId=CLIENT_ID, timeout=30)
            break
        except Exception as e:
            if attempt < 3:
                time.sleep(10)
            else:
                print(json.dumps({'error': f'Connection failed after 3 attempts: {e}'}))
                sys.exit(1)

    try:
        # ── Account summary ───────────────────────────────────────────────────
        summary_raw = ib.accountSummary(ACCOUNT)
        # Collect tags — this paper account reports in SGD, so handle USD > SGD > BASE
        summary_usd  = {}
        summary_sgd  = {}
        summary_base = {}
        for s in summary_raw:
            if s.tag in ('NetLiquidation', 'TotalCashValue', 'UnrealizedPnL', 'RealizedPnL'):
                try:
                    val = float(s.value)
                except (ValueError, TypeError):
                    continue
                if s.currency == 'USD':
                    summary_usd[s.tag] = val
                elif s.currency == 'SGD':
                    summary_sgd[s.tag] = val
                elif s.currency == 'BASE':
                    summary_base[s.tag] = val

        rate = get_sgd_usd()

        def get_usd(tag):
            """Return tag value in USD (prefer USD native, then SGD*rate, then BASE*rate)."""
            if tag in summary_usd:
                return summary_usd[tag]
            if tag in summary_sgd:
                return round(summary_sgd[tag] * rate, 2)
            if tag in summary_base:
                return round(summary_base[tag] * rate, 2)
            return 0.0

        nlv_usd  = get_usd('NetLiquidation')
        cash_usd = get_usd('TotalCashValue')

        # ── Positions — FULL REPLACE ──────────────────────────────────────────
        ibkr_positions = ib.positions(ACCOUNT)
        positions = []
        for pos in ibkr_positions:
            if pos.position == 0:
                continue
            ticker   = pos.contract.symbol
            shares   = int(pos.position)
            avg_cost = round(pos.avgCost, 4)

            # Get current price from live market data
            try:
                contract = Stock(ticker, 'SMART', 'USD')
                ib.qualifyContracts(contract)
                mkt = ib.reqMktData(contract, '', False, False)
                ib.sleep(1.5)
                # Explicitly filter out NaN/Inf — IBKR uses NaN for missing data
                def _clean(v):
                    try:
                        f = float(v)
                        return f if math.isfinite(f) and f > 0 else None
                    except (TypeError, ValueError):
                        return None
                current_price = _clean(mkt.last) or _clean(mkt.close) or avg_cost
                current_price = round(float(current_price), 4)
                ib.cancelMktData(contract)
            except Exception:
                current_price = avg_cost

            unrealized_pnl = round((current_price - avg_cost) * shares, 2)

            # Default SL/TP based on avg cost — monitor.py does not override these
            stop_loss   = round(avg_cost * 0.95, 2)
            take_profit = round(avg_cost * 1.10, 2)

            positions.append({
                'ticker':       ticker,
                'shares':       shares,
                'avgCost':      avg_cost,
                'buyPrice':     avg_cost,
                'currentPrice': current_price,
                'buyDate':      datetime.now().strftime('%Y-%m-%d'),
                'signal':       'HOLD',
                'currency':     'USD',
                'reason':       f'IBKR position @ ${avg_cost:.2f}',
                'stopLoss':     stop_loss,
                'takeProfit':   take_profit,
                'unrealizedPnL': unrealized_pnl,
                'ibkrOrderId':  None,
            })

        # ── Open orders ───────────────────────────────────────────────────────
        ib.reqAllOpenOrders()
        ib.sleep(2)
        # Load existing portfolio to carry over reasons from pendingTrades
        try:
            with open(PORTFOLIO_PATH) as _pf:
                _existing = json.load(_pf)
        except Exception:
            _existing = {}
        # Build reason map from pendingTrades: orderId -> reason
        reason_map = {}
        for pt in _existing.get('pendingTrades', {}).values():
            oid = pt.get('ibkrOrderId')
            if oid and pt.get('reason'):
                reason_map[int(oid)] = pt['reason']

        open_orders = []
        for t in ib.trades():
            if t.orderStatus.status in ('PreSubmitted', 'Submitted', 'ApiPending'):
                lmt = t.order.lmtPrice
                open_orders.append({
                    'orderId':   t.order.orderId,
                    'ticker':    t.contract.symbol,
                    'action':    t.order.action,
                    'quantity':  int(t.order.totalQuantity),
                    'orderType': t.order.orderType,
                    'tif':       t.order.tif,
                    'lmtPrice':  round(lmt, 2) if lmt and lmt > 0 else None,
                    'status':    t.orderStatus.status,
                    'filled':    t.orderStatus.filled,
                    'reason':    reason_map.get(t.order.orderId, ''),
                })

        # ── Load existing portfolio to preserve non-position data ─────────────
        try:
            with open(PORTFOLIO_PATH) as f:
                portfolio = json.load(f)
        except Exception:
            portfolio = {}

        today = datetime.now().strftime('%Y-%m-%d')

        # WIPE positions — rebuild entirely from IBKR
        portfolio['positions']  = positions
        portfolio['openOrders'] = open_orders

        # Update cash from IBKR (USD)
        cbv = portfolio.get('cashByValue', {})
        cbv['USD'] = cash_usd
        portfolio['cashByValue'] = cbv

        # Compute total value: cash + market value of positions
        market_value = sum(
            (p.get('currentPrice') or p.get('avgCost') or 0) * p['shares']
            for p in positions
        )
        portfolio['totalValue'] = round(cash_usd + market_value, 2)

        # Update NLV metadata
        nlv_sgd = summary_sgd.get('NetLiquidation', summary_usd.get('NetLiquidation', 0))
        portfolio['ibkrNLV'] = {
            'sgd': round(nlv_sgd, 2),
            'usd': nlv_usd,
            'rate': rate,
            'syncedAt': datetime.utcnow().isoformat() + 'Z'
        }

        # Update starting capital only if not already set
        portfolio.setdefault('startingCapital', nlv_usd)

        # Update value history (one entry per day)
        history = portfolio.get('valueHistory', [])
        if not history or history[-1]['date'] != today:
            history.append({'date': today, 'value': nlv_usd})
        else:
            history[-1]['value'] = nlv_usd
        portfolio['valueHistory'] = history

        # Ensure required keys exist (never wiped)
        portfolio.setdefault('pendingTrades', {})
        portfolio.setdefault('tradeHistory', [])

        # Sanitize NaN/Inf
        portfolio = sanitize(portfolio)

        # ── Atomic write ──────────────────────────────────────────────────────
        atomic_write(PORTFOLIO_PATH, portfolio)

        # ── Push to KV ───────────────────────────────────────────────────────
        try:
            push_kv(portfolio)
        except Exception as kv_err:
            print(f'KV sync warning: {kv_err}', file=sys.stderr)

        # ── Summary output ────────────────────────────────────────────────────
        print(json.dumps({
            'synced': True,
            'positions': len(positions),
            'tickers': [p['ticker'] for p in positions],
            'cash_usd': cash_usd,
            'nlv_usd': nlv_usd,
            'total_value': portfolio['totalValue'],
            'syncedAt': portfolio['ibkrNLV']['syncedAt'],
        }))

    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)
    finally:
        try:
            ib.disconnect()
        except Exception:
            pass


if __name__ == '__main__':
    main()
