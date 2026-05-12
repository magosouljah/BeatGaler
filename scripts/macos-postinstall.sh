#!/bin/bash
set -e

# Post-install script for BeatVault macOS PKG installer
# Removes quarantine attributes and launches the app

APP_PATH="/Applications/BeatVault.app"

echo "Installing BeatVault..."

# Remove quarantine attributes so macOS doesn't block the app
if [ -d "$APP_PATH" ]; then
    echo "Removing quarantine attributes..."
    sudo xattr -r -d com.apple.quarantine "$APP_PATH" 2>/dev/null || true
    sudo xattr -r -d com.apple.provenance "$APP_PATH" 2>/dev/null || true
    
    echo "Setting executable permissions..."
    sudo chmod +x "$APP_PATH/Contents/MacOS/BeatVault"
    
    echo "Launching BeatVault..."
    open "$APP_PATH"
    echo "BeatVault opened successfully!"
else
    echo "Error: BeatVault.app not found in Applications"
    exit 1
fi
