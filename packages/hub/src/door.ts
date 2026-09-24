import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ChatMessage, ChatResult, CloudProvider, Tier, ToolCall, ToolDef } from '@agenthub/shared';
import { LoginThrottle } from './auth.js';
import type { Db } from './db.js';
import { ADMIN_USER, hashToken } from './enrollment.js';
import { isCloudEndpoint, type ModelGateway, type Route } from './gateway.js';
import type { NodeRegistry } from './node-registry.js';
import type { UsageStore } from './usage.js';

/**
 * The hub's OpenAI-compatible door (PRD FR-D6/FR-D7): `POST /v1/chat/completions` and
 * `GET /v1/models`, opened by a user API token rather than the owner's session cookie, so JD, pi,
 * curl and any other OpenAI client reach the same gateway, the same routing and the same ledger as
 * everything else. The tokens themselves are minted from `/api/tokens`, which is the owner's.
 *
 * Nothing here talks to a model: a request is validated, turned into the hub's own `ChatMessage[]`
 * and handed to `ModelGateway.chat`, and its `ChatResult` is turned back into the OpenAI wire
 * shape. The one thing the door decides is priority — see `KIND_PRIORITY`.
 */

/** What a token is for. It is the whole of the door's authorization model until accounts land. */
export type TokenKind = 'assistant' | 'agent';
export const TOKEN_KINDS: TokenKind[] = ['assistant', 'agent'];

/**
 * 0020's priority tiers, the owner's half: their assistant goes first, their agents yield to it.
 * The guest rows (15 / 20) arrive with accounts in Phase F, when a token names a user other than
 * the admin. 0 is vLLM's own default, and is sent as no field at all — see `priorityFor`.
 */
export const KIND_PRIORITY: Record<TokenKind, number> = { assistant: 0, agent: 10 };

/** The priority the gateway should send for `kind`; null asks it to send no `priority` field. */
export const priorityFor = (kind: TokenKind): number | null =>
  KIND_PRIORITY[kind] === 0 ? null : KIND_PRIORITY[kind];

/** Bytes behind an API token — 48 hex characters, like a node token; it is pasted, never typed. */
const API_TOKEN_BYTES = 24;
/** Marks the string as one of ours wherever it turns up — a log, a config file, a leaked gist. */
export const API_TOKEN_PREFIX = 'ah_';
/** Long enough to say what the token is for, short enough to be a usage subject and a table cell. */
export const MAX_LABEL_LENGTH = 64;

export const newApiToken = (): string => `${API_TOKEN_PREFIX}${randomBytes(API_TOKEN_BYTES).toString('hex')}`;

/** One token as the owner sees it — never its hash, and never its plaintext after the mint. */
export interface ApiTokenView {
  id: number;
  user: string;
  kind: TokenKind;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** A freshly minted token: the view plus the one and only look at the plaintext. */
export interface MintedApiToken extends ApiTokenView {
  token: string;
}

interface TokenRow {
  id: number; user: string; kind: string; label: string; created_at: number; last_used_at: number | null;
}

const viewOf = (row: TokenRow): ApiTokenView => ({
  id: row.id, user: row.user, kind: row.kind as TokenKind, label: row.label,
  createdAt: row.created_at, lastUsedAt: row.last_used_at,
});

/**
 * The user API tokens the door accepts. Stored exactly like node tokens (`enrollment.ts`): the
 * plaintext is returned once at mint and only its sha256 is kept, so the table is worth nothing to
 * a reader. Revocation is a timestamp rather than a delete, so a revoked token's history — what it
 * was called, when it last spoke — survives in the ledger's subjects.
 */
export class ApiTokens {
  constructor(private db: Db, private now: () => number = Date.now) {}

  mint(user: string, kind: TokenKind, label: string): MintedApiToken {
    const token = newApiToken();
    const createdAt = this.now();
    const res = this.db.prepare(
      `INSERT INTO api_tokens (user, kind, label, token_hash, created_at) VALUES (?,?,?,?,?)`,
    ).run(user, kind, label, hashToken(token), createdAt);
    return { id: Number(res.lastInsertRowid), user, kind, label, createdAt, lastUsedAt: null, token };
  }

