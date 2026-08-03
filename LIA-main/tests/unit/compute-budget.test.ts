import { describe, it, expect } from 'vitest';
import {
  bytesPerParamFromQuant,
  classifyTierFromBudget,
  classifyVramPressure,
  estimateModelVramGb,
  resolveComputeBudget,
} from '@/lib/compute-budget';

describe('bytesPerParamFromQuant', () => {
  it('maps common Ollama quants', () => {
    expect(bytesPerParamFromQuant('F16')).toBe(2);
    expect(bytesPerParamFromQuant('Q8_0')).toBe(1);
    expect(bytesPerParamFromQuant('Q4_K_M')).toBe(0.55);
    expect(bytesPerParamFromQuant(null)).toBe(0.55);
  });
});

describe('estimateModelVramGb', () => {
  it('estimates ~5GB for 8B Q4', () => {
    const gb = estimateModelVramGb(8, 'Q4_K_M');
    // 8 * 0.55 + overhead ≈ 4.4 + 0.4 = 4.8
    expect(gb).toBeGreaterThan(4);
    expect(gb).toBeLessThan(6.5);
  });

  it('returns 0 for unknown size', () => {
    expect(estimateModelVramGb(0, 'Q4_K_M')).toBe(0);
  });
});

describe('resolveComputeBudget (roles + VRAM pool)', () => {
  it('counts chat + embed; agent sharing chat is not double-counted', () => {
    const budget = resolveComputeBudget({
      vramPoolGb: 12,
      roles: [
        { role: 'chat', modelName: 'qwen3:8b', parameterSizeB: 8, quantization: 'Q4_K_M' },
        { role: 'agent', modelName: null, parameterSizeB: 8, quantization: 'Q4_K_M', sharesChatWeights: true },
        { role: 'secondary', modelName: 'qwen2.5:1.5b', parameterSizeB: 1.5, quantization: 'Q4_K_M' },
        { role: 'embed', modelName: 'nomic-embed-text', parameterSizeB: 0, quantization: null },
      ],
    });

    const chatLine = budget.roles.find(r => r.role === 'chat')!;
    const agentLine = budget.roles.find(r => r.role === 'agent')!;
    const secondaryLine = budget.roles.find(r => r.role === 'secondary')!;
    const embedLine = budget.roles.find(r => r.role === 'embed')!;

    expect(agentLine.sharesChatWeights).toBe(true);
    expect(agentLine.resident).toBe(false);
    expect(secondaryLine.resident).toBe(false); // swap-in, not peak resident
    expect(chatLine.resident).toBe(true);
    expect(embedLine.resident).toBe(true);

    // resident ≈ chat + embed + KV reserve (not secondary, not shared agent)
    expect(budget.residentVramGb).toBeGreaterThan(
      chatLine.estimatedVramGb + embedLine.estimatedVramGb,
    );
    expect(budget.vramPoolGb).toBe(12);
    expect(budget.headroomGb).toBeGreaterThan(3);
    expect(budget.pressure).toBe('comfortable');
  });

  it('counts distinct agent as resident — tight on 12GB with two 8B', () => {
    const budget = resolveComputeBudget({
      vramPoolGb: 12,
      roles: [
        { role: 'chat', modelName: 'qwen3:8b', parameterSizeB: 8, quantization: 'Q4_K_M' },
        { role: 'agent', modelName: 'qwen2.5-coder:7b', parameterSizeB: 7, quantization: 'Q4_K_M' },
        { role: 'secondary', modelName: null, parameterSizeB: 0, quantization: null },
        { role: 'embed', modelName: 'nomic-embed-text', parameterSizeB: 0, quantization: null },
      ],
    });

    expect(budget.roles.find(r => r.role === 'agent')!.resident).toBe(true);
    expect(budget.residentVramGb).toBeGreaterThan(8);
    expect(['tight', 'critical']).toContain(budget.pressure);
  });

  it('CPU-only → critical pressure', () => {
    const budget = resolveComputeBudget({
      vramPoolGb: 0,
      isCpuOnly: true,
      roles: [
        { role: 'chat', modelName: 'tiny', parameterSizeB: 1.5, quantization: 'Q4_K_M' },
      ],
    });
    expect(budget.pressure).toBe('critical');
  });
});

