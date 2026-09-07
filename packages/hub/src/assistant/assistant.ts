import type { ChatMessage } from '@agenthub/shared';
import type { AgentLoop } from '../agents/loop.js';
import type { Tool } from '../agents/tools.js';
import type { Transcript } from '../agents/transcript.js';
import type { ConfirmationGate, PendingAction } from './confirm.js';
import type { MemoryStore } from './memory.js';
import type { Planner } from './planner.js';

const KIND = 'assistant';
const SUBJECT = 'owner';
const HISTORY_TURNS = 20;
const MAX_TOOL_CALLS = 8;

export interface AssistantDeps {
  loop: AgentLoop;
  tools: Tool[];
  memory: MemoryStore;
  planner: Planner;
  gate: ConfirmationGate;
  transcript: Transcript;
}

export interface AssistantReply {
  text: string;
  /** Outward actions this reply proposed; nothing happens until the owner confirms them. */
  pending: PendingAction[];
}

function systemPrompt(memoryIndex: string, plannerSnapshot: string): string {
  return [
    `You are the owner's personal assistant inside AgentHub. You work for one person — the owner —`,
    `and for nobody else. Address them directly and take their side.`,
    ``,
    `The memory index and the planner below are in every prompt: always read them before you answer,`,
    `and call recall to open a note in full when its index line is not enough. Never guess at`,
    `something memory could tell you.`,
    ``,
    `When you learn something durable about the owner — a preference, a person in their life, a`,
    `routine, a standing goal — call remember to write it down. Passing chatter is not worth a note.`,
    ``,
    `Your replies are read on Telegram: a few sentences, no headings, no tables. Say what you did and`,
    `what you need from them. Ask before assuming.`,
    ``,
    `# Memory index`,
    memoryIndex.trim(),
    ``,
    `# Planner`,
    plannerSnapshot.trim(),
  ].join('\n');
}

/**
 * The owner's assistant: one bounded tool-use session per message, over a conversation that rolls
 * across restarts because it is read back out of the transcript rather than held in memory.
 */
export class Assistant {
  constructor(private deps: AssistantDeps) {}

  async reply(text: string, opts: { onToken?: (t: string) => void } = {}): Promise<AssistantReply> {
    const [memoryIndex, plannerSnapshot] = await Promise.all([
      this.deps.memory.indexText(),
      this.deps.planner.snapshot(),
    ]);
    // Snapshot the gate before the turn so the reply reports the actions *this* message proposed,
    // not whatever the owner has left un-confirmed from earlier ones.
    const before = new Set(this.deps.gate.pending().map((a) => a.id));

    const result = await this.deps.loop.run({
      kind: KIND, subject: SUBJECT, tier: 'orchestrator',
      system: systemPrompt(memoryIndex, plannerSnapshot),
      history: this.history(),
      user: text,
      tools: this.deps.tools,
      ctx: {},
      maxToolCalls: MAX_TOOL_CALLS,
      ...(opts.onToken ? { onToken: opts.onToken } : {}),
    });

    return { text: result.text.trim(), pending: this.deps.gate.pending().filter((a) => !before.has(a.id)) };
  }

  /**
   * The last 20 turns of the owner's conversation, replayed to the model as context.
   *
   * Only plain user and assistant turns come back: a tool call and its result are one session's
   * internal working, and replaying half of that pair would leave a call no result answers.
   */
  private history(): ChatMessage[] {
    const { transcript } = this.deps;
    const sessions = transcript.sessions({ kind: KIND, subject: SUBJECT }).slice(-HISTORY_TURNS);
    const turns: ChatMessage[] = [];
    for (const session of sessions) {
      for (const msg of transcript.messages(session.id)) {
        if (msg.role === 'user') turns.push(msg);
        else if (msg.role === 'assistant' && !msg.tool_calls && msg.content?.trim()) {
          turns.push({ role: 'assistant', content: msg.content });
        }
      }
    }
    return turns.slice(-HISTORY_TURNS * 2);
  }
}
