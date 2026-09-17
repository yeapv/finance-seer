#!/usr/bin/env node
/**
 * Finance Seer Heartbeat — Simple supervisor for monitor.py
 * 
 * Runs every 5 minutes to:
 * - Start monitor.py at market open (21:30 SGT) if not running
 * - Stop monitor.py after EOD (04:00+ SGT)
 * - Check monitor is still alive during market hours
 */

const { exec } = require('child_process')
const fs = require('fs')
const path = require('path')

// ────────────────────────────────────────────────────────────────────────────
// CONFIG
// ────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  scriptDir: __dirname,
  monitorScript: path.join(__dirname, 'monitor.py'),
  logDir: path.join(__dirname, '..', 'logs', 'heartbeat'),
  stateFile: path.join(__dirname, 'heartbeat-state.json'),
}

// ────────────────────────────────────────────────────────────────────────────
// SGT TIME HANDLING
// ────────────────────────────────────────────────────────────────────────────
function getSGTTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' }))
}

function sgtTimeString(sgtTime) {
  const h = sgtTime.getHours()
  const m = sgtTime.getMinutes()
  return `${h}:${m.toString().padStart(2, '0')}`
}

// ────────────────────────────────────────────────────────────────────────────
// STATE MANAGEMENT (per trading day)
// ────────────────────────────────────────────────────────────────────────────
let state = { sessionDate: null }

function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      state = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'))
    }
  } catch (e) {
    console.error('[Heartbeat] Failed to load state:', e.message)
  }
}

function saveState() {
  try {
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state))
  } catch (e) {
    console.error('[Heartbeat] Failed to save state:', e.message)
  }
}

function todaySGTDateStr() {
  return getSGTTime().toISOString().split('T')[0]
}

function isNewTradingDay(sgtDateStr) {
  // Check if it's a weekday (Mon-Fri in SGT)
  const d = new Date(sgtDateStr + 'T00:00:00+08:00')
  const day = d.getUTCDay() // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false
  return state.sessionDate !== sgtDateStr
}

// ────────────────────────────────────────────────────────────────────────────
// MONITOR PROCESS SUPERVISION
// ────────────────────────────────────────────────────────────────────────────
function isMonitorRunning() {
  // Check if monitor.py process exists (via PID file or pgrep)
  return state.monitorPid && !state.monitorKilled
}

function startMonitor() {
  if (isMonitorRunning()) {
    console.log('[Heartbeat] Monitor already running')
    return Promise.resolve()
  }
  
  // Ensure log directory exists
  if (!fs.existsSync(CONFIG.logDir)) {
    fs.mkdirSync(CONFIG.logDir, { recursive: true })
  }
  
  const logFile = path.join(CONFIG.logDir, `monitor-${todaySGTDateStr()}.log`)
  
  console.log('[Heartbeat] Starting monitor.py...')
  
  // Run monitor.py in background (detached). Prefer project venv (has yfinance/
  // tvscreener for the performance ledger); fall back to system python3.
  const venvPy = path.join(CONFIG.scriptDir, '..', '.venv', 'bin', 'python')
  const py = fs.existsSync(venvPy) ? venvPy : 'python3'
  const cmd = `cd ${CONFIG.scriptDir} && nohup ${py} ${CONFIG.monitorScript} > ${logFile} 2>&1 & echo $!`
  
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        console.error('[Heartbeat] Failed to start monitor:', error.message)
        state.monitorError = String(error.message)
        saveState()
        reject(error)
        return
      }
      
      const pid = stdout.trim()
      if (pid && /^\d+$/.test(pid)) {
        console.log(`[Heartbeat] Monitor started with PID ${pid}`)
        state.monitorPid = pid
        state.monitorKilled = false
        delete state.monitorError
        saveState()
        
        resolve({ pid })
      } else {
        const err = new Error('Failed to get monitor PID')
        console.error('[Heartbeat] ' + err.message)
        reject(err)
      }
    })
  })
}

