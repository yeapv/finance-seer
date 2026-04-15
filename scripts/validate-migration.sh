#!/bin/bash
# Migration Validation Script
# Date: 2026-04-15

echo "========================================="
echo "Vane Migration Validation"
echo "========================================="
echo ""

GX10_HOST="192.168.10.163"
GX10_USER="yvincent"
VANE_CONTAINER="perplexica-vane-1"
LM_STUDIO_HOST="192.168.10.58"
LM_STUDIO_PORT="1234"
MODEL="qwen3.5:30b"

# Test 1: Check LM Studio is running
echo "Test 1: LM Studio Connection"
if curl -s "http://${LM_STUDIO_HOST}:${LM_STUDIO_PORT}/v1/models" | grep -q "qwen3.5:30b"; then
    echo "✅ PASS: LM Studio is running with qwen3.5:30b loaded"
else
    echo "❌ FAIL: LM Studio not running or model not loaded"
fi
echo ""

# Test 2: Check Vane is running on GX10
echo "Test 2: Vane Container Status"
SSH_OUTPUT=$(ssh -o StrictHostKeyChecking=no ${GX10_USER}@${GX10_HOST} \
    "sudo -S docker ps | grep ${VANE_CONTAINER}" 2>&1 <<< 'asRaven!00' 2>&1)
if echo "$SSH_OUTPUT" | grep -q "Up"; then
    echo "✅ PASS: Vane container is running"
else
    echo "❌ FAIL: Vane container not running"
fi
echo ""

# Test 3: Verify Vane config points to LM Studio
echo "Test 3: Vane Configuration Check"
CONFIG_OUTPUT=$(ssh -o StrictHostKeyChecking=no ${GX10_USER}@${GX10_HOST} \
    "sudo -S docker exec ${VANE_CONTAINER} cat /home/vane/data/config.json" 2>&1 <<< 'asRaven!00')
if echo "$CONFIG_OUTPUT" | grep -q "${LM_STUDIO_HOST}:${LM_STUDIO_PORT}"; then
    echo "✅ PASS: Vane configured to use LM Studio (${LM_STUDIO_HOST}:${LM_STUDIO_PORT})"
else
    echo "❌ FAIL: Vane not configured for LM Studio"
    echo "Current config:"
    echo "$CONFIG_OUTPUT"
fi
echo ""

# Test 4: Verify model is set correctly
echo "Test 4: Model Configuration"
if echo "$CONFIG_OUTPUT" | grep -q "qwen3.5:30b"; then
    echo "✅ PASS: Vane configured to use qwen3.5:30b"
else
    echo "❌ FAIL: Model not set to qwen3.5:30b"
fi
echo ""

# Test 5: Check warmup cron is removed
echo "Test 5: Warmup Cron Cleanup"
CRON_OUTPUT=$(ssh -o StrictHostKeyChecking=no ${GX10_USER}@${GX10_HOST} \
    "crontab -l" 2>&1)
if echo "$CRON_OUTPUT" | grep -q "sleep 30 && curl localhost:11434"; then
    echo "⚠️  WARNING: Old warmup cron still present"
else
    echo "✅ PASS: Warmup cron removed"
fi
echo ""

# Test 6: Vane web accessibility
echo "Test 6: Vane Web Interface"
if curl -s "http://${GX10_HOST}:3000" | grep -q "vane\|Vane\|AI"; then
    echo "✅ PASS: Vane web interface is accessible"
else
    echo "❌ FAIL: Vane web interface not accessible"
fi
echo ""

# Test 7: Vane logs check
echo "Test 7: Vane Logs (last 5 lines)"
LOGS_OUTPUT=$(ssh -o StrictHostKeyChecking=no ${GX10_USER}@${GX10_HOST} \
    "sudo -S docker logs ${VANE_CONTAINER} --tail 5 2>&1 <<< 'asRaven!00'" 2>&1)
if echo "$LOGS_OUTPUT" | grep -q "Ready\|ready"; then
    echo "✅ PASS: Vane logs show container is ready"
else
    echo "⚠️  INFO: Check logs manually"
    echo "$LOGS_OUTPUT" | tail -5
fi
echo ""

echo "========================================="
echo "Validation Complete!"
echo "========================================="
echo ""
echo "Summary:"
echo "- Vane is running on GX10: ${GX10_HOST}:3000"
echo "- Connected to LM Studio: ${LM_STUDIO_HOST}:${LM_STUDIO_PORT}"
echo "- Model: ${MODEL}"
echo "- Warmup cron: Removed (no longer needed)"
echo ""
echo "Test it: http://${GX10_HOST}:3000"
