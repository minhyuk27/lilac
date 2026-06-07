import { Recurrence } from "./types";
import { parseISO, toISO } from "./dates";

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * Expands a recurrence into concrete occurrence dates within [rangeStartISO,
 * rangeEndISO], honoring `until`/`except`/`overrides`. Per lilac SPEC §2.3 this
 * happens only at query time for the visible window — never persisted.
 *
 * Only `freq: weekly` with `days` is implemented; SPEC's worked example
 * (lecture schedules) only uses this shape. Other freqs return [] so unknown
 * recurrence values degrade to "no extra occurrences" rather than throwing.
 */
export function expandOccurrences(
	recurrence: Recurrence,
	anchorISO: string,
	rangeStartISO: string,
	rangeEndISO: string
): string[] {
	if (recurrence.freq !== "weekly" || !recurrence.days?.length) return [];

	const targetDays = new Set(
		recurrence.days
			.map((code) => DAY_CODES.indexOf(code.toUpperCase()))
			.filter((i) => i >= 0)
	);
	if (targetDays.size === 0) return [];

	// `except` = skipped instances (휴강 등, don't render). `overrides` modifies
	// an instance in place (e.g. room change) — it still occurs, so it's NOT excluded here.
	const exceptSet = new Set(recurrence.except ?? []);

	const lowerBound = anchorISO > rangeStartISO ? anchorISO : rangeStartISO;
	const upperBound = recurrence.until && recurrence.until < rangeEndISO ? recurrence.until : rangeEndISO;
	if (lowerBound > upperBound) return [];

	const occurrences: string[] = [];
	const cursor = parseISO(lowerBound);
	const end = parseISO(upperBound);
	while (cursor <= end) {
		const iso = toISO(cursor);
		if (targetDays.has(cursor.getDay()) && !exceptSet.has(iso)) {
			occurrences.push(iso);
		}
		cursor.setDate(cursor.getDate() + 1);
	}
	return occurrences;
}
