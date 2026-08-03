# Implementation plan: both poles (alive + capable)

**Audience:** coding agent / implementer  
**Status:** M0–M5 implemented (2026-07-24); M6 optional later  
**Invariant:** companion liveness and hard-task capability ship together; pool is a parameter (no hardcoded 14B/8k/16GB in product logic).  
**Host numbers:** only in Settings presets / `.env.example` comments / `PLAN-INFERENCE-HARDWARE.md` — never as constants that gate architecture.

Related: `PLAN-INFERENCE-HARDWARE.md`, `docs/AGENT-MODEL.md`, `docs/drafts/DESIGN-agent-instrument.md`.

---

## Invariants (do not violate)

1. User-facing text after agent/CC = Lia synthesize voice; never full companion `buildSystemPrompt` inside Claude Code / execute prompts (`phase-prompts.ts` guards stay).
2. VRAM/compute pressure = observe/warn only — do not cut `agentMaxSteps` / cognitive tier from pressure.
3. Day/heavy/secondary model names and target ctx come from Settings/DB/env — not magic numbers in `cognitive-depth.ts` / runner.
4. Coding project goals with CC enabled stay one-executor (CC); do not add parallel 1B coding path.
5. Prefer small PRs per milestone below; each milestone has tests + DoD.

---

## Current anchors (read before coding)

| Area | Path |
|------|------|
| Pool / tier | `src/lib/capability-profile.ts`, `src/lib/compute-budget.ts` |
| Chat ctx | `src/lib/chat/context-budget.ts` → `resolveInferenceNumCtx`; `pipeline-stream.ts` → `setOllamaNumCtx` |
| Ollama options | `src/lib/ollama.ts` (`num_ctx` only today) |
| Model slots | `src/lib/ollama.ts`, `src/lib/llm/resolve-agent-model.ts`, `src/lib/chat/model-selection.ts` |
| Settings API/UI | `src/app/api/settings/route.ts`, `src/components/lia/settings/model-tab.tsx` |
| Agent loop | `src/lib/agent/runner.ts`, `runner-helpers.ts`, `phase-prompts.ts` |
| Cognitive matrix | `src/lib/cognitive-depth.ts` (tools/maxTokens live; `autoWebSearch` dead) |
| Secondary setting key | `ollama_secondary_model` (API exists; Model tab incomplete) |

---

## Milestone M0 — docs + env contract

**Goal:** implementers know pool env and role names; no behavior change required beyond docs/example.

### Tasks

1. Update `.env.example`: `LIA_INFERENCE_VRAM_GB` (required for remote Ollama truth), optional `LIA_INFERENCE_RAM_GB` stub comment if not implemented yet.
2. Short section in `REMOTE-OLLAMA.md` (or create if missing): roles `chat` / `agent` / `secondary` / `heavy` / `embed` / `claudeCode`; pool = VRAM (+ optional RAM); NVMe = load not compute.
3. One paragraph in `docs/AGENT-MODEL.md`: day vs heavy vs CC; synthesize = Lia face.
4. Point `PLAN-INFERENCE-HARDWARE.md` stays calibration appendix (already linked).

### DoD

- [ ] `.env.example` documents pool env.
- [ ] Docs name roles without hardcoding a single host SKU as product truth.
- [ ] No runtime change required to merge M0.

### Tests

None (docs only). Optional: grep that README/AGENT-MODEL mention `LIA_INFERENCE_VRAM_GB`.

---

## Milestone M1 — pool truth + pool-aware `num_ctx`

**Goal:** capability reflects real VRAM pool; chat **and** agent send `num_ctx` from `f(pool, model residency estimate, headroom)` capped by tier — not blind model max / tier-only.

### Tasks

1. **`capability-profile` / API**
   - Ensure `/api/capability` (and Settings model tab copy) surfaces `vramGb`, `vramSource`, and when override set, non-zero pool for remote.
   - Add optional `LIA_INFERENCE_RAM_GB` only if used by budget math in this milestone; otherwise defer to M1.1 note in code comment.
2. **`resolveInferenceNumCtx` (or successor)** in `context-budget.ts`
   - Inputs: declared pool VRAM, model size/quant estimate (from `/api/show` cache), tier cap, safety headroom (embed + KV).
   - Output: ctx that prefers **full-GPU residency** for day role; if caller marks role `heavy`, allow higher spill / lower ctx per policy flag.
   - **No** fixed `8192` as architecture constant — use pool formula; tests may use example pools (8 / 16 / 48 GB).
