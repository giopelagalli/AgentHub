import type { Tool } from '../agents/tools.js';
import type { ConfirmationGate } from '../assistant/confirm.js';
import type { ToolAudit } from './audit.js';
import { geminiTools } from './gemini.js';
import { searchTools, type SearchProvider } from './search.js';
import { xaiTools } from './xai.js';

/** Every external call is bounded by this; a cloud API that stalls must not hang an agent turn. */
export const DEFAULT_EXTERNAL_TIMEOUT_MS = 15_000;

export interface ExternalOptions {
  /** `XAI_API_KEY`. Without it, grok_query and post_to_x do not exist. */
  xaiKey?: string;
  /** `GEMINI_API_KEY`. Without it, youtube_understand does not exist. */
  geminiKey?: string;
  /** `SEARCH_PROVIDER` + `SEARCH_API_KEY`. Without both, web_search does not exist. */
  search?: { provider: SearchProvider; key: string };
  /** `X_API_KEY` — posting to X uses the X API, not xAI's; absent, the xAI key is tried. */
  xPostKey?: string;
  models?: { xai?: string; gemini?: string };
  /** Test seam: point each service at a local fake so no test ever reaches the internet. */
  baseUrls?: { xaiChat?: string; xPost?: string; gemini?: string; search?: string };
  timeoutMs?: number;
}

export interface ExternalToolsDeps {
  audit: ToolAudit;
  /** Present for the owner's assistant only: without a gate, the outward post_to_x is not offered. */
  gate?: ConfirmationGate;
  options?: ExternalOptions;
  log?: (line: string) => void;
}

/**
 * The complete set of calls AgentHub is allowed to make to the outside world (PRD §12). Agents have
 * no generic fetch tool: if a capability is not one of these tools, it cannot leave the machine.
 *
 * A tool whose key is missing is simply not built — the hub says so once at startup and runs on.
 */
export function externalTools(deps: ExternalToolsDeps): Tool[] {
  const opts = deps.options ?? {};
  const log = deps.log ?? ((line: string) => console.log(line));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
  const tools: Tool[] = [];

  if (opts.xaiKey) {
    tools.push(...xaiTools({
      audit: deps.audit, apiKey: opts.xaiKey, timeoutMs,
      ...(deps.gate ? { gate: deps.gate } : {}),
      ...(opts.xPostKey ? { postKey: opts.xPostKey } : {}),
      ...(opts.models?.xai ? { model: opts.models.xai } : {}),
      ...(opts.baseUrls?.xaiChat ? { chatUrl: opts.baseUrls.xaiChat } : {}),
      ...(opts.baseUrls?.xPost ? { postUrl: opts.baseUrls.xPost } : {}),
    }));
  } else {
    log('[external] XAI_API_KEY not set; grok_query and post_to_x are disabled');
  }

  if (opts.geminiKey) {
    tools.push(...geminiTools({
      audit: deps.audit, apiKey: opts.geminiKey, timeoutMs,
      ...(opts.models?.gemini ? { model: opts.models.gemini } : {}),
      ...(opts.baseUrls?.gemini ? { baseUrl: opts.baseUrls.gemini } : {}),
    }));
  } else {
    log('[external] GEMINI_API_KEY not set; youtube_understand is disabled');
  }

  if (opts.search) {
    tools.push(...searchTools({
      audit: deps.audit, provider: opts.search.provider, apiKey: opts.search.key, timeoutMs,
      ...(opts.baseUrls?.search ? { baseUrl: opts.baseUrls.search } : {}),
    }));
  } else {
    log('[external] SEARCH_API_KEY/SEARCH_PROVIDER not set; web_search is disabled');
  }

  return tools;
}

export { ToolAudit, type ToolAuditRow, AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT } from './audit.js';
export { SEARCH_PROVIDERS, type SearchProvider } from './search.js';
