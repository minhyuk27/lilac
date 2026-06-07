import { App, Notice, moment } from "obsidian";
import { appHasDailyNotesPluginLoaded, createDailyNote, getAllDailyNotes, getDailyNote } from "obsidian-daily-notes-interface";

/** SPEC §3.1: 날짜 클릭 → 그날의 데일리노트 열기 (lilac-daily 블록 포함은 사용자 템플릿 책임). */
export async function openDailyNote(app: App, date: Date): Promise<void> {
	if (!appHasDailyNotesPluginLoaded()) {
		new Notice("lilac: 데일리 노트 코어 플러그인이 꺼져 있어 열 수 없습니다.");
		return;
	}
	const m = moment(date);
	const file = getDailyNote(m, getAllDailyNotes()) ?? (await createDailyNote(m));
	await app.workspace.getLeaf(false).openFile(file);
}
