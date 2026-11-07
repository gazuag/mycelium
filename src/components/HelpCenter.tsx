import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { helpArticleText, helpArticles, helpCategories } from '../help/help-content';

interface HelpCenterProps {
  onClose: () => void;
  onStartTour: () => void;
  showTour?: boolean;
}

export function HelpCenter({ onClose, onStartTour, showTour = true }: HelpCenterProps) {
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState(helpCategories[0].id);
  const [selectedArticleId, setSelectedArticleId] = useState(helpArticles[0].id);
  const searchRef = useRef<HTMLInputElement>(null);

  const matchingArticles = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return helpArticles.filter((article) => {
      if (!normalizedQuery && article.category !== categoryId) return false;
      if (!normalizedQuery) return true;
      const searchableText = [
        article.title,
        helpArticleText(article.summary),
        ...article.details.map(helpArticleText),
        ...article.keywords
      ].join(' ').toLocaleLowerCase();
      return searchableText.includes(normalizedQuery);
    });
  }, [categoryId, query]);
  const selectedArticle = matchingArticles.find((article) => article.id === selectedArticleId)
    ?? matchingArticles[0];

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = document.querySelector<HTMLElement>('.help-center-dialog');
      const focusable = dialog
        ? Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], summary'))
        : [];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  const selectCategory = (nextCategoryId: typeof categoryId) => {
    setQuery('');
    setCategoryId(nextCategoryId);
    setSelectedArticleId(helpArticles.find((article) => article.category === nextCategoryId)?.id ?? '');
  };

  return createPortal(
    <div
      className="help-center-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="help-center-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-center-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="help-center-header">
          <div>
            <p className="help-center-eyebrow">MYCELIUM HELP</p>
            <h1 id="help-center-title">How can we help?</h1>
          </div>
          <button className="help-center-close icon-btn" type="button" aria-label="Close Help centre" onClick={onClose}>
            <span aria-hidden="true">&times;</span>
          </button>
        </header>

        {showTour ? (
          <div className="help-center-tour-callout">
            <div>
              <strong>New to Mycelium?</strong>
              <p>Take a short tour of the main areas. You can leave at any time.</p>
            </div>
            <button className="btn" type="button" onClick={onStartTour}>Start guided tour</button>
          </div>
        ) : null}

        <label className="help-center-search">
          <span className="visually-hidden">Search help articles</span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setSelectedArticleId('');
            }}
            placeholder="Search help articles"
          />
        </label>

        <div className="help-center-content">
          <nav className="help-center-topics" aria-label="Help topics">
            <div className="help-center-categories" aria-label="Help categories">
              {helpCategories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={categoryId === category.id && !query ? 'active' : ''}
                  aria-pressed={categoryId === category.id && !query}
                  onClick={() => selectCategory(category.id)}
                >
                  {category.title}
                </button>
              ))}
            </div>
            <div className="help-center-article-list" aria-label={query ? 'Search results' : 'Articles'}>
              {matchingArticles.length > 0 ? matchingArticles.map((article) => (
                <button
                  key={article.id}
                  type="button"
                  className={selectedArticle?.id === article.id ? 'active' : ''}
                  aria-current={selectedArticle?.id === article.id ? 'page' : undefined}
                  onClick={() => setSelectedArticleId(article.id)}
                >
                  <span>{article.title}</span>
                  {query ? <small>{helpCategories.find((category) => category.id === article.category)?.title}</small> : null}
                </button>
              )) : <p className="help-center-empty">No articles match that search. Try another word.</p>}
            </div>
          </nav>

          <article className="help-center-article" aria-live="polite">
            {selectedArticle ? (
              <>
                <p className="help-center-article-category">
                  {helpCategories.find((category) => category.id === selectedArticle.category)?.title}
                </p>
                <h2>{selectedArticle.title}</h2>
                <p className={`help-center-article-summary${typeof selectedArticle.summary === 'string' ? '' : ' help-center-backup-warning'}`}>
                  {typeof selectedArticle.summary === 'string'
                    ? selectedArticle.summary
                    : <strong>{helpArticleText(selectedArticle.summary)}</strong>}
                </p>
                <div className="help-center-article-details">
                  {selectedArticle.details.map((paragraph) => (
                    <p
                      key={helpArticleText(paragraph)}
                      className={typeof paragraph === 'string' ? undefined : 'help-center-backup-warning'}
                    >
                      {typeof paragraph === 'string' ? paragraph : <strong>{helpArticleText(paragraph)}</strong>}
                    </p>
                  ))}
                </div>
              </>
            ) : (
              <p className="help-center-empty">Choose an article to read.</p>
            )}
          </article>
        </div>

        <footer className="help-center-footer">
          {showTour ? <span>Need a quick introduction? You can replay the tour any time.</span> : null}
          <button className="btn secondary" type="button" onClick={onClose}>Return to Mycelium</button>
        </footer>
      </section>
    </div>,
    document.body
  );
}
