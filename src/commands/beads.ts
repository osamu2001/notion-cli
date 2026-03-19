import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { withConnection } from "../mcp/with-connection.js";
import { printOutput } from "../output/json.js";
import type { BeadsIssue, BeadsPushIssue } from "../util/beads.js";
import {
	assessBeadsSchema,
	BEADS_DEFAULT_DATABASE_TITLE,
	BEADS_DEFAULT_VIEW_NAME,
	BEADS_SCHEMA_VERSION,
	buildBeadsDatabaseSchema,
	buildBeadsProperties,
	detectBeadsPropertiesFromFetchText,
	extractBeadsDatabaseInfoFromText,
	extractResultJson,
	extractResultText,
	extractSelfUserFromPayload,
	extractViewUrlFromText,
	findDuplicateBeadsIds,
	issuesEqualForSync,
	normalizeBeadsPageFetchPayload,
	parseBeadsPushInput,
} from "../util/beads.js";
import { BeadsConfigStore, type StoredBeadsConfig } from "../util/beads-config.js";
import { BeadsStateStore } from "../util/beads-state.js";
import { CliError } from "../util/errors.js";
import { readStdin } from "../util/stdin.js";

interface BeadsStatusOptions {
	databaseId?: string;
	viewUrl?: string;
}

interface BeadsPullOptions {
	viewUrl?: string;
}

interface BeadsPushOptions {
	databaseId?: string;
	viewUrl?: string;
	input?: string;
	data?: string;
	dryRun?: boolean;
}

interface BeadsInitOptions {
	parent?: string;
	title?: string;
}

interface BeadsConfigSetOptions {
	databaseId?: string;
	viewUrl?: string;
}

interface ToolCall {
	tool: string;
	args: Record<string, unknown>;
}

interface ResolvedBeadsTarget {
	databaseId: string;
	viewUrl?: string;
	config: StoredBeadsConfig | undefined;
	source: "flags" | "config";
}

function requireOption(
	value: string | undefined,
	flag: string,
	what: string,
	commandName: string,
): string {
	if (value) {
		return value;
	}
	throw new CliError(
		`Missing ${flag}`,
		`${what} is required`,
		`Run "ncli beads ${commandName} --help" for usage`,
	);
}

function configHint(command: string): string {
	return `Run "ncli beads init --parent <page-id>" or "ncli beads config set --database-id <id> --view-url <url>" before "ncli beads ${command}"`;
}

function resolveStatusTarget(opts: BeadsStatusOptions): ResolvedBeadsTarget {
	const store = new BeadsConfigStore();
	const config = store.read();
	const databaseId = opts.databaseId ?? config?.database_id;
	if (!databaseId) {
		throw new CliError(
			"Missing beads database target",
			"beads status needs a database id or saved beads config",
			configHint("status"),
		);
	}
	const viewUrl =
		opts.viewUrl ??
		(!opts.databaseId || config?.database_id === opts.databaseId ? config?.view_url : undefined);
	return {
		databaseId,
		viewUrl,
		config,
		source: opts.databaseId || opts.viewUrl ? "flags" : "config",
	};
}

function resolvePullTarget(opts: BeadsPullOptions): ResolvedBeadsTarget {
	const store = new BeadsConfigStore();
	const config = store.read();
	const databaseId = config?.database_id;
	if (!databaseId) {
		throw new CliError(
			"Missing beads database target",
			"beads pull needs saved beads config with a database id",
			configHint("pull"),
		);
	}
	return {
		databaseId,
		viewUrl: opts.viewUrl ?? config?.view_url,
		config,
		source: opts.viewUrl ? "flags" : "config",
	};
}

function resolvePushTarget(opts: BeadsPushOptions): ResolvedBeadsTarget {
	const store = new BeadsConfigStore();
	const config = store.read();
	if (opts.databaseId || opts.viewUrl) {
		if (!opts.databaseId || !opts.viewUrl) {
			throw new CliError(
				"Incomplete push target override",
				'When overriding saved config, "beads push" requires both --database-id and --view-url',
				'Pass both flags, or configure defaults with "ncli beads config set"',
			);
		}
		return {
			databaseId: opts.databaseId,
			viewUrl: opts.viewUrl,
			config,
			source: "flags",
		};
	}
	if (!config) {
		throw new CliError(
			"Missing beads push target",
			"beads push needs both database/view ids or saved beads config",
			configHint("push"),
		);
	}
	return {
		databaseId: config.database_id,
		viewUrl: config.view_url,
		config,
		source: "config",
	};
}