3. **Chat** — keep wiring in `pipeline-stream.ts`; verify uses new resolver.
4. **Agent** — inject `setOllamaNumCtx` (or equivalent) on plan/execute/synthesize LLM calls in `runner-helpers.ts` / `runner.ts`; clear after turn like chat.
5. Unit tests: given mock pool+weights, ctx decreases when pool shrinks; agent path calls set/clear.

### Files (expected)

- `src/lib/chat/context-budget.ts`
- `src/lib/capability-profile.ts`
- `src/lib/compute-budget.ts` (if residency estimate lives here)
- `src/lib/chat/pipeline-stream.ts`
- `src/lib/agent/runner-helpers.ts` / `runner.ts`
- `src/lib/ollama.ts` (only if shared helper needed)
- `tests/unit/context-budget.test.ts` (+ new agent ctx test)

### DoD

- [ ] Remote without env still documented; with env, capability `vramGb > 0`.
- [ ] Chat + agent both set `num_ctx` from pool-aware helper.
- [ ] Tests cover 2+ pool sizes; no host-specific model name asserts in unit tests.

### Out of scope M1

Heavy model slot, escalate, Settings heavy UI, `num_gpu`.

---

## Milestone M2 — model roles: secondary + heavy in Settings

**Goal:** owner/agent can configure `secondary` and `heavy` like chat/agent; persistence + API + Model tab; runtime can *read* heavy name (escalate in M3).

### Tasks

1. DB/settings keys: reuse `ollama_secondary_model`; add `ollama_heavy_model` (and env `OLLAMA_HEAVY_MODEL` if pattern matches agent).
2. `getOllamaSettings` / `setOllamaSettings` / `ollama-env-sync.ts` / settings Zod + `POST /api/settings`.
3. `capability-profile` role list: include `heavy` in budget observation (warn if day+heavy both huge — observe only).
4. Model tab UI: Secondary + Heavy selectors (mirror agent model UX); show effective names.
5. Resolve helpers: `getHeavyModelName()`, `resolveModelForRole('chat'|'agent'|'secondary'|'heavy')`.
6. Tests: settings round-trip; resolve falls back to chat/agent when heavy empty.

### Files (expected)

- `src/lib/ollama.ts`, `src/lib/infra/ollama-env-sync.ts`
- `src/app/api/settings/route.ts`, `src/lib/infra/api-validation.ts`
- `src/components/lia/settings/model-tab.tsx`, `types.ts`
- `src/lib/capability-profile.ts`, `compute-budget.ts`
- `tests/` settings + resolve unit tests

### DoD

- [ ] Can set/clear heavy + secondary from UI and API.
- [ ] Empty heavy ⇒ callers use agent/chat fallback (documented in helper JSDoc).
- [ ] Capability/budget aware of heavy role name when set.

### Out of scope M2

Auto-switching to heavy mid-task (M3); keep_alive policy can be stubbed as settings fields without Ollama wiring if needed — prefer minimal: store `heavyKeepAliveSec` only if wired in M2.1 same PR or skip until M3.

---

## Milestone M3 — escalate to heavy (chat + agent)

**Goal:** hard work can use heavy without manually swapping the day model; user-facing answer still Lia day voice where applicable.

### Tasks

1. **Policy module** `src/lib/llm/model-escalate.ts` (new):
   - Inputs: complexity, mode (`chat`|`agent`), signals (`loopDetected`, `weakPlan`, optional flag).
   - Output: `{ role: 'day' | 'heavy'; reason }`.
   - Default triggers: `complexity === 'research' | 'complex'` for agent plan/synthesize; loop detector hit → next step heavy; chat research → heavy for main stream **or** only for deliberate-equivalent single shot (prefer: chat main stream escalate on research/complex when heavy configured).
   - If heavy unset → no-op (day/agent).
2. **Chat pipeline** (`pipeline.ts` / `pipeline-stream.ts`): choose model via escalate + existing secondary for trivial (`model-selection.ts`); do not break secondary trivial path.
3. **Agent** (`runner-helpers.ts`):
   - `generatePlan` / `synthesize`: may use heavy when policy says.
   - `executeStep`: stay on agent model by default (tool stability); on loop escalate execute to heavy **or** replan on heavy — pick one in code comments and tests; prefer **replan/synthesize on heavy, execute stays agent** unless loop count ≥ N then execute heavy once.
