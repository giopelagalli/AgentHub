import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { HubState, WsMessage } from '@agenthub/shared';

export interface WsHub { broadcastState(): void; broadcast(msg: WsMessage): void; }

export function registerWs(app: FastifyInstance, getState: () => HubState, getBusy: () => number[]): WsHub {
  const sockets = new Set<WebSocket>();

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
      socket.on('close', () => sockets.delete(socket));
    });
  });

  const broadcast = (msg: WsMessage) => {
    if (sockets.size === 0) return;
    const payload = JSON.stringify(msg);
    for (const socket of sockets) socket.send(payload);
  };

  return {
    // Building state is real work; skip it rather than compute for nobody.
    broadcastState: () => {
      if (sockets.size === 0) return;
      broadcast({ type: 'state', state: getState() });
    },
    broadcast,
  };
}