async function readPushInput(opts: BeadsPushOptions) {
	if (opts.data) {
		return parseBeadsPushInput(opts.data);
	}
	if (!opts.input) {
		throw new CliError(
			"Missing push input",
			"beads push requires --input <path|-> or --data <json>",
			"Pass --input issues.json, --input -, or --data '{\"issues\":[...]}'.",
		);
	}
	const raw = opts.input === "-" ? await readStdin() : await readFile(opts.input, "utf8");
	return parseBeadsPushInput(raw);
}

export function buildBeadsAuthCall(): ToolCall {
	return { tool: "notion-get-users", args: { user_id: "self" } };
}

export function buildBeadsFetchCall(databaseId: string): ToolCall {
	return { tool: "notion-fetch", args: { id: databaseId } };
}

export function buildBeadsPullCall(viewUrl: string): ToolCall {
	return { tool: "notion-query-database-view", args: { view_url: viewUrl } };
}

export function buildBeadsInitDbCall(
	parentId: string,
	title: string = BEADS_DEFAULT_DATABASE_TITLE,
): ToolCall {
	return {
		tool: "notion-create-database",
		args: {
			title,
			schema: buildBeadsDatabaseSchema(title),
			parent: {
				page_id: parentId,
				type: "page_id",
			},
		},
	};
}

export function buildBeadsInitViewCall(
	databaseId: string,
	dataSourceId: string,
	name: string = BEADS_DEFAULT_VIEW_NAME,
): ToolCall {
	return {
		tool: "notion-create-view",
		args: {
			database_id: databaseId,
			data_source_id: `collection://${dataSourceId}`,
			type: "table",
			name,
		},
	};
}

export function buildBeadsCreateCall(dataSourceId: string, issues: BeadsPushIssue[]): ToolCall {
	return {
		tool: "notion-create-pages",
		args: {
			parent: { data_source_id: dataSourceId, type: "data_source_id" },
			pages: issues.map((issue) => ({ properties: buildBeadsProperties(issue) })),
		},
	};
}

export function buildBeadsUpdateCall(pageId: string, issue: BeadsPushIssue): ToolCall {
	return {
		tool: "notion-update-page",
		args: {
			page_id: pageId,
			command: "update_properties",
			properties: buildBeadsProperties(issue),
		},
	};
}

function buildStoredConfig(
	databaseId: string,
	dataSourceId: string,
	viewUrl: string,
): StoredBeadsConfig {
	return {
		database_id: databaseId,
		data_source_id: dataSourceId,
		view_url: viewUrl,
		schema_version: BEADS_SCHEMA_VERSION,
	};
}

function validateStoredConfigMatch(
	config: StoredBeadsConfig | undefined,
	dataSourceId: string | null,
): void {
	if (config && dataSourceId && config.data_source_id !== dataSourceId) {
		throw new CliError(
			"Saved beads config is stale",
			`Saved data_source_id ${config.data_source_id} does not match fetched data_source_id ${dataSourceId}`,
			'Run "ncli beads config set --database-id <id> --view-url <url>" to refresh the saved config',
		);
	}
}

async function runBeadsInit(opts: BeadsInitOptions, cmd: Command): Promise<void> {
	const parentId = requireOption(opts.parent, "--parent", "A parent page ID", "init");
	const title = opts.title ?? BEADS_DEFAULT_DATABASE_TITLE;
	const store = new BeadsConfigStore();

	await withConnection(async (conn) => {
		const dbCall = buildBeadsInitDbCall(parentId, title);
		const dbResult = (await conn.callTool(dbCall.tool, dbCall.args)) as Record<string, unknown>;
		const databaseInfo = extractBeadsDatabaseInfoFromText(
			extractResultText(dbResult, "beads init database"),
		);
		if (!databaseInfo.database_id || !databaseInfo.data_source_id) {
			throw new CliError(
				"Could not extract database info from beads init",
				"Database creation did not return database_id and data_source_id in the expected shape",
				'Retry with "ncli beads init --raw" to inspect the raw response',
			);
		}

		const viewCall = buildBeadsInitViewCall(databaseInfo.database_id, databaseInfo.data_source_id);
		const viewResult = (await conn.callTool(viewCall.tool, viewCall.args)) as Record<
			string,
			unknown
		>;
		const viewUrl = extractViewUrlFromText(extractResultText(viewResult, "beads init view"));
		if (!viewUrl) {
			throw new CliError(
				"Could not extract view url from beads init",
				"View creation succeeded but did not return a view:// url in the expected shape",
				'Retry with "ncli beads init --raw" to inspect the raw response',
			);
		}

		const savedConfig = buildStoredConfig(
			databaseInfo.database_id,
			databaseInfo.data_source_id,
			viewUrl,
		);
		store.save(savedConfig);

		const payload = {
			database_id: savedConfig.database_id,
			data_source_id: savedConfig.data_source_id,
			view_url: savedConfig.view_url,
			schema_version: savedConfig.schema_version,
			saved: true,
		};

		const rawPayload = {
			database: dbResult,
			view: viewResult,
		};

		printOutput(
			(cmd.optsWithGlobals().raw ? rawPayload : payload) as Record<string, unknown>,
			cmd.optsWithGlobals(),
		);
	});
}

