import type { LocalPostMetadata, LocalPostMetadataStore, LocalPostView, ObjectStore, PostObject } from './types';

export function postPayload(view: LocalPostView): Record<string, unknown> {
  return typeof view.object.payload === 'object' && view.object.payload !== null && !Array.isArray(view.object.payload)
    ? view.object.payload as Record<string, unknown>
    : {};
}

export function postContent(view: LocalPostView): string {
  const content = postPayload(view).content;
  return typeof content === 'string' ? content : '';
}

export function postTags(view: LocalPostView): string[] {
  const tags = postPayload(view).tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
}

export function postReplyTo(view: LocalPostView): string | undefined {
  const replyTo = postPayload(view).reply_to;
  return typeof replyTo === 'string' ? replyTo : undefined;
}

export function createLocalPostView(
  object: PostObject,
  authorFingerprint: string,
  metadata: Omit<LocalPostView, 'object' | 'authorFingerprint'> = {}
): LocalPostView {
  return { object, authorFingerprint, ...metadata };
}

export function selectFollowedPosts(posts: readonly LocalPostView[], followedAuthorKeys: ReadonlySet<string>): LocalPostView[] {
  const followedPosts = posts.filter((post) => followedAuthorKeys.has(post.authorFingerprint) || followedAuthorKeys.has(post.object.author));
  const selectedIds = new Set(followedPosts.map((post) => post.object.object_id));
  let addedReply = true;
  while (addedReply) {
    addedReply = false;
    for (const post of posts) {
      const parentId = postReplyTo(post);
      if (parentId && selectedIds.has(parentId) && !selectedIds.has(post.object.object_id)) {
        selectedIds.add(post.object.object_id);
        addedReply = true;
      }
    }
  }

  return posts
    .filter((post) => selectedIds.has(post.object.object_id))
    .sort((left, right) => new Date(right.object.created_at).getTime() - new Date(left.object.created_at).getTime());
}

export function localPostMetadata(view: LocalPostView): LocalPostMetadata {
  return {
    object_id: view.object.object_id,
    authorFingerprint: view.authorFingerprint,
    ...(view.authorDisplayName ? { authorDisplayName: view.authorDisplayName } : {}),
    ...(view.source ? { source: view.source } : {}),
    ...(view.notInterested === undefined ? {} : { notInterested: view.notInterested }),
    ...(view.hidden === undefined ? {} : { hidden: view.hidden })
  };
}

export async function hydratePostViews(
  objectStore: ObjectStore,
  metadataStore: LocalPostMetadataStore,
  onError: (error: unknown) => void = () => undefined,
  resolveAuthorFingerprint: (author: string) => Promise<string> = async (author) => author
): Promise<LocalPostView[]> {
  try {
    const [objects, metadata] = await Promise.all([
      objectStore.query({ object_type: 'mycelium.post' }),
      metadataStore.query()
    ]);
    const metadataById = new Map(metadata.map((item) => [item.object_id, item]));
    return Promise.all(objects.map(async (object) => {
      const item = metadataById.get(object.object_id);
      const authorFingerprint = item?.authorFingerprint ?? await resolveAuthorFingerprint(object.author);
      return createLocalPostView(
        object as PostObject,
        authorFingerprint,
        item ? {
          authorDisplayName: item.authorDisplayName,
          source: item.source ?? 'peer',
          notInterested: item.notInterested,
          hidden: item.hidden
        } : { source: 'peer' }
      );
    }));
  } catch (error) {
    onError(error);
    return [];
  }
}

export function upsertLocalPostView(views: LocalPostView[], next: LocalPostView): LocalPostView[] {
  const existing = views.find((view) => view.object.object_id === next.object.object_id);
  const merged = existing
    ? {
      ...next,
      notInterested: next.notInterested ?? existing.notInterested,
      hidden: next.hidden ?? existing.hidden
    }
    : next;
  return [merged, ...views.filter((view) => view.object.object_id !== next.object.object_id)];
}

export function mergeLocalPostViews(views: LocalPostView[], incoming: LocalPostView[]): LocalPostView[] {
  return incoming.reduce(upsertLocalPostView, views);
}

export function createReplyObjectPayload(replyTo: string): { reply_to: string } {
  return { reply_to: replyTo };
}