#!/usr/bin/env python3
import asyncio
import json
import logging
from typing import Dict
import websockets
from websockets.server import WebSocketServerProtocol

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(message)s')

clients: Dict[str, WebSocketServerProtocol] = {}

async def handle_client(websocket: WebSocketServerProtocol) -> None:
    client_id = None

    try:
        async for raw_message in websocket:
            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                logging.warning('Invalid JSON received from client')
                continue

            msg_type = message.get('type')

            if msg_type == 'register':
                client_id = message.get('id')
                if not isinstance(client_id, str):
                    logging.warning('Invalid register payload')
                    continue
                clients[client_id] = websocket
                logging.info('Registered client %s', client_id)
                continue

            if msg_type in {'offer', 'answer', 'ice-candidate'}:
                target = message.get('to')
                if not isinstance(target, str):
                    logging.warning('Signal missing target')
                    continue
                recipient = clients.get(target)
                if recipient and recipient.open:
                    await recipient.send(raw_message)
                    logging.info('Relayed %s from %s to %s', msg_type, message.get('from'), target)
                else:
                    logging.info('Target %s not connected; ignoring %s', target, msg_type)
                continue

            logging.warning('Unsupported message type: %s', msg_type)
    except websockets.ConnectionClosed:
        pass
    finally:
        if client_id and clients.get(client_id) is websocket:
            del clients[client_id]
            logging.info('Client disconnected: %s', client_id)

async def main() -> None:
    server = await websockets.serve(handle_client, '0.0.0.0', 8765)
    logging.info('Signalling server started on ws://0.0.0.0:8765')
    await server.wait_closed()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info('Server stopped')
