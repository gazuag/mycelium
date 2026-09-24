import { isRecommendationObject } from './envelope';
import type { DistributedObject, LocalPostView, RecommendationObject, RecommendationSummary } from './types';

type RecommendationKey = string;

function keyFor(author: string, postId: string): RecommendationKey {
  return `${author}\u0000${postId}`;
}

export function recommendationWeight(followedRecommenderCount: number): number {
  return 1 - Math.pow(1 - 0.2, Math.max(0, followedRecommenderCount));
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(value: string): number {
  return (hashSeed(value) + 1) / 4294967297;
}

export interface RecommendationSelectionOptions {
  readonly capacity: number;
  readonly localIdentity: string;
  readonly feedDay: string;
  readonly followedAuthorKeys: ReadonlySet<string>;
  readonly alreadySelectedIds?: ReadonlySet<string>;
  readonly isHidden?: (post: LocalPostView) => boolean;
  readonly isBlocked?: (post: LocalPostView) => boolean;
}

export function selectRecommendationCandidates(
  posts: readonly LocalPostView[],
  getSummary: (postId: string) => RecommendationSummary,
  options: RecommendationSelectionOptions
): LocalPostView[] {
  const selectedIds = options.alreadySelectedIds ?? new Set<string>();
  const candidates = posts.flatMap((post) => {
    if (selectedIds.has(post.object.object_id) || options.isHidden?.(post) || options.isBlocked?.(post)) return [];
    if (options.followedAuthorKeys.has(post.object.author) || options.followedAuthorKeys.has(post.authorFingerprint)) return [];
    const summary = getSummary(post.object.object_id);
    const weight = recommendationWeight(summary.followed_recommender_count);
    if (weight <= 0) return [];
    const key = `${post.object.object_id}${options.localIdentity}${options.feedDay}`;
    return [{ post, sortKey: -Math.log(seededUnit(key)) / weight }];
  });

  return candidates
    .sort((left, right) => left.sortKey - right.sortKey || left.post.object.object_id.localeCompare(right.post.object.object_id))
    .slice(0, Math.max(0, options.capacity))
    .map((candidate) => candidate.post);
}

export class RecommendationIndex {
  private readonly latestByAuthorAndPost = new Map<RecommendationKey, RecommendationObject>();

  add(object: DistributedObject): boolean {
    if (!isRecommendationObject(object)) return false;
    const payload = object.payload as { post_id: string };
    const key = keyFor(object.author, payload.post_id);
    const existing = this.latestByAuthorAndPost.get(key);
    if (existing && (existing.sequence ?? 0) >= (object.sequence ?? 0)) return false;
    this.latestByAuthorAndPost.set(key, object);
    return true;
  }

  addAll(objects: Iterable<DistributedObject>): number {
    let changed = 0;
    for (const object of objects) {
      if (this.add(object)) changed += 1;
    }
    return changed;
  }

  rebuild(objects: Iterable<DistributedObject>): void {
    this.latestByAuthorAndPost.clear();
    this.addAll(objects);
  }

  getSummary(postId: string, followedAuthors: Iterable<string> = [], localAuthor?: string): RecommendationSummary {
    const followed = new Set(followedAuthors);
    const activeRecommenders = [...this.latestByAuthorAndPost.values()]
      .filter((object) => {
        const payload = object.payload as { post_id: string; action: 'recommend' | 'withdraw' };
        return payload.post_id === postId && payload.action === 'recommend';
      })
      .map((object) => object.author);
    const followedRecommenders = activeRecommenders.filter((author) => followed.has(author));
    return {
      post_id: postId,
      active_recommenders: activeRecommenders,
      active_recommender_count: activeRecommenders.length,
      followed_recommenders: followedRecommenders,
      followed_recommender_count: followedRecommenders.length,
      recommended_by_me: localAuthor ? activeRecommenders.includes(localAuthor) : false
    };
  }
}