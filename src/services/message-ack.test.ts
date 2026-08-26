import { describe, expect, it, vi } from 'vitest';
import { acknowledgeMessage, registerMessageAckTimeout } from './message-ack';

describe('message ACK timeout bookkeeping', () => {
  it('cancels the transport-ID timeout and does not invoke retry after acknowledgement', () => {
    vi.useFakeTimers();
    const timers: Record<string, number> = {};
    const chatMessageIds: Record<string, string> = {};
    const retry = vi.fn();

    registerMessageAckTimeout(timers, chatMessageIds, 'transport-id', 'chat-id', retry);
    expect(acknowledgeMessage(timers, chatMessageIds, 'transport-id')).toBe('chat-id');
    vi.advanceTimersByTime(5000);

    expect(retry).not.toHaveBeenCalled();
    expect(timers).toEqual({});
    expect(chatMessageIds).toEqual({});
    vi.useRealTimers();
  });
});