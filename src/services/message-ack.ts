export type AckTimerMap = Record<string, number>;
export type ChatMessageIdMap = Record<string, string>;

export function registerMessageAckTimeout(
  timers: AckTimerMap,
  chatMessageIds: ChatMessageIdMap,
  transportMessageId: string,
  chatMessageId: string,
  onTimeout: () => void,
  setTimer: (callback: () => void, delay: number) => number = globalThis.setTimeout
) {
  if (timers[transportMessageId]) {
    window.clearTimeout(timers[transportMessageId]);
  }
  chatMessageIds[transportMessageId] = chatMessageId;
  timers[transportMessageId] = setTimer(() => {
    delete timers[transportMessageId];
    delete chatMessageIds[transportMessageId];
    onTimeout();
  }, 5000);
}

export function acknowledgeMessage(
  timers: AckTimerMap,
  chatMessageIds: ChatMessageIdMap,
  transportMessageId: string,
  clearTimer: (timerId: number) => void = globalThis.clearTimeout
) {
  const timerId = timers[transportMessageId];
  if (timerId) {
    clearTimer(timerId);
    delete timers[transportMessageId];
  }
  const chatMessageId = chatMessageIds[transportMessageId];
  delete chatMessageIds[transportMessageId];
  return chatMessageId;
}