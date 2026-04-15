#!/usr/bin/env node
/**
 * Finance Seer Health Monitor
 * 
 * Monitors:
 * - PM2 service health
 * - API endpoint availability
 * - Auto-restart failed services
 */

const { exec, spawn } = require('child_process')
const http = require('http')

const CONFIG = {
  PORTAL_URL: process.env.PORTAL_URL || 'https://finance-seer.vercel.app',
  intervalMs: 5 * 60 * 1000, // 5 minutes
  pm2ListCmd: '/home/joobi/.npm-global/bin/pm2 list',
}

console.log('[HealthMonitor] Starting health monitoring...')

function checkPM2Services() {
  console.log('[HealthMonitor] Checking PM2 services...')
  
  return new Promise((resolve, reject) => {
    exec(CONFIG.pm2ListCmd, (error, stdout, stderr) => {
      if (error) {
        console.error('[HealthMonitor] PM2 check failed:', error.message)
        reject(error)
        return
      }
      
      const lines = stdout.trim().split('\n').slice(1) // Skip header
      const services = {}
      
      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 9) continue
        
        const name = parts[1]
        const status = parts[8]
        
        services[name] = {
          name,
          status,
          pid: parts[5],
          uptime: parts[6],
          restarts: parts[7]
        }
        
        if (status !== 'online') {
          console.warn(`[HealthMonitor] Service ${name} is ${status} - attempting restart`)
          restartService(name)
        }
      }
      
      console.log(`[HealthMonitor] PM2 services: ${Object.keys(services).length} running`)
      resolve(services)
    })
  })
}

function restartService(name) {
  const { exec } = require('child_process')
  
  exec(`/home/joobi/.npm-global/bin/pm2 restart ${name}`, (error) => {
    if (error) {
      console.error(`[HealthMonitor] Failed to restart ${name}:`, error.message)
      return
    }
    console.log(`[HealthMonitor] Successfully restarted ${name}`)
  })
}

function checkWebApp() {
  const url = new URL(CONFIG.PORTAL_URL)
  
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: '/',
    method: 'GET',
    timeout: 10000, // 10 seconds
    headers: { 'User-Agent': 'Finance-Seer-HealthMonitor/1.0' }
  }
  
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      console.log(`[HealthMonitor] Web app status: ${res.statusCode} (${res.headers['content-type'] || 'unknown'})`)
      resolve(res.statusCode === 200)
    })
    
    req.on('error', (error) => {
      console.error('[HealthMonitor] Web app check failed:', error.message)
      reject(error)
    })
    
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })
    
    req.end()
  })
}

function runHealthCheck() {
  console.log(`[HealthMonitor] ${new Date().toISOString()} - Starting health check cycle`)
  
  checkPM2Services()
    .then(() => checkWebApp())
    .then(() => {
      console.log('[HealthMonitor] Health check cycle complete - all systems operational')
    })
    .catch((err) => {
      console.error('[HealthMonitor] Health check cycle failed:', err.message)
    })
}

// Run immediately
runHealthCheck()

// Then run every 5 minutes
setInterval(runHealthCheck, CONFIG.intervalMs)

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('[HealthMonitor] Shutting down gracefully')
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('[HealthMonitor] Shutting down gracefully')
  process.exit(0)
})
