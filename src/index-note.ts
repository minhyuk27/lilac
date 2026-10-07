import { App, TFile } from "obsidian";

/**
 * SPEC §4 #9 — "index 노트는 사용자가 항목에 폴더를 링크하기로 선택한 그 시점에만"
 * 생성/갱신. 볼트 전체를 훑어 자동 생성하지 않음(일정과 무관한 폴더가 훨씬 많음) —
 * 이 함수는 오직 item-modal의 "폴더에 연결" 토글이 켜진 채 저장될 때만 호출된다.
 */
export async function generateFolderIndex(app: App, folderPath: string): Promise<void> {
	const normalized = folderPath.replace(/\/+$/, "");
	if (!app.vault.getAbstractFileByPath(normalized)) {
		await app.vault.createFolder(normalized).catch(() => undefined);
	}

	const indexPath = `${normalized}/index.md`;
	const files = app.vault
		.getFiles()
		.filter((f) => f.path.startsWith(normalized + "/") && f.path !== indexPath && f.extension === "md")
		.sort((a, b) => a.basename.localeCompare(b.basename));

	const folderName = normalized.split("/").pop() ?? normalized;
	const lines = files.map((f) => `- [[${f.path.slice(0, -3)}|${f.basename}]]`);
	const content = `# ${folderName}\n\n${lines.length > 0 ? lines.join("\n") : "(아직 문서가 없습니다)"}\n`;

	const existing = app.vault.getAbstractFileByPath(indexPath);
	if (existing instanceof TFile) await app.vault.modify(existing, content);
	else await app.vault.create(indexPath, content);
}
