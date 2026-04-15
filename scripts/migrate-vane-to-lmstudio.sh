#!/bin/bash
# Vane Migration Script: GX10 Ollama → AMD Ryzen AI Max+ 395 LM Studio
# Date: 2026-04-15
# Purpose: Migrate Vane from GX10 local Ollama to LM Studio on 192.168.10.58

set -e

GX10_HOST="192.168.10.163"
GX10_USER="yvincent"
LM_STUDIO_HOST="192.168.10.58"
LM_STUDIO_PORT="1234"
VANE_CONTAINER="perplexica-vane-1"
MODEL="qwen3.5:30b"

echo "========================================="
echo "Vane Migration Script"
echo "========================================="
echo "Target: LM Studio on ${LM_STUDIO_HOST}:${LM_STUDIO_PORT}"
echo "Model: ${MODEL}"
echo ""

# Step 1: Test LM Studio connectivity
echo "Step 1: Testing LM Studio connectivity..."
if curl -s "http://${LM_STUDIO_HOST}:${LM_STUDIO_PORT}/v1/models" | grep -q "qwen3.5:30b"; then
    echo "✅ LM Studio is running and qwen3.5:30b is loaded"
else
    echo "⚠️ WARNING: LM Studio connection test failed or model not loaded"
    echo "   Please verify LM Studio is running on ${LM_STUDIO_HOST}:${LM_STUDIO_PORT}"
    echo "   And that qwen3.5:30b is loaded in the UI"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ Aborted"
        exit 1
    fi
fi

# Step 2: Backup current Vane config on GX10
echo ""
echo "Step 2: Backing up current Vane config..."
ssh -o StrictHostKeyChecking=no ${GX10_USER}@${GX10_HOST} "
    echo 'Connecting to GX10...'
    sudo -S docker exec ${VANE_CONTAINER} cp /home/vane/data/config.json /home/vane/data/config.json.backup \
        2>&1 <<< 'asRaven!00'
    if [ \${PIPESTATUS[0]} -eq 0 ]; then
        echo '✅ Backup created'
    else
        echo '❌ Backup failed'
        exit 1
    fi
"

# Step 3: Update Vane config
echo ""
echo "Step 3: Updating Vane config..."
ssh -o StrictHostKeyChecking=no ${GX10_USER}@${GX10_HOST} "
    sudo -S docker exec ${VANE_CONTAINER} bash -c '
        cat > /home/vane/data/config.json << '\''EOF'\''
{
  "providers": {
    "ollama": {
      "enabled": true,
      "settings": {
        "baseUrl": "http://${LM_STUDIO_HOST}:${LM_STUDIO_PORT}",
        "modelName": "qwen3.5:30b"
      }
    }
  }
}
EOF
    '
    echo '✅ Config updated'
"

# Step 4: Restart Vane container
echo ""
echo "Step 4: Restarting Vane container..."
ssh -o StrictHostKeyChecking=no ${GX10_USER}@${GX10_HOST} "
    sudo -S docker restart ${VANE_CONTAINER} 2>&1 <<< 'asRaven!00'
    echo '✅ Vane container restarted'
"

# Step 5: Verify new configuration
echo ""
echo "Step 5: Verifying new configuration..."
sleep 10
ssh -o StrictHostKeyChecking=no ${GX10_USER}@${GX10_HOST} "
    sudo -S docker exec ${VANE_CONTAINER} cat /home/vane/data/config.json 2>&1 <<< 'asRaven!00'
"

# Step 6: Optional - Remove warmup cron
echo ""
echo "Step 6: Cleaning up (optional)..."
read -p "Remove old warmup cron? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    ssh -o StrictHostKeyChecking=no ${GX10_USER}@${GX10_HOST} "
        crontab -l | grep -v 'sleep 30 && curl localhost:11434' | crontab -
        echo '✅ Warmup cron removed'
    "
fi

echo ""
echo "========================================="
echo "Migration Complete!"
echo "========================================="
echo ""
echo "Test Vane at: http://${GX10_HOST}:3000"
echo "Vane is now connected to LM Studio on ${LM_STUDIO_HOST}:${LM_STUDIO_PORT}"
echo "Model: ${MODEL}"
echo ""
echo "To verify:"
echo "1. Open http://${GX10_HOST}:3000"
echo "2. Ask a question (should respond instantly)"
echo "3. Check logs: docker logs perplexica-vane-1 --tail 20"
echo ""
echo "The warmup cron is no longer required (LM Studio auto-warms models)."
