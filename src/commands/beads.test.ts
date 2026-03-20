import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { BeadsStateStore } from "../util/beads-state.js";
import {
	buildBeadsAuthCall,
	buildBeadsBodyUpdateCall,
	buildBeadsCreateCall,
	buildBeadsFetchCall,
	buildBeadsInitDbCall,
	buildBeadsInitViewCall,
	buildBeadsPullCall,
	buildBeadsSearchCall,
	buildBeadsStateDoctorEntry,
	buildBeadsUpdateCall,
	collectExistingBeadsPagesForPush,
	createBeadsPagesForPush,
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

describe("buildBeadsSearchCall", () => {
	it("scopes live row discovery to the target database when a URL is available", () => {
		expect(buildBeadsSearchCall("bd-1", "https://www.notion.so/workspace/beads-db")).toEqual({
			tool: "notion-search",
			args: {
				query: "bd-1",
				page_size: 25,
				query_type: "internal",
				data_source_url: "https://www.notion.so/workspace/beads-db",
			},
		});
	});

	it("falls back to unscoped search when the database URL is unavailable", () => {
		expect(buildBeadsSearchCall("bd-1", null)).toEqual({
			tool: "notion-search",
			args: {
				query: "bd-1",
				page_size: 25,
				query_type: "internal",
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
					Description: null,
					Assignee: null,
					Labels: [],
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

describe("collectExistingBeadsPagesForPush", () => {
	const makeIssueFetch = (beadsId: string, pageId: string) => ({
		text: `<properties>${JSON.stringify({
			Name: `Issue ${beadsId}`,
			"Beads ID": beadsId,
			Status: "Open",
			url: `https://www.notion.so/${pageId.replaceAll("-", "")}`,
		})}</properties>\n<blank-page />`,
	});

	it("discovers existing rows from live search when local state is empty", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const conn = {
			callTool: async (name: string, args: Record<string, unknown>) => {
				calls.push({ name, args });
				if (name === "notion-search") {
					return {
						results: [{ id: "11111111-1111-4111-8111-111111111111", type: "page" }],
					};
				}
				if (name === "notion-fetch") {
					return makeIssueFetch("bd-1", "11111111-1111-4111-8111-111111111111");
				}
				throw new Error(`unexpected tool: ${name}`);
			},
		};

		const result = await collectExistingBeadsPagesForPush(
			conn,
			{ database_id: "db-1", page_ids: {} },
			[
				{
					id: "bd-1",
					title: "Issue bd-1",
					description: null,
					body: null,
					status: "open",
					priority: null,
					type: null,
					issue_type: null,
					assignee: null,
					labels: [],
					comments: [],
				},
			],
			"https://www.notion.so/workspace/beads-db",
		);

		expect(result.existingById.get("bd-1")?.notion_page_id).toBe(
			"11111111-1111-4111-8111-111111111111",
		);
		expect(result.discoveredPageIds).toEqual({
			"bd-1": "11111111-1111-4111-8111-111111111111",
		});
		expect(result.rawExistingPages).toMatchObject([
			{
				beads_id: "bd-1",
				page_id: "11111111-1111-4111-8111-111111111111",
				source: "search",
			},
		]);
		expect(calls).toContainEqual({
			name: "notion-search",
			args: {
				query: "bd-1",
				page_size: 25,
				query_type: "internal",
				data_source_url: "https://www.notion.so/workspace/beads-db",
			},
		});
	});

	it("fails when live search finds multiple exact Beads ID matches", async () => {
		const conn = {
			callTool: async (name: string, args: Record<string, unknown>) => {
				if (name === "notion-search") {
					return {
						results: [
							{ id: "11111111-1111-4111-8111-111111111111", type: "page" },
							{ id: "22222222-2222-4222-8222-222222222222", type: "page" },
						],
					};
				}
				if (name === "notion-fetch" && args.id === "11111111-1111-4111-8111-111111111111") {
					return makeIssueFetch("bd-1", "11111111-1111-4111-8111-111111111111");
				}
				if (name === "notion-fetch" && args.id === "22222222-2222-4222-8222-222222222222") {
					return makeIssueFetch("bd-1", "22222222-2222-4222-8222-222222222222");
				}
				throw new Error(`unexpected tool: ${name}`);
			},
		};

		await expect(
			collectExistingBeadsPagesForPush(
				conn,
				{ database_id: "db-1", page_ids: {} },
				[
					{
						id: "bd-1",
						title: "Issue bd-1",
						description: null,
						body: null,
						status: "open",
						priority: null,
						type: null,
						issue_type: null,
						assignee: null,
						labels: [],
						comments: [],
					},
				],
				"https://www.notion.so/workspace/beads-db",
			),
		).rejects.toThrow("Duplicate live Beads ID rows detected");
	});
});

describe("createBeadsPagesForPush", () => {
	const makePushIssue = (id: string) => ({
		id,
		title: `Issue ${id}`,
		description: null,
		body: null,
		status: "open" as const,
		priority: null,
		type: null,
		issue_type: null,
		assignee: null,
		labels: [],
		comments: [],
	});

	it("persists created mappings before later sync steps run", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "ncli-beads-state-"));
		try {
			const stateStore = new BeadsStateStore(tempDir);
			const state = { database_id: "db-1", page_ids: {} as Record<string, string> };
			const plannedComments = [{ id: "bd-1", title: "Issue bd-1", pageId: null, comments: [] }];
			const conn = {
				callTool: async () =>
					({
						pages: [{ id: "11111111-1111-4111-8111-111111111111" }],
					}) as Record<string, unknown>,
			};

			await createBeadsPagesForPush(
				conn,
				stateStore,
				state,
				"ds-1",
				[makePushIssue("bd-1")],
				plannedComments,
			);

			expect(stateStore.readForDatabase("db-1")).toEqual({
				database_id: "db-1",
				page_ids: {
					"bd-1": "11111111-1111-4111-8111-111111111111",
				},
			});
			expect(plannedComments[0]?.pageId).toBe("11111111-1111-4111-8111-111111111111");
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps earlier created mappings when the batch returns only a partial set of ids", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "ncli-beads-state-"));
		try {
			const stateStore = new BeadsStateStore(tempDir);
			const state = { database_id: "db-1", page_ids: {} as Record<string, string> };
			const conn = {
				callTool: async () =>
					({
						pages: [{ id: "11111111-1111-4111-8111-111111111111" }, {}],
					}) as Record<string, unknown>,
			};

			await createBeadsPagesForPush(conn, stateStore, state, "ds-1", [
				makePushIssue("bd-1"),
				makePushIssue("bd-2"),
			]);

			expect(stateStore.readForDatabase("db-1")).toEqual({
				database_id: "db-1",
				page_ids: {
					"bd-1": "11111111-1111-4111-8111-111111111111",
				},
			});
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
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
