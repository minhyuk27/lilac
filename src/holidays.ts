import { App, TFile, stringifyYaml } from "obsidian";
import { addDays, toISO } from "./dates";

export interface Holiday {
	date: string; // YYYY-MM-DD
	name: string;
}

/** 사용자가 직접 추가한 휴일(설날/추석 등 음력 공휴일과 그 대체공휴일)만 여기 저장된다 —
 * 매년 같은 양력 날짜인 고정 공휴일은 저장 없이 매번 계산되므로(`computeFixedHolidays`)
 * 이 파일엔 안 들어간다(자세한 이유는 `loadHolidays` 참고). */
export const HOLIDAYS_PATH = "lilac/Holidays.md";

const SATURDAY = 6;
const SUNDAY = 0;

function isWeekend(date: Date): boolean {
	const day = date.getDay();
	return day === SATURDAY || day === SUNDAY;
}

/** 대체공휴일 미적용 대상(2023년 확대 개정 이후로도 그대로) — 신정, 현충일. */
const FIXED_NO_SUBSTITUTE: { month: number; day: number; name: string }[] = [
	{ month: 1, day: 1, name: "신정" },
	{ month: 6, day: 6, name: "현충일" },
];

/** 대체공휴일 적용 대상 — 3대 국경일(삼일절/광복절/개천절) + 한글날 + 어린이날 + 성탄절
 * (2023년 확대 개정으로 성탄절도 포함). 날짜 자체는 매년 같은 양력 날짜라 계산이
 * 필요 없고, 토·일요일과 겹치는지만 매년 확인하면 된다. */
const FIXED_WITH_SUBSTITUTE: { month: number; day: number; name: string }[] = [
	{ month: 3, day: 1, name: "삼일절" },
	{ month: 5, day: 5, name: "어린이날" },
	{ month: 8, day: 15, name: "광복절" },
	{ month: 10, day: 3, name: "개천절" },
	{ month: 10, day: 9, name: "한글날" },
	{ month: 12, day: 25, name: "성탄절" },
];

/**
 * 한 해의 "고정 양력 날짜" 공휴일과 그 대체공휴일을 계산한다. 설날/추석/부처님오신날처럼
 * 음력 기준으로 매년 날짜가 바뀌는 공휴일은 계산에 정확한 음력 변환표가 필요해 여기서는
 * 다루지 않는다 — 설정 탭에서 사용자가 직접 추가해야 한다(그 공휴일들의 대체공휴일도
 * 마찬가지). 대체공휴일이 다른 고정 공휴일과 또 겹치는 극히 드문 경우까지는 다루지
 * 않음 — 그 정도로 미세한 보정은 사용자가 설정 탭에서 직접 추가/수정하면 된다.
 */
function computeFixedHolidays(year: number): Holiday[] {
	const result: Holiday[] = [];
	for (const h of FIXED_NO_SUBSTITUTE) {
		result.push({ date: toISO(new Date(year, h.month - 1, h.day)), name: h.name });
	}
	for (const h of FIXED_WITH_SUBSTITUTE) {
		const base = new Date(year, h.month - 1, h.day);
		result.push({ date: toISO(base), name: h.name });
		if (isWeekend(base)) {
			let sub = addDays(base, 1);
			while (isWeekend(sub)) sub = addDays(sub, 1);
			result.push({ date: toISO(sub), name: `${h.name} 대체공휴일` });
		}
	}
	return result;
}

// 캘린더가 보여줄 수 있는 아무 달이나 커버할 만큼 넉넉한 연도 범위 — 계산 자체가
// 가벼운 날짜 산술뿐이라 매번 다시 계산해도 비용이 무시할 만하다(캐싱 불필요).
const YEARS_BEFORE = 2;
const YEARS_AFTER = 8;

/** `Holidays.md` frontmatter에서 사용자가 직접 추가한 휴일만 읽는다(설정 탭 편집용). */
export function loadCustomHolidays(app: App): Holiday[] {
	const file = app.vault.getAbstractFileByPath(HOLIDAYS_PATH);
	if (!(file instanceof TFile)) return [];

	const raw = app.metadataCache.getFileCache(file)?.frontmatter?.holidays;
	if (!Array.isArray(raw)) return [];

	const holidays: Holiday[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.date !== "string" || typeof e.name !== "string") continue;
		holidays.push({ date: e.date, name: e.name });
	}
	return holidays;
}

/** 설정 탭에서 편집한 휴일 목록을 `Holidays.md` frontmatter로 저장 — 자동 계산되는 고정
 * 공휴일은 여기 포함하지 않는다(매번 다시 계산되므로 저장해두면 오히려 해가 바뀌어도
 * 옛 대체공휴일 날짜가 그대로 남는 등 정확성이 떨어짐). */
export async function saveCustomHolidays(app: App, holidays: Holiday[]): Promise<void> {
	const data = holidays.map((h) => ({ date: h.date, name: h.name }));
	const existing = app.vault.getAbstractFileByPath(HOLIDAYS_PATH);
	if (existing instanceof TFile) {
		await app.fileManager.processFrontMatter(existing, (fm) => {
			fm.holidays = data;
		});
		return;
	}

	const folder = HOLIDAYS_PATH.slice(0, HOLIDAYS_PATH.lastIndexOf("/"));
	if (folder && !app.vault.getAbstractFileByPath(folder)) {
		await app.vault.createFolder(folder).catch(() => undefined);
	}
	// 파일이 아직 없을 땐 빈 frontmatter로 먼저 만든 뒤 곧바로 processFrontMatter로
	// 채우지 않는다 — 방금 만든 파일은 metadataCache가 아직 그 frontmatter 경계를
	// 파악하기 전이라, processFrontMatter가 "frontmatter 없음"으로 오판해 기존
	// `---\n---\n`은 그대로 둔 채 새 내용을 frontmatter가 아닌 본문으로 덧붙여버리는
	// 문제가 있었다(사용자 보고, 2026-08-21: "수동으로 추가한 휴일 반영이 안되는데" —
	// 실제로 Holidays.md를 열어보니 frontmatter 블록이 이중으로 깨져 있었고, 진짜
	// frontmatter엔 `holidays`가 없어 `loadCustomHolidays`가 항상 빈 배열을 읽고
	// 있었음). 대신 완성된 frontmatter를 `vault.create()` 한 번으로 통째로 써서
	// 이 경쟁 자체를 없앤다.
	await app.vault.create(HOLIDAYS_PATH, `---\n${stringifyYaml({ holidays: data })}---\n`);
}

/**
 * 캘린더가 실제로 쓰는 병합된 휴일 목록 — 자동 계산된 고정 공휴일(및 그 대체공휴일)에
 * 사용자가 `Holidays.md`에 직접 추가한 휴일(설날/추석/부처님오신날 등 음력 공휴일과
 * 그 대체공휴일)을 겹쳐 얹는다. 같은 날짜가 겹치면 사용자 항목이 이긴다(이름을 바꾸고
 * 싶을 때도 그냥 같은 날짜로 하나 추가하면 됨).
 */
export function loadHolidays(app: App): Holiday[] {
	const map = new Map<string, string>();
	const thisYear = new Date().getFullYear();
	for (let y = thisYear - YEARS_BEFORE; y <= thisYear + YEARS_AFTER; y++) {
		for (const h of computeFixedHolidays(y)) map.set(h.date, h.name);
	}
	for (const h of loadCustomHolidays(app)) map.set(h.date, h.name);
	return [...map.entries()].map(([date, name]) => ({ date, name })).sort((a, b) => a.date.localeCompare(b.date));
}
