import { isRecommendationObject } from './envelope';
import type { DistributedObject, RecommendationObject, RecommendationSummary } from './types';

type RecommendationKey = string;

function keyFor(author: string, postId: string): RecommendationKey {
  return `${author}\u0000${postId}`;
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