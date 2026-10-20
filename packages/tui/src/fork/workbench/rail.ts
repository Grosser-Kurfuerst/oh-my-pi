/**
 * The turn rail: a one-column minimap beside the content area. Every user
 * prompt is a tick at its proportional height; the viewport shows as a thick
 * track.
 */
import { theme } from "../../theme";
import type { TurnEntry } from "./turn-index";

const TRACK = "│";
const VIEWPORT = "┃";
const TICK = "━";

/** Rail row (0-based) a content row maps to on a rail `height` rows tall. */
export function railRow(row: number, height: number, total: number): number {
	if (height <= 0 || total <= 0) return 0;
	return Math.min(height - 1, Math.max(0, Math.floor((row * height) / total)));
}

/**
 * One styled cell per rail row. Ticks sharing a row merge; the tick of
 * `current` is accented.
 */
export function renderRail(
	turns: readonly TurnEntry[],
	height: number,
	total: number,
	visible: { readonly start: number; readonly end: number },
	current: number,
): string[] {
	const cells: string[] = [];
	if (height <= 0) return cells;
	const viewTop = railRow(visible.start, height, total);
	const viewBottom = Math.max(viewTop, railRow(Math.max(visible.start, visible.end - 1), height, total));
	for (let y = 0; y < height; y++) {
		cells.push(y >= viewTop && y <= viewBottom ? theme.fg("muted", VIEWPORT) : theme.fg("dim", TRACK));
	}
	turns.forEach((turn, index) => {
		if (index !== current) cells[railRow(turn.row, height, total)] = theme.fg("muted", TICK);
	});
	// Drawn last so the accent wins a row it shares with other ticks.
	const active = turns[current];
	if (active) cells[railRow(active.row, height, total)] = theme.fg("accent", TICK);
	return cells;
}

/** Turn whose tick is closest to rail row `y`; the earlier turn wins a tie. */
export function nearestTurn(turns: readonly TurnEntry[], height: number, total: number, y: number): number | undefined {
	let best: number | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	turns.forEach((turn, index) => {
		const distance = Math.abs(railRow(turn.row, height, total) - y);
		if (distance < bestDistance) {
			best = index;
			bestDistance = distance;
		}
	});
	return best;
}
