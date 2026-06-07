export type ItemType = "schedule" | "todo";
export type ScheduleKind = "period" | "day" | "time";

export interface RecurrenceOverride {
	note?: string;
}

export interface Recurrence {
	freq: string;
	days?: string[];
	until?: string | null;
	except?: string[];
	overrides?: Record<string, RecurrenceOverride>;
}

interface LilacItemBase {
	path: string;
	title: string;
	category: string | null;
	link: string | null;
}

export interface ScheduleItem extends LilacItemBase {
	type: "schedule";
	schedule_kind: ScheduleKind;
	start: string | null;
	end: string | null;
	time_start: string | null;
	time_end: string | null;
	calendar_visible: boolean | null; // null = follow category default
	recurrence: Recurrence | null;
}

export interface TodoItem extends LilacItemBase {
	type: "todo";
	due: string | null;
	do_date: string | null;
	done: boolean;
	done_date: string | null;
}

export type LilacItem = ScheduleItem | TodoItem;

export interface Category {
	id: string;
	name: string;
	color: string;
	calendar_visible: boolean;
}
