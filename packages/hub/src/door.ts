import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ChatMessage, ChatResult, CloudProvider, Tier, ToolCall, ToolDef } from '@agenthub/shared';
import { LoginThrottle } from './auth.js';
import type { Db } from './db.js';
import { ADMIN_USER, hashToken } from './enrollment.js';
import { CLOUD_PROVIDERS, isCloudEndpoint, type ModelGateway, type Route } from './gateway.js';
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

/**
 * The label of the `agent` token a pi run is minted (decision 0050): `pi:<project>/<member id>`,
 * the member part empty when the run has no roster member. The door reads it back to put the run's
 * spend under its project and member, as the built-in loop's is. The prefix is reserved: the
 * owner's `POST /api/tokens` refuses it, so only a pi run ever holds such a label.
 */
export const HARNESS_LABEL_PREFIX = 'pi:';
const HARNESS_LABEL_RE = /^pi:([a-z0-9-]{1,40})\/(.*)$/;

export const harnessTokenLabel = (project: string, memberId: string | undefined): string =>
  `${HARNESS_LABEL_PREFIX}${project}/${memberId ?? ''}`.slice(0, MAX_LABEL_LENGTH);

/** The project and member a harness token's spend belongs to; null for any other token. */
export function harnessAttribution(token: ApiTokenView): { subject: string; memberId: string | null } | null {
  if (token.kind !== 'agent') return null;
  const match = HARNESS_LABEL_RE.exec(token.label);
  if (!match) return null;
  // A label cut at the length limit has lost the end of its member id, so it names no member.
  const full = token.label.length < MAX_LABEL_LENGTH;
  return { subject: match[1]!, memberId: full && match[2] ? match[2] : null };
}

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
   * Revokes every live pi run token. A run cannot outlive the hub process that started it, so at
   * startup any such token is a leftover of a crash, and it is closed rather than left to the owner.
   */
  revokeHarnessTokens(): number {
    return this.db.prepare(
      // `substr` rather than `LIKE`: an exact prefix, with no wildcard or case folding to reason about.
      `UPDATE api_tokens SET revoked_at=? WHERE kind='agent' AND substr(label, 1, ?)=? AND revoked_at IS NULL`,
    ).run(this.now(), HARNESS_LABEL_PREFIX.length, HARNESS_LABEL_PREFIX).changes;
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

/**
 * A tier name's optional route suffix — `agenthub/worker@local`, `@cloud` or `@<provider>` — as the
 * `Route` it asks for (0050). Documented rather than listed in `/v1/models`: it is how a caller with
 * a project's model policy (pi, for one) carries that policy through the door.
 */
function suffixRoute(suffix: string): { route: Route; local?: true } | null {
  if (suffix === 'local') return { route: { prefer: 'local' }, local: true };
  if (suffix === 'cloud') return { route: { prefer: 'cloud' } };
  if (CLOUD_PROVIDERS.includes(suffix as CloudProvider)) return { route: { prefer: 'cloud', provider: suffix as CloudProvider } };
  return null;
}

/**
 * Which tier a request's `model` asks for, and how to route it; null when nothing serves it.
 * `local` marks a request that must not be allowed to fall through to a cloud endpoint — see the
 * capacity check in the route handler.
 */
export function resolveModel(
  registry: NodeRegistry, model: string,
): { tier: Tier; route?: Route; local?: true } | null {
  const at = model.lastIndexOf('@');
  const tier = TIER_MODELS[at > 0 ? model.slice(0, at) : model];
  if (tier) {
    if (at <= 0) return { tier };
    const routed = suffixRoute(model.slice(at + 1));
    return routed ? { tier, ...routed } : null;
  }
  // A concrete id: whatever endpoint is serving it right now fixes both the tier and the route. A
  // cloud id is asked of that provider (and that model); a local id is local-only, because a local
  // endpoint serves what its node loaded and no other node's model is a substitute for it.
  for (const node of registry.online()) {
    for (const ep of node.endpoints) {
      if (ep.model !== model) continue;
      return isCloudEndpoint(ep)
        ? { tier: ep.tier, route: { prefer: 'cloud', provider: ep.provider as CloudProvider, model: ep.model } }
        : { tier: ep.tier, route: { prefer: 'local' }, local: true };
    }
  }
  return null;
}

/** An OpenAI error body. `type` and `code` are what a client branches on; the message is for a human. */
export function openAiError(message: string, type: string, code?: string): { error: Record<string, unknown> } {
  return { error: { message, type, ...(code ? { code } : {}) } };
}

const badRequest = (reply: FastifyReply, message: string): FastifyReply =>
  reply.code(400).send(openAiError(message, 'invalid_request_error'));

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
    // `developer` is what newer OpenAI clients call a system message; it is the same thing here.
    if (m.role === 'system' || m.role === 'developer' || m.role === 'user') {
      messages.push({ role: m.role === 'developer' ? 'system' : m.role, content: text });
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

/** What a bearer amounts to: the token it names, or the status to refuse it with. */
export type BearerVerdict = { token: ApiTokenView } | { status: 401 | 429 };

/**
 * The user-API-token check, shared by the door (`/v1/*`) and the assistant scope (`/api/*` routes
 * `auth.ts` lists, decision 0065): one token store, one lockout counter. A bearer is guessable in
 * exactly the way a password is, so it gets login's lockout on its own counter — a client spraying
 * tokens must not lock the owner out of the UI, or the reverse — and the counter is one, so a
 * guesser cannot double its attempts by alternating between `/v1` and `/api`.
 */
export class TokenGate {
  readonly tokens: ApiTokens;
  private readonly throttle: LoginThrottle;

  constructor(db: Db, now: () => number = Date.now) {
    this.tokens = new ApiTokens(db, now);
    this.throttle = new LoginThrottle(now);
  }

  check(client: string, authorization: string | undefined): BearerVerdict {
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
    // The bearer is checked before the lockout, not after: the throttle exists to stop guessing,
    // and a token that verifies is not a guess. Otherwise one misconfigured client behind a shared
    // address (a NAT, the droplet's proxy) would lock out every other client on it.
    const token = bearer ? this.tokens.verify(bearer) : null;
    // A hit does not clear the client's history the way a successful login does: the lockout only
    // ever refuses bad bearers, so one holder of a valid token must not be able to wipe the
    // counter a guesser on the same address is running up. It expires on its own window.
    if (token) return { token };
    // A blocked client's attempt is refused without being counted, so a spray cannot keep extending
    // its own lockout — the same bargain `POST /api/login` strikes.
    const blocked = this.throttle.blocked(client);
    if (!blocked) this.throttle.fail(client);
    return { status: blocked ? 429 : 401 };
  }
}

export interface DoorOptions {
  /** The token store and lockout `/v1` checks bearers against — the same one the assistant scope uses. */
  gate: TokenGate;
  gateway: ModelGateway;
  registry: NodeRegistry;
  usage: UsageStore;
  /** The clock the `created` stamps run on; tests drive it. */
  now?: () => number;
}

/**
 * The door and the tokens that open it, as one Fastify plugin: `/api/tokens` (the owner's, guarded
 * by `routeAccess`'s default) and `/v1/*` (classified `door`, so the bearer check is here).
 */
export async function door(app: FastifyInstance, opts: DoorOptions): Promise<void> {
  const now = opts.now ?? Date.now;
  const { tokens } = opts.gate;

  /** The token behind a `/v1` request, or null — having already answered 401 with an OpenAI error. */
  const requireToken = (req: FastifyRequest, reply: FastifyReply): ApiTokenView | null => {
    const verdict = opts.gate.check(req.ip, req.headers.authorization);
    if ('token' in verdict) return verdict.token;
    reply.code(verdict.status).send(verdict.status === 429
      ? openAiError('too many bad tokens; try again later', 'invalid_request_error', 'rate_limit_exceeded')
      : openAiError('invalid api token', 'invalid_request_error', 'invalid_api_key'));
    return null;
  };

  // Everything Fastify itself rejects before a handler runs — malformed JSON (400), a body over
  // the limit (413), an unparseable content type (415) — reaches a door client in its own error
  // shape rather than Fastify's. `/api/tokens` is in this same plugin and keeps the hub's shape.
  app.setErrorHandler((raw, req, reply) => {
    const err = raw as { statusCode?: number; code?: string; message?: string };
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    const message = err.message ?? 'internal error';
    if (!req.url.startsWith('/v1/')) return reply.code(status).send({ error: message });
    return reply.code(status).send(openAiError(message, status >= 500 ? 'api_error' : 'invalid_request_error', err.code));
  });

  // A path under `/v1` that is not one of the two routes. It is a real route rather than a
  // not-found handler so that `routeAccess` still classifies it `door`: an unmatched request is
  // denied by the hub's shared hook, and a token holder asking for `/v1/embeddings` deserves the
  // door's own 404, not a bare `unauthorized`.
  app.all('/v1/*', async (req, reply) => {
    if (!requireToken(req, reply)) return reply;
    return reply.code(404).send(openAiError(
      `no route for ${req.method} ${req.url.split('?')[0]}`, 'invalid_request_error', 'unknown_endpoint',
    ));
  });

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
    // Reserved for pi run tokens, whose label books their spend to a project and is swept at startup.
    if (label.startsWith(HARNESS_LABEL_PREFIX)) {
      return reply.code(400).send({ error: `labels starting with ${HARNESS_LABEL_PREFIX} are reserved for harness runs` });
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
      return reply.code(404).send(openAiError(`no model named ${body.model}`, 'invalid_request_error', 'model_not_found'));
    }
    // A concrete local id means local, full stop: `prefer: 'local'` falls back to the cloud for a
    // tier nothing local can serve, which would quietly bill the owner for a model they did not
    // ask for. Refused here instead, before anything is spent.
    if (resolved.local && !opts.gateway.localAvailable(resolved.tier)) {
      return reply.code(503).send(openAiError(
        `no local endpoint is serving ${body.model}${opts.gateway.localModelsPaused(resolved.tier) ? ' (local models paused)' : ''}`,
        'server_error', 'no_capacity',
      ));
    }
    const includeUsage = (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true;

    const id = `chatcmpl-${randomBytes(12).toString('hex')}`;
    const created = Math.floor(now() / 1000);
    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());
    const streaming = body.stream === true;
    // Chunks name the model asked for until the request is over and the gateway says which one
    // actually served it; the closing chunks carry that instead, so a streaming client learns the
    // same thing a non-streaming one reads off `model`.
    const chunk = (payload: Record<string, unknown>, model: string = body.model as string): void => {
      reply.raw.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, ...payload })}\n\n`);
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
      // A pi run's token books its spend to its project and member instead (0050), so it shows in
      // the project's cost like the built-in loop's.
      if (result.usage) {
        const harness = harnessAttribution(token);
        opts.usage.record({
          ...result.usage,
          subject: harness?.subject ?? `door:${token.label}`,
          sessionId: null,
          memberId: harness?.memberId ?? null,
          kind: 'door',
        });
      }
      const usage = wireUsage(result);
      // What actually served the request, which for a tier name is only known now.
      const served = result.usage?.model ?? (body.model as string);
      if (!streaming) {
        return reply.code(200).send({
          id, object: 'chat.completion', created, model: served,
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
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: result.finish }] }, served);
      if (includeUsage) chunk({ choices: [], usage: usage ?? null }, served);
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return reply;
    } catch (err) {
      const message = (err as Error).message;
      // "no capacity" is the hub saying later, not never — the status a client should retry on.
      const status = /no capacity for tier/.test(message) ? 503 : 502;
      const payload = openAiError(message, status === 503 ? 'server_error' : 'api_error');
      if (!streaming) return reply.code(status).send(payload);
      // The head is long gone on a stream, so the error travels as a frame instead of a status.
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return reply;
    }
  });
}