async function runBeadsConfigSet(opts: BeadsConfigSetOptions, cmd: Command): Promise<void> {
	const databaseId = requireOption(
		opts.databaseId,
		"--database-id",
		"A Notion database ID",
		"config set",
	);
	const viewUrl = requireOption(opts.viewUrl, "--view-url", "A Notion view URL", "config set");
	const store = new BeadsConfigStore();
	const stateStore = new BeadsStateStore();

	await withConnection(async (conn) => {
		const fetchCall = buildBeadsFetchCall(databaseId);
		const fetchResult = (await conn.callTool(fetchCall.tool, fetchCall.args)) as Record<
			string,
			unknown
		>;
		const fetchText = extractResultText(fetchResult, "beads fetch");
		const databaseInfo = extractBeadsDatabaseInfoFromText(fetchText);
		if (!databaseInfo.data_source_id) {
			throw new CliError(
				"Missing data source ID",
				`Could not extract a data_source_id from database ${databaseId}`,
				'Run "ncli fetch <db-id> --raw" and check that the target is a database page',
			);
		}
		if (!databaseInfo.views.some((view) => view.url === viewUrl)) {
			throw new CliError(
				"Unknown beads view URL",
				`The provided view URL is not listed on database ${databaseId}`,
				'Rerun "ncli fetch <db-id>" and choose one of the reported view URLs',
			);
		}
		const schema = assessBeadsSchema(detectBeadsPropertiesFromFetchText(fetchText), true);

		const savedConfig = buildStoredConfig(
			databaseInfo.database_id ?? databaseId,
			databaseInfo.data_source_id,
			viewUrl,
		);
		const previous = store.read();
		store.save(savedConfig);
		if (!previous || previous.database_id !== savedConfig.database_id) {
			stateStore.save({ database_id: savedConfig.database_id, page_ids: {} });
		}

		const payload = {
			...savedConfig,
			saved: true,
			schema,
		};

		const rawPayload = {
			fetch: fetchResult,
		};

		printOutput(
			(cmd.optsWithGlobals().raw ? rawPayload : payload) as Record<string, unknown>,
			cmd.optsWithGlobals(),
		);
	});
}

function runBeadsConfigShow(cmd: Command): void {
	const store = new BeadsConfigStore();
	const config = store.read();
	printOutput(
		{
			configured: !!config,
			path: store.filePath(),
			config,
		},
		cmd.optsWithGlobals(),
	);
}

function runBeadsConfigClear(cmd: Command): void {
	const store = new BeadsConfigStore();
	const stateStore = new BeadsStateStore();
	const existed = !!store.read();
	store.clear();
	stateStore.clear();
	printOutput(
		{
			cleared: true,
			existed,
			path: store.filePath(),
		},
		cmd.optsWithGlobals(),
	);
}