function stopMonitor() {
  if (!isMonitorRunning()) return Promise.resolve()
  
  console.log(`[Heartbeat] Stopping monitor (PID: ${state.monitorPid})...`)
  
  // Kill by PID (use -9 for force)
  const cmd = `kill ${state.monitorPid} 2>/dev/null || true`
  
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      state.monitorKilled = true
      state.monitorPid = null
      saveState()
      
      if (error && !/No such process/.test(error.message)) {
        console.error('[Heartbeat] Failed to kill monitor:', error.message)
        reject(error)
        return
      }
      
      console.log('[Heartbeat] Monitor stopped')
      resolve({ success: true })
    })
  })
}

function checkMonitorHealth() {
  if (!isMonitorRunning()) {
    console.log('[Heartbeat] Monitor not running (expected during after-hours)')
    return false
  }
  
  // Check if process still exists
  const cmd = `ps -p ${state.monitorPid} > /dev/null 2>&1; echo $?`
  
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      const exitCode = parseInt(stdout.trim()) || 0
      
      if (exitCode === 0) {
        console.log(`[Heartbeat] Monitor alive (PID: ${state.monitorPid})`)
        return true
      } else {
        console.error('[Heartbeat] Monitor process dead, restarting...')
        
        // Auto-restart during market hours
        if (inMarketHours(getSGTTime())) {
          state.monitorError = 'Process died unexpectedly'
          saveState()
          startMonitor().catch(console.error)
        } else {
          // After hours — just mark as dead
          state.monitorPid = null
          saveState()
        }
        
        resolve(false)
      }
    })
  }).then(() => isMonitorRunning())
}

// ────────────────────────────────────────────────────────────────────────────
// MARKET HOURS CHECK (SGT)
// ────────────────────────────────────────────────────────────────────────────
function inMarketHours(sgtTime) {
  const hour = sgtTime.getHours()
  const minute = sgtTime.getMinutes()
  
  // NYSE: 21:30-04:00 SGT (Mon-Fri)
  if (hour === 21 && minute >= 30) return true   // 21:30-21:59
  if (hour > 21 && hour < 24) return true       // 22:00-23:59
  if (hour >= 0 && hour < 4) return true        // 00:00-03:59
  if (hour === 4 && minute < 15) return false   // After EOD
  
  return false
}

// ────────────────────────────────────────────────────────────────────────────
// TELEGRAM NOTIFICATIONS
// ────────────────────────────────────────────────────────────────────────────
function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN || ''
  const chatId = process.env.TELEGRAM_CHAT_ID || '786437034'
  
  if (!token || !chatId) {
    console.log('[Heartbeat] Telegram not configured, skipping notification')
    return Promise.resolve()
  }
  
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown'
    })
    
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    }).then(() => resolve()).catch((e) => console.error('[Heartbeat] Telegram failed:', e.message))
  })
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN HEARTBEAT CYCLE
// ────────────────────────────────────────────────────────────────────────────
async function runHeartbeatCycle() {
  const sgtTime = getSGTTime()
  const sgtDateStr = todaySGTDateStr()
  const hour = sgtTime.getHours()
  const minute = sgtTime.getMinutes()
  const timeStr = sgtTimeString(sgtTime)
  
  // Check for new trading day (Monday-Friday in SGT)
  if (isNewTradingDay(sgtDateStr)) {
    state.sessionDate = sgtDateStr
    
    // Reset daily flags
    delete state.monitorPid
    delete state.monitorKilled
    delete state.eodDone
    delete state.preMarketDone
    
    saveState()
    
    console.log(`[Heartbeat] New session started: ${sgtDateStr}`)
  }
  
  console.log(`[Heartbeat] SGT time: ${timeStr} (session: ${state.sessionDate || 'none'})`)
  
  // ─── PRE-MARKET / MARKET OPEN (21:00-21:30) ──────────────────────────────────────
  if (hour === 21 && minute >= 0 && minute < 30) {
    console.log('[Heartbeat] Pre-market phase')
    
    // At exactly 21:00, start monitor early to sync IBKR
    if (!state.preMarketDone && hour === 21 && minute < 6) {
      state.preMarketDone = true
      saveState()
      
      await sendTelegram('🌅 Pre-market — starting monitor for IBKR sync...')
      await startMonitor().catch(console.error)
    }
    
    return
  }
  
  // ─── MARKET HOURS (21:30-04:00) ─────────────────────────────────────
  if (inMarketHours(sgtTime)) {
    console.log('[Heartbeat] Market hours — monitor should be running')
    
    // Check monitor is alive, restart if needed
    await checkMonitorHealth().catch(console.error)
    
    return
  }
  
  // ─── EOD (04:00-04:15) ─────────────────────────────────────
  if (hour === 4 && minute < 16 && !state.eodDone) {
    console.log('[Heartbeat] End of day — stopping monitor')
    
    await stopMonitor().catch(console.error)
    
    state.eodDone = true
    saveState()
    
    // Send EOD summary via Telegram
    await sendEodSummary()
      .then(() => sendTelegram('🔔 Monitor stopped for the day'))
      .catch(console.error)
    
    return
  }
  
  // ─── AFTER HOURS (04:15-20:59) ──────────────────────────────────────
  console.log('[Heartbeat] After hours — idle')
}

