# Finance Seer - AI-Powered Trading System

## 🚀 Overview

**Finance Seer** is an autonomous AI trading system that analyzes market data, detects technical patterns, and generates trading recommendations using local AI (GX10) with real-time market data from Finnhub.

### Key Features:
- ✅ **GX10 Local AI**: Qwen3.5:122b running on your RTX 3070 (zero API costs)
- ✅ **11 Technical Patterns**: Double top/bottom, flags, triangles, EMA crossovers
- ✅ **8 Pre-Trade Safety Filters**: Volume, volatility, EPS, debt, sentiment, RSI, P/E
- ✅ **Risk-Based Position Sizing**: 5-15% based on risk level
- ✅ **Autonomous Heartbeat**: ~30-minute analysis intervals
- ✅ **Telegram Alerts**: Real-time notifications for high-confidence trades
- ✅ **Paper Trading Ready**: IBKR integration for execution
- ✅ **Production-Ready**: PM2 process management + Docker containers

---

## 📊 System Architecture

```
Market Data (Finnhub) → Pattern Detection → AI Analysis (GX10) → Safety Filters → Order Generation
                                                                 ↓
                                                            Telegram Alerts
```

### Data Flow:
1. **Market Phase Check**: Only runs during NYSE open/midday/closing
2. **Data Collection**: Fetches real-time quotes, fundamentals, news
3. **Pattern Detection**: Identifies 11 technical patterns
4. **AI Analysis**: Qwen3.5:122b analyzes patterns + data
5. **Safety Validation**: 8 pre-trade risk filters
6. **Order Generation**: Risk-based position sizing
7. **Alerts**: Telegram notifications for EXECUTE actions

---

## 🏗️ Deployment Options

### Option 1: PM2 (Recommended for Dev/Staging)

#### Prerequisites:
```bash
npm install -g pm2
```

#### Start Services:
```bash
# Navigate to finance-seer directory
cd /home/joobi/.openclaw/workspace/finance-seer

# Run startup script
./scripts/startup.sh
```

#### Common PM2 Commands:
```bash
# View status
pm2 status

# View logs
pm2 logs finance-seer
pm2 logs finance-seer-heartbeat

# Restart all
pm2 restart all

# Stop all
pm2 stop all

# Delete all
pm2 delete all
```

#### Environment Variables:
```bash
NODE_ENV=production
FINNHUB_API_KEY="your_finnhub_api_key_here"
OPENAI_API_KEY="your_openai_api_key_here"
OPENAI_API_URL="http://192.168.10.163:11434/v1"
AI_MODEL="qwen3.5:122b"
TELEGRAM_BOT_TOKEN="your_telegram_bot_token"
TELEGRAM_CHAT_ID="your_chat_id"
```

### Option 2: Docker (Production)

#### Prerequisites:
- Docker Engine 20.10+
- Docker Compose 2.0+

#### Build & Run:
```bash
# Build all images
docker-compose build

# Start all services
docker-compose up -d

# View logs
docker-compose logs -f finance-seer
docker-compose logs -f finance-seer-heartbeat

# Stop services
docker-compose down

# Rebuild and restart
docker-compose up -d --build
```

#### Environment Variables (docker-compose.yml):
```yaml
environment:
  - NODE_ENV=production
  - FINNHUB_API_KEY=${FINNHUB_API_KEY}
  - OPENAI_API_KEY=${OPENAI_API_KEY}
  - OPENAI_API_URL=http://192.168.10.163:11434/v1
  - AI_MODEL=qwen3.5:122b
  - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
  - TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}
```

---

## 🧪 Testing

### Quick GX10 Connection Test:
```bash
node scripts/quick-test-gx10.js
```

### Complete System Test:
```bash
FINNHUB_API_KEY="d7egi31r01qi33g66ksgd7egi31r01qi33g66kt0" \
node scripts/complete-system-test.js
```

### Live Analysis Test:
```bash
node scripts/live-test.js
```

### Unit Tests:
```bash
npm test
npm run test:watch
npm run test:coverage
```

---

## 📡 GX10 Ollama Setup

### Prerequisites:
- GX10 server (192.168.10.163) with RTX 3070
- Ollama installed on GX10
- Network connectivity between host and GX10

### Install Ollama on GX10:
```bash
# SSH into GX10
ssh user@gx10-8a6a

# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull Qwen3.5:122b model (~2 hours for 122GB)
ollama pull qwen3.5:122b

# Verify installation
ollama list
ollama serve

# Confirm endpoint is accessible
curl http://localhost:11434/api/tags
```

### Network Configuration:
- **IP Address**: 192.168.10.163
- **Port**: 11434
- **Endpoint**: http://192.168.10.163:11434/v1
- **Hostname**: gx10-8a6a (if DNS/hosts configured)

### Test Connectivity:
```bash
# Test network
ping 192.168.10.163

# Test Ollama endpoint
curl http://192.168.10.163:11434/api/tags

# Check if Qwen3.5:122b is loaded
ollama list
```

---

## 🔐 Security & Best Practices

### API Keys:
- **Finnhub**: Free tier = 60 req/min, 300/day
- **Telegram**: Token stored in environment variables
- **GX10**: No API key required (local)

