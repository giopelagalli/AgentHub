import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { Transcript } from '../src/agents/transcript.js';

describe('Transcript.lastMessage', () => {
  it('returns the tail of the last non-blank message, trimmed', () => {
    const transcript = new Transcript(openDb(':memory:'));
    const session = transcript.startSession('subagent', 'demo', 'worker');
    transcript.append(session, { role: 'user', content: 'do the thing' });
    transcript.append(session, { role: 'assistant', content: '  editing the parser  ' });

    expect(transcript.lastMessage(session)).toBe('editing the parser');
  });

  it('skips a blank final message and event rows', () => {
    const transcript = new Transcript(openDb(':memory:'));
    const session = transcript.startSession('subagent', 'demo', 'worker');
    transcript.append(session, { role: 'assistant', content: 'the real answer' });
    // A tool-call assistant turn often carries no content; a following event (e.g. a gateway error)
    // must not read as the "last message" either — only role<>'event' rows with real text count.
    transcript.append(session, { role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'x', arguments: '{}' }] });
    transcript.appendEvent(session, 'gateway error: boom');

    expect(transcript.lastMessage(session)).toBe('the real answer');
  });

  it('is empty for a session with nothing said yet', () => {
    const transcript = new Transcript(openDb(':memory:'));
    const session = transcript.startSession('subagent', 'demo', 'worker');
    expect(transcript.lastMessage(session)).toBe('');
  });
});
