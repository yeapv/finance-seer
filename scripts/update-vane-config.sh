#!/bin/bash
# Quick Vane Config Update Script
# Updates Vane to use LM Studio on AMD Ryzen AI Max+ 395

set -e

GX10_USER="yvincent"
GX10_HOST="192.168.10.163"
LM_STUDIO_HOST="192.168.10.58"
LM_STUDIO_PORT="1234"
VANE_CONTAINER="perplexica-vane-1"
MODEL="qwen3.5:30b"

echo "====== Vane Config Update ======"
echo "Updating Vane to use LM Studio..."
echo ""

# Step 1: Backup config
echo "Step 1: Backing up config..."
ssh -o StrictHostKeyChecking=no ${GX10_USER}@${GX10_HOST} \
    "sudo -S docker exec ${VANE_CONTAINER} cp /home/vane/data/config.json /home/vane/data/config.json.backup 2>&1 <<< 'asRaven!00' >/dev/null 2>&1" && \
    echo "✅ Backup created" || echo "⚠️  Backup may have failed"

# Step 2: Update config
echo "Step 2: Updating config..."
ssh -o StrictHostKeyChecking=no ${GX10_USER}@${GX10_HOST} \
    "sudo -S docker exec ${VANE_CONTAINER} bash -c \"
        cat > /home/vane/data/config.json << 'CONFIG_EOF'
{
  'providers': {
    'ollama': {
      'enabled': true,
      'settings': {
        'baseUrl': 'http://${LM_STUDIO_HOST}:${LM_STUDIO_PORT}',
        'modelName': '${MODEL}'
      }
    }
  }
}
CONFIG_EOF
    \" 2>&1 <<< 'asRaven!00' >/dev/null 2>&1" && \
    echo "✅ Config updated" || echo "❌ Config update failed"

# Step 3: Restart Vane
echo "Step 3: Restarting Vane..."
ssh -o StrictHostKeyChecking=no ${GX10_USER}@${GX10_HOST} \
    "sudo -S docker restart ${VANE_CONTAINER} 2>&1 <<< 'asRaven!00' >/dev/null 2>&1" && \
    echo "✅ Vane restarted" || echo "❌ Restart failed"

echo ""
echo "====== Update Complete ======"
echo "Vane is now configured for LM Studio on ${LM_STUDIO_HOST}:${LM_STUDIO_PORT}"
echo "Model: ${MODEL}"
echo ""
echo "Wait 30 seconds for restart to complete, then:"
echo "1. Test: http://${GX10_HOST}:3000"
echo "2. Verify: docker logs ${VANE_CONTAINER} --tail 20"