async function runBeadsStatus(opts: BeadsStatusOptions, cmd: Command): Promise<void> {
	const target = resolveStatusTarget(opts);
	const stateStore = new BeadsStateStore();

	await withConnection(async (conn) => {
		const authCall = buildBeadsAuthCall();
		const authResult = (await conn.callTool(authCall.tool, authCall.args)) as Record<
			string,
			unknown
		>;
		const authPayload = extractResultJson(authResult, "beads status auth");

		const fetchCall = buildBeadsFetchCall(target.databaseId);
		const fetchResult = (await conn.callTool(fetchCall.tool, fetchCall.args)) as Record<
			string,
			unknown
		>;
		const fetchText = extractResultText(fetchResult, "beads fetch");
		const databaseInfo = extractBeadsDatabaseInfoFromText(fetchText);
		validateStoredConfigMatch(target.config, databaseInfo.data_source_id);

		const schema = assessBeadsSchema(detectBeadsPropertiesFromFetchText(fetchText), true);
		const viewUrl = target.viewUrl ?? null;
		const viewConfigured = !viewUrl || databaseInfo.views.some((view) => view.url === viewUrl);
		const state = stateStore.readForDatabase(target.databaseId);

		const payload = {
			ready: !!databaseInfo.data_source_id && schema.missing.length === 0 && viewConfigured,
			auth: {
				ok: true,
				user: extractSelfUserFromPayload(authPayload),
			},
			database: {
				id: databaseInfo.database_id ?? target.databaseId,
				url: databaseInfo.database_url,
			},
			data_source_id: databaseInfo.data_source_id,
			view_url: viewUrl,
			views: databaseInfo.views,
			schema_version: target.config?.schema_version ?? BEADS_SCHEMA_VERSION,
			configured: !!target.config,
			config_source: target.source,
			schema,
			state: {
				managed_count: Object.keys(state?.page_ids ?? {}).length,
				view_configured: viewConfigured,
			},
		};

		const rawPayload = {
			auth: authResult,
			fetch: fetchResult,
		};

		printOutput(
			(cmd.optsWithGlobals().raw ? rawPayload : payload) as Record<string, unknown>,
			cmd.optsWithGlobals(),
		);
	});
}

async function runBeadsPull(opts: BeadsPullOptions, cmd: Command): Promise<void> {
	const target = resolvePullTarget(opts);
	const stateStore = new BeadsStateStore();

	await withConnection(async (conn) => {
		const state = stateStore.readForDatabase(target.databaseId) ?? {
			database_id: target.databaseId,
			page_ids: {},
		};
		const issues: BeadsPushIssue[] = [];
		const rawPages: Array<{ beads_id: string; fetch: Record<string, unknown> }> = [];

		for (const [beadsId, pageId] of Object.entries(state.page_ids)) {
			const fetchCall = { tool: "notion-fetch", args: { id: pageId } };
			const result = (await conn.callTool(fetchCall.tool, fetchCall.args)) as Record<
				string,
				unknown
			>;
			const payload = extractResultJson(result, `beads pull page ${beadsId}`);
			issues.push(normalizeBeadsPageFetchPayload(payload));
			rawPages.push({ beads_id: beadsId, fetch: result });
		}

		issues.sort((a, b) => a.id.localeCompare(b.id));

		const payload = { issues };
		const rawPayload = {
			state,
			pages: rawPages,
		};

		printOutput(
			(cmd.optsWithGlobals().raw ? rawPayload : payload) as Record<string, unknown>,
			cmd.optsWithGlobals(),
		);
	});
}

