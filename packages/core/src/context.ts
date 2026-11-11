import type { ModelCapabilities, ModelMessage } from './types.js';

export function estimateTokens(messages: ModelMessage[]): number {
  return Math.ceil(messages.reduce((sum, message) => sum + message.content.length + JSON.stringify(message.toolCalls ?? []).length, 0) / 4);
}

export class ContextManager {
  build(messages: ModelMessage[], capabilities: ModelCapabilities): ModelMessage[] {
    const limit = Math.max(1000, (capabilities.maxContextTokens ?? 32000) - 2000);
    if (estimateTokens(messages) <= limit) return messages;
    const system = messages.filter((message) => message.role === 'system');
    const nonSystem = messages.filter((message) => message.role !== 'system');
    const selected: ModelMessage[] = [];
    let total = estimateTokens(system);
    for (let index = nonSystem.length - 1; index >= 0; index -= 1) {
      const message = nonSystem[index];
      if (!message) continue;
      const cost = estimateTokens([message]);
      if (total + cost > limit) break;
      selected.unshift(message);
      total += cost;
    }
    const firstUser = nonSystem.find((message) => message.role === 'user');
    if (firstUser && !selected.includes(firstUser)) selected.unshift(firstUser);
    if (selected.length < nonSystem.length) {
      selected.unshift({ role: 'system', content: `Earlier context omitted: ${nonSystem.length - selected.length} messages. Resolve missing details from current artifacts rather than assuming them.` });
    }
    return [...system, ...selected];
  }
}
