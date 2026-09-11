import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@agenthub/shared';
import { latestWorkMessages, statusLabel } from '../src/activity.js';

describe('statusLabel', () => {
  it('labels working and idle', () => {
    expect(statusLabel('working')).toBe('Working');
    expect(statusLabel('idle')).toBe('Idle');
  });
});

describe('latestWorkMessages', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'you are a coder' },
    { role: 'user', content: 'fix the parser' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', name: 'read_file', arguments: '{}' }] },
    { role: 'tool', tool_call_id: 't1', content: 'file body' },
    { role: 'assistant', content: 'parser fixed' },
    { role: 'assistant', content: '   ' },
  ];

  it('keeps only the said turns, labelling the task and the member', () => {
    expect(latestWorkMessages(messages, 'Ada')).toEqual([
      { speaker: 'Task', text: 'fix the parser' },
      { speaker: 'Ada', text: 'parser fixed' },
    ]);
  });

  it('caps at the given limit, keeping the most recent turns', () => {
    const many: ChatMessage[] = Array.from({ length: 12 }, (_, i) => ({ role: 'assistant', content: `line ${i}` }));
    const result = latestWorkMessages(many, 'Ada', 10);
    expect(result).toHaveLength(10);
    expect(result[0]).toEqual({ speaker: 'Ada', text: 'line 2' });
    expect(result[9]).toEqual({ speaker: 'Ada', text: 'line 11' });
  });

  it('is empty when nothing was said', () => {
    expect(latestWorkMessages([{ role: 'system', content: 'x' }], 'Ada')).toEqual([]);
  });
});
