#!/usr/bin/env python3
"""
Trade Approval Handler — polls Telegram for APPROVE/REJECT messages
and executes trades immediately when received.

Runs as a persistent background process.
Usage: python3 approval_handler.py
"""
import json, time, subprocess, sys, os
from datetime import datetime
from pathlib import Path

TG_TOKEN  = os.environ.get('TELEGRAM_BOT_TOKEN', '')
TG_CHAT   = '786437034'
SCRIPTS   = Path(__file__).parent
PORTFOLIO = SCRIPTS.parent / 'data' / 'portfolio.json'
KV_URL    = os.environ.get('UPSTASH_REDIS_URL', 'https://clean-eagle-92052.upstash.io')
KV_TOKEN  = os.environ.get('UPSTASH_REDIS_TOKEN', '')

import urllib.request

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def send_telegram(msg: str):
    try:
        body = json.dumps({'chat_id': TG_CHAT, 'text': msg, 'parse_mode': 'Markdown'}).encode()
        req = urllib.request.Request(
            f'https://api.telegram.org/bot{TG_TOKEN}/sendMessage',
            data=body, headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        log(f'Telegram error: {e}')

def get_updates(offset: int) -> tuple[list, int]:
    try:
        url = (f'https://api.telegram.org/bot{TG_TOKEN}/getUpdates'
               f'?offset={offset}&timeout=30&limit=10'
               f'&allowed_updates=["message","callback_query"]')
        resp = json.loads(urllib.request.urlopen(url, timeout=35).read())
        updates = resp.get('result', [])
        new_offset = updates[-1]['update_id'] + 1 if updates else offset
        return updates, new_offset
    except Exception as e:
        log(f'Poll error: {e}')
        return [], offset

def kv_set(data):
    req = urllib.request.Request(f'{KV_URL}/set/portfolio',
        data=json.dumps(data).encode(),
        headers={'Authorization': f'Bearer {KV_TOKEN}', 'Content-Type': 'application/json'},
        method='POST')
    urllib.request.urlopen(req, timeout=10)

def execute_trade(action: str, ticker: str):
    """Find pending trade details from portfolio and execute."""
    import os
    if os.environ.get('FINSEER_EXECUTION', 'disabled') != 'enabled':
        log('Execution disabled (FINSEER_EXECUTION!=enabled) - advisory mode; trade NOT placed')
        return
    try:
        with open(PORTFOLIO) as f:
            p = json.load(f)
    except:
        send_telegram(f'⚠️ Could not read portfolio for {action} {ticker}')
        return

    pending = p.get('pendingTrades', {})
    trade_key = f'{action}_{ticker}'
    trade = next((v for k, v in pending.items() if trade_key in k and v.get('status') == 'pending'), None)

    if not trade:
        send_telegram(f'⚠️ No pending trade found for {action} {ticker}')
        return

    price  = trade.get('price', 0)
    shares = trade.get('shares', 0)
    sl     = trade.get('sl', round(price * 0.92, 2))
    tp     = trade.get('tp', round(price * 1.15, 2))
    reason = trade.get('reason', '')

    if not price or not shares:
        send_telegram(f'⚠️ Missing price/shares for {action} {ticker}')
        return

    send_telegram(f'⏳ Executing {action} {shares}x *{ticker}* @ ${price:.2f}...')

    # Execute via IBKR
    result = subprocess.run(
        [sys.executable, str(SCRIPTS / 'ibkr_execute.py'), action, ticker, str(shares), str(price)],
        capture_output=True, text=True, timeout=60
    )
    try:
        ibkr = json.loads(result.stdout)
    except:
        send_telegram(f'⚠️ IBKR error: {result.stderr or result.stdout}')
        return

    if ibkr.get('error'):
        send_telegram(f'⚠️ IBKR error: {ibkr["error"]}')
        return

    filled     = ibkr.get('filled', 0)
    avg_fill   = ibkr.get('avgFillPrice', price)
    commission = ibkr.get('commission', 0)

    if filled == 0:
        send_telegram(f'⚠️ Order placed but not yet filled. Order ID: {ibkr.get("orderId")}')
        # Mark as submitted
        for k, v in pending.items():
            if trade_key in k:
                p['pendingTrades'][k]['status'] = 'submitted'
                p['pendingTrades'][k]['orderId'] = ibkr.get('orderId')
        with open(PORTFOLIO, 'w') as f:
            json.dump(p, f, indent=2)
        kv_set(p)
        return

    # Record the trade
    subprocess.run(
        [sys.executable, str(SCRIPTS / 'record_trade.py'),
         action, ticker, str(int(filled)), str(price), str(avg_fill), str(commission)],
        capture_output=True, timeout=30
    )

    # Remove from pending
    for k in list(pending.keys()):
        if trade_key in k:
            del p['pendingTrades'][k]
    with open(PORTFOLIO, 'w') as f:
        json.dump(p, f, indent=2)
    kv_set(p)

    # Sync from IBKR
    subprocess.run([sys.executable, str(SCRIPTS / 'sync_from_ibkr.py')],
                   capture_output=True, timeout=60)

    emoji = '🟢' if action == 'BUY' else '🔴'
    pnl_note = ''
    if action == 'SELL':
        try:
            with open(PORTFOLIO) as f:
                p2 = json.load(f)
            closed = [c for c in p2.get('closedPositions', []) if c['ticker'] == ticker]
            if closed:
                pnl = closed[-1].get('pnl', 0)
                pnl_note = f' | P&L: {"+$" if pnl >= 0 else "-$"}{abs(pnl):.0f}'
        except: pass

    send_telegram(
        f'{emoji} *Executed: {action} {int(filled)}x {ticker}* @ ${avg_fill:.2f}\n'
        f'Commission: ${commission:.4f}{pnl_note}\n'
        f'Dashboard: finance-seer.vercel.app/portfolio'
    )
    log(f'Executed: {action} {int(filled)}x {ticker} @ ${avg_fill:.2f} | commission ${commission:.4f}')

def reject_trade(action: str, ticker: str):
    """Mark trade as rejected."""
    try:
        with open(PORTFOLIO) as f:
            p = json.load(f)
        trade_key = f'{action}_{ticker}'
        for k in list(p.get('pendingTrades', {}).keys()):
            if trade_key in k:
                p['pendingTrades'][k]['status'] = 'rejected'
        with open(PORTFOLIO, 'w') as f:
            json.dump(p, f, indent=2)
        kv_set(p)
    except: pass
    send_telegram(f'❌ Trade rejected: {action} {ticker}')
    log(f'Rejected: {action} {ticker}')

def process_update(update: dict):
    """Parse update for APPROVE/REJECT commands."""
    # Handle inline button callbacks
    cb = update.get('callback_query', {})
    msg = update.get('message', {})
    text = cb.get('data', '') or msg.get('text', '')

    if not text:
        return

    text = text.upper().strip()

    if text.startswith('APPROVE_'):
        parts = text.split('_', 2)  # APPROVE_BUY_TICKER or APPROVE_SELL_TICKER
        if len(parts) == 3:
            _, action, ticker = parts
            log(f'APPROVE received: {action} {ticker}')
            execute_trade(action, ticker)

    elif text.startswith('REJECT_'):
        parts = text.split('_', 2)
        if len(parts) == 3:
            _, action, ticker = parts
            log(f'REJECT received: {action} {ticker}')
            reject_trade(action, ticker)

def main():
    log('Approval handler started — polling Telegram...')
    offset = 0

    # Get current offset to ignore old messages
    try:
        url = f'https://api.telegram.org/bot{TG_TOKEN}/getUpdates?limit=1&offset=-1'
        resp = json.loads(urllib.request.urlopen(url, timeout=10).read())
        results = resp.get('result', [])
        if results:
            offset = results[-1]['update_id'] + 1
    except:
        pass

    log(f'Starting from update offset {offset}')

    while True:
        updates, offset = get_updates(offset)
        for update in updates:
            try:
                process_update(update)
            except Exception as e:
                log(f'Error processing update: {e}')
        # Short sleep between polls (long polling handles the wait)
        time.sleep(0.5)

if __name__ == '__main__':
    main()
