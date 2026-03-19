import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
	buildBeadsAuthCall,
	buildBeadsBodyUpdateCall,
	buildBeadsCreateCall,
	buildBeadsFetchCall,
	buildBeadsInitDbCall,
	buildBeadsInitViewCall,
	buildBeadsPullCall,
	buildBeadsStateDoctorEntry,
	buildBeadsUpdateCall,
	detectBeadsArchiveSupport,
	registerBeadsCommands,
	summarizeBeadsStateDoctorEntries,
} from "./beads.js";

describe("buildBeadsAuthCall", () => {
	it("targets notion-get-users self lookup", () => {
		expect(buildBeadsAuthCall()).toEqual({
			tool: "notion-get-users",
			args: { user_id: "self" },
		});
	});
});

describe("buildBeadsFetchCall", () => {
	it("maps database id to notion-fetch", () => {
		expect(buildBeadsFetchCall("db-id")).toEqual({
			tool: "notion-fetch",
			args: { id: "db-id" },
		});
	});
});

describe("buildBeadsPullCall", () => {
	it("maps view url to notion-query-database-view", () => {
		expect(buildBeadsPullCall("view://abc")).toEqual({
			tool: "notion-query-database-view",
			args: { view_url: "view://abc" },
		});
	});
});

describe("buildBeadsInitDbCall", () => {
	it("builds the dedicated beads database create call", () => {
		const result = buildBeadsInitDbCall("page-1", "Beads Issues");
		expect(result.tool).toBe("notion-create-database");
		expect(result.args.title).toBe("Beads Issues");
		expect(result.args.parent).toEqual({ page_id: "page-1", type: "page_id" });
		expect(result.args.schema).toContain(`"Beads ID" RICH_TEXT`);
	});
});

describe("buildBeadsInitViewCall", () => {
	it("builds the default view create call", () => {
		expect(buildBeadsInitViewCall("db-1", "ds-1", "All Issues")).toEqual({
			tool: "notion-create-view",
			args: {
				database_id: "db-1",
				data_source_id: "collection://ds-1",
				type: "table",
				name: "All Issues",
			},
		});
	});
});

describe("buildBeadsCreateCall", () => {
	it("creates pages under a data source", () => {
		expect(
			buildBeadsCreateCall("ds-1", [
				{
					id: "bd-1",
					title: "Issue",
					description: null,
					body: "Body text",
					status: "open",
					priority: null,
					type: null,
					issue_type: null,
					assignee: null,
					labels: [],
					comments: [],
				},
			]),
		).toEqual({
			tool: "notion-create-pages",
			args: {
				parent: { data_source_id: "ds-1", type: "data_source_id" },
				pages: [
					{
						properties: {
							title: "Issue",
							"Beads ID": "bd-1",
							Status: "Open",
						},
						content: "Body text",
					},
				],
			},
		});
	});
});

describe("buildBeadsUpdateCall", () => {
	it("updates properties on an existing page", () => {
		expect(
			buildBeadsUpdateCall("page-1", {
				id: "bd-1",
				title: "Issue",
				description: null,
				body: null,
				status: null,
				priority: "high",
				type: "bug",
				issue_type: "bug",
				assignee: null,
				labels: [],
				comments: [],
			}),
		).toEqual({
			tool: "notion-update-page",
			args: {
				page_id: "page-1",
				command: "update_properties",
				properties: {
					title: "Issue",
					"Beads ID": "bd-1",
					Priority: "High",
					Type: "Bug",
				},
			},
		});
	});
});

describe("buildBeadsBodyUpdateCall", () => {
	it("replaces page content separately from property updates", () => {
		expect(buildBeadsBodyUpdateCall("page-1", "Body")).toEqual({
			tool: "notion-update-page",
			args: {
				page_id: "page-1",
				command: "replace_content",
				new_str: "Body",
			},
		});
	});
});

