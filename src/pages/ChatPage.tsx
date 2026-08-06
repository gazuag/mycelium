import { ChatBubble } from '../components/ChatBubble';

interface ChatPageProps {
  peerId: string;
  chatHistory: string[];
  messageText: string;
  onChangeMessage: (value: string) => void;
  onSendMessage: () => void;
  onBack: () => void;
  peerName: string;
  connected: boolean;
}

export function ChatPage({ peerId, chatHistory, messageText, onChangeMessage, onSendMessage, onBack, peerName, connected }: ChatPageProps) {
  return (
    <main className="page-content chat-page">
      <section className="page-header">
        <button className="link-button" onClick={onBack}>Back</button>
        <div>
          <h2>{peerName}</h2>
          <p className="note">{connected ? 'Connected' : 'Offline'}</p>
        </div>
      </section>

      <div className="chat-thread">
        {chatHistory.length === 0 ? (
          <div className="empty-state card">
            <p>No messages yet. Start the conversation.</p>
          </div>
        ) : (
          chatHistory.map((line, index) => {
            const sender = line.startsWith('You:') ? 'me' : 'peer';
            const message = line.replace(/^(You:|Peer:)\s*/, '');
            return <ChatBubble key={`${index}-${line}`} sender={sender} text={message} time={new Date().toLocaleTimeString()} />;
          })
        )}
      </div>

      <div className="chat-input-bar">
        <input value={messageText} onChange={(e) => onChangeMessage(e.target.value)} placeholder="Type a message…" />
        <button className="btn" onClick={onSendMessage} disabled={!messageText.trim()}>Send</button>
      </div>
    </main>
  );
}
