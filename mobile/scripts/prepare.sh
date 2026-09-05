#!/usr/bin/env bash
# ZoneGlow mobile - one-shot project preparation.
#
# Installs Capacitor dependencies, generates/refreshes the Android platform
# and syncs the shell web assets (www/) into it.
#
# Usage:  mobile/scripts/prepare.sh          (from the repository root)
# Requires: Node.js 18+ (Android Studio only needed for the actual APK build)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CAP="$ROOT/mobile/capacitor"

cd "$CAP"
npm install

if [ ! -d android ]; then
  npx cap add android
fi

npx cap sync android
echo "Done. Open mobile/capacitor/android in Android Studio, or run:"
echo "  cd mobile/capacitor/android && ./gradlew assembleDebug"