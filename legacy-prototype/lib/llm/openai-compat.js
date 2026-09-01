// OpenAI-compatible API connector (LM Studio, vLLM, text-gen-webui, etc.)

class OpenAICompatConnector {
  constructor(config = {}) {
    this.model = config.model || 'default';
    this.baseUrl = (config.url || 'http://localhost:8080').replace(/\/+$/, '');
    this.apiKey = config.api_key || 'no-key'; // many local servers don't need one
  }

  /**
   * Stream a chat completion via OpenAI-compatible /v1/chat/completions
   * @param {Array<{role:string, content:string}>} messages
   * @param {string} systemPrompt
   * @yields {{ text: string, done: boolean }}
   */
  async *stream(messages, systemPrompt) {
    const allMessages = [];

    if (systemPrompt) {
      allMessages.push({ role: 'system', content: systemPrompt });
    }

    for (const m of messages) {
      allMessages.push({ role: m.role, content: m.content });
    }

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: allMessages,
        stream: true,
        max_tokens: 4096,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI-compatible API ${res.status}: ${errText}`);
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
        if (raw === '[DONE]') {
          yield { text: '', done: true };
          return;
        }
        try {
          const data = JSON.parse(raw);
          const delta = data.choices?.[0]?.delta?.content;
          if (delta) {
            yield { text: delta, done: false };
          }
          if (data.choices?.[0]?.finish_reason) {
            yield { text: '', done: true };
            return;
          }
        } catch {
          // skip
        }
      }
    }

    yield { text: '', done: true };
  }

  async complete(messages, systemPrompt) {
    let full = '';
    for await (const chunk of this.stream(messages, systemPrompt)) {
      full += chunk.text;
    }
    return full;
  }
}

module.exports = OpenAICompatConnector;