async function runBeadsPush(opts: BeadsPushOptions, cmd: Command): Promise<void> {
	const target = resolvePushTarget(opts);
	const input = await readPushInput(opts);
	const stateStore = new BeadsStateStore();

	await withConnection(async (conn) => {
		const fetchCall = buildBeadsFetchCall(target.databaseId);
		const fetchResult = (await conn.callTool(fetchCall.tool, fetchCall.args)) as Record<
			string,
			unknown
		>;
		const fetchText = extractResultText(fetchResult, "beads fetch");
		const databaseInfo = extractBeadsDatabaseInfoFromText(fetchText);
		if (!databaseInfo.data_source_id) {
			throw new CliError(
				"Missing data source ID",
				`Could not extract a data_source_id from database ${target.databaseId}`,
				'Run "ncli fetch <db-id> --raw" and check that the target is a database page',
			);
		}
		validateStoredConfigMatch(target.config, databaseInfo.data_source_id);

		const schema = assessBeadsSchema(detectBeadsPropertiesFromFetchText(fetchText), true);
		if (schema.missing.length > 0) {
			throw new CliError(
				"Invalid beads database schema",
				`The target database is missing required properties: ${schema.missing.join(", ")}`,
				"Use the dedicated beads database schema before pushing issues",
			);
		}
		if (target.viewUrl && !databaseInfo.views.some((view) => view.url === target.viewUrl)) {
			throw new CliError(
				"Unknown beads view URL",
				`The configured view URL is not listed on database ${target.databaseId}`,
				'Rerun "ncli fetch <db-id>" and update the saved config if the view changed',
			);
		}

		const duplicateInputIds = findDuplicateBeadsIds(input.issues.map((issue) => issue.id));
		if (duplicateInputIds.length > 0) {
			throw new CliError(
				"Duplicate Beads ID values in input",
				`Input contains duplicate Beads ID values: ${duplicateInputIds.join(", ")}`,
				"Ensure each issue id appears only once before pushing",
			);
		}

		const state = stateStore.readForDatabase(target.databaseId) ?? {
			database_id: target.databaseId,
			page_ids: {},
		};
		const existingById = new Map<string, BeadsIssue>();
		const rawExistingPages: Array<{
			beads_id: string;
			page_id: string;
			fetch: Record<string, unknown>;
		}> = [];

		for (const [expectedBeadsId, pageId] of Object.entries(state.page_ids)) {
			const pageFetchCall = { tool: "notion-fetch", args: { id: pageId } };
			const pageFetchResult = (await conn.callTool(
				pageFetchCall.tool,
				pageFetchCall.args,
			)) as Record<string, unknown>;
			const pagePayload = extractResultJson(
				pageFetchResult,
				`beads push preflight page ${expectedBeadsId}`,
			);
			const existingIssue = normalizeBeadsPageFetchPayload(pagePayload);
			if (existingIssue.id !== expectedBeadsId) {
				throw new CliError(
					"Managed page ID drift detected",
					`Saved mapping expected Beads ID ${expectedBeadsId}, but Notion page ${pageId} currently reports ${existingIssue.id}`,
					"Fix the page property in Notion or clear the saved beads state before retrying",
				);
			}
			if (!existingIssue.notion_page_id) {
				throw new CliError(
					"Invalid target row",
					`Managed issue ${expectedBeadsId} does not expose a page id after fetch`,
					'Retry with "ncli fetch <page-id> --raw" to inspect the raw payload',
				);
			}
			existingById.set(existingIssue.id, existingIssue);
			rawExistingPages.push({ beads_id: expectedBeadsId, page_id: pageId, fetch: pageFetchResult });
		}

		const toCreate: BeadsPushIssue[] = [];
		const toUpdate: Array<{ pageId: string; issue: BeadsPushIssue }> = [];
		const skipped: Array<{
			id: string;
			title: string;
			notion_page_id: string | null;
			reason: string;
		}> = [];

		for (const issue of input.issues) {
			buildBeadsProperties(issue);
			const current = existingById.get(issue.id);
			if (!current) {
				toCreate.push(issue);
				continue;
			}
			if (issuesEqualForSync(current, issue)) {
				skipped.push({
					id: issue.id,
					title: issue.title,
					notion_page_id: current.notion_page_id,
					reason: "unchanged",
				});
				continue;
			}
			const currentPageId = current.notion_page_id;
			if (!currentPageId) {
				throw new CliError(
					"Invalid target row",
					`Managed issue ${issue.id} does not expose a page id after fetch`,
					'Retry with "ncli fetch <page-id> --raw" to inspect the raw payload',
				);
			}
			toUpdate.push({ pageId: currentPageId, issue });
		}

		const payload = {
			dry_run: !!opts.dryRun,
			input_count: input.issues.length,
			created_count: toCreate.length,
			updated_count: toUpdate.length,
			skipped_count: skipped.length,
			errors: [] as string[],
			created: toCreate.map((issue) => ({
				id: issue.id,
				title: issue.title,
			})),
			updated: toUpdate.map((update) => ({
				id: update.issue.id,
				title: update.issue.title,
				notion_page_id: update.pageId,
			})),
			skipped,
		};

		let createResult: Record<string, unknown> | null = null;
		const updateResults: Array<{ id: string; result: Record<string, unknown> }> = [];

		if (!opts.dryRun) {
			if (toCreate.length > 0) {
				const createCall = buildBeadsCreateCall(databaseInfo.data_source_id, toCreate);
				createResult = (await conn.callTool(createCall.tool, createCall.args)) as Record<
					string,
					unknown
				>;
				const createPayload = extractResultJson(createResult, "beads push create");
				const createdPages = Array.isArray(createPayload.pages) ? createPayload.pages : [];
				for (const [index, issue] of toCreate.entries()) {
					const page = createdPages[index];
					if (
						page &&
						typeof page === "object" &&
						page !== null &&
						"id" in page &&
						typeof page.id === "string"
					) {
						state.page_ids[issue.id] = page.id;
					}
				}
			}
			for (const update of toUpdate) {
				const updateCall = buildBeadsUpdateCall(update.pageId, update.issue);
				const result = (await conn.callTool(updateCall.tool, updateCall.args)) as Record<
					string,
					unknown
				>;
				updateResults.push({ id: update.issue.id, result });
				state.page_ids[update.issue.id] = update.pageId;
			}
			stateStore.save(state);
		}

		const rawPayload = {
			plan: payload,
			fetch: fetchResult,
			existing_pages: rawExistingPages,
			create: createResult,
			updates: updateResults,
		};

		printOutput(
			(cmd.optsWithGlobals().raw ? rawPayload : payload) as Record<string, unknown>,
			cmd.optsWithGlobals(),
		);
	});
}

