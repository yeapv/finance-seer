const path = require('path');
const ROOT = __dirname;
module.exports = {
  apps: [
    {
      name: 'finance-seer-heartbeat',
      script: 'node',
      args: './heartbeat.js',
      cwd: path.join(ROOT, 'scripts'),
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        PORTAL_URL: 'https://finance-seer.vercel.app',
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
      },
      error_file: path.join(ROOT, 'logs/') + '/heartbeat-error.log',
      out_file: path.join(ROOT, 'logs/') + '/heartbeat.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      time: true,
      max_memory_restart: '1G',
    },
    {
      name: 'finance-seer-monitor',
      script: 'python3',
      args: './monitor.py',
      cwd: path.join(ROOT, 'scripts'),
      env: {
        NODE_ENV: 'production',
        PORTAL_URL: 'https://finance-seer.vercel.app',
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
        PYTHONUNBUFFERED: '1',
      },
      error_file: path.join(ROOT, 'logs/') + '/monitor-error.log',
      out_file: path.join(ROOT, 'logs/') + '/monitor.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      time: true,
      max_memory_restart: '1G',
      watch: false,
    },
    {
      name: 'finance-seer-health-monitor',
      script: 'node',
      args: './health-monitor.js',
      cwd: path.join(ROOT, 'scripts'),
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        PORTAL_URL: 'https://finance-seer.vercel.app',
      },
      error_file: path.join(ROOT, 'logs/') + '/health-monitor-error.log',
      out_file: path.join(ROOT, 'logs/') + '/health-monitor.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      time: true,
      max_memory_restart: '500M',
    }
  ],
};
