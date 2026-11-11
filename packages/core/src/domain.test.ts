import { describe, expect, it } from 'vitest';
import { agentDefinitionSchema, budgetSchema, defaultAgent, estimateTokens, ContextManager, assertTransition, JoymindError } from './index.js';

describe('domain contracts', () => {
  it('applies budgets and rejects unknown fields', () => {
    expect(budgetSchema.parse({}).maxSteps).toBe(40);
    expect(() => agentDefinitionSchema.parse({ ...defaultAgent, unexpected: true })).toThrow();
    expect(agentDefinitionSchema.parse(defaultAgent).spec.budget.maxToolCalls).toBe(60);
  });

  it('enforces terminal states and legal resume', () => {
    expect(() => assertTransition('running', 'paused')).not.toThrow();
    expect(() => assertTransition('completed', 'running')).toThrow(JoymindError);
    expect(() => assertTransition('interrupted', 'running')).not.toThrow();
  });
});

describe('ContextManager', () => {
  it('retains system instructions and the current goal under pressure', () => {
    const messages = [
      { role: 'system' as const, content: 'safety' },
      { role: 'user' as const, content: 'original goal' },
      ...Array.from({ length: 100 }, (_, index) => ({ role: 'assistant' as const, content: `-${index}-`.repeat(500) })),
      { role: 'tool' as const, toolCallId: 'last', content: 'recent result' },
    ];
    const result = new ContextManager().build(messages, { streaming: true, toolCalling: true, structuredOutput: false, vision: false, maxContextTokens: 2000 });
    expect(estimateTokens(result)).toBeLessThanOrEqual(2100);
    expect(result[0]?.content).toBe('safety');
    expect(result.some((message) => message.content === 'original goal')).toBe(true);
    expect(result.at(-1)?.content).toBe('recent result');
  });
});
