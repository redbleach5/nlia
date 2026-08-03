#!/usr/bin/env bash
# E2E test runner — starts mock Ollama + Next.js, runs agent-browser tests, cleans up.
# Usage: bash tests/e2e/run-e2e.sh

set -e

ROOT_DIR="/home/z/my-project/work/Lia-v2-public"
cd "$ROOT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${YELLOW}[E2E]${NC} $1"; }
ok()  { echo -e "${GREEN}[OK]${NC} $1"; }
err() { echo -e "${RED}[ERR]${NC} $1"; }

# Track child PIDs for cleanup
MOCK_OLLAMA_PID=""
NEXT_PID=""

cleanup() {
  log "Cleaning up..."
  [ -n "$MOCK_OLLAMA_PID" ] && kill $MOCK_OLLAMA_PID 2>/dev/null || true
  [ -n "$NEXT_PID" ] && kill $NEXT_PID 2>/dev/null || true
  # Kill any remaining next dev processes on port 3000
  pkill -f "next dev" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

# Step 1: Start mock Ollama
log "Starting mock Ollama on :11434..."
python3 tests/e2e/mock-ollama.py &
MOCK_OLLAMA_PID=$!
sleep 1

# Verify mock Ollama is running
if curl -s --max-time 2 http://127.0.0.1:11434/api/tags | grep -q "qwen2.5"; then
  ok "Mock Ollama is running"
else
  err "Mock Ollama failed to start"
  exit 1
fi

# Step 2: Ensure DB exists
log "Initializing database..."
if [ ! -f "db/custom.db" ]; then
  mkdir -p db
  node_modules/.bin/prisma db push --skip-generate 2>&1 | tail -3
fi
ok "Database ready"

# Step 3: Start Next.js dev server
log "Starting Next.js dev server on :3000..."
PORT=3000 node_modules/.bin/next dev -p 3000 > /tmp/lia-next.log 2>&1 &
NEXT_PID=$!

# Wait for Next.js to be ready (up to 60s)
log "Waiting for Next.js to be ready..."
for i in $(seq 1 60); do
  if curl -s --max-time 2 http://127.0.0.1:3000/ | grep -q "html\|Lia\|lia" 2>/dev/null; then
    ok "Next.js is ready (after ${i}s)"
    break
  fi
  if [ $i -eq 60 ]; then
    err "Next.js failed to start within 60s"
    tail -20 /tmp/lia-next.log
    exit 1
  fi
  sleep 1
done

# Step 4: Run agent-browser E2E tests
log "Running E2E tests via agent-browser..."
if bash tests/e2e/smoke.spec.sh; then
  ok "E2E smoke tests PASSED"
  exit 0
else
  err "E2E smoke tests FAILED"
  exit 1
fi
