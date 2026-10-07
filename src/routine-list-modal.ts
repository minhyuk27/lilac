import { App, Modal } from "obsidian";
import type LilacPlugin from "../main";
import { ScheduleItem } from "./types";
import { chipTextColor } from "./color";
import { WEEKDAY_OPTIONS, LilacItemModal } from "./item-modal";

/** "월, 수 · 2027. 8. 16. 까지" / "매일" / "종료일 없음" 없이 요일만("화" 등). */
function recurrenceSummary(item: ScheduleItem): string {
	const rec = item.recurrence;
	if (!rec) return "";
	const days = rec.days ?? [];
	const dayLabels = WEEKDAY_OPTIONS.filter((o) => days.includes(o.code)).map((o) => o.label);
	const daysText = dayLabels.length === 7 ? "매일" : dayLabels.length > 0 ? dayLabels.join(", ") : "요일 없음";
	if (!rec.until) return daysText;
	const [y, m, d] = rec.until.split("-").map(Number);
	return `${daysText} · ${y}. ${m}. ${d}. 까지`;
}

/**
 * "루틴들만 따로 확인할 수 있는 방법"(사용자 요청, 2026-08-16) — 매주 반복이 켜진
 * schedule 항목만 모아 한 화면에서 훑어보는 목록. 캘린더뷰/데일리노트는 특정 날짜
 * 범위만 보여주므로 "지금 반복 중인 게 전부 몇 개고 뭔지"를 한눈에 보려면 별도
 * 화면이 필요했음. 행을 탭하면 바로 그 항목의 `LilacItemModal`(기존 추가/수정
 * 모달)을 열어 편집 — 새 편집 UI를 또 만들지 않고 검증된 걸 재사용.
 */
export class LilacRoutineListModal extends Modal {
	constructor(app: App, private plugin: LilacPlugin) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("루틴 목록");
		this.contentEl.addClass("lilac-routine-list-modal");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		const db = this.plugin.getDatabase();
		const items = db?.getRecurringScheduleItems() ?? [];
		if (items.length === 0) {
			contentEl.createDiv({ cls: "lilac-day-detail-empty", text: "설정된 반복 일정(루틴)이 없습니다." });
			return;
		}

		const categoryById = new Map((db?.getCategories() ?? []).map((c) => [c.id, c]));
		// daily-render.ts의 섹션 목록과 같은 클래스 — 같은 시각 언어(행 사이 간격)를
		// 새 CSS 없이 그대로 재사용.
		const list = contentEl.createDiv({ cls: "lilac-daily-section-list" });
		for (const item of items) this.renderRow(list, item, categoryById);
	}

	private renderRow(parent: HTMLElement, item: ScheduleItem, categoryById: Map<string, { color: string }>): void {
		const row = parent.createDiv({ cls: "lilac-detail-row" });
		const category = item.category ? categoryById.get(item.category) ?? null : null;
		const dot = row.createDiv({ cls: "lilac-detail-dot" });
		if (category) {
			dot.style.setProperty("--lilac-chip-color", category.color);
			dot.style.setProperty("--lilac-chip-text", chipTextColor(category.color));
		}

		const text = row.createDiv({ cls: "lilac-detail-text" });
		text.createSpan({ cls: "lilac-detail-time", text: recurrenceSummary(item) });
		const titleRow = text.createDiv({ cls: "lilac-detail-title-row" });
		titleRow.createSpan({ cls: "lilac-detail-title", text: item.title });
		if (item.memo) titleRow.createSpan({ cls: "lilac-detail-memo", text: item.memo });

		// 이 화면의 주 목적은 "루틴을 관리(편집)"하는 것이라 — 링크된 노트로 가는
		// daily-render.ts류 행과 달리, 탭하면 곧장 이 항목의 편집 모달을 연다.
		row.onclick = () => new LilacItemModal(this.app, this.plugin, { existing: item, onSaved: () => this.render() }).open();
	}
}
