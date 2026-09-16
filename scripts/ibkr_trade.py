#!/usr/bin/env python3
"""
IBKR Trade Executor — limit orders only, auto-cancel after 30 min if unfilled.
Usage:
  python3 ibkr_trade.py BUY AAPL 10 250.00    # limit order at $250
  python3 ibkr_trade.py SELL AAPL 10 255.00   # limit order at $255
  python3 ibkr_trade.py CANCEL 12             # cancel order by ID
  python3 ibkr_trade.py STATUS
  python3 ibkr_trade.py POSITIONS
Returns JSON.
"""
import os, sys, json, time, threading
from ib_insync import IB, Stock, LimitOrder

HOST    = os.environ.get('IBKR_HOST', 'host.docker.internal')
PORT    = int(os.environ.get('IBKR_PORT', '4002'))
ACCOUNT = 'DU7992310'
LIMIT_TIMEOUT_MINS = 30  # Auto-cancel after 30 minutes if unfilled

def connect(client_id=15):
    ib = IB()
    ib.connect(HOST, PORT, clientId=client_id, timeout=15)
    return ib

def auto_cancel(order_id: int, delay_secs: int):
    """Cancel order after delay if still open — runs in background thread."""
    time.sleep(delay_secs)
    try:
        ib = connect(client_id=16)
        open_orders = ib.openOrders()
        for o in open_orders:
            if o.orderId == order_id:
                ib.cancelOrder(o)
                ib.sleep(1)
                # Send Telegram alert
                import urllib.request
                TG_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
                TG_CHAT  = '786437034'
                msg = f'⏰ Order #{order_id} cancelled — not filled within {LIMIT_TIMEOUT_MINS} minutes.'
                body = json.dumps({'chat_id': TG_CHAT, 'text': msg}).encode()
                req = urllib.request.Request(
                    f'https://api.telegram.org/bot{TG_TOKEN}/sendMessage',
                    data=body, headers={'Content-Type': 'application/json'})
                urllib.request.urlopen(req, timeout=10)
        ib.disconnect()
    except:
        pass

def main():
    cmd = sys.argv[1].upper() if len(sys.argv) > 1 else 'STATUS'

    try:
        ib = connect()
    except Exception as e:
        print(json.dumps({'error': f'Connection failed: {e}'}))
        sys.exit(1)

    try:
        if cmd == 'STATUS':
            summary = {s.tag: s.value for s in ib.accountSummary(ACCOUNT)}
            print(json.dumps({
                'account': ACCOUNT,
                'nlv':  summary.get('NetLiquidation'),
                'cash': summary.get('TotalCashValue'),
                'currency': 'SGD'
            }))

        elif cmd == 'POSITIONS':
            positions = [{'ticker': p.contract.symbol, 'shares': p.position, 'avgCost': p.avgCost}
                         for p in ib.positions(ACCOUNT)]
            print(json.dumps(positions))

        elif cmd == 'CANCEL':
            if len(sys.argv) < 3:
                print(json.dumps({'error': 'Usage: ibkr_trade.py CANCEL ORDER_ID'}))
                sys.exit(1)
            order_id = int(sys.argv[2])
            open_orders = ib.openOrders()
            cancelled = False
            for o in open_orders:
                if o.orderId == order_id:
                    ib.cancelOrder(o)
                    ib.sleep(1)
                    cancelled = True
            print(json.dumps({'cancelled': cancelled, 'orderId': order_id}))

        elif cmd in ('BUY', 'SELL'):
            if len(sys.argv) < 5:
                print(json.dumps({'error': 'Usage: ibkr_trade.py BUY/SELL TICKER SHARES PRICE (limit price required)'}))
                sys.exit(1)

            ticker = sys.argv[2].upper()
            shares = int(sys.argv[3])
            price  = round(float(sys.argv[4]), 2)

            contract = Stock(ticker, 'SMART', 'USD')
            ib.qualifyContracts(contract)

            # Always limit order, DAY TIF
            order = LimitOrder(cmd, shares, price, account=ACCOUNT, tif='DAY')
            trade = ib.placeOrder(contract, order)
            ib.sleep(3)

            order_id = trade.order.orderId
            status   = trade.orderStatus.status
            filled   = trade.orderStatus.filled
            avg_fill = trade.orderStatus.avgFillPrice

            result = {
                'success':      True,
                'orderId':      order_id,
                'ticker':       ticker,
                'action':       cmd,
                'shares':       shares,
                'limitPrice':   price,
                'orderType':    'LMT',
                'status':       status,
                'filled':       filled,
                'avgFillPrice': avg_fill,
                'autoCancel':   f'{LIMIT_TIMEOUT_MINS} min',
            }
            print(json.dumps(result))

            # Schedule auto-cancel in background if not immediately filled
            if filled < shares:
                t = threading.Thread(
                    target=auto_cancel,
                    args=(order_id, LIMIT_TIMEOUT_MINS * 60),
                    daemon=True
                )
                t.start()
                t.join(timeout=1)  # Let it kick off then exit

        else:
            print(json.dumps({'error': f'Unknown command: {cmd}'}))

    except Exception as e:
        print(json.dumps({'error': str(e)}))
    finally:
        ib.disconnect()

if __name__ == '__main__':
    main()
