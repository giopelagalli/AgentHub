import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { HubState, WsMessage } from '@agenthub/shared';

export interface WsHub {
  broadcastState(): void;
  broadcast(msg: WsMessage): void;
  /** Sends only to sockets that subscribed to `topic` — used for the browser screencast. */
  broadcastTo(topic: string, msg: WsMessage): void;
}

export interface WsOptions {
  /** Fired whenever a topic's subscriber count changes, so the hub can start/stop work nobody is watching. */
  onTopicCount?: (topic: string, count: number) => void;
}

export function registerWs(app: FastifyInstance, getState: () => HubState, getBusy: () => number[], opts: WsOptions = {}): WsHub {
  const sockets = new Set<WebSocket>();
  const topics = new Map<string, Set<WebSocket>>();

  app.register(websocket);
  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket) => {
      sockets.add(socket);
      socket.send(JSON.stringify({ type: 'state', state: getState() } satisfies WsMessage));
      // A busy agent mid-stream when this socket connects would otherwise never
      // learn it's busy — replay the current set as if each just started.
      for (const agentId of getBusy()) {
        socket.send(JSON.stringify({ type: 'agent-busy', agentId, busy: true } satisfies WsMessage));
      }
      // The only thing a client may say is which topics it wants; anything else is ignored rather
      // than an error, so an older UI talking to a newer hub stays connected.
      socket.on('message', (data: unknown) => {
        let msg: { type?: unknown; topic?: unknown };
        try {
          msg = JSON.parse(String(data)) as { type?: unknown; topic?: unknown };
        } catch {
          return;
        }
        if (typeof msg.topic !== 'string' || (msg.type !== 'subscribe' && msg.type !== 'unsubscribe')) return;
        const subscribers = topics.get(msg.topic) ?? new Set<WebSocket>();
        topics.set(msg.topic, subscribers);
        if (msg.type === 'subscribe') subscribers.add(socket);
        else subscribers.delete(socket);
        opts.onTopicCount?.(msg.topic, subscribers.size);
      });
      socket.on('close', () => {
        sockets.delete(socket);
        for (const [topic, subscribers] of topics) {
          if (subscribers.delete(socket)) opts.onTopicCount?.(topic, subscribers.size);
        }
      });
    });
  });

  const send = (targets: Set<WebSocket>, msg: WsMessage) => {
    if (targets.size === 0) return;
    const payload = JSON.stringify(msg);
    for (const socket of targets) socket.send(payload);
  };

  return {
    // Building state is real work; skip it rather than compute for nobody.
    broadcastState: () => {
      if (sockets.size === 0) return;
      send(sockets, { type: 'state', state: getState() });
    },
    broadcast: (msg) => send(sockets, msg),
    broadcastTo: (topic, msg) => send(topics.get(topic) ?? new Set(), msg),
  };
}
