/**
 * Every session's tool-call budget, in one place. A budget is a product decision — how much room a
 * kind of session gets to orient, act and report — not a call-site detail, and an orchestrator turn
 * that cannot both read its bundle and delegate never reaches the point of reporting.
 */
export const ORCHESTRATOR_TOOL_CALLS = 40;
/** Tool calls an orchestrator turn keeps in reserve at the end, so it notices and publishes a briefing. */
export const BRIEFING_RESERVE = 5;
export const SUBAGENT_TOOL_CALLS = 25;
export const ASSISTANT_TOOL_CALLS = 8;
export const MASTER_COMMAND_TOOL_CALLS = 8;
export const CHAT_TOOL_CALLS = 6;
/** A document persona reads its document, edits it and checks the result — more room than a chat. */
export const DOC_PERSONA_TOOL_CALLS = 8;
/**
 * *Refresh map* has to read its way around a codebase before it can chart one — the digest names
 * the files, but the chapters and the line numbers come from opening them — so it gets far more
 * room than a chat and still less than a turn, which also has work to delegate.
 */
export const CODE_MAP_TOOL_CALLS = 20;
