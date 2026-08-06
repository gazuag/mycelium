interface ChatBubbleProps {
  sender: 'me' | 'peer';
  text: string;
  time: string;
}

export function ChatBubble({ sender, text, time }: ChatBubbleProps) {
  return (
    <div className={`chat-bubble ${sender === 'me' ? 'sent' : 'received'}`}>
      <div>{text}</div>
      <time>{time}</time>
    </div>
  );
}
