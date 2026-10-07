import { Category, ScheduleItem } from "./types";
import { expandOccurrences } from "./recurrence";

/** A schedule occurrence clipped to a date range. Multi-day -> rendered as a band; single-day -> a chip/row. */
export interface Occurrence {
	item: ScheduleItem;
	category: Category | null;
	startISO: string;
	endISO: string;
	/** Per-instance override note (e.g. "강의실 301호 변경", SPEC §2.3 `recurrence.overrides`) — only ever set for recurrence-expanded occurrences. */
	note?: string;
}

/**
 * Expands schedule items (period/day/time + recurrence) into occurrences clipped to
 * [rangeStartISO, rangeEndISO]. `isVisible` lets callers apply their own filter — the
 * calendar grid hides `calendar_visible: false` items (e.g. 강의), but the daily note
 * must show everything for that day regardless (lilac SPEC §3.2 요구사항 #1), so this
 * is a parameter rather than a hardcoded rule.
 */
export function buildOccurrences(
	items: ScheduleItem[],
	categoryById: Map<string, Category>,
	rangeStartISO: string,
	rangeEndISO: string,
	isVisible: (item: ScheduleItem, category: Category | null) => boolean
): Occurrence[] {
	const occurrences: Occurrence[] = [];

	for (const item of items) {
		const category = item.category ? categoryById.get(item.category) ?? null : null;
		if (!isVisible(item, category)) continue;

		if (item.recurrence && item.start) {
			for (const iso of expandOccurrences(item.recurrence, item.start, rangeStartISO, rangeEndISO)) {
				const note = item.recurrence.overrides?.[iso]?.note;
				occurrences.push({ item, category, startISO: iso, endISO: iso, note });
			}
			continue;
		}

		if (item.schedule_kind === "period" && item.start) {
			const itemStart = item.start;
			const itemEnd = item.end ?? item.start;
			const startISO = itemStart > rangeStartISO ? itemStart : rangeStartISO;
			const endISO = itemEnd < rangeEndISO ? itemEnd : rangeEndISO;
			if (startISO <= endISO) occurrences.push({ item, category, startISO, endISO });
		} else if (item.start) {
			occurrences.push({ item, category, startISO: item.start, endISO: item.start });
		}
	}
	return occurrences;
}
