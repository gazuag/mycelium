import { useLayoutEffect, useRef } from 'react';
import type { Contact } from '../types';
import { ChatBubble } from '../components/ChatBubble';
import { displayNameOrFallback } from '../utils/fingerprintNames';

interface ChatPageProps {
  contact: Contact;
  messages: Array<{ text: string; timestamp: string; isMine: boolean; deliveryStatus?: 'queued' | 'sent' }>;
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

    const scrollToBottom = () => {
      element.scrollTop = element.scrollHeight;
    };

    requestAnimationFrame(scrollToBottom);
    setTimeout(scrollToBottom, 0);
  }, [messages]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSendMessage();
    }
  };

  const displayName = displayNameOrFallback(contact.displayName, contact.fingerprint);

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
          <ChatBubble
            key={`${message.timestamp}-${index}`}
            text={message.text}
            timestamp={message.timestamp}
            isMine={message.isMine}
            deliveryStatus={message.deliveryStatus}
          />
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
