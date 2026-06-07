import { App, TFile } from "obsidian";
import { LilacItem, ScheduleItem, TodoItem, ScheduleKind, Recurrence } from "./types";

function asString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

function asBool(v: unknown): boolean | null {
	return typeof v === "boolean" ? v : null;
}

function parseRecurrence(raw: unknown): Recurrence | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.freq !== "string") return null;
	return {
		freq: r.freq,
		days: Array.isArray(r.days) ? (r.days as string[]) : undefined,
		until: asString(r.until) ?? undefined,
		except: Array.isArray(r.except) ? (r.except as string[]) : undefined,
		overrides:
			r.overrides && typeof r.overrides === "object"
				? (r.overrides as Record<string, { note?: string }>)
				: undefined,
	};
}

/**
 * Reads frontmatter via metadataCache (not raw file content) so this stays in
 * sync with whatever Obsidian has already parsed — avoids re-parsing YAML and
 * double-handling edge cases the cache already resolved.
 */
export function parseLilacItem(app: App, file: TFile): LilacItem | null {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	if (!fm || fm.lilac !== true) return null;

	const base = {
		path: file.path,
		title: asString(fm.title) ?? file.basename,
		category: asString(fm.category),
		link: asString(fm.link),
	};

	if (fm.type === "schedule") {
		const item: ScheduleItem = {
			...base,
			type: "schedule",
			schedule_kind: (asString(fm.schedule_kind) as ScheduleKind) ?? "day",
			start: asString(fm.start),
			end: asString(fm.end),
			time_start: asString(fm.time_start),
			time_end: asString(fm.time_end),
			calendar_visible: asBool(fm.calendar_visible),
			recurrence: parseRecurrence(fm.recurrence),
		};
		return item;
	}

	if (fm.type === "todo") {
		const item: TodoItem = {
			...base,
			type: "todo",
			due: asString(fm.due),
			do_date: asString(fm.do_date),
			done: fm.done === true,
			done_date: asString(fm.done_date),
		};
		return item;
	}

	return null;
}

export function scanVault(app: App): LilacItem[] {
	const items: LilacItem[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const item = parseLilacItem(app, file);
		if (item) items.push(item);
	}
	return items;
}
