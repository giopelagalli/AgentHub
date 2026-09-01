import { createMockOpenAI } from './openai-mock.js';
const port = Number(process.argv[2] ?? 8100);
const tokenDelayMs = Number(process.argv[3] ?? 0);
const app = createMockOpenAI({ tokenDelayMs });
app.listen({ port, host: '127.0.0.1' }).then(() => console.log(`[mock-openai] listening on ${port}`));
