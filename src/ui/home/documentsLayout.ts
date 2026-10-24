/**
 * Layout constants the Documents surface shares between its TSX and CSS
 * (DSK-196). Each literal is repeated in a stylesheet, which can't import it;
 * `narrowLayout.css.test.ts` pins both sides together.
 */

/** The size container `.dh-content` declares (`container-name`). */
export const DOCUMENTS_LIST_CONTAINER = 'documents-list';

/**
 * The list width (content box, px) at or below which a list row becomes two
 * lines. The table row's fixed tracks (checkbox, last edited, people, size,
 * details toggle, actions, padding) take about 524px, so at 680 the name still
 * has about 150px; every desktop width from 1024px up stays above it.
 */
export const LIST_ROWS_NARROW_MAX = 680;
