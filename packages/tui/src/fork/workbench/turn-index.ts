/**
 * Turn index for the workbench: which transcript blocks start a user turn,
 * their labels, and the jump arithmetic shared by keys and the rail.
 */
import { CollabPromptMessageComponent } from "../../chat/collab-prompt-message";
import { SkillMessageComponent } from "../../chat/skill-message";
import { UserMessageComponent } from "../../chat/user-message";
import type { Component } from "../../tui";
import { replaceTabs, stripTerminalSequences } from "../../utils";

export interface TurnEntry {
	/** Content row the prompt block starts on. */
	readonly row: number;
	/** First non-blank line of the rendered prompt, plain text. */
	readonly label: string;
}

/** A jump parks the prompt this many rows below the viewport top, leaving its separator in view. */
export const JUMP_MARGIN = 1;

/** Native card role of a synthetic user message (auto-continue and similar); the class is shared. */
const SYNTHETIC_USER_ROLE = "omp.user.synthetic";

/**
 * Whether a transcript block starts a user turn, matching what rewind and
 * copy count: a real prompt bubble, a `/skill:` prompt, or a collab prompt.
 * Skill and collab cards do not expose their attribution, so agent-invoked
 * ones count too. Call once per block: a user bubble is classified through its
 * native description.
 */
export function isUserTurnBlock(block: Component): boolean {
	if (block instanceof UserMessageComponent) {
		const role = (block.describe().p as { readonly role?: string } | undefined)?.role;
		return role !== SYNTHETIC_USER_ROLE;
	}
	return block instanceof SkillMessageComponent || block instanceof CollabPromptMessageComponent;
}

/**
 * Plain-text label of a turn block rendered `width` wide. A user bubble names
 * its first prompt line, past the padding row that can carry reaction and
 * steering badges; other cards use their first visible row.
 */
export function promptLabel(block: Component, rows: readonly string[], width: number): string {
	const first = block instanceof UserMessageComponent ? block.renderTranscriptBlockEmergencyRow(width) : undefined;
	return turnLabel(first === undefined ? rows : [first]);
}

/** Plain-text label from rendered rows: the first one with visible text. */
export function turnLabel(rows: readonly string[]): string {
	for (const row of rows) {
		const text = replaceTabs(stripTerminalSequences(row)).trim();
		if (text) return text;
	}
	return "";
}

/** Scroll offset that shows `turn` just below the viewport top. */
export function jumpOffset(turn: TurnEntry): number {
	return Math.max(0, turn.row - JUMP_MARGIN);
}

/** Index of the turn being read at `scrollTop`, or -1 above the first prompt. */
export function currentTurn(turns: readonly TurnEntry[], scrollTop: number): number {
	let current = -1;
	for (let index = 0; index < turns.length && jumpOffset(turns[index]!) <= scrollTop; index++) current = index;
	return current;
}

/**
 * Turn a relative jump lands on, or undefined when there is none in that
 * direction. Backwards goes to the last prompt parked above `scrollTop`, so
 * from the middle of a long answer it first returns to that turn's own
 * prompt; forwards goes to the first prompt parked below it.
 */
export function turnTarget(turns: readonly TurnEntry[], scrollTop: number, delta: -1 | 1): number | undefined {
	if (delta < 0) {
		for (let index = turns.length - 1; index >= 0; index--) {
			if (jumpOffset(turns[index]!) < scrollTop) return index;
		}
		return undefined;
	}
	const index = turns.findIndex(turn => jumpOffset(turn) > scrollTop);
	return index === -1 ? undefined : index;
}