  /** Every live token of `user`, newest first. Revoked ones are gone from the owner's list. */
  list(user: string): ApiTokenView[] {
    const rows = this.db.prepare(
      `SELECT id, user, kind, label, created_at, last_used_at FROM api_tokens
        WHERE user=? AND revoked_at IS NULL ORDER BY created_at DESC, id DESC`,
    ).all(user) as TokenRow[];
    return rows.map(viewOf);
  }

  /** Revokes `id` if it is `user`'s and still live; false when it is neither. */
  revoke(id: number, user: string): boolean {
    return this.db.prepare(`UPDATE api_tokens SET revoked_at=? WHERE id=? AND user=? AND revoked_at IS NULL`)
      .run(this.now(), id, user).changes > 0;
  }

  /**
   * Who `token` speaks for, or null when it is unknown or revoked — one answer for both, so a
   * caller cannot tell a revoked token from a made-up one. A hit stamps `last_used_at`, which is
   * the only thing that says whether a token in the list is still in use.
   */
  verify(token: string): ApiTokenView | null {
    if (!token) return null;
    const row = this.db.prepare(
      `SELECT id, user, kind, label, created_at, last_used_at FROM api_tokens
        WHERE token_hash=? AND revoked_at IS NULL`,
    ).get(hashToken(token)) as TokenRow | undefined;
    if (!row) return null;
    this.db.prepare(`UPDATE api_tokens SET last_used_at=? WHERE id=?`).run(this.now(), row.id);
    return viewOf(row);
  }
}

/** The two model names the door advertises: a tier, not a model, so routing stays the hub's call. */
export const TIER_MODELS: Record<string, Tier> = {
  'agenthub/orchestrator': 'orchestrator',
  'agenthub/worker': 'worker',
};

/** Which tier a request's `model` asks for, and how to route it; null when nothing serves it. */
export function resolveModel(registry: NodeRegistry, model: string): { tier: Tier; route?: Route } | null {
  const tier = TIER_MODELS[model];
  if (tier) return { tier };
  // A concrete id: whatever endpoint is serving it right now fixes both the tier and the route. A
  // cloud id is asked of that provider (and that model); a local id is local-only, because a local
  // endpoint serves what its node loaded and no other node's model is a substitute for it.
  for (const node of registry.online()) {
    for (const ep of node.endpoints) {
      if (ep.model !== model) continue;
      return isCloudEndpoint(ep)
        ? { tier: ep.tier, route: { prefer: 'cloud', provider: ep.provider as CloudProvider, model: ep.model } }
        : { tier: ep.tier, route: { prefer: 'local' } };
    }
  }
  return null;
}

/** An OpenAI error body. `type` and `code` are what a client branches on; the message is for a human. */
function errorBody(message: string, type: string, code?: string): { error: Record<string, unknown> } {
  return { error: { message, type, ...(code ? { code } : {}) } };
}

const badRequest = (reply: FastifyReply, message: string): FastifyReply =>
  reply.code(400).send(errorBody(message, 'invalid_request_error'));

/**
 * One message's text. A string is itself; the content-parts array every newer client sends is
 * joined; anything else (an image part, a number) is null, which the caller turns into a 400 rather
 * than silently dropping what the user asked about.
 */
function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (!Array.isArray(content)) return null;
  let out = '';
  for (const part of content) {
    const p = part as { type?: unknown; text?: unknown } | null;
    if (!p || typeof p !== 'object' || p.type !== 'text' || typeof p.text !== 'string') return null;
    out += p.text;
  }
  return out;
}

/** The wire's `tool_calls` → ours: `{ id, name, arguments }`, arguments left as the JSON text. */
function toToolCalls(raw: unknown): ToolCall[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: ToolCall[] = [];
  for (const entry of raw) {
    const tc = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } } | null;
    if (!tc || typeof tc !== 'object' || typeof tc.id !== 'string') return null;
    const fn = tc.function;
    if (!fn || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') return null;
    out.push({ id: tc.id, name: fn.name, arguments: fn.arguments });
  }
  return out;
}

