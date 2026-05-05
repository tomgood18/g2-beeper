import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer
} from '@evenrealities/even_hub_sdk';

// ===================== TYPES =====================

type Screen =
  | 'setup' | 'connecting' | 'loading' | 'error'
  | 'platforms' | 'conversations' | 'thread' | 'reply' | 'listening' | 'sending' | 'sent';

interface BeeperConfig { ip: string; port: string; token: string; }
interface Platform { id: string; name: string; roomCount: number; }
interface Room { id: string; name: string; }
interface Message { id: string; sender: string; text: string; timestamp: number; mine: boolean; }

// ===================== STATE =====================

let bridge: any = null;
let ws: WebSocket | null = null;
let isFirstRender = true;
let screen: Screen = 'setup';
let errorMsg = '';

let platformsData: Record<string, Room[]> = {};
let platforms: Platform[] = [];
let conversations: Room[] = [];
let messages: Message[] = [];
let selectedPlatform: Platform | null = null;
let selectedConversation: Room | null = null;
let pendingMessage = '';

const DEFAULT_PRESETS = ['SOUNDS GOOD', 'ON MY WAY', "CAN'T TALK NOW", 'CALL YOU LATER'];
const activityLog: { time: string; msg: string }[] = [];

// ===================== CONFIG =====================

function getConfig(): BeeperConfig {
  return {
    ip:    localStorage.getItem('beeper_ip')    || '',
    port:  localStorage.getItem('beeper_port')  || '8448',
    token: localStorage.getItem('beeper_token') || ''
  };
}

function saveConfig(c: BeeperConfig) {
  localStorage.setItem('beeper_ip',    c.ip);
  localStorage.setItem('beeper_port',  c.port);
  localStorage.setItem('beeper_token', c.token);
}

function getPresets(): string[] {
  try { return JSON.parse(localStorage.getItem('beeper_presets') || 'null') || DEFAULT_PRESETS; }
  catch { return DEFAULT_PRESETS; }
}

function savePresets(p: string[]) { localStorage.setItem('beeper_presets', JSON.stringify(p)); }

const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n - 2) + '..' : s;

// ===================== LOGGING =====================

function log(msg: string) {
  activityLog.push({ time: new Date().toTimeString().slice(0, 8), msg });
  if (activityLog.length > 100) activityLog.shift();
  renderWebUI();
}

// ===================== WEBSOCKET =====================

function connect() {
  const { ip } = getConfig();
  if (!ip) return;

  screen = 'connecting';
  renderWebUI();
  updateGlassesUI(true);

  const isLocal = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost|127\.)/.test(ip);
  const proto = isLocal ? 'ws' : 'wss';
  const url = isLocal ? `${proto}://${ip}:8765` : `${proto}://${ip}`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    const c = getConfig();
    ws!.send(JSON.stringify({ type: 'set_config', ip: c.ip, port: c.port, token: c.token }));
  };

  ws.onmessage = (e) => {
    try { handleServerMsg(JSON.parse(e.data)); } catch { }
  };

  ws.onclose = () => {
    if (screen !== 'setup') {
      screen = 'connecting';
      log('Disconnected — reconnecting in 3s...');
      updateGlassesUI(true);
      setTimeout(connect, 3000);
    }
  };

  ws.onerror = () => {
    errorMsg = 'Cannot reach server';
    screen = 'error';
    log('Connection error');
    updateGlassesUI(true);
    renderWebUI();
  };
}

function send(payload: object) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

// ===================== SERVER MESSAGES =====================

