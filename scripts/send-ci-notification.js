#!/usr/bin/env node

/**
 * Send CI/CD Test Results to Telegram
 * Used by GitHub Actions workflow
 * Parses actual test output from CI logs
 */

const https = require('https');

// Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// GITHUB_REPOSITORY is 'owner/repo' — use it directly for URLs, strip owner for display
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || 'yeapv/finance-seer';
const REPO_NAME = GITHUB_REPOSITORY.split('/').pop() || 'finance-seer'; // display name only
const COMMIT_HASH = process.env.GITHUB_SHA || 'unknown';
const RUN_ID = process.env.GITHUB_RUN_ID || 'unknown';
const SERVER_URL = process.env.GITHUB_SERVER_URL || 'https://github.com';
const REPO_OWNER = process.env.GITHUB_REPOSITORY_OWNER || 'yeapv';

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
 * Parse real test results from CI job outputs.
 * CI captures stdout of run-all-tests.js and run-integration-tests.js
 * and passes the parsed counts as env vars.
 */
function getTestResults() {
  const unitPassed  = parseInt(process.env.UNIT_PASSED)  || 0;
  const unitTotal   = parseInt(process.env.UNIT_TOTAL)   || 0;
  const unitFailed  = parseInt(process.env.UNIT_FAILED)  || 0;
  const intPassed   = parseInt(process.env.INT_PASSED)   || 0;
  const intTotal    = parseInt(process.env.INT_TOTAL)    || 0;
  const intFailed   = parseInt(process.env.INT_FAILED)   || 0;

  const passed = unitPassed + intPassed;
  const total  = unitTotal  + intTotal;
  const failed = total - passed;

  // Parse failure details
  const unitFailures = (process.env.UNIT_FAILURES || '').trim();
  const intFailures = (process.env.INT_FAILURES || '').trim();

  return { total, passed, failed, unitPassed, unitTotal, unitFailed, intPassed, intTotal, intFailed, unitFailures, intFailures };
}

/**
 * Main function
 */
async function main() {
  try {
    const { total, passed, failed, unitPassed, unitTotal, unitFailed, intPassed, intTotal, intFailed, unitFailures, intFailures } = getTestResults();
    
    // Determine status based on test results only (deployment outcome is separate)
    const testsPassed = failed === 0;
    const deployResult = process.env.DEPLOYMENT_RESULT || null; // may be null if not set
    
    let statusEmoji, statusText, deployLine;
    
    if (testsPassed && deployResult === 'success') {
      // Tests passed AND deployment succeeded
      statusEmoji = '✅';
      statusText = 'ALL TESTS PASSED';
      deployLine = '🚀 *Deployed to production*';
    } else if (testsPassed) {
      // Tests passed but deployment unknown/failed
      statusEmoji = '⚠️';
      statusText = 'TESTS PASSED';
      deployLine = deployResult === 'failure' 
        ? '🚫 *Deployment failed*'
        : 'ℹ️ *Deployment status: pending or skipped*';
    } else {
      // Tests failed — deployment blocked
      statusEmoji = '❌';
      statusText = 'TESTS FAILED — Deployment blocked';
      deployLine = '🚫 *Deployment blocked — fix tests first*';
    }

    // Get timestamp
    const now = new Date();
    const timestamp = now.toISOString();

    // Build message
    const unitLine = unitTotal  > 0 ? `\n  • Unit:        ${unitPassed}/${unitTotal}` : '';
    const intLine  = intTotal   > 0 ? `\n  • Integration: ${intPassed}/${intTotal}` : '';
    
    // Build failure details section
    let failureDetails = '';
    if (unitFailures) {
      const unitFailList = unitFailures.split('|').map(f => f.trim()).filter(Boolean);
      if (unitFailList.length > 0) {
        failureDetails += '\n\n🔴 *Unit Test Failures:*\n';
        unitFailList.forEach((name, i) => {
          failureDetails += `  ${i + 1}. \`${name}\`\n`;
        });
      }
    }
    if (intFailures) {
      const intFailList = intFailures.split('|').map(f => f.trim()).filter(Boolean);
      if (intFailList.length > 0) {
        failureDetails += '\n\n🔴 *Integration Test Failures:*\n';
        intFailList.forEach((name, i) => {
          failureDetails += `  ${i + 1}. \`${name}\`\n`;
        });
      }
    }
    
    const message = `
🤖 *Finance Seer CI/CD Status*

📦 *Build:* ${REPO_NAME}
🔗 *Commit:* \`${COMMIT_HASH.substring(0, 7)}\`
📅 *Time:* ${timestamp}

${statusEmoji} *${statusText}*
🧪 *Tests:* ${passed}/${total} passing${failed > 0 ? ` (${failed} failed)` : ''}${unitLine}${intLine}${failureDetails}

${deployLine}
🔍 *View Logs:* ${SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${RUN_ID}
    `.trim();

    // Send to Telegram
    await sendTelegramMessage(message);
    
    console.log('✅ CI/CD notification complete');
    console.log(`📊 Test Results: ${passed}/${total} passed`);
    process.exit(0);
    
  } catch (error) {
    console.error('❌ CI/CD notification failed:', error.message);
    process.exit(1);
  }
}

// Run
main();
