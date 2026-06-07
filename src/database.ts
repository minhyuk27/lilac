import initSqlJs, { Database, SqlValue } from "sql.js";
import { LilacItem, ScheduleItem, TodoItem, Category, Recurrence, ScheduleKind } from "./types";

function str(v: SqlValue): string | null {
	return typeof v === "string" ? v : null;
}

function rowToScheduleItem(row: SqlValue[]): ScheduleItem {
	// column order matches SCHEMA: path,type,title,category,schedule_kind,start,end,
	// time_start,time_end,due,do_date,done,done_date,calendar_visible,link,recurrence
	const recurrenceRaw = str(row[15]);
	return {
		path: row[0] as string,
		type: "schedule",
		title: row[2] as string,
		category: str(row[3]),
		schedule_kind: (str(row[4]) as ScheduleKind) ?? "day",
		start: str(row[5]),
		end: str(row[6]),
		time_start: str(row[7]),
		time_end: str(row[8]),
		calendar_visible: row[13] === null ? null : row[13] === 1,
		link: str(row[14]),
		recurrence: recurrenceRaw ? (JSON.parse(recurrenceRaw) as Recurrence) : null,
	};
}

function rowToTodoItem(row: SqlValue[]): TodoItem {
	// column order: path, type, title, category, due, do_date, done, done_date, link
	return {
		path: row[0] as string,
		type: "todo",
		title: row[2] as string,
		category: str(row[3]),
		due: str(row[4]),
		do_date: str(row[5]),
		done: row[6] === 1,
		done_date: str(row[7]),
		link: str(row[8]),
	};
}

const SCHEMA = `
CREATE TABLE items (
  path TEXT PRIMARY KEY,
  type TEXT,
  title TEXT,
  category TEXT,
  schedule_kind TEXT,
  start TEXT, end TEXT, time_start TEXT, time_end TEXT,
  due TEXT, do_date TEXT,
  done INTEGER, done_date TEXT,
  calendar_visible INTEGER,
  link TEXT,
  recurrence TEXT
);
CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT, color TEXT, calendar_visible INTEGER);
`;

function boolToInt(v: boolean | null): number | null {
	return v === null ? null : v ? 1 : 0;
}

/**
 * In-memory query cache only — never persisted to disk (see lilac DECISIONS,
 * 2026-06-07). Rebuilt from the vault's markdown frontmatter on load and kept
 * in sync incrementally as files change.
 */
export class LilacDatabase {
	private constructor(private db: Database) {
		this.db.run(SCHEMA);
	}

	static async create(wasmBinary: ArrayBuffer): Promise<LilacDatabase> {
		const SQL = await initSqlJs({ wasmBinary });
		return new LilacDatabase(new SQL.Database());
	}

	upsertItem(item: LilacItem): void {
		this.db.run("DELETE FROM items WHERE path = ?", [item.path]);

		if (item.type === "schedule") {
			this.db.run(
				`INSERT INTO items
					(path, type, title, category, schedule_kind, start, "end", time_start, time_end, calendar_visible, link, recurrence)
				 VALUES (?, 'schedule', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					item.path,
					item.title,
					item.category,
					item.schedule_kind,
					item.start,
					item.end,
					item.time_start,
					item.time_end,
					boolToInt(item.calendar_visible),
					item.link,
					item.recurrence ? JSON.stringify(item.recurrence) : null,
				]
			);
		} else {
			this.db.run(
				`INSERT INTO items (path, type, title, category, due, do_date, done, done_date, link)
				 VALUES (?, 'todo', ?, ?, ?, ?, ?, ?, ?)`,
				[
					item.path,
					item.title,
					item.category,
					item.due,
					item.do_date,
					item.done ? 1 : 0,
					item.done_date,
					item.link,
				]
			);
		}
	}

	deleteItem(path: string): void {
		this.db.run("DELETE FROM items WHERE path = ?", [path]);
	}

	rebuildItems(items: LilacItem[]): void {
		this.db.run("DELETE FROM items");
		for (const item of items) this.upsertItem(item);
	}

	setCategories(categories: Category[]): void {
		this.db.run("DELETE FROM categories");
		for (const cat of categories) {
			this.db.run(
				"INSERT INTO categories (id, name, color, calendar_visible) VALUES (?, ?, ?, ?)",
				[cat.id, cat.name, cat.color, cat.calendar_visible ? 1 : 0]
			);
		}
	}

	private countRows(table: "items" | "categories"): number {
		const result = this.db.exec(`SELECT COUNT(*) FROM ${table}`);
		return Number(result[0]?.values?.[0]?.[0] ?? 0);
	}

	countItems(): number {
		return this.countRows("items");
	}

	countCategories(): number {
		return this.countRows("categories");
	}

	getCategories(): Category[] {
		const result = this.db.exec("SELECT id, name, color, calendar_visible FROM categories");
		const rows = result[0]?.values ?? [];
		return rows.map((row) => ({
			id: row[0] as string,
			name: row[1] as string,
			color: row[2] as string,
			calendar_visible: row[3] === 1,
		}));
	}

	/**
	 * Schedule items whose date range overlaps [startISO, endISO] (inclusive,
	 * "YYYY-MM-DD" strings — lexical comparison is correct for ISO dates).
	 * Recurrence is NOT expanded here (see lilac SPEC §2.3 — expansion happens
	 * at query time in the view layer, only for the visible window).
	 */
	getScheduleItemsOverlapping(startISO: string, endISO: string): ScheduleItem[] {
		const result = this.db.exec(
			`SELECT path, type, title, category, schedule_kind, start, "end", time_start,
			        time_end, due, do_date, done, done_date, calendar_visible, link, recurrence
			 FROM items
			 WHERE type = 'schedule'
			   AND (
			        (schedule_kind = 'period' AND start <= ? AND COALESCE("end", start) >= ?)
			     OR (schedule_kind != 'period' AND start BETWEEN ? AND ?)
			     OR (recurrence IS NOT NULL AND start <= ?)
			   )`,
			[endISO, startISO, startISO, endISO, endISO]
		);
		const rows = result[0]?.values ?? [];
		return rows.map(rowToScheduleItem);
	}

	/**
	 * Todos (done and pending alike) with a `due` or `do_date` falling in
	 * [startISO, endISO]. Both states are returned because the calendar needs to
	 * tell "finished everything that day" (✓) apart from "nothing was due that
	 * day" (blank) — see lilac DECISIONS 2026-06-07 (Todomate-style day badge).
	 * Todos with neither date (SPEC §2's "상시" bucket) are intentionally excluded —
	 * they don't belong to a specific date, so they don't fit a date grid
	 * (handled separately, see lilac STATE "상시" notes / Phase 5).
	 */
	getTodoItemsInRange(startISO: string, endISO: string): TodoItem[] {
		const result = this.db.exec(
			`SELECT path, type, title, category, due, do_date, done, done_date, link
			 FROM items
			 WHERE type = 'todo'
			   AND (
			        (due IS NOT NULL AND due BETWEEN ? AND ?)
			     OR (do_date IS NOT NULL AND do_date BETWEEN ? AND ?)
			   )`,
			[startISO, endISO, startISO, endISO]
		);
		const rows = result[0]?.values ?? [];
		return rows.map(rowToTodoItem);
	}

	close(): void {
		this.db.close();
	}
}
