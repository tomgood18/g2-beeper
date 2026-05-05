import asyncio
import websockets
import json
import urllib.request
import urllib.error
import urllib.parse
import time
import sys

beeper_ip    = ''
beeper_port  = '8448'
beeper_token = ''
connected_clients = set()
next_batch = None

BRIDGE_MAP = {
    'imessage':  'iMessage',
    'whatsapp':  'WhatsApp',
    'telegram':  'Telegram',
    'signal':    'Signal',
    'messenger': 'Messenger',
    'facebook':  'Messenger',
    'slack':     'Slack',
    'discord':   'Discord',
    'instagram': 'Instagram',
    'twitter':   'Twitter',
    'sms':       'SMS',
    'android':   'SMS',
    'linkedin':  'LinkedIn',
    'googlechat':'Google Chat',
    'hangouts':  'Google Chat',
}


def matrix_get(path: str):
    url = f'http://{beeper_ip}:{beeper_port}{path}'
    req = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {beeper_token}',
        'User-Agent': 'g2-beeper/1.0'
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def matrix_put(path: str, data: dict):
    url = f'http://{beeper_ip}:{beeper_port}{path}'
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers={
        'Authorization': f'Bearer {beeper_token}',
        'Content-Type': 'application/json',
        'User-Agent': 'g2-beeper/1.0'
    }, method='PUT')
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def detect_platform(room_name: str, state_events: list) -> str:
    sources = [room_name.lower()]

    for event in state_events:
        etype = event.get('type', '')
        content = event.get('content', {})
        if etype == 'm.room.canonical_alias':
            sources.append(content.get('alias', '').lower())
        elif etype == 'm.room.aliases':
            sources.extend(a.lower() for a in content.get('aliases', []))
        elif 'bridge' in etype.lower():
            sources.append(json.dumps(content).lower())

    combined = ' '.join(sources)
    for key, display in BRIDGE_MAP.items():
        if key in combined:
            return display
    return 'Other'


def get_my_user_id() -> str:
    try:
        return matrix_get('/_matrix/client/v3/account/whoami').get('user_id', '')
    except Exception:
        return ''


def fetch_platforms() -> dict:
    result = matrix_get('/_matrix/client/v3/joined_rooms')
    room_ids = result.get('joined_rooms', [])
    platforms: dict[str, list] = {}

    for room_id in room_ids:
        try:
            encoded = urllib.parse.quote(room_id, safe='')
            state = matrix_get(f'/_matrix/client/v3/rooms/{encoded}/state')

            name = ''
            for event in state:
                if event.get('type') == 'm.room.name':
                    name = event.get('content', {}).get('name', '')
                    break

            platform = detect_platform(name, state)

            if platform not in platforms:
                platforms[platform] = []

            platforms[platform].append({
                'id': room_id,
                'name': name or room_id.split(':')[0][1:]
            })
        except Exception as e:
            print(f'  room error {room_id[:30]}: {e}')

    return platforms


def fetch_messages(room_id: str, limit: int = 30) -> list:
    encoded = urllib.parse.quote(room_id, safe='')
    my_uid = get_my_user_id()

    member_names: dict[str, str] = {}
    try:
        members = matrix_get(f'/_matrix/client/v3/rooms/{encoded}/members')
        for chunk in members.get('chunk', []):
            if chunk.get('type') == 'm.room.member':
                uid = chunk.get('state_key', '')
                display = chunk.get('content', {}).get('displayname', '') or uid.split(':')[0][1:]
                member_names[uid] = display
    except Exception:
        pass

    result = matrix_get(f'/_matrix/client/v3/rooms/{encoded}/messages?dir=b&limit={limit}')
    messages = []

    for event in reversed(result.get('chunk', [])):
        if event.get('type') != 'm.room.message':
            continue
        content = event.get('content', {})
        msgtype = content.get('msgtype', '')

        if msgtype == 'm.text':
            body = content.get('body', '')
        elif msgtype == 'm.image':
            body = '[Image]'
        elif msgtype in ('m.file', 'm.audio', 'm.video'):
            body = f'[{msgtype.split(".")[1].capitalize()}: {content.get("body", "")}]'
        else:
            continue

        sender = event.get('sender', '')
        messages.append({
            'id':        event.get('event_id', ''),
            'sender':    member_names.get(sender, sender.split(':')[0][1:]),
            'text':      body,
            'timestamp': event.get('origin_server_ts', 0),
            'mine':      sender == my_uid
        })

    return messages