// ────────────────────────────────────────────────────────────────────────────
// EOD SUMMARY
// ────────────────────────────────────────────────────────────────────────────
async function sendEodSummary() {
  try {
    const portfolioPath = path.join(CONFIG.scriptDir, '..', 'data', 'portfolio.json')
    if (!fs.existsSync(portfolioPath)) return
    
    const portfolio = JSON.parse(fs.readFileSync(portfolioPath, 'utf8'))
    const positions = portfolio.positions || []
    const cash = portfolio.cashByValue?.USD || 0
    const totalPositionsValue = positions.reduce((sum, p) => sum + (p.currentPrice || p.avgCost || 0) * p.shares, 0)
    const totalValue = cash + totalPositionsValue
    const startingCapital = portfolio.startingCapital || 100000
    const returnPct = ((totalValue - startingCapital) / startingCapital) * 100
    
    let msg = `📅 *EOD Summary — ${todaySGTDateStr()}*\n`
    msg += `Portfolio: $${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })} | Return: ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%\n\n`
    
    if (positions.length > 0) {
      for (const pos of positions) {
        const pnl = ((pos.currentPrice || pos.avgCost) - (pos.buyPrice || pos.avgCost)) * pos.shares
        msg += `🟢 ${pos.ticker} (${pos.shares}x) @ $${(pos.currentPrice || pos.avgCost).toFixed(2)} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}\n`
      }
      msg += `\n💵 Cash: $${cash.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n`
    } else {
      msg += `No open positions.\n💵 Cash: $${cash.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n`
    }
    
    await sendTelegram(msg)
    console.log('[Heartbeat] EOD summary sent')
  } catch (e) {
    console.error('[Heartbeat] EOD summary error:', e.message)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// INITIALIZATION & LOOP
// ────────────────────────────────────────────────────────────────────────────
function init() {
  // Ensure log directory exists
  if (!fs.existsSync(CONFIG.logDir)) {
    fs.mkdirSync(CONFIG.logDir, { recursive: true })
  }
  
  loadState()
  
  console.log('[Heartbeat] Starting Finance Seer heartbeat (SGT-aware)')
  console.log(`[Heartbeat] State file: ${CONFIG.stateFile}`)
}

// Initial run
init()
runHeartbeatCycle().catch(console.error)

// Then every 5 minutes
setInterval(() => {
  runHeartbeatCycle().catch(console.error)
}, 5 * 60 * 1000) // 5 minutes

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Heartbeat] Shutting down...')
  stopMonitor()
    .then(() => process.exit(0))
    .catch(() => process.exit(0))
})

process.on('SIGINT', () => {
  console.log('[Heartbeat] Shutting down...')
  stopMonitor()
    .then(() => process.exit(0))
    .catch(() => process.exit(0))
})