describe("buildBeadsStateDoctorEntry", () => {
	it("marks matching entries as ok", () => {
		expect(
			buildBeadsStateDoctorEntry("bd-1", "page-1", {
				id: "bd-1",
				title: "Issue",
				description: null,
				body: null,
				status: "open",
				priority: null,
				type: null,
				issue_type: null,
				assignee: null,
				labels: [],
				comments: [],
				external_ref: "notion:page-1",
				notion_page_id: "page-1",
				url: "https://www.notion.so/page-1",
				created_at: null,
				updated_at: null,
			}),
		).toMatchObject({
			status: "ok",
			message: null,
		});
	});

	it("marks mismatched ids as drift", () => {
		expect(
			buildBeadsStateDoctorEntry("bd-1", "page-1", {
				id: "bd-2",
				title: "Issue",
				description: null,
				body: null,
				status: "open",
				priority: null,
				type: null,
				issue_type: null,
				assignee: null,
				labels: [],
				comments: [],
				external_ref: "notion:page-1",
				notion_page_id: "page-1",
				url: "https://www.notion.so/page-1",
				created_at: null,
				updated_at: null,
			}),
		).toMatchObject({
			status: "id_drift",
			actual_beads_id: "bd-2",
		});
	});
});

describe("summarizeBeadsStateDoctorEntries", () => {
	it("counts each doctor status", () => {
		expect(
			summarizeBeadsStateDoctorEntries([
				{ beads_id: "bd-1", page_id: "page-1", status: "ok", message: null },
				{ beads_id: "bd-2", page_id: "page-2", status: "missing_page", message: "missing" },
				{ beads_id: "bd-3", page_id: "page-3", status: "id_drift", message: "drift" },
				{ beads_id: "bd-4", page_id: "page-4", status: "property_mismatch", message: "bad" },
			]),
		).toEqual({
			ok: false,
			total_count: 4,
			ok_count: 1,
			missing_page_count: 1,
			id_drift_count: 1,
			property_mismatch_count: 1,
		});
	});
});

describe("detectBeadsArchiveSupport", () => {
	it("reports unsupported when notion-update-page has no archive command", () => {
		expect(
			detectBeadsArchiveSupport([
				{
					name: "notion-update-page",
					inputSchema: {
						type: "object",
						properties: {
							command: {
								enum: [
									"update_properties",
									"update_content",
									"replace_content",
									"apply_template",
									"update_verification",
								],
							},
						},
					},
				} as never,
			]),
		).toMatchObject({
			supported: false,
			mode: "unsupported",
			supported_commands: [
				"update_properties",
				"update_content",
				"replace_content",
				"apply_template",
				"update_verification",
			],
		});
	});

	it("reports support when notion-update-page exposes archive", () => {
		expect(
			detectBeadsArchiveSupport([
				{
					name: "notion-update-page",
					inputSchema: {
						type: "object",
						properties: {
							command: {
								enum: ["update_properties", "archive"],
							},
						},
					},
				} as never,
			]),
		).toEqual({
			supported: true,
			mode: "update_page_command",
			reason: null,
			supported_commands: ["update_properties", "archive"],
		});
	});
});

describe("registerBeadsCommands", () => {
	it("registers init, config, state, status, pull, and push subcommands", () => {
		const program = new Command();
		registerBeadsCommands(program);
		const beads = program.commands.find((command) => command.name() === "beads");
		expect(beads).toBeDefined();
		expect(beads?.commands.map((command) => command.name())).toEqual([
			"init",
			"config",
			"state",
			"status",
			"pull",
			"push",
		]);

		const config = beads?.commands.find((command) => command.name() === "config");
		expect(config?.commands.map((command) => command.name())).toEqual(["set", "show", "clear"]);

		const state = beads?.commands.find((command) => command.name() === "state");
		expect(state?.commands.map((command) => command.name())).toEqual([
			"show",
			"export",
			"import",
			"doctor",
		]);
	});
});
