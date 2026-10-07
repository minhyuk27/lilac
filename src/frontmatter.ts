import { App, TFile } from "obsidian";

/**
 * Writes fields back to an item's own markdown note's frontmatter. This is the only place
 * that mutates lilac item frontmatter — checkboxes, "오늘로 당기기", and the add/edit modal
 * all go through here. `metadataCache.on("changed")` (see main.ts) picks up the write right
 * after and refreshes the in-memory DB + any open calendar view; no extra sync needed.
 */
export async function updateItemFields(app: App, path: string, fields: Record<string, unknown>): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return;
	await app.fileManager.processFrontMatter(file, (fm) => {
		Object.assign(fm, fields);
	});
}
