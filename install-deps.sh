#!/bin/bash

# Install system dependencies if they don't exist
if ! ldconfig -p | grep -q libglib-2.0.so.0; then
    echo "Installing system dependencies..."
    apt-get update
    apt-get install -y libglib2.0-0 libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgtk-3-0 libgbm1 libasound2
fi

# Install Playwright browsers if not present
if [ ! -d "/root/.cache/ms-playwright/chromium-1208" ]; then
    echo "Installing Playwright browsers..."
    npx playwright install chromium
    npx playwright install-deps chromium
fi

# Start the application
node server.js