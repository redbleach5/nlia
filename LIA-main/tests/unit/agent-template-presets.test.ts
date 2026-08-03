import { describe, it, expect } from 'vitest';
import { AGENT_TEMPLATES, getTemplate } from '@/lib/agent/templates';
import { createAgentTaskSchema } from '@/lib/infra/api-validation';

describe('agent template presets', () => {
  describe('AGENT_TEMPLATES', () => {
    it('has 3 templates', () => {
      expect(Object.keys(AGENT_TEMPLATES)).toHaveLength(3);
    });

    it('includes general, researcher, coder', () => {
      expect(Object.keys(AGENT_TEMPLATES)).toEqual(
        expect.arrayContaining(['general', 'researcher', 'coder']),
      );
    });

    it('each template has required fields', () => {
      for (const [name, tmpl] of Object.entries(AGENT_TEMPLATES)) {
        expect(tmpl.name).toBe(name);
        expect(typeof tmpl.label).toBe('string');
        expect(tmpl.maxSteps).toBeGreaterThan(0);
        expect(tmpl.maxDurationSec).toBeGreaterThan(0);
      }
    });

    it('general has null toolWhitelist (all tools)', () => {
      expect(AGENT_TEMPLATES.general.toolWhitelist).toBeNull();
    });

    it('presets do not include removed spawn tools', () => {
      for (const name of ['researcher', 'coder'] as const) {
        const wl = AGENT_TEMPLATES[name].toolWhitelist ?? [];
        expect(wl).not.toContain('spawn_subagent');
        expect(wl).not.toContain('spawn_subagents');
      }
    });

    it('coder has run_command and write_file', () => {
      expect(AGENT_TEMPLATES.coder.toolWhitelist).toContain('run_command');
      expect(AGENT_TEMPLATES.coder.toolWhitelist).toContain('write_file');
    });
  });

  describe('getTemplate', () => {
    it('falls back to general for unknown template', () => {
      expect(getTemplate('planner').name).toBe('general');
    });
  });
});

describe('createAgentTaskSchema', () => {
  it('accepts all 3 template names', () => {
    for (const template of ['general', 'researcher', 'coder']) {
      const result = createAgentTaskSchema.safeParse({
        episodeId: 'ep1',
        goal: 'test',
        template,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects removed templates', () => {
    const result = createAgentTaskSchema.safeParse({
      episodeId: 'ep1',
      goal: 'test',
      template: 'planner',
    });
    expect(result.success).toBe(false);
  });
});
