import { App, TFile } from "obsidian";

/**
 * "스티키노트" — todo/schedule과 완전히 무관한 자유 짧은 메모(스크래치패드), 윈도우
 * 스티키노트처럼 버튼 하나로 항상 열어볼 수 있는 카드 모음. lilac 항목(scanner.ts가
 * 인식하는 `lilac: true`)과는 별개 플래그(`lilac_sticky: true`)를 쓰므로 vault 스캐너/
 * sql.js 인덱스에는 전혀 잡히지 않는다 — 일정·할일 데이터 모델과 무관한 순수 메모.
 */
export const STICKY_FOLDER = "lilac/stickies";

/** 실제 옵시디언 스티키노트 위젯과 같은 느낌을 주기 위한 고정 파스텔 팔레트. */
export const STICKY_COLORS = ["#FFF3B0", "#FFD3E0", "#C9E4FF", "#D6F5D6", "#E5D9FF"];

function pickColor(): string {
	return STICKY_COLORS[Math.floor(Math.random() * STICKY_COLORS.length)];
}

async function ensureFolder(app: App): Promise<void> {
	if (app.vault.getAbstractFileByPath(STICKY_FOLDER)) return;
	await app.vault.createFolder(STICKY_FOLDER).catch(() => undefined);
}

export interface StickyNote {
	file: TFile;
	color: string;
	body: string;
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
	const match = /^---\n[\s\S]*?\n---\n?/.exec(content);
	if (!match) return { frontmatter: "", body: content };
	return { frontmatter: match[0], body: content.slice(match[0].length) };
}

export async function listStickyNotes(app: App): Promise<StickyNote[]> {
	const folder = app.vault.getAbstractFileByPath(STICKY_FOLDER);
	if (!folder) return [];

	const files = app.vault
		.getFiles()
		.filter((f) => f.path.startsWith(STICKY_FOLDER + "/") && f.extension === "md")
		.filter((f) => app.metadataCache.getFileCache(f)?.frontmatter?.lilac_sticky === true);

	const notes: StickyNote[] = [];
	for (const file of files) {
		const cache = app.metadataCache.getFileCache(file);
		const color = (cache?.frontmatter?.color as string) ?? STICKY_COLORS[0];
		const content = await app.vault.read(file);
		notes.push({ file, color, body: splitFrontmatter(content).body.trim() });
	}
	notes.sort((a, b) => a.file.stat.ctime - b.file.stat.ctime);
	return notes;
}

export async function createStickyNote(app: App): Promise<StickyNote> {
	await ensureFolder(app);
	const color = pickColor();
	const path = `${STICKY_FOLDER}/sticky-${Date.now()}.md`;
	const content = `---\nlilac_sticky: true\ncolor: "${color}"\n---\n`;
	const file = await app.vault.create(path, content);
	return { file, color, body: "" };
}

export async function writeStickyBody(app: App, file: TFile, body: string): Promise<void> {
	await app.vault.process(file, (content) => {
		const { frontmatter } = splitFrontmatter(content);
		return frontmatter + body;
	});
}

export async function deleteStickyNote(app: App, file: TFile): Promise<void> {
	await app.fileManager.trashFile(file);
}

/** 사용자가 직접 색을 골라 바꿀 수 있게(2026-06-21 요청) — 생성 시 무작위로 고른 색을 나중에 바꿈. */
export async function setStickyColor(app: App, file: TFile, color: string): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm) => {
		fm.color = color;
	});
}
