interface HideButtonProps {
  postId: string;
  onHide: (postId: string) => void;
}

export function HideButton({ postId, onHide }: HideButtonProps) {
  return (
    <button className="chip" onClick={() => onHide(postId)} type="button">
      Hide
    </button>
  );
}
