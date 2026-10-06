import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const databaseSource = readFileSync(new URL('./storage/idb.ts', import.meta.url), 'utf8');
const webrtcSource = readFileSync(new URL('./p2p/webrtc.ts', import.meta.url), 'utf8');
const protocolSource = readFileSync(new URL('./p2p/protocol.ts', import.meta.url), 'utf8');

describe('legacy plaintext chat removal', () => {
  it('uses only the encrypted DM page for the chat route and renders it for the active contact', () => {
    expect(appSource).toContain("import { DmChatPage } from './pages/DmChatPage'");
    expect(appSource).toContain("page === 'chat' && activeChatContact && identity");
    expect(appSource).toContain('<DmChatPage');
    expect(appSource).not.toContain('<ChatPage');
    expect(existsSync(new URL('./pages/ChatPage.tsx', import.meta.url))).toBe(false);
  });

  it('has no exports or transport APIs for the removed plaintext chat', () => {
    for (const symbol of [
      'saveDirectChatMessage',
      'loadDirectChatMessages',
      'deleteDirectChatMessage',
      'updateDirectChatMessageStatus',
      'clearDirectChatMessages',
      'saveMessageQueue',
      'loadMessageQueue',
      'deleteMessageQueue',
      'sendChatMessage',
      'pendingMessageAcks'
    ]) {
      expect(`${databaseSource}\n${webrtcSource}`).not.toContain(symbol);
    }
    expect(protocolSource).not.toContain("'MESSAGE'");
    expect(protocolSource).not.toContain("'MESSAGE_ACK'");
    expect(appSource).not.toContain('saveDirectMessage');
    expect(appSource).not.toContain('directChats');
    expect(appSource).not.toContain('messageQueue');
  });
});
