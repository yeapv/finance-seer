#!/usr/bin/env node

/**
 * Send CI/CD Test Results to Telegram
 * Used by GitHub Actions workflow
 */

const { execSync } = require('child_process');
const https = require('https');

// Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8609316971:AAFhvA7fOyXRx5ch5Mm740ajcjMRD5brIr4';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '786437034';
const REPO_NAME = process.env.GITHUB_REPOSITORY || 'finance-seer';
const COMMIT_HASH = process.env.GITHUB_SHA || 'unknown';
const RUN_ID = process.env.GITHUB_RUN_ID || 'unknown';
const SERVER_URL = process.env.GITHUB_SERVER_URL || 'https://github.com';
const REPO_OWNER = process.env.GITHUB_REPOSITORY_OWNER || 'yeapvin';

/**
 * Send message to Telegram
 */
function sendTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      chat_id: CHAT_ID,
      text: text,
      parse_mode: 'Markdown'
    });

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => responseData += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✅ Telegram message sent successfully');
          resolve(JSON.parse(responseData));
        } else {
          console.error(`❌ Telegram API error: ${res.statusCode}`);
          reject(new Error(`Telegram API error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (error) => {
      console.error('❌ Request failed:', error.message);
      reject(error);
    });

    req.write(data);
    req.end();
  });
}

/**
 * Main function
 */
async function main() {
  try {
    // Get test results
    const deploymentResult = process.env.DEPLOYMENT_RESULT || 'success';
    const testCount = parseInt(process.env.TEST_COUNT || '141');
    const passedCount = parseInt(process.env.TESTS_PASSED || '0');
    const failedCount = parseInt(process.env.TESTS_FAILED || '0');
    
    // Determine status
    const isPassing = deploymentResult === 'success';
    const statusEmoji = isPassing ? '✅' : '❌';
    const statusText = isPassing ? '**ALL TESTS PASSED**' : '**TESTS FAILED - Review needed**';
    const warning = !isPassing ? '\n⚠️ *Deployment blocked due to test failures*' : '';
    
    // Get timestamp
    const now = new Date();
    const timestamp = now.toISOString();
    
    // Build message
    const message = `
🤖 *Finance Seer CI/CD Status*

📦 *Build:* ${REPO_NAME}
🔗 *Commit:* ${COMMIT_HASH}
📅 *Time:* ${timestamp}

${statusEmoji} *${statusText}*
🧪 *Tests:* ${passedCount}/${testCount} passing${failedCount > 0 ? ` (${failedCount} failed)` : ''}

🔍 *View Results:* ${SERVER_URL}/${REPO_OWNER}/${REPO_NAME}/actions/runs/${RUN_ID}

${warning}
    `.trim();

    // Send to Telegram
    await sendTelegramMessage(message);
    
    console.log('✅ CI/CD notification complete');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ CI/CD notification failed:', error.message);
    process.exit(1);
  }
}

// Run
main();