describe('classifyVramPressure', () => {
  it('comfortable when plenty of headroom', () => {
    expect(classifyVramPressure({
      vramPoolGb: 24, headroomGb: 10, headroomRatio: 10 / 24,
    })).toBe('comfortable');
  });

  it('tight near the floor', () => {
    expect(classifyVramPressure({
      vramPoolGb: 12, headroomGb: 2, headroomRatio: 2 / 12,
    })).toBe('tight');
  });

  it('critical when almost full', () => {
    expect(classifyVramPressure({
      vramPoolGb: 12, headroomGb: 0.5, headroomRatio: 0.04,
    })).toBe('critical');
  });
});

describe('classifyTierFromBudget', () => {
  it('8B on 12GB → standard (model size class)', () => {
    expect(classifyTierFromBudget({
      modelSizeB: 8,
      vramPoolGb: 12,
      gpuCount: 1,
      isCpuOnly: false,
      chatEstimatedVramGb: 5,
      pressure: 'comfortable',
    })).toBe('standard');
  });

  it('does not demote large models just because VRAM is tight', () => {
    // 70B class stays max — pressure is advisory, not a throttle
    expect(classifyTierFromBudget({
      modelSizeB: 70,
      vramPoolGb: 12,
      gpuCount: 1,
      isCpuOnly: false,
      chatEstimatedVramGb: 40,
      pressure: 'critical',
    })).toBe('max');
  });

  it('does not demote plus under multi-model tight pressure', () => {
    expect(classifyTierFromBudget({
      modelSizeB: 32,
      vramPoolGb: 24,
      gpuCount: 1,
      isCpuOnly: false,
      chatEstimatedVramGb: 18,
      pressure: 'tight',
    })).toBe('plus');
  });

  it('CPU-only → micro', () => {
    expect(classifyTierFromBudget({
      modelSizeB: 32,
      vramPoolGb: 0,
      gpuCount: 0,
      isCpuOnly: true,
      chatEstimatedVramGb: 0,
      pressure: 'critical',
    })).toBe('micro');
  });

  it('known tiny VRAM → micro even for mid-size models', () => {
    expect(classifyTierFromBudget({
      modelSizeB: 8,
      vramPoolGb: 4,
      gpuCount: 1,
      isCpuOnly: false,
      vramPoolKnown: true,
    })).toBe('micro');
  });

  it('remote unknown VRAM: 8B stays standard (no fake micro from UI GPU)', () => {
    expect(classifyTierFromBudget({
      modelSizeB: 8,
      vramPoolGb: 0,
      gpuCount: 1,
      isCpuOnly: false,
      vramPoolKnown: false,
    })).toBe('standard');
  });
});

describe('resolveComputeBudget — unknown remote pool', () => {
  it('does not invent critical pressure when vramPoolKnown=false', () => {
    const budget = resolveComputeBudget({
      vramPoolGb: 0,
      vramPoolKnown: false,
      roles: [
        { role: 'chat', modelName: 'qwen3:8b', parameterSizeB: 8, quantization: 'Q4_K_M' },
        { role: 'embed', modelName: 'nomic-embed-text', parameterSizeB: 0, quantization: null },
      ],
    });
    expect(budget.pressure).toBe('comfortable');
    expect(budget.vramPoolGb).toBe(0);
    expect(budget.residentVramGb).toBeGreaterThan(0);
  });
});

describe('classifyVramPressure — unknown pool', () => {
  it('unknown remote pool is comfortable (warn via UI copy, not critical spam)', () => {
    expect(classifyVramPressure({
      vramPoolGb: 0, headroomGb: 0, headroomRatio: 0, vramPoolKnown: false,
    })).toBe('comfortable');
  });
});

describe('VRAM pressure policy', () => {
  it('classifies pressure for UI observe/warn (budgets never cut in capability-profile)', () => {
    expect(classifyVramPressure({
      vramPoolGb: 24, headroomGb: 2, headroomRatio: 0.08, vramPoolKnown: true,
    })).toBe('critical');
  });
});
