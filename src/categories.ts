import { App, TFile } from "obsidian";
import { Category } from "./types";

export const CATEGORIES_PATH = "lilac/Categories.md";

export function loadCategories(app: App): Category[] {
	const file = app.vault.getAbstractFileByPath(CATEGORIES_PATH);
	if (!(file instanceof TFile)) return [];

	const raw = app.metadataCache.getFileCache(file)?.frontmatter?.categories;
	if (!Array.isArray(raw)) return [];

	const categories: Category[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.id !== "string" || typeof e.name !== "string") continue;
		categories.push({
			id: e.id,
			name: e.name,
			color: typeof e.color === "string" ? e.color : "#888888",
			calendar_visible: e.calendar_visible !== false,
		});
	}
	return categories;
}