function handleServerMsg(msg: any) {
  switch (msg.type) {

    case 'config_set':
      log('Connected — loading platforms...');
      screen = 'loading';
      updateGlassesUI(true);
      send({ type: 'get_platforms' });
      break;

    case 'platforms': {
      const raw = msg.platforms as Record<string, Room[]>;
      platformsData = raw;
      platforms = Object.entries(raw)
        .map(([name, rooms]) => ({ id: name, name: name.toUpperCase(), roomCount: rooms.length }))
        .filter(p => p.roomCount > 0)
        .sort((a, b) => b.roomCount - a.roomCount);
      log(`${platforms.length} platform(s) loaded`);
      screen = 'platforms';
      updateGlassesUI(true);
      renderWebUI();
      break;
    }

    case 'messages':
      messages = msg.messages || [];
      log(`${messages.length} message(s) loaded`);
      screen = 'thread';
      updateGlassesUI(true);
      renderWebUI();
      break;

    case 'message_sent':
      log('Message sent');
      screen = 'sent';
      updateGlassesUI(true);
      renderWebUI();
      setTimeout(() => {
        if (selectedConversation) {
          screen = 'loading';
          updateGlassesUI(true);
          send({ type: 'get_messages', roomId: selectedConversation.id });
        }
      }, 1500);
      break;

    case 'new_message':
      log(`New: ${msg.message?.sender} — ${trunc(msg.message?.text || '', 35)}`);
      if (selectedConversation?.id === msg.roomId && screen === 'thread') {
        send({ type: 'get_messages', roomId: msg.roomId });
      }
      renderWebUI();
      break;

    case 'error':
      errorMsg = msg.message || 'Unknown error';
      log(`Error: ${errorMsg}`);
      screen = 'error';
      updateGlassesUI(true);
      renderWebUI();
      break;
  }
}

// ===================== NAVIGATION =====================

function openPlatform(p: Platform) {
  selectedPlatform = p;
  conversations = platformsData[p.id] || [];
  screen = 'conversations';
  log(`${p.name}: ${conversations.length} conversation(s)`);
  updateGlassesUI(true);
  renderWebUI();
}

function openConversation(r: Room) {
  selectedConversation = r;
  messages = [];
  screen = 'loading';
  log(`Loading ${r.name}...`);
  updateGlassesUI(true);
  send({ type: 'get_messages', roomId: r.id });
}

function openReply() {
  screen = 'reply';
  updateGlassesUI(true);
  renderWebUI();
}

function doSend(text: string) {
  if (!selectedConversation || !text.trim()) return;
  pendingMessage = text;
  screen = 'sending';
  log(`Sending: "${trunc(text, 40)}"`);
  updateGlassesUI(true);
  send({ type: 'send_message', roomId: selectedConversation.id, text });
}

function goBack() {
  switch (screen) {
    case 'conversations': screen = 'platforms'; selectedPlatform = null; break;
    case 'thread':        screen = 'conversations'; selectedConversation = null; messages = []; break;
    case 'reply':
    case 'sent':          screen = 'thread'; break;
    case 'error':         screen = platforms.length > 0 ? 'platforms' : 'setup'; break;
    default:              screen = 'platforms';
  }
  updateGlassesUI(true);
  renderWebUI();
}

// ===================== GLASSES CONTENT =====================

function glassesContent(): { text: string; items: string[] } {
  const presets = getPresets();

  switch (screen) {
    case 'connecting':
      return { text: '   BEEPER\n   Connecting...', items: ['WAIT'] };

    case 'loading':
      return { text: '   BEEPER\n   Loading...', items: ['WAIT'] };

    case 'platforms':
      return {
        text: `   BEEPER MESSAGES\n   ${platforms.length} platform${platforms.length !== 1 ? 's' : ''}`,
        items: [...platforms.map(p => `${p.name} (${p.roomCount})`), 'REFRESH']
      };

    case 'conversations': {
      const pname = selectedPlatform?.name || '';
      return {
        text: `   ${pname}\n   ${conversations.length} conversation${conversations.length !== 1 ? 's' : ''}`,
        items: [...conversations.map(c => trunc(c.name, 28)), 'BACK']
      };
    }

    case 'thread': {
      const last = messages.length > 0 ? messages[messages.length - 1] : null;
      const preview = last
        ? `${last.mine ? 'You' : last.sender}: ${trunc(last.text, 32)}`
        : 'No messages';
      return {
        text: `   ${trunc(selectedConversation?.name || '', 30)}\n   ${preview}`,
        items: ['REPLY', 'BACK']
      };
    }

    case 'reply':
      return {
        text: `   REPLY TO\n   ${trunc(selectedConversation?.name || '', 35)}`,
        items: [...presets.map(p => trunc(p, 28)), 'VOICE INPUT', 'BACK']
      };

    case 'listening':
      return { text: '   LISTENING...\n   Speak your message', items: ['CANCEL'] };

    case 'sending':
      return { text: `   SENDING...\n   "${trunc(pendingMessage, 35)}"`, items: ['WAIT'] };

    case 'sent':
      return { text: `   SENT\n   "${trunc(pendingMessage, 35)}"`, items: ['BACK', 'REPLY AGAIN'] };

    case 'error':
      return {
        text: `   ERROR\n   ${trunc(errorMsg, 40)}`,
        items: ['BACK', 'RETRY']
      };

    default:
      return { text: '   BEEPER\n   Setup required', items: ['WAIT'] };
  }
}

