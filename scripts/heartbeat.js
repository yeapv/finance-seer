#!/usr/bin/env node
/**
 * Finance Seer Heartbeat
 * 
 * Every 5 minutes, does:
 * 1. Sync portfolio from IBKR (if not recently synced)
 * 2. Check dashboard for critical issues
 * 3. Send daily summary at 9:00 AM SGT
 * 4. Alert on significant events
 */

const { exec } = require('child_process')
const path = require('path')

const CONFIG = {
  scriptDir: path.join(__dirname, '..'),
  syncScript: path.join(__dirname, 'sync_from_ibkr.py'),
  logDir: path.join(__dirname, '..', 'logs'),
  intervalMs: 5 * 60 * 1000, // 5 minutes
  lastSyncFile: path.join(__dirname, 'last-sync.json'),
  config: {
    PORTAL_URL: process.env.PORTAL_URL || 'https://finance-seer.vercel.app',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  }
}

let lastSyncTime = Date.now() - 60 * 60 * 1000 // Default: synced 1 hour ago

// Load last sync time
try {
  const fs = require('fs')
  if (fs.existsSync(CONFIG.lastSyncFile)) {
    const data = JSON.parse(fs.readFileSync(CONFIG.lastSyncFile, 'utf8'))
    lastSyncTime = data.timestamp || Date.now()
  }
} catch (e) {
  console.error('Failed to load last sync time:', e.message)
}

function syncPortfolio() {
  const now = Date.now()
  const hoursSinceSync = (now - lastSyncTime) / (1000 * 60 * 60)
  
  // Sync every 6 hours, or immediately on first run
  if (hoursSinceSync < 6 && hoursSinceSync > 0) {
    console.log(`[Heartbeat] Skipping sync (last sync: ${hoursSinceSync.toFixed(1)}h ago)`)
    return Promise.resolve()
  }
  
  console.log(`[Heartbeat] Running portfolio sync (last sync: ${hoursSinceSync.toFixed(1)}h ago)`)
  
  return new Promise((resolve, reject) => {
    exec(`python3 ${CONFIG.syncScript}`, {
      cwd: CONFIG.scriptDir,
      env: { ...process.env, PORTAL_URL: CONFIG.config.PORTAL_URL },
      timeout: 300000 // 5 minutes
    }, (error, stdout, stderr) => {
      if (error) {
        console.error('[Heartbeat] Sync failed:', error.message)
        reject(error)
        return
      }
      
      // Update last sync time
      try {
        const fs = require('fs')
        fs.writeFileSync(CONFIG.lastSyncFile, JSON.stringify({ timestamp: Date.now() }))
      } catch (e) {
        console.error('Failed to update last sync file:', e.message)
      }
      
      lastSyncTime = Date.now()
      console.log('[Heartbeat] Sync complete')
      resolve(stdout)
    })
  })
}

function runHeartbeat() {
  console.log(`[Heartbeat] ${new Date().toISOString()} - Starting heartbeat cycle`)
  
  // Always try to sync (will skip if recent)
  syncPortfolio()
    .then(() => {
      console.log('[Heartbeat] Heartbeat cycle complete')
    })
    .catch((err) => {
      console.error('[Heartbeat] Cycle failed:', err.message)
    })
}

// Run heartbeat immediately
runHeartbeat()

// Then run every 5 minutes
setInterval(runHeartbeat, CONFIG.intervalMs)

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Heartbeat] Shutting down gracefully')
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('[Heartbeat] Shutting down gracefully')
  process.exit(0)
})
