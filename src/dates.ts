/** Local-time date helpers. ISO strings here are always "YYYY-MM-DD" (no TZ). */

export function parseISO(iso: string): Date {
	const [y, m, d] = iso.split("-").map(Number);
	return new Date(y, m - 1, d);
}

export function toISO(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

export function addDays(date: Date, days: number): Date {
	const next = new Date(date);
	next.setDate(next.getDate() + days);
	return next;
}

/** Sunday of the week containing `date` (SPEC: 캘린더는 일요일 시작). */
export function startOfWeek(date: Date): Date {
	return addDays(date, -date.getDay());
}

export function isSameDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function todayISO(): string {
	return toISO(new Date());
}
