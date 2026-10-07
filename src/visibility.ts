import { Category, ScheduleItem, TodoItem } from "./types";

/**
 * 캘린더 화면(큰 캘린더뷰·사이드바 미니 달력)에서 무엇을 보여줄지 정하는 공용 규칙.
 * 원래 calendar-view.ts 안의 private 메서드였는데, 사이드바(50라운드, 2026-10-07)도
 * 같은 규칙을 써야 해서 꺼냈다 — 동작은 그대로다.
 */

/** 항목 자체 설정(calendar_visible)이 있으면 그걸, 없으면 카테고리 설정을 따른다. */
export function isScheduleVisible(item: ScheduleItem, category: Category | null): boolean {
	if (item.calendar_visible !== null) return item.calendar_visible;
	return isCategoryVisible(category);
}

/** 카테고리가 없으면(미분류) 보인다. */
export function isCategoryVisible(category: Category | null): boolean {
	return category ? category.calendar_visible : true;
}

/** How many of a day's todos are still pending vs. already finished — drives the day badge. */
export interface TodoDaySummary {
	pending: number;
	done: number;
	/** Distinct category colors among that day's todos (any state), insertion order, capped
	 * at `maxColors` — drives the Todomate-style "clover" badge (배지를 카테고리별 색으로 분할). */
	colors: string[];
}

/** 날짜별 할일 요약 — 날짜는 do_date 우선, 없으면 due(데일리노트의 effectiveDate와 같은 규칙). */
export function summarizeTodosByDate(
	todos: TodoItem[],
	categoryById: Map<string, Category>,
	maxColors: number
): Map<string, TodoDaySummary> {
	const map = new Map<string, TodoDaySummary>();
	for (const todo of todos) {
		const dateISO = todo.do_date ?? todo.due;
		if (!dateISO) continue;
		const summary = map.get(dateISO) ?? { pending: 0, done: 0, colors: [] };
		if (todo.done) summary.done++;
		else summary.pending++;
		const color = todo.category ? categoryById.get(todo.category)?.color : undefined;
		if (color && !summary.colors.includes(color) && summary.colors.length < maxColors) {
			summary.colors.push(color);
		}
		map.set(dateISO, summary);
	}
	return map;
}
