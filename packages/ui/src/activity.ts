import type { ChatMessage, TeamStatus } from '@agenthub/shared';

/** One line of the chat drawer's "Latest work" block. */
export interface ActivityLine {
  speaker: string;
  text: string;
}

/** Human label for a roster member's working/idle status. */
export function statusLabel(status: TeamStatus): string {
  return status === 'working' ? 'Working' : 'Idle';
}

/**
 * The last `limit` said turns of a work session — the task the manager handed the member, and the
 * member's own replies — oldest first. A tool call and its result carry no readable `content` and
 * are left out, same as the one-on-one chat log does.
 */
export function latestWorkMessages(messages: ChatMessage[], memberName: string, limit = 10): ActivityLine[] {
  const said = messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim(),
  );
  return said.slice(-limit).map((m) => ({
    speaker: m.role === 'user' ? 'Task' : memberName,
    text: String(m.content).trim(),
  }));
}
