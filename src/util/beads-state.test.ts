import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BeadsStateStore,
	listStoredBeadsStateEntries,
	normalizeStoredBeadsState,
	parseStoredBeadsState,
} from "./beads-state.js";
import { CliError } from "./errors.js";

describe("normalizeStoredBeadsState", () => {
	it("normalizes and sorts page mappings", () => {
		expect(
			normalizeStoredBeadsState({
				database_id: "db-1",
				page_ids: {
					"bd-2": "page-2",
					"bd-1": "page-1",
				},
			}),
		).toEqual({
			database_id: "db-1",
			page_ids: {
				"bd-1": "page-1",
				"bd-2": "page-2",
			},
		});
	});

	it("rejects empty page ids", () => {
		try {
			normalizeStoredBeadsState({
				database_id: "db-1",
				page_ids: {
					"bd-1": "",
				},
			});
			throw new Error("expected normalizeStoredBeadsState to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(CliError);
			expect((error as CliError).what).toBe("Invalid beads state");
			expect((error as CliError).why).toMatch(/empty page id/);
		}
	});

	it("rejects duplicate page ids", () => {
		try {
			normalizeStoredBeadsState({
				database_id: "db-1",
				page_ids: {
					"bd-1": "page-1",
					"bd-2": "page-1",
				},
			});
			throw new Error("expected normalizeStoredBeadsState to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(CliError);
			expect((error as CliError).what).toBe("Invalid beads state");
			expect((error as CliError).why).toMatch(/duplicate page id/);
		}
	});

	it("returns undefined for invalid stored payload via parseStoredBeadsState", () => {
		expect(parseStoredBeadsState({ nope: true })).toBeUndefined();
	});
});

describe("listStoredBeadsStateEntries", () => {
	it("returns sorted entries", () => {
		expect(
			listStoredBeadsStateEntries({
				database_id: "db-1",
				page_ids: {
					"bd-2": "page-2",
					"bd-1": "page-1",
				},
			}),
		).toEqual([
			{ id: "bd-1", page_id: "page-1" },
			{ id: "bd-2", page_id: "page-2" },
		]);
	});
});

describe("BeadsStateStore", () => {
	let tmpDir: string;
	let store: BeadsStateStore;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ncli-beads-state-"));
		store = new BeadsStateStore(tmpDir);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns undefined when no state exists", () => {
		expect(store.read()).toBeUndefined();
	});

	it("saves and reads state", () => {
		store.save({
			database_id: "db-1",
			page_ids: { "bd-1": "page-1" },
		});
		expect(store.read()).toEqual({
			database_id: "db-1",
			page_ids: { "bd-1": "page-1" },
		});
	});

	it("filters state by database id", () => {
		store.save({
			database_id: "db-1",
			page_ids: { "bd-1": "page-1" },
		});
		expect(store.readForDatabase("db-1")?.database_id).toBe("db-1");
		expect(store.readForDatabase("db-2")).toBeUndefined();
	});

	it("clears state", () => {
		store.save({
			database_id: "db-1",
			page_ids: { "bd-1": "page-1" },
		});
		store.clear();
		expect(store.read()).toBeUndefined();
	});

	it("writes state with 0o600 permissions", () => {
		store.save({
			database_id: "db-1",
			page_ids: { "bd-1": "page-1" },
		});
		const stat = fs.statSync(path.join(tmpDir, "beads-state.json"));
		expect(stat.mode & 0o777).toBe(0o600);
	});

	it("readStrict returns undefined when no state exists", () => {
		expect(store.readStrict()).toBeUndefined();
	});

	it("readStrict rejects malformed JSON", () => {
		fs.writeFileSync(path.join(tmpDir, "beads-state.json"), "{broken", "utf8");
		expect(() => store.readStrict()).toThrow(CliError);
		expect(() => store.readStrict()).toThrow(/Invalid beads state/);
	});

	it("readStrict rejects invalid state shape", () => {
		fs.writeFileSync(
			path.join(tmpDir, "beads-state.json"),
			JSON.stringify({ database_id: "db-1" }),
			"utf8",
		);
		try {
			store.readStrict();
			throw new Error("expected readStrict to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(CliError);
			expect((error as CliError).why).toMatch(/must include a "page_ids" object/);
		}
	});

	it("readForDatabaseStrict preserves missing-vs-mismatch behavior", () => {
		store.save({
			database_id: "db-1",
			page_ids: { "bd-1": "page-1" },
		});
		expect(store.readForDatabaseStrict("db-1")?.database_id).toBe("db-1");
		expect(store.readForDatabaseStrict("db-2")).toBeUndefined();
	});
});
