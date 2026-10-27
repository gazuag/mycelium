export function resizeTextareaToRows(textarea: HTMLTextAreaElement, maxRows: number): void {
  const styles = window.getComputedStyle(textarea);
  const fontSize = Number.parseFloat(styles.fontSize) || 16;
  const lineHeight = Number.parseFloat(styles.lineHeight) || fontSize * 1.6;
  const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
  const verticalBorder = Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth);
  const maxHeight = lineHeight * maxRows + verticalPadding + verticalBorder;

  textarea.style.height = 'auto';
  const contentHeight = textarea.scrollHeight + verticalBorder;
  textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
  textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
}
