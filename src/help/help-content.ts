export type HelpCategoryId = 'getting-started' | 'using-mycelium' | 'privacy-advanced' | 'troubleshooting';

export interface HelpCategory {
  id: HelpCategoryId;
  title: string;
}

export interface HelpArticle {
  id: string;
  category: HelpCategoryId;
  title: string;
  summary: HelpArticleText;
  details: HelpArticleText[];
  keywords: string[];
  tourDescription?: string;
}

export type HelpArticleText = string | { text: string; emphasis: 'backup-warning' };

export function helpArticleText(value: HelpArticleText): string {
  return typeof value === 'string' ? value : value.text;
}

export const helpCategories: HelpCategory[] = [
  { id: 'getting-started', title: 'Getting started' },
  { id: 'using-mycelium', title: 'Using Mycelium' },
  { id: 'privacy-advanced', title: 'Privacy and advanced topics' },
  { id: 'troubleshooting', title: 'Troubleshooting' }
];

export const helpArticles: HelpArticle[] = [
  {
    id: 'what-is-mycelium',
    category: 'getting-started',
    title: 'What is Mycelium?',
    summary: 'Mycelium is a peer-to-peer social app for sharing posts and having encrypted direct-message conversations.',
    details: [
      'There is no central user directory. The app uses servers for connection setup and optional public-content discovery, while connected peers exchange data directly when possible.',
      'Mycelium is a prototype. Peer availability, discovery, background delivery, and synchronization are not guaranteed.'
    ],
    keywords: ['social', 'posts', 'messages', 'peer to peer', 'overview']
  },
  {
    id: 'identity-handle',
    category: 'getting-started',
    title: 'Your identity and generated handle',
    summary: 'Your identity is created on this device. Its generated handle is a readable way to identify your unique cryptographic identity.',
    details: [
      'The handle is derived from your identity ID, which is tied to your signing key. It is not a display name and is not a password.',
      { text: 'Keep an identity backup somewhere safe. If the device copy is lost and you have no backup, the identity and its private keys cannot be recovered from the handle alone.', emphasis: 'backup-warning' }
    ],
    keywords: ['identity', 'handle', 'fingerprint', 'unique', 'key', 'ID']
  },
  {
    id: 'display-name',
    category: 'getting-started',
    title: 'Display name versus unique identity',
    summary: 'Your display name is the name shown on your profile; your generated handle identifies the underlying identity.',
    details: [
      'You can edit your display name and bio from Profile. Changing the display name does not change your identity ID, keys, or handle.',
      'Display names are not unique and do not prove that two accounts with the same name belong to the same person.'
    ],
    keywords: ['profile', 'name', 'handle', 'unique']
  },
  {
    id: 'identity-backup',
    category: 'getting-started',
    title: 'Back up your identity',
    summary: { text: 'In Settings → Identity management, export an identity backup and keep the downloaded file somewhere private and secure.', emphasis: 'backup-warning' },
    details: [
      'The backup contains your identity ID, public and private signing keys, encryption keys, profile preferences, and contact records. It does not contain your posts, messages, or the app’s complete local data.',
      { text: 'You can encrypt the backup with a passphrase in Settings. Without a passphrase the downloaded JSON is unencrypted and anyone who obtains it may control that identity. If you encrypt it, keep the passphrase separately; Mycelium cannot recover a forgotten passphrase.', emphasis: 'backup-warning' },
      { text: 'Export a fresh backup after important profile or contact changes. A backup is a snapshot from the time it was exported.', emphasis: 'backup-warning' }
    ],
    keywords: ['backup', 'export', 'identity', 'private key', 'encrypted', 'passphrase']
  },
  {
    id: 'restore-backup',
    category: 'getting-started',
    title: 'Restore an identity from a backup',
    summary: 'Use Settings → Identity management → Import Identity and select your backup file. Enter its passphrase if it was encrypted.',
    details: [
      'Import restores the identity keys and ID, profile preferences, and contacts included in that backup. It does not restore posts, direct messages, or all application data.',
      { text: 'Import changes the active identity and profile/contact data in this browser. Export any identity you want to keep before importing another one.', emphasis: 'backup-warning' },
      { text: 'The backup is a file, so you can move it to another browser or device where Mycelium is available. The file must remain private, especially if it is not encrypted.', emphasis: 'backup-warning' }
    ],
    keywords: ['restore', 'import', 'backup', 'identity', 'device', 'browser']
  },
  {
    id: 'finding-people',
    category: 'getting-started',
    title: 'Finding and connecting with people',
    summary: 'Use Discover to browse available people and public posts. You can follow a profile or add a peer by address in Settings.',
    details: [
      'Discover → People may show popular or suggested profiles when discovery data is available. Results can be empty, and seeing a profile does not mean that person is currently reachable.',
      'You can also use Settings → Advanced → Follow peer by address with a handle, peer ID, or public key. Following and having a live peer connection are separate things.'
    ],
    keywords: ['discover', 'people', 'follow', 'connect', 'peer', 'address'],
    tourDescription: 'Discover has Posts and People views. Browse public posts, look for suggested profiles, and follow someone you want to keep up with.'
  },
  {
    id: 'home-feed',
    category: 'using-mycelium',
    title: 'Understanding the Home feed',
    summary: 'Home brings together posts available on this device, including followed-account and discovery content.',
    details: [
      'What appears depends on what has been published, received, and cached, as well as your Home feed preferences in Settings. A new account or an offline connection may have little or no content.',
      'The feed is not a complete archive. Posts can be unavailable if they have not reached this device or a peer it can currently contact.'
    ],
    keywords: ['home', 'feed', 'posts', 'empty', 'discovery'],
    tourDescription: 'Home is your feed. Read posts available to you, write a post, and open a post to reply.'
  },
  {
    id: 'posts-replies',
    category: 'using-mycelium',
    title: 'Creating posts and replying',
    summary: 'Write a post from Home, or open a post and use its reply controls to join the conversation.',
    details: [
      'Posts and replies are signed with your identity. When “Publish to discovery” is enabled in Settings, they may also be sent to the discovery service.',
      'You can include Markdown formatting and mentions. A successful local action does not guarantee every peer has received or stored the post.'
    ],
    keywords: ['post', 'reply', 'write', 'publish', 'markdown']
  },
  {
    id: 'following',
    category: 'using-mycelium',
    title: 'Following people',
    summary: 'Follow a person from a profile or Discover to include their activity in your relationships and feed.',
    details: [
      'Following is a local relationship preference. It does not by itself create a live network connection, guarantee that their posts will reach you, or mean that they follow you back.',
      'Use Profile relationship links to view following and follower lists.'
    ],
    keywords: ['follow', 'unfollow', 'following', 'followers', 'relationship']
  },
  {
    id: 'direct-messages',
    category: 'using-mycelium',
    title: 'Direct messages',
    summary: 'Open Messages to read conversations, view replies, or start a message with an available contact.',
    details: [
      'Direct-message content is encrypted for its intended recipient. Mycelium stores message objects locally and exchanges them through its object and peer transport; delivery and syncing depend on peers being reachable.',
      'Messages are not included in an identity backup. Notification badges can indicate unread messages or replies.'
    ],
    keywords: ['message', 'chat', 'direct', 'encrypted', 'conversation'],
    tourDescription: 'Messages brings conversations and replies together, with unread notifications for messages and replies. Notification preferences, including followed-post updates, are in Settings.'
  },
  {
    id: 'notifications',
    category: 'using-mycelium',
    title: 'Notifications',
    summary: 'Notification categories and optional Web Push controls are in Settings.',
    details: [
      'The local preferences cover direct messages, replies to your posts, and new posts from people you follow. They control notifications, not whether Mycelium verifies or synchronizes objects.',
      'Web Push is optional and requires you to enable it and grant browser permission. Background delivery is best-effort; it is not a guaranteed way to receive or synchronize messages.'
    ],
    keywords: ['notification', 'push', 'unread', 'replies', 'settings'],
    tourDescription: 'There is no separate Notifications tab. Settings contains notification preferences for messages, replies, and followed posts; optional Web Push also needs your permission.'
  },
  {
    id: 'profile',
    category: 'using-mycelium',
    title: 'Your profile',
    summary: 'Profile shows your identity, display name, bio, posts, and relationship counts.',
    details: [
      'Edit your display name and bio from your own Profile. Your generated handle and identity keys remain unchanged.',
      'Changes to your signed profile can be shared with discovery and connected peers; availability elsewhere depends on those services and peers.'
    ],
    keywords: ['profile', 'bio', 'display name', 'handle'],
    tourDescription: 'Profile shows your public identity and posts. Edit your display name or bio there; the generated handle stays the same.'
  },
  {
    id: 'settings',
    category: 'using-mycelium',
    title: 'Settings and preferences',
    summary: 'Settings includes feed and publishing options, notifications, identity backup, peer tools, and diagnostics.',
    details: [
      'You can manage notification preferences, identity import/export, storage limits, discovery publishing, and other local preferences here.',
      'The Advanced area includes adding a peer by address. Diagnostics can help explain connection or synchronization problems.'
    ],
    keywords: ['settings', 'preferences', 'backup', 'diagnostics', 'peer'],
    tourDescription: 'Configure feed, publishing, and notification preferences; manage identity backups and storage; and inspect connection and synchronization diagnostics in Settings.'
  },
  {
    id: 'online-indicator',
    category: 'using-mycelium',
    title: 'Understanding the Online indicator',
    summary: 'The header indicator reports Mycelium’s connection state, not whether every person or post is available.',
    details: [
      'Connected means the app has a connection to its signalling server; the expanded status panel also reports open peer connections. Connecting and Disconnected describe the app’s current server connection.',
      'A connected status does not guarantee that a particular peer is online, that a post has synchronized, or that a message has been delivered.'
    ],
    keywords: ['online', 'connected', 'status', 'signalling', 'offline']
  },
  {
    id: 'peer-to-peer',
    category: 'privacy-advanced',
    title: 'How peer-to-peer connections work',
    summary: 'Mycelium uses a signalling service to help peers establish a direct WebRTC connection when possible.',
    details: [
      'The signalling service handles connection setup and optional discovery requests. Once connected, peers exchange data directly over WebRTC when the network allows it.',
      'Direct connectivity is not always possible. A connected signalling server does not mean every peer connection is open.'
    ],
    keywords: ['peer', 'webrtc', 'signalling', 'network', 'architecture']
  },
  {
    id: 'local-vs-shared',
    category: 'privacy-advanced',
    title: 'What is stored locally and what is shared?',
    summary: 'Your identity keys are stored in this browser’s IndexedDB. Public posts and signed profile information may be shared; direct-message content is encrypted.',
    details: [
      'Contacts, cached objects, cursors, and other app data are also stored locally. Some signed profile information and public posts can be published to discovery; objects may also be exchanged with peers.',
      'The discovery service handles public content and identity profile discovery. Direct-message contents are encrypted for the intended recipient. No backup currently includes all local application data.'
    ],
    keywords: ['local', 'storage', 'indexeddb', 'shared', 'distributed', 'data', 'privacy']
  },
  {
    id: 'identity-keys',
    category: 'privacy-advanced',
    title: 'Identity keys and why backups matter',
    summary: 'Your private keys prove control of your identity. The generated handle cannot be used to recreate those keys.',
    details: [
      'Mycelium uses a signing key pair for identity and signed content, plus encryption keys for direct messages. The private keys remain on your device unless you export them in a backup.',
      { text: 'Treat an unencrypted backup like a password. Encrypt it with a strong passphrase or store it somewhere protected. Losing both the device copy and every backup means the identity cannot be recovered.', emphasis: 'backup-warning' }
    ],
    keywords: ['key', 'private key', 'identity', 'backup', 'cryptography']
  },
  {
    id: 'discovery-following',
    category: 'privacy-advanced',
    title: 'Discovery versus following',
    summary: 'Discovery helps find public posts and possible profiles; following is your local choice to keep track of a profile.',
    details: [
      'Discovery results can be incomplete or unavailable. A profile found through discovery is not automatically followed, and following does not guarantee a direct connection.',
      'Mycelium may use discovery results as part of Home feed content according to your preferences.'
    ],
    keywords: ['discovery', 'follow', 'people', 'public']
  },
  {
    id: 'offline',
    category: 'privacy-advanced',
    title: 'What happens when you are offline?',
    summary: 'Mycelium can show content already stored on your device, but discovery and peer synchronization need network connectivity.',
    details: [
      'When connections return, the app may resume supported synchronization and outbox work. The timing and success of delivery depend on available peers and services.',
      'Web Push is opportunistic and does not guarantee background retrieval or message delivery.'
    ],
    keywords: ['offline', 'cache', 'sync', 'outbox', 'connectivity']
  },
  {
    id: 'privacy-security',
    category: 'privacy-advanced',
    title: 'Privacy and security considerations',
    summary: 'Keep your device and backups secure, and remember that a peer-to-peer design does not make all information private.',
    details: [
      'Public posts and published profile details can be shared with discovery services and peers. Do not put sensitive information in public posts.',
      { text: 'Identity signatures prove possession of a key, not a person’s real-world identity. Protect private keys and never share an unencrypted backup.', emphasis: 'backup-warning' },
      'Network services may observe connection and request metadata. Read the relevant service and browser policies before relying on Mycelium for sensitive communication.'
    ],
    keywords: ['privacy', 'security', 'public', 'metadata', 'identity']
  },
  {
    id: 'feed-empty',
    category: 'troubleshooting',
    title: 'My feed is empty',
    summary: 'A new identity may have no posts yet. Try Discover, follow a person, or check your connection and feed settings.',
    details: [
      'Home only shows content available to this device. Discovery may have no results, and followed people may not have published posts or may not be reachable.',
      'Check the Online indicator and Settings → Home feed preferences. A blank feed does not mean your identity failed to load.'
    ],
    keywords: ['empty', 'feed', 'no posts', 'home', 'discover']
  },
  {
    id: 'cannot-connect',
    category: 'troubleshooting',
    title: 'I cannot connect to another peer',
    summary: 'Check the Online indicator, confirm you have the right peer address, and try again when both sides have network access.',
    details: [
      'Mycelium uses signalling and WebRTC, and some networks prevent direct connections. A peer can be discoverable without being reachable now.',
      'Open Settings → Diagnostics for connection details. A connected signalling server alone does not guarantee a peer-to-peer connection.'
    ],
    keywords: ['connect', 'peer', 'webrtc', 'signalling', 'network']
  },
  {
    id: 'cannot-find-profile',
    category: 'troubleshooting',
    title: 'I cannot find someone’s profile',
    summary: 'Try Discover → People or ask the person for their handle, peer ID, or public key.',
    details: [
      'Discovery is not a complete directory. If you already have their address, Settings → Advanced lets you add a peer by address.',
      'A profile may not appear until profile information has been published or exchanged with your device.'
    ],
    keywords: ['profile', 'find', 'search', 'discover', 'handle']
  },
  {
    id: 'old-identity',
    category: 'troubleshooting',
    title: 'I cannot access an old identity',
    summary: 'Look for an identity backup file and import it from Settings → Identity management.',
    details: [
      { text: 'If the old identity still exists in the original browser profile, export its backup before clearing site data or changing identities.', emphasis: 'backup-warning' },
      { text: 'Importing changes the active identity on the current browser. Back up any identity you want to keep before importing.', emphasis: 'backup-warning' }
    ],
    keywords: ['old identity', 'restore', 'backup', 'import', 'lost']
  },
  {
    id: 'lost-backup',
    category: 'troubleshooting',
    title: 'I lost my identity backup',
    summary: { text: 'If the identity is still on a device, export a new backup there. A handle alone cannot restore the identity.', emphasis: 'backup-warning' },
    details: [
      'If the original device copy and all backups are gone, Mycelium cannot reconstruct the private keys. A peer’s copy of your public profile is not a replacement for your private identity.',
      'If the lost backup was encrypted, you also need its passphrase to restore it.'
    ],
    keywords: ['lost', 'backup', 'identity', 'handle', 'recover']
  },
  {
    id: 'offline-not-updating',
    category: 'troubleshooting',
    title: 'Mycelium appears offline or is not updating',
    summary: 'Check your network connection and the header status. Then open Settings → Diagnostics for more detail.',
    details: [
      'Discovery, peer connections, and Web Push are separate best-effort services. Some content may remain unavailable until a peer or service can be reached.',
      { text: 'Refreshing the app may help after a temporary interruption. Do not clear browser data unless you have backed up your identity; clearing it can remove the local identity and app data.', emphasis: 'backup-warning' }
    ],
    keywords: ['offline', 'not updating', 'disconnected', 'sync', 'diagnostics']
  },
  {
    id: 'help-centre',
    category: 'using-mycelium',
    title: 'Using the Help centre and guided tour',
    summary: 'Open Help from the header any time to search articles or replay the guided tour.',
    details: [
      'The Help centre opens over your current page. Close it to return to the same place in the app.',
      'The guided tour highlights navigation controls without sending messages, creating posts, changing settings, or changing your current page.'
    ],
    keywords: ['help', 'tour', 'introduction', 'guide'],
    tourDescription: 'Help is always available from the question-mark button in the header. Search the Help centre or replay this tour whenever you like.'
  }
];

export const guidedTourSteps = [
  { id: 'home', title: 'Home and your feed', target: '[data-tour-target="home"]', articleId: 'home-feed' },
  { id: 'messages', title: 'Messages', target: '[data-tour-target="messages"]', articleId: 'direct-messages' },
  { id: 'discover', title: 'Discover', target: '[data-tour-target="discover"]', articleId: 'finding-people' },
  { id: 'profile', title: 'Profile', target: '[data-tour-target="myProfile"]', articleId: 'profile' },
  { id: 'settings', title: 'Settings', target: '[data-tour-target="settings"]', articleId: 'settings' },
  { id: 'help', title: 'Help centre', target: '[data-tour-target="help"]', articleId: 'help-centre' }
].map((step) => {
  const article = helpArticles.find((item) => item.id === step.articleId);
  if (!article?.tourDescription) {
    throw new Error(`Guided tour article is missing: ${step.articleId}`);
  }
  return { ...step, description: article.tourDescription };
});