// ===================== GLASSES UI =====================

async function updateGlassesUI(forceRefresh = false) {
  if (!bridge) return;
  const { text, items } = glassesContent();

  try {
    const textObj = TextContainerProperty.fromJson({
      xPosition: 10, yPosition: 10, width: 550, height: 85,
      containerID: 1, containerName: 'text_box',
      content: text, isEventCapture: 0, borderWidth: 1, borderColor: 7
    });
    const listObj = ListContainerProperty.fromJson({
      xPosition: 10, yPosition: 100, width: 550, height: 175,
      containerID: 2, containerName: 'list_box',
      itemContainer: ListItemContainerProperty.fromJson({
        itemCount: items.length, itemName: items, isItemSelectBorderEn: 1
      }),
      isEventCapture: 1
    });

    if (isFirstRender) {
      const res = await bridge.createStartUpPageContainer(
        CreateStartUpPageContainer.fromJson({ containerTotalNum: 2, textObject: [textObj], listObject: [listObj] })
      );
      if (res === 0) isFirstRender = false;
    } else if (forceRefresh) {
      await bridge.rebuildPageContainer(
        RebuildPageContainer.fromJson({ containerTotalNum: 2, textObject: [textObj], listObject: [listObj] })
      );
    }
  } catch (e) { console.error(e); }
}

// ===================== RING INPUT =====================

function handleGlassesEvent(e: any) {
  const idx: number = (e.listEvent || e.jsonData)?.currentSelectItemIndex ?? 0;
  const presets = getPresets();

  switch (screen) {
    case 'platforms':
      if (idx >= platforms.length) {
        screen = 'loading'; updateGlassesUI(true); send({ type: 'get_platforms' });
      } else {
        openPlatform(platforms[idx]);
      }
      break;

    case 'conversations':
      if (idx >= conversations.length) goBack();
      else openConversation(conversations[idx]);
      break;

    case 'thread':
      if (idx === 0) openReply(); else goBack();
      break;

    case 'reply':
      if (idx < presets.length) {
        doSend(presets[idx]);
      } else if (idx === presets.length) {
        screen = 'listening'; updateGlassesUI(true); startVoice();
      } else {
        goBack();
      }
      break;

    case 'listening':
      stopVoice(); goBack();
      break;

    case 'sent':
      if (idx === 0) goBack(); else openReply();
      break;

    case 'error':
      if (idx === 0) goBack();
      else { screen = 'loading'; updateGlassesUI(true); send({ type: 'get_platforms' }); }
      break;
  }
}

// ===================== VOICE INPUT =====================

let recognition: any = null;

function startVoice() {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR) { errorMsg = 'Speech not supported'; screen = 'error'; updateGlassesUI(true); return; }

  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = 'en-US';

  recognition.onresult = (evt: any) => {
    const text = evt.results[0]?.[0]?.transcript || '';
    if (text) doSend(text); else goBack();
  };
  recognition.onerror = () => { screen = 'reply'; updateGlassesUI(true); };
  recognition.start();
}

function stopVoice() { recognition?.stop(); recognition = null; }

// ===================== WEB UI =====================

