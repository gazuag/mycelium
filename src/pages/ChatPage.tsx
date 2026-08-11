import { useLayoutEffect, useRef } from 'react';
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
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = listRef.current;

    if (!element) {
      return;
    }

    window.requestAnimationFrame(() => {
      element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
    });
  }, [messages]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSendMessage();
    }
  };

  const displayName = contact.displayName ?? contact.fingerprint.slice(0, 16);

  return (
    <section className="chat-page">
      <div className="chat-header">
        <span className="chat-header-title">Chat with {displayName}</span>
        <span className="chat-header-status">{connectionText}</span>
      </div>

      <div className="chat-message-list" ref={listRef}>
        {messages.length === 0 && (
          <p className="chat-empty">No messages yet. Say hello!</p>
        )}
        {messages.map((message, index) => (
          <ChatBubble key={`${message.timestamp}-${index}`} text={message.text} timestamp={message.timestamp} isMine={message.isMine} />
        ))}
      </div>

      <div className="chat-input-row">
        <input
          value={messageDraft}
          onChange={(e) => onMessageChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message…"
          autoComplete="off"
        />
        <button className="btn" onClick={onSendMessage} type="button">Send</button>
      </div>
    </section>
  );
}
