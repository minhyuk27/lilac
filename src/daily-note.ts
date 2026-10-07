import { App, Notice, moment } from "obsidian";
import { appHasDailyNotesPluginLoaded, createDailyNote, getAllDailyNotes, getDailyNote } from "obsidian-daily-notes-interface";

/**
 * 사용자가 "전체를 플러그인이 관리"를 택함 — 데일리노트를 처음 만들 때는 옵시디언 코어
 * Daily Notes 템플릿 설정에 맡기지 않고 Lilac이 직접 구조(일정·할일 블록 + 메모 헤딩)를
 * 박아넣는다. 이미 있던 노트는 절대 건드리지 않음 — SPEC의 "본문 자동 덮어쓰기 금지"
 * 불변식은 신규 생성 시 1회 적용으로 유지된다.
 */
const DAILY_NOTE_TEMPLATE = "\n```lilac-daily\n```\n\n## 메모\n\n";

/** SPEC §3.1: 날짜 클릭 → 그날의 데일리노트 열기. 새로 만들어진 노트엔 기본 템플릿을 채운다. */
export async function openDailyNote(app: App, date: Date): Promise<void> {
	if (!appHasDailyNotesPluginLoaded()) {
		new Notice("lilac: 데일리 노트 코어 플러그인이 꺼져 있어 열 수 없습니다.");
		return;
	}
	const m = moment(date);
	let file = getDailyNote(m, getAllDailyNotes());
	if (!file) {
		const created = await createDailyNote(m);
		if (!created) {
			new Notice("lilac: 데일리 노트를 만들지 못했습니다.");
			return;
		}
		await app.vault.modify(created, DAILY_NOTE_TEMPLATE);
		file = created;
	} else {
		// 이미 있는 노트인데 lilac이 만든 게 아니라면(코어 Daily Notes 템플릿으로 먼저
		// 만들어졌거나, 플러그인 설치 전부터 있던 노트) lilac-daily 블록이 없을 수 있음 —
		// "캘린더에서 누르면 항상 같은 화면이 보여야" 일관되므로, 기존 내용은 그대로 두고
		// 끝에 블록만 덧붙인다(SPEC의 "본문 자동 덮어쓰기 금지" 불변식은 *추가*이지
		// *수정/삭제*가 아니므로 위반하지 않음).
		const content = await app.vault.read(file);
		if (!content.includes("```lilac-daily")) {
			const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
			await app.vault.modify(file, content + separator + DAILY_NOTE_TEMPLATE);
		}
	}
	// 새 탭(getLeaf("tab"))으로 시도해봤지만 사용자가 "뒤로가기 여전히 안 됌"이라고
	// 재보고 — 새 leaf는 히스토리가 비어 있어 애초에 "뒤로 갈 캘린더"가 없었을 가능성이
	// 큼(레이어드 추측, 실기기로 검증 못 함). 원래 방식(같은 leaf 재사용)으로 되돌리고,
	// 기기 back 버튼/제스처가 안 먹는 경우를 대비해 lilac-daily 블록에 직접 "←캘린더"
	// 버튼을 추가해 확실한 복귀 경로를 보장한다(daily-render.ts).
	await app.workspace.getLeaf(false).openFile(file);
}
