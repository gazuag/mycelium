interface LikeButtonProps {
  isLiked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

export function LikeButton({ isLiked, disabled = false, onToggle }: LikeButtonProps) {
  return (
    <button
      className={`like-button${isLiked ? ' liked' : ''}`}
      onClick={onToggle}
      type="button"
      disabled={disabled}
      aria-label={isLiked ? 'Unlike post' : 'Like post'}
      aria-pressed={isLiked}
      title={isLiked ? 'Unlike' : 'Like'}
    >
      <span aria-hidden="true">{isLiked ? '\u2665' : '\u2661'}</span>
    </button>
  );
}
