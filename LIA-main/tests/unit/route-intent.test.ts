import { describe, expect, it } from 'vitest';
import { classifyAgentRoute, hasAgentWorkIntent } from '@/lib/agent/route-intent';

describe('classifyAgentRoute', () => {
  it('routes greetings and thanks to chat', () => {
    expect(classifyAgentRoute('привет')).toBe('chat');
    expect(classifyAgentRoute('спасибо')).toBe('chat');
    expect(classifyAgentRoute('ок')).toBe('chat');
    expect(classifyAgentRoute('как дела')).toBe('chat');
  });

  it('routes clear agent / create tasks to agent', () => {
    expect(classifyAgentRoute('напиши игру тетрис')).toBe('agent');
    expect(classifyAgentRoute('создай сайт-лендинг на HTML')).toBe('agent');
    expect(classifyAgentRoute('почини баг в index.ts')).toBe('agent');
    expect(classifyAgentRoute('проанализируй код проекта')).toBe('agent');
  });

  it('routes short ambiguous prompts to ask', () => {
    expect(classifyAgentRoute('помоги')).toBe('ask');
    expect(classifyAgentRoute('что дальше')).toBe('ask');
    expect(classifyAgentRoute('нужна помощь')).toBe('ask');
  });

  it('routes who-are-you / acquaintance to chat, not agent confirm', () => {
    expect(classifyAgentRoute('кто ты')).toBe('chat');
    expect(classifyAgentRoute('Привет. Кто ты?')).toBe('chat');
    expect(classifyAgentRoute('расскажи о себе')).toBe('chat');
  });

  it('routes short simple questions to chat without confirm', () => {
    expect(classifyAgentRoute('Что такое TypeScript?')).toBe('chat');
  });

  it('trusts agent mode for longer non-trivial asks', () => {
    const goal =
      'Разберись почему сборка падает после обновления зависимостей и предложи план фикса без лишних правок';
    expect(classifyAgentRoute(goal)).toBe('agent');
  });
});

describe('hasAgentWorkIntent', () => {
  it('routes HTML/file creation to agent (auto-route parity)', () => {
    expect(hasAgentWorkIntent('напиши минимальный HTML файл hello.html с заголовком Hello')).toBe(true);
    expect(classifyAgentRoute('напиши минимальный HTML файл hello.html с заголовком Hello')).toBe('agent');
  });
});
