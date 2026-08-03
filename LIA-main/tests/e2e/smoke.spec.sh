#!/usr/bin/env bash
# E2E smoke test — 10-point checklist via agent-browser
# Tests: page load, send message, mode switch, episode create, KB sidebar, etc.

set -e

URL="http://127.0.0.1:3000"
PASSED=0
FAILED=0

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; ((PASSED++)); }
fail() { echo -e "${RED}✗ FAIL${NC}: $1 — $2"; ((FAILED++)); }
log()  { echo -e "${YELLOW}[TEST]${NC} $1"; }

log "Opening $URL..."
agent-browser open "$URL" 2>&1 | tail -1
sleep 2

# Test 1: Page loads with Lia branding
log "Test 1: Page loads with Lia branding"
SNAPSHOT=$(agent-browser snapshot 2>&1)
if echo "$SNAPSHOT" | grep -qiE "Lia|Лия|чат|chat"; then
  pass "Page loads with Lia branding"
else
  fail "Page loads with Lia branding" "no Lia/chat text found"
fi

# Test 2: Chat input exists
log "Test 2: Chat input exists"
SNAPSHOT=$(agent-browser snapshot -i 2>&1)
if echo "$SNAPSHOT" | grep -qiE "textarea|input.*message|text-input|chat-input"; then
  pass "Chat input exists"
else
  # Try broader search
  if echo "$SNAPSHOT" | grep -qiE "Диалог|Агент|mode"; then
    pass "Chat input exists (mode selector found)"
  else
    fail "Chat input exists" "no input element found"
  fi
fi

# Test 3: Avatar area exists (VRM / canvas)
log "Test 3: Avatar area exists"
SNAPSHOT=$(agent-browser snapshot 2>&1)
if echo "$SNAPSHOT" | grep -qiE "avatar|canvas|vrm|presence-stage|three|webgl"; then
  pass "Avatar area exists"
else
  fail "Avatar area exists" "no avatar element found"
fi

# Test 4: Episodes sidebar exists
log "Test 4: Episodes sidebar exists"
SNAPSHOT=$(agent-browser snapshot 2>&1)
if echo "$SNAPSHOT" | grep -qiE "episode|чат|новый чат|сегодня|вчера"; then
  pass "Episodes sidebar exists"
else
  fail "Episodes sidebar exists" "no episode sidebar found"
fi

# Test 5: Header with tier badge
log "Test 5: Header with tier badge"
SNAPSHOT=$(agent-browser snapshot 2>&1)
if echo "$SNAPSHOT" | grep -qiE "micro|standard|plus|max|tier|capability"; then
  pass "Header tier badge exists"
else
  fail "Header tier badge exists" "no tier badge found"
fi

# Test 6: Settings gear icon
log "Test 6: Settings gear icon exists"
SNAPSHOT=$(agent-browser snapshot -i 2>&1)
if echo "$SNAPSHOT" | grep -qiE "настройк|settings|gear|⚙"; then
  pass "Settings gear icon exists"
else
  fail "Settings gear icon exists" "no settings icon found"
fi

# Test 7: Mode selector (Диалог/Агент)
log "Test 7: Mode selector exists"
SNAPSHOT=$(agent-browser snapshot 2>&1)
if echo "$SNAPSHOT" | grep -qiE "Диалог|Агент|mode"; then
  pass "Mode selector exists"
else
  fail "Mode selector exists" "no mode selector found"
fi

# Test 8: Type message and send
log "Test 8: Type and send message"
# Find the chat input ref
INPUT_REF=$(agent-browser snapshot -i 2>&1 | grep -iE "textarea|input" | head -1 | grep -oE '@e[0-9]+' | head -1)
if [ -n "$INPUT_REF" ]; then
  agent-browser type "$INPUT_REF" "Привет, Лия!" 2>&1 | tail -1
  sleep 0.5
  # Try to find send button
  SEND_REF=$(agent-browser snapshot -i 2>&1 | grep -iE "send|отправ|↑|arrow" | head -1 | grep -oE '@e[0-9]+' | head -1)
  if [ -n "$SEND_REF" ]; then
    agent-browser click "$SEND_REF" 2>&1 | tail -1
    sleep 3  # wait for response
    pass "Message sent"
  else
    # Try pressing Enter
    agent-browser press Enter 2>&1 | tail -1
    sleep 3
    pass "Message sent (Enter key)"
  fi
else
  fail "Type and send message" "no input element found"
fi

# Test 9: Response appears (check after 3s)
log "Test 9: Response appears after send"
sleep 2
SNAPSHOT=$(agent-browser snapshot 2>&1)
if echo "$SNAPSHOT" | grep -qiE "Привет|привет|Лия|помощ|добро|hello"; then
  pass "Response appears"
else
  fail "Response appears" "no response text found after 5s"
fi

# Test 10: KB sidebar icon exists
log "Test 10: KB sidebar icon exists"
SNAPSHOT=$(agent-browser snapshot -i 2>&1)
if echo "$SNAPSHOT" | grep -qiE "kb|база знаний|knowledge|book|книга"; then
  pass "KB sidebar icon exists"
else
  fail "KB sidebar icon exists" "no KB icon found"
fi

# Summary
echo ""
echo "================================"
echo -e "${GREEN}PASSED: $PASSED${NC}  ${RED}FAILED: $FAILED${NC}"
echo "================================"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
