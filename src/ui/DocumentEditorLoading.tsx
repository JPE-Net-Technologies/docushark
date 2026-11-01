/**
 * The document editor while its lazy chunk loads (DSK-205).
 *
 * It paints the panel's own backdrop, so nothing shifts when the editor
 * arrives, and fades in a quiet bar only once the wait is long enough to
 * notice. Its styles live in App.css: the panel's stylesheet ships inside the
 * chunk being waited on.
 */
export function DocumentEditorLoading() {
  return (
    <div className="document-editor-loading" role="status" aria-label="Loading the editor">
      <span className="document-editor-loading__bar" aria-hidden="true" />
    </div>
  );
}
