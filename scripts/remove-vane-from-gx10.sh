#!/bin/bash
# Vane Removal & Warmup Cron Cleanup Script
# Execute on GX10: 192.168.10.163
# Date: 2026-04-15

echo "====== Vane Removal & Cron Cleanup ======"
echo "This will remove:"
echo "  - Vane Docker container (perplexica-vane-1)"
echo "  - Vane Docker volume (vane-data)"
echo "  - Vane Docker image (itzcrazykns1337/vane:latest)"
echo "  - Ollama warmup cron job"
echo ""

# Password prompt
read -sp "Enter GX10 password (asRaven!00): " PASSWORD
echo ""

if [ "$PASSWORD" != "asRaven!00" ]; then
    echo "❌ Password incorrect. Exiting."
    exit 1
fi

echo "✅ Password accepted"
echo ""

# Step 1: Stop Vane container
echo "Step 1: Stopping Vane container..."
echo "$PASSWORD" | sudo -S docker stop perplexica-vane-1 2>&1 | grep -v "Error: No such container" || echo "Container already stopped or doesn't exist"

# Step 2: Remove Vane container
echo "Step 2: Removing Vane container..."
echo "$PASSWORD" | sudo -S docker rm perplexica-vane-1 2>&1 | grep -v "Error: No such container" || echo "Container already removed"

# Step 3: Remove Vane volume
echo "Step 3: Removing Vane volume..."
echo "$PASSWORD" | sudo -S docker volume rm vane-data 2>&1 | grep -v "Error: No such volume" || echo "Volume already removed"

# Step 4: Remove Vane Docker image
echo "Step 4: Removing Vane Docker image..."
echo "$PASSWORD" | sudo -S docker rmi itzcrazykns1337/vane:latest 2>&1 | grep -v "Error: No such image" || echo "Image already removed"

# Step 5: Remove warmup cron
echo "Step 5: Removing warmup cron job..."
CRONTAB=$(crontab -l 2>/dev/null)
if echo "$CRONTAB" | grep -q "sleep 30 && curl localhost:11434"; then
    echo "$CRONTAB" | grep -v "sleep 30 && curl localhost:11434" | crontab -
    echo "✅ Warmup cron removed"
else
    echo "ℹ️  No warmup cron found (already removed)"
fi

# Step 6: Verify removal
echo ""
echo "Step 6: Verification..."
echo ""
echo "Container status:"
docker ps -a | grep -i vane || echo "  ✅ No Vane containers found"

echo ""
echo "Volume status:"
docker volume ls | grep -i vane || echo "  ✅ No Vane volumes found"

echo ""
echo "Image status:"
docker images | grep vane || echo "  ✅ No Vane images found"

echo ""
echo "Cron status:"
crontab -l | grep -i "vane\|ollama.*warm\|sleep.*11434" || echo "  ✅ No Vane/Ollama warmup cron found"

echo ""
echo "====== Cleanup Complete ======"
echo ""
echo "Summary:"
echo "  ✅ Vane container removed"
echo "  ✅ Vane volume removed"
echo "  ✅ Vane image removed"
echo "  ✅ Warmup cron removed"
echo ""
echo "GX10 Ollama is now clean!"
echo "You can safely remove Ollama from GX10 if desired."