function renderWebUI() {
  document.body.style.cssText = 'margin:0;padding:0;background:#0a0a0a;color:white;font-family:monospace;display:flex;flex-direction:column;min-height:100vh;';

  const config = getConfig();
  const presets = getPresets();
  const hasConfig = !!(config.ip && config.token);

  const STATUS_COLOR: Partial<Record<Screen, string>> = {
    setup: '#666', connecting: '#f0a500', loading: '#f0a500',
    platforms: '#00cc66', conversations: '#4da6ff', thread: '#4da6ff',
    reply: '#4da6ff', listening: '#ff6600', sending: '#f0a500',
    sent: '#00cc66', error: '#cc3300'
  };
  const STATUS_LABEL: Partial<Record<Screen, string>> = {
    setup: 'SETUP', connecting: 'CONNECTING', loading: 'LOADING',
    platforms: 'PLATFORMS', conversations: 'CONVERSATIONS', thread: 'THREAD',
    reply: 'REPLY', listening: 'LISTENING', sending: 'SENDING',
    sent: 'SENT', error: 'ERROR'
  };

  // Platforms summary
  const platformsHtml = platforms.length > 0
    ? platforms.map(p => `
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1a1a1a;font-size:0.82rem;">
          <span>${p.name}</span>
          <span style="color:#555;">${p.roomCount} chat${p.roomCount !== 1 ? 's' : ''}</span>
        </div>`).join('')
    : '<div style="color:#444;font-size:0.8rem;">Not yet loaded</div>';

  // Conversations preview (for currently selected platform)
  const convsHtml = conversations.length > 0 && selectedPlatform
    ? `<div style="color:#555;font-size:0.65rem;letter-spacing:2px;margin:12px 0 8px;">${selectedPlatform.name} CONVERSATIONS</div>` +
      conversations.map(c => `
        <div class="conv-row" data-id="${c.id}" style="padding:6px 0;border-bottom:1px solid #1a1a1a;font-size:0.82rem;cursor:pointer;display:flex;justify-content:space-between;align-items:center;">
          <span>${trunc(c.name, 45)}</span>
          <span style="color:#4da6ff;font-size:0.7rem;">OPEN →</span>
        </div>`).join('')
    : '';

  // Messages preview
  const msgsHtml = messages.length > 0 && selectedConversation
    ? `<div style="color:#555;font-size:0.65rem;letter-spacing:2px;margin:12px 0 8px;">${selectedConversation.name.toUpperCase()} — LAST ${Math.min(messages.length, 10)} MESSAGES</div>` +
      messages.slice(-10).map(m => `
        <div style="padding:5px 0;border-bottom:1px solid #1a1a1a;font-size:0.8rem;">
          <span style="color:${m.mine ? '#00cc66' : '#4da6ff'};margin-right:8px;">${m.mine ? 'You' : trunc(m.sender, 15)}</span>
          <span style="color:#ccc;">${trunc(m.text, 60)}</span>
        </div>`).join('')
    : '';

  const presetsHtml = presets.map((p, i) => `
    <input class="preset-input" data-idx="${i}" value="${p.replace(/"/g, '&quot;')}"
      style="width:180px;padding:8px;background:#1a1a1a;border:1px solid #333;color:white;font-family:monospace;border-radius:4px;font-size:0.8rem;text-transform:uppercase;"/>`
  ).join('');

  const logHtml = activityLog.length === 0
    ? '<div style="color:#444;font-size:0.8rem;">No activity yet...</div>'
    : [...activityLog].reverse().map(e => `
        <div style="display:flex;gap:16px;padding:7px 0;border-bottom:1px solid #1a1a1a;font-size:0.82rem;">
          <span style="color:#444;flex-shrink:0;">${e.time}</span>
          <span>${e.msg}</span>
        </div>`).join('');

  document.body.innerHTML = `
    <div style="padding:16px 32px;background:#111;border-bottom:1px solid #222;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-weight:bold;letter-spacing:2px;">G2 BEEPER</span>
      <span style="color:${STATUS_COLOR[screen] || '#666'};font-size:0.75rem;letter-spacing:1px;">${STATUS_LABEL[screen] || screen.toUpperCase()}</span>
    </div>

    <div style="padding:16px 32px;background:#0d0d0d;border-bottom:1px solid #1a1a1a;">
      <div style="color:#555;font-size:0.65rem;letter-spacing:2px;margin-bottom:12px;">BEEPER SERVER</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
        <div style="display:flex;flex-direction:column;gap:4px;">
          <label style="color:#555;font-size:0.65rem;letter-spacing:1px;">IP ADDRESS</label>
          <input id="cfg-ip" value="${config.ip}" placeholder="192.168.x.x"
            style="width:150px;padding:8px;background:#1a1a1a;border:1px solid #333;color:white;font-family:monospace;border-radius:4px;font-size:0.8rem;"/>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <label style="color:#555;font-size:0.65rem;letter-spacing:1px;">PORT</label>
          <input id="cfg-port" value="${config.port}" placeholder="8448"
            style="width:70px;padding:8px;background:#1a1a1a;border:1px solid #333;color:white;font-family:monospace;border-radius:4px;font-size:0.8rem;"/>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <label style="color:#555;font-size:0.65rem;letter-spacing:1px;">API TOKEN</label>
          <input id="cfg-token" type="password" value="${config.token}" placeholder="syt_..."
            style="width:240px;padding:8px;background:#1a1a1a;border:1px solid #333;color:white;font-family:monospace;border-radius:4px;font-size:0.8rem;"/>
        </div>
        <button id="cfg-save"
          style="padding:9px 20px;background:white;color:black;border:none;font-family:monospace;font-weight:bold;cursor:pointer;border-radius:4px;font-size:0.8rem;letter-spacing:1px;">
          ${hasConfig ? 'UPDATE' : 'CONNECT'}
        </button>
      </div>
    </div>

    <div style="padding:16px 32px;background:#0a0a0a;border-bottom:1px solid #1a1a1a;">
      <div style="color:#555;font-size:0.65rem;letter-spacing:2px;margin-bottom:8px;">PLATFORMS</div>
      ${platformsHtml}
      ${convsHtml}
      ${msgsHtml}
    </div>

    <div style="padding:16px 32px;background:#0d0d0d;border-bottom:1px solid #1a1a1a;">
      <div style="color:#555;font-size:0.65rem;letter-spacing:2px;margin-bottom:10px;">PRESET REPLIES</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        ${presetsHtml}
        <button id="presets-save"
          style="padding:8px 16px;background:transparent;color:#555;border:1px solid #333;font-family:monospace;font-size:0.75rem;cursor:pointer;border-radius:4px;">
          SAVE
        </button>
      </div>
    </div>

    <div style="padding:16px 32px;background:#0a0a0a;border-bottom:1px solid #1a1a1a;">
      <div style="color:#555;font-size:0.65rem;letter-spacing:2px;margin-bottom:10px;">DEV — SEND TO CURRENT CONVERSATION</div>
      <div style="display:flex;gap:8px;">
        <input id="dev-msg" placeholder="${selectedConversation ? `Send to ${trunc(selectedConversation.name, 30)}...` : 'Select a conversation first...'}"
          style="flex:1;padding:8px;background:#1a1a1a;border:1px solid #333;color:white;font-family:monospace;border-radius:4px;font-size:0.82rem;"/>
        <button id="dev-send"
          style="padding:8px 20px;background:${selectedConversation ? 'white' : '#1a1a1a'};color:${selectedConversation ? 'black' : '#444'};border:none;font-family:monospace;font-size:0.75rem;font-weight:bold;cursor:pointer;border-radius:4px;">
          SEND
        </button>
      </div>
    </div>

    <div id="log" style="flex:1;padding:16px 32px;overflow-y:auto;">
      <div style="color:#555;font-size:0.65rem;letter-spacing:2px;margin-bottom:12px;">ACTIVITY</div>
      ${logHtml}
    </div>`;

  document.getElementById('cfg-save')?.addEventListener('click', () => {
    const ip    = (document.getElementById('cfg-ip')    as HTMLInputElement).value.trim();
    const port  = (document.getElementById('cfg-port')  as HTMLInputElement).value.trim();
    const token = (document.getElementById('cfg-token') as HTMLInputElement).value.trim();
    if (!ip || !token) return;
    saveConfig({ ip, port: port || '8448', token });
    ws?.close(); ws = null;
    screen = 'setup'; isFirstRender = true;
    activityLog.length = 0;
    platforms = []; platformsData = {}; conversations = []; messages = [];
    selectedPlatform = null; selectedConversation = null;
    connect();
  });

  document.getElementById('presets-save')?.addEventListener('click', () => {
    const inputs = document.querySelectorAll<HTMLInputElement>('.preset-input');
    const updated = Array.from(inputs).map(i => i.value.trim().toUpperCase()).filter(Boolean);
    savePresets(updated);
    log('Presets saved');
  });

  document.getElementById('dev-send')?.addEventListener('click', () => {
    const input = document.getElementById('dev-msg') as HTMLInputElement;
    const text = input.value.trim();
    if (text && selectedConversation) { doSend(text); input.value = ''; }
    else if (!selectedConversation) log('No conversation selected');
  });

  document.getElementById('dev-msg')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') document.getElementById('dev-send')?.click();
  });

  // Web-click shortcuts for conversations
  document.querySelectorAll<HTMLElement>('.conv-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.id!;
      const room = conversations.find(c => c.id === id);
      if (room) openConversation(room);
    });
  });
}

// ===================== ENTRY =====================

async function startApp() {
  renderWebUI();
  const { ip, token } = getConfig();
  if (!ip || !token) return;

  bridge = await waitForEvenAppBridge();
  bridge.onEvenHubEvent((e: any) => handleGlassesEvent(e));
  connect();
}

window.addEventListener('load', startApp);