### Production Hardening:
1. ✅ Use environment variables for all secrets
2. ✅ Non-root Docker container
3. ✅ Auto-restart with PM2
4. ✅ Memory limits (1GB per instance)
5. ✅ Health checks on all containers
6. ✅ Separate logs for each service

### Rate Limiting:
- Finnhub free tier limits:
  - 60 requests/minute
  - 300 requests/day
- System gracefully handles 403 errors
- Historical data and news may be rate-limited

---

## 📊 Monitoring & Logging

### PM2 Logs:
```bash
# View combined logs
pm2 logs

# View specific service
pm2 logs finance-seer --lines 100

# JSON format
pm2 logs finance-seer --format json
```

### Docker Logs:
```bash
# All services
docker-compose logs

# Specific service
docker-compose logs finance-seer

# Follow logs
docker-compose logs -f finance-seer
```

### Health Checks:
- PM2: `pm2 status`
- Docker: `docker-compose ps`
- GX10: `curl http://192.168.10.163:11434/api/tags`

---

## 🚦 Trading Signals

### Signal Types:
- **BUY**: Strong bullish signals (confidence ≥50%)
- **SELL**: Strong bearish signals
- **HOLD**: Neutral or mixed signals
- **WAIT**: Low confidence (<50%)

### Position Sizing:
| Risk Level | Max Position |
|---|---|
| LOW | 15% |
| MEDIUM | 10% |
| HIGH | 5% |

### Safety Checks (8 Filters):
1. ✅ Volume > 5M shares
2. ✅ Daily change < 5%
3. ✅ EPS > 0
4. ✅ Debt/Equity < 2.0
5. ✅ News sentiment neutral/positive
6. ✅ No pattern conflicts
7. ✅ RSI not overbought/oversold
8. ✅ P/E not excessively high

---

## 🎯 Usage Examples

### Manual Analysis:
```javascript
const { runFullAnalysis } = require('./lib/ai-analyzer');
const { validateTradeSafety, generateTradingOrder } = require('./lib/trading-safety');

// Analyze a stock
const result = await runFullAnalysis('NVDA');
console.log(result.aiAnalysis.analysis);
```

### Trigger Heartbeat:
```bash
# Start heartbeat manually
node scripts/heartbeat.js

# Or via PM2
pm2 start scripts/heartbeat.js --name finance-seer-heartbeat
```

### Check Status:
```bash
pm2 status
docker-compose ps
```

---

## 🛠️ Troubleshooting

### Common Issues:

#### GX10 Not Responding:
```bash
# Check network
ping 192.168.10.163

# Check Ollama service
curl http://192.168.10.163:11434/api/tags

# Verify Qwen3.5:122b is loaded
ollama list
```

#### Finnhub Rate Limited:
- Error: `Request failed with status code 403`
- Solution: Upgrade to paid tier or wait for next day

#### Memory Issues:
- Check PM2 memory: `pm2 status`
- Adjust `max_memory_restart` in ecosystem.config.js

#### Telegram Alerts Not Sending:
- Verify token: `echo $TELEGRAM_BOT_TOKEN`
- Check Chat ID: `echo $TELEGRAM_CHAT_ID`
- Test manually: `curl https://api.telegram.org/bot<TOKEN>/sendMessage?...`

---

## 📈 Performance

### System Resources:
- **CPU**: 1 core per service (PM2)
- **RAM**: 1GB limit per service
- **Disk**: 50GB for model storage (GX10)
- **Network**: <1ms latency to GX10

### Response Times:
- Market data: <2 seconds
- AI analysis: 30-120 seconds (122B model)
- Pattern detection: <1 second
- Safety checks: <1 second
- Order generation: <1 second

---

## 🔄 Updates & Maintenance

### Weekly Tasks:
1. Review Telegram alert logs
2. Check PM2 service health
3. Verify GX10 model status
4. Review trading signals for accuracy

### Monthly Tasks:
1. Analyze system performance metrics
2. Update watchlist if needed
3. Review API usage and costs
4. Backup configuration files

---

## 📚 Documentation

### Core Modules:
- `lib/market-status.js` - NYSE hours, phases, business days
- `lib/finnhub-client.js` - Market data API client
- `lib/pattern-detector.js` - 11 technical pattern detection
- `lib/ai-analyzer.js` - GX10 Qwen3.5:122b AI analysis
- `lib/trading-safety.js` - 8 pre-trade safety filters
- `lib/order-manager.js` - Order state management

### Scripts:
- `scripts/startup.sh` - PM2 startup script
- `scripts/heartbeat.js` - Autonomous analysis service
- `scripts/live-test.js` - Live analysis testing
- `scripts/complete-system-test.js` - Full system validation

---

## 🤝 Support

### Resources:
- **OpenClaw Docs**: https://docs.openclaw.ai
- **Finnhub API**: https://finnhub.io/docs
- **Ollama**: https://ollama.ai/docs
- **Telegram Bot API**: https://core.telegram.org/bots/api

### Contact:
- System logs: `pm2 logs` or `docker-compose logs`
- Issues: Check error logs in `./logs/`

---

## 📄 License

MIT License - See LICENSE file for details.

---

**Built with ❤️ for autonomous AI trading**
# Test
# Test
