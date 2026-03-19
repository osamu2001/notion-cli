import { describe, expect, it } from "vitest";
import {
	assessBeadsSchema,
	BEADS_DEFAULT_DATABASE_TITLE,
	buildBeadsDatabaseSchema,
	buildBeadsProperties,
	detectBeadsPropertiesFromQueryPayload,
	extractBeadsDatabaseInfoFromText,
	extractPageIdFromUrl,
	extractViewUrlFromText,
	findDuplicateBeadsIds,
	issuesEqualForSync,
	normalizeBeadsPushInput,
	normalizeBeadsQueryPayload,
} from "./beads.js";

describe("buildBeadsDatabaseSchema", () => {
	it("builds the fixed beads schema", () => {
		expect(buildBeadsDatabaseSchema()).toContain(`CREATE TABLE "${BEADS_DEFAULT_DATABASE_TITLE}"`);
		expect(buildBeadsDatabaseSchema()).toContain(`"Name" TITLE`);
		expect(buildBeadsDatabaseSchema()).toContain(`"Beads ID" RICH_TEXT`);
		expect(buildBeadsDatabaseSchema()).toContain(`"Labels" MULTI_SELECT`);
	});
});

describe("extractBeadsDatabaseInfoFromText", () => {
	it("extracts database, data source, and views from fetch text", () => {
		const info = extractBeadsDatabaseInfoFromText(`
			<database url="https://www.notion.so/123456781234123412341234567890ab">
				<data-source url="collection://ds-123">
					<view name="All" url="view://view-1" type="table">
					<view name="Open" url="view://view-2" type="board">
				</data-source>
			</database>
		`);

		expect(info.database_id).toBe("12345678-1234-1234-1234-1234567890ab");
		expect(info.data_source_id).toBe("ds-123");
		expect(info.views).toEqual([
			{ name: "All", url: "view://view-1", type: "table" },
			{ name: "Open", url: "view://view-2", type: "board" },
		]);
	});
});

describe("extractViewUrlFromText", () => {
	it("extracts a view url from create-view output", () => {
		expect(extractViewUrlFromText(`Created view "All" (table) — view://abcd-1234`)).toBe(
			"view://abcd-1234",
		);
	});
});

describe("extractPageIdFromUrl", () => {
	it("normalizes compact Notion ids", () => {
		expect(
			extractPageIdFromUrl("https://www.notion.so/Task-123456781234123412341234567890ab"),
		).toBe("12345678-1234-1234-1234-1234567890ab");
	});
});

describe("detectBeadsPropertiesFromQueryPayload", () => {
	it("keeps only schema properties from query results", () => {
		const detected = detectBeadsPropertiesFromQueryPayload({
			results: [
				{
					id: "page-1",
					url: "https://www.notion.so/page-1",
					Name: "Issue one",
					"Beads ID": "bd-1",
					Status: "Open",
					Priority: "High",
					Type: "Bug",
					Description: "desc",
				},
			],
		});

		expect(detected).toEqual(["Beads ID", "Description", "Name", "Priority", "Status", "Type"]);
	});
});

describe("assessBeadsSchema", () => {
	it("reports missing required and optional properties", () => {
		const schema = assessBeadsSchema(["Name", "Beads ID", "Status"], true);
		expect(schema.missing).toEqual(["Priority", "Type", "Description"]);
		expect(schema.optional_missing).toEqual(["Assignee", "Labels"]);
	});
});

describe("findDuplicateBeadsIds", () => {
	it("returns duplicate ids once", () => {
		expect(findDuplicateBeadsIds(["bd-1", "bd-2", "bd-1", "bd-3", "bd-2"])).toEqual([
			"bd-1",
			"bd-2",
		]);
	});
});

describe("normalizeBeadsQueryPayload", () => {
	it("normalizes query results into beads issue JSON", () => {
		const payload = normalizeBeadsQueryPayload({
			results: [
				{
					id: "page-1",
					url: "https://www.notion.so/Task-123456781234123412341234567890ab",
					Name: "Fix login",
					"Beads ID": "bd-42",
					Status: "In Progress",
					Priority: "High",
					Type: "Bug",
					Description: "Handle the edge case",
					Assignee: "osamu",
					Labels: ["backend", "auth"],
					created_time: "2026-03-19T00:00:00Z",
					last_edited_time: "2026-03-19T01:00:00Z",
				},
			],
		});

		expect(payload).toEqual({
			issues: [
				{
					id: "bd-42",
					title: "Fix login",
					description: "Handle the edge case",
					status: "in_progress",
					priority: "high",
					type: "bug",
					issue_type: "bug",
					assignee: "osamu",
					labels: ["backend", "auth"],
					external_ref: "https://www.notion.so/Task-123456781234123412341234567890ab",
					notion_page_id: "page-1",
					url: "https://www.notion.so/Task-123456781234123412341234567890ab",
					created_at: "2026-03-19T00:00:00Z",
					updated_at: "2026-03-19T01:00:00Z",
				},
			],
		});
	});
});

describe("normalizeBeadsPushInput", () => {
	it("accepts both object and array roots", () => {
		expect(
			normalizeBeadsPushInput({
				issues: [{ id: "bd-1", title: "Issue", status: "open", labels: "a, b" }],
			}),
		).toEqual({
			issues: [
				{
					id: "bd-1",
					title: "Issue",
					description: null,
					status: "open",
					priority: null,
					type: null,
					issue_type: null,
					assignee: null,
					labels: ["a", "b"],
				},
			],
		});
	});
});

describe("issuesEqualForSync", () => {
	it("treats matching issues as equal even if labels order differs", () => {
		expect(
			issuesEqualForSync(
				{
					id: "bd-1",
					title: "Issue",
					description: "desc",
					status: "open",
					priority: "high",
					type: "task",
					issue_type: "task",
					assignee: "osamu",
					labels: ["b", "a"],
					external_ref: "notion:page-1",
					notion_page_id: "page-1",
					url: "https://www.notion.so/page-1",
					created_at: null,
					updated_at: null,
				},
				{
					id: "bd-1",
					title: "Issue",
					description: "desc",
					status: "open",
					priority: "high",
					type: "task",
					issue_type: "task",
					assignee: "osamu",
					labels: ["a", "b"],
				},
			),
		).toBe(true);
	});
});

describe("buildBeadsProperties", () => {
	it("maps normalized beads issue values back to Notion properties", () => {
		expect(
			buildBeadsProperties({
				id: "bd-7",
				title: "Ship it",
				description: "Release checklist",
				status: "closed",
				priority: "critical",
				type: "feature",
				issue_type: "feature",
				assignee: "osamu",
				labels: ["release"],
			}),
		).toEqual({
			title: "Ship it",
			"Beads ID": "bd-7",
			Status: "Closed",
			Priority: "Critical",
			Type: "Feature",
			Description: "Release checklist",
			Assignee: "osamu",
			Labels: ["release"],
		});
	});

	it("rejects unsupported enum values at property build time", () => {
		expect(() =>
			buildBeadsProperties({
				id: "bd-7",
				title: "Ship it",
				description: null,
				status: "invalid",
				priority: null,
				type: null,
				issue_type: null,
				assignee: null,
				labels: [],
			}),
		).toThrow("Invalid beads status");
	});
});
