#!/usr/bin/env bash
set -euo pipefail

VERSION="2.77.0"
ARCH="linux_amd64"
TARGET_DIR="./bin/supabase"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TARGET_DIR"

echo "Downloading Supabase CLI v${VERSION} for ${ARCH}..."
curl -L -f "https://github.com/supabase/cli/releases/download/v${VERSION}/supabase_${ARCH}.tar.gz" \
  -o "$TMP_DIR/supabase.tar.gz"

echo "Extracting to $TARGET_DIR..."
tar -xzf "$TMP_DIR/supabase.tar.gz" -C "$TARGET_DIR"

echo "Done! CLI is ready at $TARGET_DIR/supabase"