/** The wire's `messages` → the hub's `ChatMessage[]`, or the reason it is not a valid request. */
export function toChatMessages(raw: unknown): { messages: ChatMessage[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'messages must be a non-empty array' };
  const messages: ChatMessage[] = [];
  for (const entry of raw) {
    const m = entry as { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown } | null;
    if (!m || typeof m !== 'object' || typeof m.role !== 'string') return { error: 'each message needs a role' };
    const text = textOf(m.content);
    if (text === null) return { error: `unsupported content on a ${m.role} message` };
    if (m.role === 'system' || m.role === 'user') {
      messages.push({ role: m.role, content: text });
      continue;
    }
    if (m.role === 'assistant') {
      const toolCalls = toToolCalls(m.tool_calls);
      if (!toolCalls) return { error: 'invalid assistant tool_calls' };
      messages.push({ role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string') return { error: 'a tool message needs a tool_call_id' };
      messages.push({ role: 'tool', tool_call_id: m.tool_call_id, content: text });
      continue;
    }
    return { error: `unknown role: ${m.role}` };
  }
  return { messages };
}

/** The wire's `tools` → the hub's `ToolDef[]`, or the reason it is not a valid request. */
export function toToolDefs(raw: unknown): { tools: ToolDef[] } | { error: string } {
  if (raw === undefined) return { tools: [] };
  if (!Array.isArray(raw)) return { error: 'tools must be an array' };
  const tools: ToolDef[] = [];
  for (const entry of raw) {
    const t = entry as { type?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } } | null;
    const fn = t?.function;
    if (!t || t.type !== 'function' || !fn || typeof fn.name !== 'string') {
      return { error: "each tool must be {type:'function', function:{name, parameters}}" };
    }
    tools.push({
      type: 'tool', name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: (fn.parameters ?? {}) as Record<string, unknown>,
    });
  }
  return { tools };
}

/** Our `ToolCall[]` → the wire's `function` envelope, as a finished message carries them. */
const wireToolCalls = (calls: ToolCall[]): unknown[] =>
  calls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }));

/** The same, in a stream delta, where every entry is also numbered so fragments can be assembled. */
const wireToolCallDeltas = (calls: ToolCall[]): unknown[] =>
  wireToolCalls(calls).map((tc, index) => ({ index, ...(tc as object) }));

/** A `ChatResult`'s usage as the wire reports it; undefined when the endpoint reported none. */
function wireUsage(result: ChatResult): Record<string, unknown> | undefined {
  if (!result.usage) return undefined;
  const { promptTokens, cachedTokens, completionTokens } = result.usage;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: cachedTokens },
  };
}

export interface DoorOptions {
  db: Db;
  gateway: ModelGateway;
  registry: NodeRegistry;
  usage: UsageStore;
  /** The clock the throttle and the token timestamps run on; tests drive it. */
  now?: () => number;
}

/**
 * The door and the tokens that open it, as one Fastify plugin: `/api/tokens` (the owner's, guarded
 * by `routeAccess`'s default) and `/v1/*` (classified `door`, so the bearer check is here).
 */
