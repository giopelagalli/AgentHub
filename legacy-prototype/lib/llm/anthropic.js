// Anthropic Messages API connector (streaming)

class AnthropicConnector {
  constructor(config = {}) {
    this.apiKey = config.api_key || process.env.ANTHROPIC_API_KEY;
    this.model = config.model || 'claude-sonnet-4-20250514';
    this.baseUrl = (config.url || 'https://api.anthropic.com').replace(/\/+$/, '');

    if (!this.apiKey) {
      this._noKey = true;
      console.warn('AnthropicConnector: No API key set. Agent will appear but chatting will fail until key is configured.');
    }
  }

  /**
   * Stream a chat completion.
   * @param {Array<{role:string, content:string}>} messages
   * @param {string} systemPrompt
   * @yields {{ text: string, done: boolean }}
   */
  async *stream(messages, systemPrompt) {
    if (this._noKey) {
      throw new Error('No API key configured. Set ANTHROPIC_API_KEY in .env or add api_key to this agent in agents.yaml');
    }

    const body = {
      model: this.model,
      max_tokens: 4096,
      stream: true,
      messages: messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'system' ? 'user' : m.role, // Anthropic uses system param
        content: m.content,
      })),
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    // Ensure messages alternate user/assistant; collapse if needed
    const cleaned = [];
    for (const m of body.messages) {
      if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === m.role) {
        cleaned[cleaned.length - 1].content += '\n' + m.content;
      } else {
        cleaned.push({ ...m });
      }
    }
    // Anthropic requires first message to be 'user'
    if (cleaned.length > 0 && cleaned[0].role !== 'user') {
      cleaned.unshift({ role: 'user', content: '(continued)' });
    }
    body.messages = cleaned;

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${errText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;

        try {
          const event = JSON.parse(raw);

          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            yield { text: event.delta.text, done: false };
          }

          if (event.type === 'message_stop') {
            yield { text: '', done: true };
            return;
          }
        } catch {
          // skip malformed JSON
        }
      }
    }

    yield { text: '', done: true };
  }

  /** Non-streaming single response */
  async complete(messages, systemPrompt) {
    let full = '';
    for await (const chunk of this.stream(messages, systemPrompt)) {
      full += chunk.text;
    }
    return full;
  }
}

module.exports = AnthropicConnector;
