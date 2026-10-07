import { App, TFile, stringifyYaml } from "obsidian";
import { Category } from "./types";

export const CATEGORIES_PATH = "lilac/Categories.md";

/** Writes the full category list back to `Categories.md`'s frontmatter — used by the settings tab. */
export async function saveCategories(app: App, categories: Category[]): Promise<void> {
	const data = categories.map((c) => ({
		id: c.id,
		name: c.name,
		color: c.color,
		calendar_visible: c.calendar_visible,
	}));
	const existing = app.vault.getAbstractFileByPath(CATEGORIES_PATH);
	if (existing instanceof TFile) {
		await app.fileManager.processFrontMatter(existing, (fm) => {
			fm.categories = data;
		});
		return;
	}

	const folder = CATEGORIES_PATH.slice(0, CATEGORIES_PATH.lastIndexOf("/"));
	if (folder && !app.vault.getAbstractFileByPath(folder)) {
		await app.vault.createFolder(folder).catch(() => undefined);
	}
	// 파일이 아직 없을 땐 빈 frontmatter로 먼저 만들고 곧바로 processFrontMatter로 채우지
	// 않는다 — 방금 만든 파일은 metadataCache가 그 frontmatter 경계를 아직 못 읽은
	// 상태라, processFrontMatter가 "frontmatter 없음"으로 오판해 기존 `---\n---\n`은
	// 그대로 둔 채 새 내용을 frontmatter가 아닌 본문으로 덧붙여버릴 수 있다(holidays.ts의
	// saveCustomHolidays에서 실제로 겪은 버그, 2026-08-21 — 같은 패턴이라 여기도 미리
	// 고쳐둠). 완성된 frontmatter를 `vault.create()` 한 번으로 써서 이 경쟁을 없앤다.
	await app.vault.create(CATEGORIES_PATH, `---\n${stringifyYaml({ categories: data })}---\n`);
}

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
