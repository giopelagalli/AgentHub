// LLM connector factory — picks the right connector based on agent config

const AnthropicConnector = require('./anthropic');
const OllamaConnector = require('./ollama');
const OpenAICompatConnector = require('./openai-compat');

/**
 * Create an LLM connector from a merged config object.
 * @param {{ type: string, model?: string, url?: string, api_key?: string }} config
 * @returns {AnthropicConnector|OllamaConnector|OpenAICompatConnector}
 */
function createConnector(config) {
  // Resolve env-var references like ${ANTHROPIC_API_KEY}
  const resolved = { ...config };
  if (resolved.api_key && typeof resolved.api_key === 'string') {
    const envMatch = resolved.api_key.match(/^\$\{(.+)\}$/);
    if (envMatch) {
      resolved.api_key = process.env[envMatch[1]] || '';
    }
  }

  switch (resolved.type) {
    case 'anthropic':
      return new AnthropicConnector(resolved);

    case 'ollama':
      return new OllamaConnector(resolved);

    case 'openai-compatible':
      return new OpenAICompatConnector(resolved);

    default:
      throw new Error(`Unknown LLM type: "${resolved.type}". Use: anthropic, ollama, or openai-compatible`);
  }
}

module.exports = { createConnector };
