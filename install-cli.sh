#!/bin/bash
# install-cli.sh
set -e

VERSION="2.77.0"
ARCH="linux_amd64"
BIN_DIR="./bin"

mkdir -p "$BIN_DIR"

echo "Downloading Supabase CLI v$VERSION for $ARCH..."
curl -L "https://github.com/supabase/cli/releases/download/v$VERSION/supabase_$VERSION_$ARCH.tar.gz" -o supabase.tar.gz

echo "Extracting..."
tar -xzf supabase.tar.gz -C "$BIN_DIR"
rm supabase.tar.gz

echo "Done! CLI is ready at $BIN_DIR/supabase"
