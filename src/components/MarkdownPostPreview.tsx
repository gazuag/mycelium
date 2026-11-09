import { useState } from 'react';
import { MarkdownContent } from './MarkdownContent';

const POST_PREVIEW_LENGTH = 300;

interface MarkdownPostPreviewProps {
  source: string;
  imageSizes?: unknown;
  className?: string;
}

export function MarkdownPostPreview({ source, imageSizes, className = '' }: MarkdownPostPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = source.length > POST_PREVIEW_LENGTH;

  return (
    <div className={`rendered-post-preview${className ? ` ${className}` : ''}${canExpand && !expanded ? ' is-collapsed' : ''}`}>
      <MarkdownContent source={source} imageSizes={imageSizes} />
      {canExpand && !expanded ? (
        <button
          className="post-content-more"
          type="button"
          aria-label="Show full post"
          onClick={() => setExpanded(true)}
        >
          more...
        </button>
      ) : null}
    </div>
  );
}
