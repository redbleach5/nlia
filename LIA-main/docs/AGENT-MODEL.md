# Agent model guidance

Agent ReAct (`runAgentTask`) needs a model with **stable tool calling** — for non-coding paths (KB, web, Create Runtime).

## Claude Code coding backend (optional)

**Настройка на ПК (чеклист):** [`CLAUDE-CODE.md`](./CLAUDE-CODE.md).

Settings → Model → **Coding: Claude Code** (default off).

When enabled, **project coding** goals with a real `fsScope` (not sandbox) run via **Claude Code CLI** through Ollama’s **Anthropic Messages API** (local and ollama.com cloud). One goal → one executor: no silent fallback to ReAct.

| Path | Executor |
|------|----------|
| Edit / fix / explore repo + project fsScope + toggle on | Claude Code only |
| Create Runtime sandbox | ReAct + runtime |
| KB / news / chat | chat / ReAct non-FS |
| Toggle off | Legacy ReAct coding |

**Prompt isolation:** Claude Code receives only the user goal + repo rules (`AGENTS.md` / `.cursorrules`) + `@mentions` — never Lia companion `buildSystemPrompt` or ReAct agent system. Lia voice is a short synthesize **after** CC.

**Ops:** git snapshot before spawn; env scrub (no inherited `ANTHROPIC_API_KEY`); wall-time kill; **after stream `result` → grace (~8s) then SIGTERM** if CLI hangs (common with local thinking models); no CC resume after server restart; Windows `claude` / `claude.cmd`.

Install CLI and ensure it is on `PATH`. Prefer models with **≥64k** context for coding.

## Recommended (ReAct / chat)

- Dedicated **agent** slot in Settings → Model (not the companion chat model).
- With Claude Code on, the agent slot (or CC model override) is passed as `claude --model`.
- Prefer instruction-tuned chat models that emit tool calls reliably (e.g. Qwen3 Instruct / similar).
- Avoid **Reasoning Distilled** / heavy chain-of-thought models for the ReAct loop — they add latency and often skip or mangle tools.

## Companion vs agent

| Slot | Role |
|------|------|
| Chat / companion (day) | Fast dialogue — tools usually off on trivial/simple turns; monologue/deliberate LLM pre-calls are off (TTFT) |
| Agent | ReAct for non-coding; or Claude Code `--model` when coding backend is on |
| Heavy (optional) | Hard / research / loop escalate — brain phases; not a substitute for companion identity |
| Claude Code | Coding executor only — never companion `buildSystemPrompt` |

/** Day vs heavy vs CC:** day is the Lia face users talk to. Heavy runs **agent** brain phases (plan / weak-plan replan / loop execute) when configured — not the companion chat stream (keeps latency + voice). Synthesize and post–CC summary stay day voice. Claude Code stays one-executor for project coding when the toggle is on — no parallel small coding path. Inference pool (`LIA_INFERENCE_VRAM_GB`) and model names come from Settings/env, not hardcoded host SKUs. Pool-aware `num_ctx` on heavy uses **heavy** weight size, not day/agent.

UI tip: Settings → Model → «Агент и память» repeats this split.

## Prompt channels (isolation)

| Channel | System content | Companion `buildSystemPrompt` |
|---------|----------------|--------------------------------|
| Chat | Full companion identity, memory, warmth | yes |
| Agent **plan** | Operational planner JSON rules (`buildPlanSystemPrompt`) | **no** |
| Agent **execute** | Plan + tools + ГОТОВО (`buildExecuteSystemPrompt`) | **no** |
| Agent **synthesize** | Light Lia voice for the user-facing answer only | no full companion; short voice ok |
| Claude Code | User goal + rules/mentions only | **no** |
| Post–CC summary | Short local synthesize | light voice |

Guards: `assertOperationalAgentPrompt` / `promptLooksLikeCompanionSystem` in `src/lib/agent/phase-prompts.ts`.

## Optional deep verify

`LIA_AGENT_DEEP_VERIFY=1` — reserved for heavier post-edit checks (not required for DoD). Default path uses lightweight grounded checks (exists, non-empty, round-trip, JSON parse).