4. **Synthesize** always uses day/chat model for voice when heavy was used for brain (if day ≠ heavy). Enforce in helper.
5. Tests: policy table-driven; pipeline/runner mocks assert model name selection; companion prompt still absent from execute.

### DoD

- [ ] With heavy configured, research/complex or loop uses heavy for brain phases.
- [ ] Synthesize/user-facing chat voice = day model when day configured separately.
- [ ] With heavy empty, behavior = pre-M3.
- [ ] Pressure still does not shrink maxSteps.

### Out of scope M3

Instrument 1B executor; `num_gpu`; multi-agent.

---

## Milestone M4 — residency / warmup policy (remote)

**Goal:** day pinned; heavy not permanently resident stealing day VRAM.

### Tasks

1. Document + implement keep_alive strategy via Ollama API options where supported:
   - Day/chat: longer `keep_alive` (existing warmup path — extend).
   - Heavy: short keep_alive / `0` after escalate call.
2. Optional Settings: day keep_alive / heavy keep_alive durations.
3. Log residency intent at info level once per escalate.

### DoD

- [ ] Heavy calls do not leave indefinite keep_alive equal to day (verify via unit of options passed + manual note in REMOTE-OLLAMA).
- [ ] Day warmup still works for remote.

---

## Milestone M5 — hygiene + liveness (parallel-safe)

**Goal:** remove false orchestration; keep light-turn latency; no character rewrite required unless separate task.

### Tasks

1. Remove or deprecate unused `ExecutionPlan.autoWebSearch` (wire to `needsProactiveWebSearch` **or** delete field + tests that only assert the dead flag). Prefer **delete/stop testing dead flag** — web stays on `needsProactiveWebSearch`.
2. JSDoc on `cognitive-depth.ts`: matrix only gates tools + maxTokens; deliberate permanently off.
3. Guard test: `assertOperationalAgentPrompt` still fails companion bleed.
4. No change to trivial/simple tools-off unless a failing prod case is cited in PR.

### DoD

- [ ] No dead `autoWebSearch` pretending to drive runtime.
- [ ] Light turns still tools-off; TTFT path unchanged.

---

## Milestone M6 — optional phase instrument (later)

**Only after M3 stable.** Implement `docs/drafts/DESIGN-agent-instrument.md` subset:

- Separate execute model slot (small tool-use) under Lia plan.
- Not used for Claude Code coding path.
- Plan/synthesize remain day/heavy brain.

Track as separate PR train; do not block M1–M5.

---

## Explicit non-goals (reject in review)

- Hardcoding current host models/ctx into resolvers.
- DirectStorage / SSD weight streaming in-app.
- Fine-tune/LoRA pipeline as part of this plan.
- Multi-agent / subagent framework.
- Re-enabling deliberate LLM pre-calls for all chat turns.
- Cutting agent budgets from VRAM pressure.
- Companion system prompt in CC/execute.

---

## Suggested PR sequence

| PR | Milestone | Title sketch |
|----|-----------|--------------|
| 1 | M0 | docs: inference roles + pool env |
| 2 | M1 | feat: pool-aware num_ctx for chat and agent |
| 3 | M2 | feat: heavy + secondary model settings |
| 4 | M3 | feat: escalate to heavy on hard tasks |
| 5 | M4 | feat: day/heavy keep_alive residency policy |
| 6 | M5 | chore: drop dead autoWebSearch; cognitive docs |

Each PR: focused diff, Vitest for touched contracts, no drive-by refactors.

---

## Verification cheat-sheet

```bash
# unit / core (adjust to touched files)
bun test tests/unit/context-budget.test.ts
bun test tests/unit/cognitive-depth.test.ts
bun test tests/core/chat-pipeline.test.ts
bun test tests/core/  # if agent ctx / escalate tests land here
```

Manual (after M1+ with env set):

1. Settings → capability shows pool ≠ 0 when `LIA_INFERENCE_VRAM_GB` set.
2. Chat light turn: fast, no tools.
3. Agent research with heavy set: logs/reason show escalate; final bubble is Lia voice.
4. CC coding unchanged with toggle on.

---

## Done when

- [ ] M0–M5 merged (M6 optional).
- [ ] Pool-parameterized ctx + roles + escalate exist.
- [ ] Invariants 1–5 still true.
- [ ] Host upgrade = change Settings/env preset only.
