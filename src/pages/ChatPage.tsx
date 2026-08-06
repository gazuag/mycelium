import type { Contact } from '../types';
import { ChatBubble } from '../components/ChatBubble';

interface ChatPageProps {
  contact: Contact;
  messages: Array<{ text: string; timestamp: string; isMine: boolean }>;
  messageDraft: string;
  onMessageChange: (value: string) => void;
  onSendMessage: () => void;
  connectionText: string;
}

export function ChatPage({ contact, messages, messageDraft, onMessageChange, onSendMessage, connectionText }: ChatPageProps) {
  return (
    <section className="page-view chat-page">
      <div className="page-header">
        <h2>Chat</h2>
        <p className="note">{contact.displayName ?? contact.fingerprint.slice(0, 16)}</p>
      </div>

      <div className="chat-status card">
        <span>{connectionText}</span>
      </div>

      <div className="chat-message-list">
        {messages.map((message, index) => (
          <ChatBubble key={`${message.timestamp}-${index}`} text={message.text} timestamp={message.timestamp} isMine={message.isMine} />
        ))}
      </div>

      <div className="chat-input-row">
        <input
          value={messageDraft}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder="Send a message"
        />
        <button className="btn" onClick={onSendMessage} type="button">Send</button>
      </div>
    </section>
  );
}