def send_message(room_id: str, text: str) -> str:
    encoded = urllib.parse.quote(room_id, safe='')
    txn_id = f'g2beeper{int(time.time() * 1000)}'
    result = matrix_put(
        f'/_matrix/client/v3/rooms/{encoded}/send/m.room.message/{txn_id}',
        {'msgtype': 'm.text', 'body': text}
    )
    return result.get('event_id', '')


async def sync_loop():
    global next_batch

    while True:
        if not beeper_token or not beeper_ip:
            await asyncio.sleep(5)
            continue

        try:
            loop = asyncio.get_event_loop()

            if not next_batch:
                # Initial sync — capture token only, skip all timeline events
                path = '/_matrix/client/v3/sync?' + urllib.parse.urlencode({
                    'filter': json.dumps({'room': {'timeline': {'limit': 0}}, 'presence': {'types': []}})
                })
                result = await loop.run_in_executor(None, lambda: matrix_get(path))
                next_batch = result.get('next_batch')
                print(f'Sync ready: {next_batch[:20] if next_batch else "none"}')
                continue

            # Long-poll for new events
            path = '/_matrix/client/v3/sync?' + urllib.parse.urlencode({
                'timeout': 30000,
                'since':   next_batch,
                'filter':  json.dumps({'presence': {'types': []}})
            })
            result = await loop.run_in_executor(None, lambda: matrix_get(path))
            new_batch = result.get('next_batch')

            if new_batch and new_batch != next_batch:
                rooms = result.get('rooms', {}).get('join', {})
                for room_id, room_data in rooms.items():
                    for event in room_data.get('timeline', {}).get('events', []):
                        if event.get('type') != 'm.room.message':
                            continue
                        content = event.get('content', {})
                        if content.get('msgtype') != 'm.text':
                            continue
                        notification = json.dumps({
                            'type':   'new_message',
                            'roomId': room_id,
                            'message': {
                                'sender':    event.get('sender', '').split(':')[0][1:],
                                'text':      content.get('body', ''),
                                'timestamp': event.get('origin_server_ts', 0)
                            }
                        })
                        for client in list(connected_clients):
                            try:
                                await client.send(notification)
                            except Exception:
                                pass
                next_batch = new_batch

        except Exception as e:
            print(f'Sync error: {e}')
            await asyncio.sleep(10)


async def handler(websocket):
    global beeper_ip, beeper_port, beeper_token, next_batch
    connected_clients.add(websocket)
    print(f'Client connected: {websocket.remote_address}')

    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            mtype = msg.get('type')

            if mtype == 'set_config':
                beeper_ip    = msg.get('ip', '')
                beeper_port  = msg.get('port', '8448')
                beeper_token = msg.get('token', '')
                next_batch   = None
                print(f'Config: {beeper_ip}:{beeper_port}')
                await websocket.send(json.dumps({'type': 'config_set'}))

            elif mtype == 'get_platforms':
                try:
                    loop = asyncio.get_event_loop()
                    data = await loop.run_in_executor(None, fetch_platforms)
                    await websocket.send(json.dumps({'type': 'platforms', 'platforms': data}))
                    print(f'Platforms: {list(data.keys())}')
                except Exception as e:
                    print(f'get_platforms error: {e}')
                    await websocket.send(json.dumps({'type': 'error', 'message': str(e)}))

            elif mtype == 'get_messages':
                room_id = msg.get('roomId', '')
                try:
                    loop = asyncio.get_event_loop()
                    msgs = await loop.run_in_executor(None, lambda: fetch_messages(room_id))
                    await websocket.send(json.dumps({'type': 'messages', 'messages': msgs, 'roomId': room_id}))
                    print(f'Messages: {len(msgs)} for {room_id[:30]}')
                except Exception as e:
                    print(f'get_messages error: {e}')
                    await websocket.send(json.dumps({'type': 'error', 'message': str(e)}))

            elif mtype == 'send_message':
                room_id = msg.get('roomId', '')
                text    = msg.get('text', '')
                try:
                    loop = asyncio.get_event_loop()
                    event_id = await loop.run_in_executor(None, lambda: send_message(room_id, text))
                    await websocket.send(json.dumps({'type': 'message_sent', 'eventId': event_id}))
                    print(f'Sent: "{text[:40]}"')
                except Exception as e:
                    print(f'send_message error: {e}')
                    await websocket.send(json.dumps({'type': 'error', 'message': str(e)}))

    except websockets.exceptions.ConnectionClosed:
        print('Client disconnected')
    finally:
        connected_clients.discard(websocket)


async def main():
    print('G2 Beeper server — ws://0.0.0.0:8765')
    print('All Beeper API calls are proxied here — no CORS issues.')
    asyncio.create_task(sync_loop())
    async with websockets.serve(handler, '0.0.0.0', 8765):
        await asyncio.Future()


asyncio.run(main())
