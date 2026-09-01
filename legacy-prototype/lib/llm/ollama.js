// Ollama native API connector (streaming)

class OllamaConnector {
  constructor(config = {}) {
    this.model = config.model || 'llama3';
    this.baseUrl = (config.url || 'http://localhost:11434').replace(/\/+$/, '');
  }

  /**
   * Stream a chat completion via Ollama's /api/chat
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

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: allMessages,
        stream: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama API ${res.status}: ${errText}`);
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
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.done) {
            yield { text: '', done: true };
            return;
          }
          if (data.message?.content) {
            yield { text: data.message.content, done: false };
          }
        } catch {
          // skip malformed lines
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

module.exports = OllamaConnector;
