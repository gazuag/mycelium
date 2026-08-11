interface ChatBubbleProps {
  text: string;
  timestamp: string;
  isMine: boolean;
  deliveryStatus?: 'queued' | 'sent';
}

export function ChatBubble({ text, timestamp, isMine, deliveryStatus }: ChatBubbleProps) {
  return (
    <div className={`chat-bubble ${isMine ? 'mine' : 'theirs'}`}>
      <p>{text}</p>
      <span className="chat-timestamp">
        {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        {isMine && deliveryStatus === 'queued' ? ' • offline, queued' : ''}
      </span>
    </div>
  );
}
