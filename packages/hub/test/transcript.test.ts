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

describe('Transcript.endOpenSessions', () => {
  it('closes every open session of the given kind, and leaves others alone', () => {
    const transcript = new Transcript(openDb(':memory:'));
    const orch1 = transcript.startSession('orchestrator', 'acme', 'orchestrator');
    const orch2 = transcript.startSession('orchestrator', 'beta', 'orchestrator');
    const alreadyEnded = transcript.startSession('orchestrator', 'gamma', 'orchestrator');
    transcript.endSession(alreadyEnded, 'stop', 100);
    const sub = transcript.startSession('subagent', 'acme', 'worker');

    const closed = transcript.endOpenSessions('orchestrator', 'aborted', 500);

    expect(closed).toBe(2);
    const [s1, s2, s3, s4] = transcript.sessions();
    expect(s1).toMatchObject({ id: orch1, endedAt: 500, outcome: 'aborted' });
    expect(s2).toMatchObject({ id: orch2, endedAt: 500, outcome: 'aborted' });
    // Already-ended session keeps its own outcome, and a session of another kind is untouched.
    expect(s3).toMatchObject({ id: alreadyEnded, endedAt: 100, outcome: 'stop' });
    expect(s4).toMatchObject({ id: sub, endedAt: null, outcome: null });
  });

  it('is a no-op when nothing of that kind is open', () => {
    const transcript = new Transcript(openDb(':memory:'));
    expect(transcript.endOpenSessions('orchestrator', 'aborted')).toBe(0);
  });
});