export async function door(app: FastifyInstance, opts: DoorOptions): Promise<void> {
  const now = opts.now ?? Date.now;
  const tokens = new ApiTokens(opts.db, now);
  // A bearer is guessable in exactly the way a password is, so it gets login's lockout on its own
  // counter: a client spraying tokens must not lock the owner out of the UI, or the reverse.
  const throttle = new LoginThrottle(now);

  /** The token behind a `/v1` request, or null — having already answered 401 with an OpenAI error. */
  const requireToken = (req: FastifyRequest, reply: FastifyReply): ApiTokenView | null => {
    const client = req.ip;
    if (throttle.blocked(client)) {
      reply.code(429).send(errorBody('too many bad tokens; try again later', 'invalid_request_error', 'rate_limit_exceeded'));
      return null;
    }
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const token = bearer ? tokens.verify(bearer) : null;
    if (!token) {
      throttle.fail(client);
      reply.code(401).send(errorBody('invalid api token', 'invalid_request_error', 'invalid_api_key'));
      return null;
    }
    throttle.succeed(client);
    return token;
  };

  // --- the owner's token routes -------------------------------------------------

  app.post('/api/tokens', async (req, reply) => {
    const body = req.body as Partial<{ kind: unknown; label: unknown }> | undefined;
    const kind = body?.kind;
    if (typeof kind !== 'string' || !TOKEN_KINDS.includes(kind as TokenKind)) {
      return reply.code(400).send({ error: `kind must be one of ${TOKEN_KINDS.join(', ')}` });
    }
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    if (!label || label.length > MAX_LABEL_LENGTH) {
      return reply.code(400).send({ error: `label must be 1-${MAX_LABEL_LENGTH} characters` });
    }
    // `user` is the admin until accounts land (PRD FR-F1); the column is already here for them.
    return reply.code(201).send(tokens.mint(ADMIN_USER, kind as TokenKind, label));
  });

  app.get('/api/tokens', async () => ({ tokens: tokens.list(ADMIN_USER) }));

  app.delete('/api/tokens/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid token id' });
    if (!tokens.revoke(id, ADMIN_USER)) return reply.code(404).send({ error: 'unknown token' });
    return { ok: true };
  });

  // --- the door -----------------------------------------------------------------

  app.get('/v1/models', async (req, reply) => {
    if (!requireToken(req, reply)) return reply;
    const created = Math.floor(now() / 1000);
    return {
      object: 'list',
      data: Object.keys(TIER_MODELS).map((id) => ({ id, object: 'model', created, owned_by: 'agenthub' })),
    };
  });

  app.post('/v1/chat/completions', async (req, reply) => {
    const token = requireToken(req, reply);
    if (!token) return reply;
    const body = req.body as Partial<{ model: unknown; messages: unknown; tools: unknown; stream: unknown; stream_options: unknown }> | undefined;
    if (typeof body?.model !== 'string') return badRequest(reply, 'model is required');
    const parsed = toChatMessages(body.messages);
    if ('error' in parsed) return badRequest(reply, parsed.error);
    const toolDefs = toToolDefs(body.tools);
    if ('error' in toolDefs) return badRequest(reply, toolDefs.error);
    if (body.stream !== undefined && typeof body.stream !== 'boolean') return badRequest(reply, 'stream must be a boolean');
    const resolved = resolveModel(opts.registry, body.model);
    if (!resolved) {
      return reply.code(404).send(errorBody(`no model named ${body.model}`, 'invalid_request_error', 'model_not_found'));
    }
    const includeUsage = (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true;

    const id = `chatcmpl-${randomBytes(12).toString('hex')}`;
    const created = Math.floor(now() / 1000);
    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());
    const streaming = body.stream === true;
    const chunk = (payload: Record<string, unknown>): void => {
      reply.raw.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model as string, ...payload })}\n\n`);
    };

    if (streaming) {
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      chunk({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    }

    try {
      const result = await opts.gateway.chat(resolved.tier, parsed.messages, {
        ...(streaming ? { onToken: (t: string) => chunk({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] }) } : {}),
        ...(toolDefs.tools.length ? { tools: toolDefs.tools } : {}),
        ...(resolved.route ? { route: resolved.route } : {}),
        priorityOverride: priorityFor(token.kind),
        signal: ac.signal,
      });
      // The door's own row in the hub's one ledger, so the cost chip and the daily cloud cap see an
      // outside client exactly as they see a project turn.
      if (result.usage) {
        opts.usage.record({ ...result.usage, subject: `door:${token.label}`, sessionId: null, memberId: null, kind: 'door' });
      }
      const usage = wireUsage(result);
      if (!streaming) {
        return reply.code(200).send({
          id, object: 'chat.completion', created, model: result.usage?.model ?? (body.model as string),
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: result.content,
              ...(result.toolCalls.length ? { tool_calls: wireToolCalls(result.toolCalls) } : {}),
            },
            finish_reason: result.finish,
          }],
          ...(usage ? { usage } : {}),
        });
      }
      // The gateway hands tool calls back assembled rather than fragment by fragment, so they leave
      // as one delta. A client that concatenates fragments reads it the same way.
      if (result.toolCalls.length) {
        chunk({ choices: [{ index: 0, delta: { tool_calls: wireToolCallDeltas(result.toolCalls) }, finish_reason: null }] });
      }
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: result.finish }] });
      if (includeUsage) chunk({ choices: [], usage: usage ?? null });
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return reply;
    } catch (err) {
      const message = (err as Error).message;
      // "no capacity" is the hub saying later, not never — the status a client should retry on.
      const status = /no capacity for tier/.test(message) ? 503 : 502;
      const payload = errorBody(message, status === 503 ? 'server_error' : 'api_error');
      if (!streaming) return reply.code(status).send(payload);
      // The head is long gone on a stream, so the error travels as a frame instead of a status.
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return reply;
    }
  });
}
