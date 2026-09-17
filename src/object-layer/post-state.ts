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

export function localPostMetadata(view: LocalPostView): LocalPostMetadata {
  return {
    object_id: view.object.object_id,
    authorFingerprint: view.authorFingerprint,
    ...(view.authorDisplayName ? { authorDisplayName: view.authorDisplayName } : {}),
    ...(view.source ? { source: view.source } : {}),
    ...(view.reaction ? { reaction: view.reaction } : {}),
    ...(view.isRecommendation === undefined ? {} : { isRecommendation: view.isRecommendation }),
    ...(view.recommendedBy ? { recommendedBy: view.recommendedBy } : {}),
    ...(view.notInterested === undefined ? {} : { notInterested: view.notInterested }),
    ...(view.hidden === undefined ? {} : { hidden: view.hidden })
  };
}

export async function hydratePostViews(
  objectStore: ObjectStore,
  metadataStore: LocalPostMetadataStore,
  onError: (error: unknown) => void = () => undefined
): Promise<LocalPostView[]> {
  try {
    const [objects, metadata] = await Promise.all([
      objectStore.query({ object_type: 'mycelium.post' }),
      metadataStore.query()
    ]);
    const metadataById = new Map(metadata.map((item) => [item.object_id, item]));
    return objects.map((object) => {
      const item = metadataById.get(object.object_id);
      return createLocalPostView(
        object as PostObject,
        item?.authorFingerprint ?? object.author,
        item ? {
          authorDisplayName: item.authorDisplayName,
          source: item.source ?? 'peer',
          reaction: item.reaction,
          isRecommendation: item.isRecommendation,
          recommendedBy: item.recommendedBy,
          notInterested: item.notInterested,
          hidden: item.hidden
        } : { source: 'peer' }
      );
    });
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
      reaction: next.reaction ?? existing.reaction,
      recommendedBy: next.recommendedBy ?? existing.recommendedBy,
      isRecommendation: next.isRecommendation ?? existing.isRecommendation,
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