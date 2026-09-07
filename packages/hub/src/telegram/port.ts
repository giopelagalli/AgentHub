export interface InlineButton {
  text: string;
  data: string;
}

export interface OutgoingMessage {
  text: string;
  buttons?: InlineButton[][];
  parseMode?: 'MarkdownV2' | 'HTML' | undefined;
  voice?: Buffer;
  /** An mp4 to send alongside the text — a finished `video-gen` job's clip. */
  video?: Buffer;
}

export interface IncomingMessage {
  chatId: string;
  text: string;
  messageId: number;
}

export interface IncomingCallback {
  chatId: string;
  data: string;
  callbackId: string;
}

export type MessageHandler = (m: IncomingMessage) => Promise<void>;
export type CallbackHandler = (c: IncomingCallback) => Promise<void>;

export interface TelegramPort {
  send(chatId: string, msg: OutgoingMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onCallback(handler: CallbackHandler): void;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * An in-memory `TelegramPort` for tests: `send` records to `sent` instead of calling out, and
 * `simulateMessage`/`simulateCallback` drive the registered handlers the way a real update would,
 * awaiting them so a caller can await the whole reaction (including any further sends it triggers)
 * before asserting on `sent`.
 */
export class FakeTelegramPort implements TelegramPort {
  sent: { chatId: string; msg: OutgoingMessage }[] = [];
  answered: { callbackId: string; text: string | undefined }[] = [];
  private messageHandlers: MessageHandler[] = [];
  private callbackHandlers: CallbackHandler[] = [];
  private nextMessageId = 1;
  private nextCallbackId = 1;

  async send(chatId: string, msg: OutgoingMessage): Promise<void> {
    this.sent.push({ chatId, msg });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onCallback(handler: CallbackHandler): void {
    this.callbackHandlers.push(handler);
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    this.answered.push({ callbackId, text });
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async simulateMessage(chatId: string, text: string): Promise<void> {
    const message: IncomingMessage = { chatId, text, messageId: this.nextMessageId++ };
    for (const handler of this.messageHandlers) await handler(message);
  }

  async simulateCallback(chatId: string, data: string): Promise<void> {
    const callback: IncomingCallback = { chatId, data, callbackId: `cb_${this.nextCallbackId++}` };
    for (const handler of this.callbackHandlers) await handler(callback);
  }
}