export function registerBeadsCommands(program: Command): void {
	const beads = program.command("beads").description("Beads-oriented Notion sync workflows");

	beads
		.command("init")
		.description("Create a dedicated Beads database and default table view")
		.requiredOption("--parent <id>", "Parent page ID")
		.option("--title <title>", "Database title", BEADS_DEFAULT_DATABASE_TITLE)
		.addHelpText(
			"after",
			`
Examples:
  ncli beads init --parent <page-id>
  ncli beads init --parent <page-id> --title "My Beads Issues"

The command creates:
  - a dedicated Beads database
  - a default table view
  - a saved beads config for later status/pull/push commands`,
		)
		.action(async (opts: BeadsInitOptions, cmd: Command) => {
			await runBeadsInit(opts, cmd);
		});

	const config = beads.command("config").description("Manage saved Beads database configuration");

	config
		.command("set")
		.description("Save the default database and view used by beads commands")
		.requiredOption("--database-id <id>", "Notion database ID")
		.requiredOption("--view-url <url>", "Notion view URL")
		.action(async (opts: BeadsConfigSetOptions, cmd: Command) => {
			await runBeadsConfigSet(opts, cmd);
		});

	config
		.command("show")
		.description("Show saved Beads configuration")
		.action((_opts: unknown, cmd: Command) => {
			runBeadsConfigShow(cmd);
		});

	config
		.command("clear")
		.description("Clear saved Beads configuration")
		.action((_opts: unknown, cmd: Command) => {
			runBeadsConfigClear(cmd);
		});

	beads
		.command("status")
		.description("Check database connectivity and beads schema readiness")
		.option("--database-id <id>", "Notion database ID (defaults to saved config)")
		.option("--view-url <url>", "Saved view URL to verify against fetched database metadata")
		.addHelpText(
			"after",
			`
Examples:
  ncli beads status
  ncli beads status --database-id <db-id>
  ncli beads status --database-id <db-id> --view-url "view://<view-id>"

The dedicated beads database schema expects:
  Name, Beads ID, Status, Priority, Type, Description
Optional:
  Assignee, Labels`,
		)
		.action(async (opts: BeadsStatusOptions, cmd: Command) => {
			await runBeadsStatus(opts, cmd);
		});

	beads
		.command("pull")
		.description("Pull locally managed Notion beads pages into beads-friendly JSON")
		.addHelpText(
			"after",
			`
Example:
  ncli beads pull
  ncli beads pull --json

Output:
  { "issues": [{ "id": "bd-123", "title": "...", ... }] }

Notes:
  Pull reads the saved beads config and local manifest of managed page IDs.`,
		)
		.action(async (opts: BeadsPullOptions, cmd: Command) => {
			await runBeadsPull(opts, cmd);
		});

	beads
		.command("push")
		.description("Create or update Notion pages from beads issue JSON")
		.option("--database-id <id>", "Notion database ID (defaults to saved config)")
		.option("--view-url <url>", "View URL to save/verify when overriding saved config")
		.option("--input <path|->", 'Issue JSON file path, or "-" to read stdin')
		.option("--data <json>", "Issue JSON string (overrides --input)")
		.option("--dry-run", "Plan create/update changes without mutating Notion")
		.addHelpText(
			"after",
			`
Examples:
  ncli beads push --dry-run --input issues.json
  ncli beads push --database-id <db-id> --view-url "view://<view-id>" --input issues.json
  echo '{"issues":[{"id":"bd-1","title":"Fix login"}]}' | ncli beads push --dry-run --input -

Input JSON:
  { "issues": [{ "id": "bd-123", "title": "Title", "status": "open" }] }

Matching uses the "Beads ID" property against the saved local manifest.
When overriding saved config, pass both --database-id and --view-url.`,
		)
		.action(async (opts: BeadsPushOptions, cmd: Command) => {
			await runBeadsPush(opts, cmd);
		});
}
