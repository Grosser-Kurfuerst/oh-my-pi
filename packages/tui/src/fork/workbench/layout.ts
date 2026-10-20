/**
 * Pure geometry for the workbench shell: column and row allocation plus
 * hit-testing of 0-based screen coordinates.
 */

/** Rows the scrollable content area keeps even when the bottom chrome is tall. */
export const MIN_CONTENT_ROWS = 4;
/** The turn rail: one gap column, then the rail itself. */
export const RAIL_COLUMNS = 2;
/** Narrower main columns drop the rail and give the transcript every column. */
export const MIN_RAIL_MAIN_COLUMNS = 20;

export interface ColumnSpan {
	readonly x: number;
	readonly width: number;
}

export interface WorkbenchLayout {
	readonly columns: number;
	readonly rows: number;
	/** Main column: transcript content above, pinned chrome (editor, status) below. */
	readonly main: ColumnSpan;
	/** The transcript part of the main column, left of the rail. */
	readonly content: ColumnSpan;
	/** Gap plus rail, beside the content rows only; absent on narrow screens. */
	readonly rail: ColumnSpan | undefined;
	/** First screen row of the pinned bottom area; the content area spans `[0, bottomTop)`. */
	readonly bottomTop: number;
}

export type WorkbenchRegion = "content" | "rail" | "bottom" | "outside";

/** Most rows the pinned bottom area may take on a screen `rows` tall. */
export function bottomRowCap(rows: number): number {
	return Math.max(0, rows - MIN_CONTENT_ROWS);
}

/**
 * Keep the bottom chrome within {@link bottomRowCap}. The tail survives: the
 * cursor row and a selector's highlighted entry sit near the bottom.
 */
export function clampBottomRows(lines: readonly string[], rows: number): readonly string[] {
	const cap = bottomRowCap(rows);
	return lines.length > cap ? lines.slice(lines.length - cap) : lines;
}

/** Main column span; independent of row allocation so chrome can render at its width first. */
export function mainColumn(columns: number): ColumnSpan {
	return { x: 0, width: Math.max(1, columns) };
}

/** Content span inside `main`; the rendering width of everything that scrolls. */
export function contentColumn(main: ColumnSpan): ColumnSpan {
	if (main.width < MIN_RAIL_MAIN_COLUMNS) return main;
	return { x: main.x, width: main.width - RAIL_COLUMNS };
}

export function computeLayout(columns: number, rows: number, bottomRows: number): WorkbenchLayout {
	const safeRows = Math.max(0, rows);
	const bottom = Math.min(Math.max(0, bottomRows), bottomRowCap(safeRows));
	const main = mainColumn(columns);
	const content = contentColumn(main);
	const railWidth = main.width - content.width;
	return {
		columns: Math.max(1, columns),
		rows: safeRows,
		main,
		content,
		rail: railWidth > 0 ? { x: content.x + content.width, width: railWidth } : undefined,
		bottomTop: safeRows - bottom,
	};
}

export function regionAt(layout: WorkbenchLayout, row: number, col: number): WorkbenchRegion {
	if (row < 0 || row >= layout.rows) return "outside";
	if (col < layout.main.x || col >= layout.main.x + layout.main.width) return "outside";
	if (row >= layout.bottomTop) return "bottom";
	// The gap column counts as rail: a two-column target is easier to hit.
	return layout.rail && col >= layout.rail.x ? "rail" : "content";
}
