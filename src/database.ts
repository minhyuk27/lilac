import initSqlJs, { Database } from "sql.js";
import { LilacItem, Category } from "./types";

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

	close(): void {
		this.db.close();
	}
}
