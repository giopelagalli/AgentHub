import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { HubState, WsMessage } from '@agenthub/shared';

export interface WsHub { broadcastState(): void; broadcast(msg: WsMessage): void; }

export function registerWs(app: FastifyInstance, getState: () => HubState): WsHub {
  const sockets = new Set<WebSocket>();

  app.register(websocket);
  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket) => {
      sockets.add(socket);
      socket.send(JSON.stringify({ type: 'state', state: getState() } satisfies WsMessage));
      socket.on('close', () => sockets.delete(socket));
    });
  });

  const broadcast = (msg: WsMessage) => {
    const payload = JSON.stringify(msg);
    for (const socket of sockets) socket.send(payload);
  };

  return { broadcastState: () => broadcast({ type: 'state', state: getState() }), broadcast };
}
