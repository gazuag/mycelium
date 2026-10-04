export type MessageLogKind = 'incoming' | 'queued' | 'sent' | 'duplicate-suppressed';

export interface MessageLogMeta {
  peerId: string;
  messageId?: string;
  textLength: number;
}

export function formatMessageLog(kind: MessageLogKind, meta: MessageLogMeta): string {
  return `Message ${kind}: peer=${meta.peerId.slice(0, 12)} messageId=${meta.messageId ?? 'unavailable'} textLength=${meta.textLength}`;
}

export function redactNetworkAddresses(text: string): string {
  return text
    .replace(/(candidate:\S+\s+\d+\s+\S+\s+\d+\s+)\S+(\s+)\d+(\s+typ\b)/gi, '$1[address]$2[port]$3')
    .replace(/\[([\da-f:.]+)\](?::\d{1,5})?/gi, (match, address: string) => isIpv6Address(address) ? '[address]' : match)
    .replace(/(?<![\da-f:])(?:[\da-f]{0,4}:){2,7}[\da-f]{0,4}(?![\da-f:])/gi, (match) => isIpv6Address(match) ? '[address]' : match)
    .replace(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{1,5})?\b/g, '[address]')
    .replace(/\b((?:port|relatedPort|localPort|remotePort)\s*[=:]\s*)\d+\b/gi, '$1[port]');
}

export function appendBoundedLog<T>(logs: readonly T[], entry: T, max = 200): T[] {
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 200;
  return limit === 0 ? [] : [...logs, entry].slice(-limit);
}

export function shouldRenderDiagnosticPayload(objectType: string): boolean {
  return objectType === 'mycelium.post';
}

function isIpv6Address(address: string): boolean {
  try {
    return new URL(`http://[${address}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}