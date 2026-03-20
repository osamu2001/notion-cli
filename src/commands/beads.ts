import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Command } from "commander";
import { withConnection } from "../mcp/with-connection.js";
import { printOutput } from "../output/json.js";
import type { BeadsIssue, BeadsIssueComment, BeadsPushIssue } from "../util/beads.js";
import {
	assessBeadsSchema,
	BEADS_DEFAULT_DATABASE_TITLE,
	BEADS_DEFAULT_VIEW_NAME,
	BEADS_SCHEMA_VERSION,
	buildBeadsDatabaseSchema,
	buildBeadsProperties,
	buildBeadsUpdateProperties,
	detectBeadsPropertiesFromFetchText,
	extractBeadsDatabaseInfoFromText,
	extractPageIdFromUrl,
	extractResultJson,
	extractResultText,
	extractSelfUserFromPayload,
	extractViewUrlFromText,
	findDuplicateBeadsIds,
	issuesEqualForPropertySync,
	issuesEqualForSync,
	normalizeBeadsCommentListPayload,
	normalizeBeadsPageFetchPayload,
	parseBeadsPushInput,
} from "../util/beads.js";
import { BeadsConfigStore, type StoredBeadsConfig } from "../util/beads-config.js";
import {
	BeadsStateStore,
	listStoredBeadsStateEntries,
	normalizeStoredBeadsState,
	type StoredBeadsState,
} from "../util/beads-state.js";
import { CliError } from "../util/errors.js";
import { readStdin } from "../util/stdin.js";
import { buildCommentCreateCall, buildCommentListCall } from "./comment.js";

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
	archiveMissing?: boolean;
}

interface BeadsInitOptions {
	parent?: string;
	title?: string;
}

interface BeadsConfigSetOptions {
	databaseId?: string;
	viewUrl?: string;
}

interface BeadsStateExportOptions {
	output?: string;
}

interface BeadsStateImportOptions {
	input?: string;
}

type BeadsStateDoctorStatus = "ok" | "missing_page" | "id_drift" | "property_mismatch";

export interface BeadsStateDoctorEntry {
	beads_id: string;
	page_id: string;
	status: BeadsStateDoctorStatus;
	message: string | null;
	actual_beads_id?: string | null;
	notion_page_id?: string | null;
	title?: string | null;
}

type ArchiveSupportMode = "update_page_command" | "unsupported";

export interface BeadsArchiveSupport {
	supported: boolean;
	mode: ArchiveSupportMode;
	reason: string | null;
	supported_commands: string[];
}

interface ToolCall {
	tool: string;
	args: Record<string, unknown>;
}

interface ToolCaller {
	callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

interface RawExistingBeadsPage {
	beads_id: string;
	page_id: string;
	fetch: Record<string, unknown>;
	source: "state" | "search";
	search?: Record<string, unknown>;
}

interface ExistingBeadsPagesForPush {
	existingById: Map<string, BeadsIssue>;
	rawExistingPages: RawExistingBeadsPage[];
	discoveredPageIds: Record<string, string>;
}

interface PlannedBeadsCommentCreate {
	id: string;
	title: string;
	pageId: string | null;
	comments: BeadsIssueComment[];
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

function stateHint(command: string): string {
	return `Run "ncli beads push ...", "ncli beads config set --database-id <id> --view-url <url>", or "ncli beads state import --input <path|->" before "ncli beads state ${command}"`;
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
			pages: issues.map((issue) => ({
				properties: buildBeadsProperties(issue),
				...(issue.body ? { content: issue.body } : {}),
			})),
		},
	};
}

export function buildBeadsSearchCall(query: string, databaseUrl: string | null): ToolCall {
	return {
		tool: "notion-search",
		args: {
			query,
			page_size: 25,
			query_type: "internal",
			...(databaseUrl ? { data_source_url: databaseUrl } : {}),
		},
	};
}

export function buildBeadsUpdateCall(pageId: string, issue: BeadsPushIssue): ToolCall {
	return {
		tool: "notion-update-page",
		args: {
			page_id: pageId,
			command: "update_properties",
			properties: buildBeadsUpdateProperties(issue),
		},
	};
}

export function buildBeadsBodyUpdateCall(pageId: string, body: string | null): ToolCall {
	return {
		tool: "notion-update-page",
		args: {
			page_id: pageId,
			command: "replace_content",
			new_str: body ?? "",
		},
	};
}

function commentFingerprint(comment: Pick<BeadsIssueComment, "discussion_id" | "body">): string {
	return `${comment.discussion_id ?? ""}\n${comment.body}`;
}

function planBeadsCommentCreates(
	existingComments: BeadsIssueComment[],
	nextComments: BeadsIssueComment[],
): BeadsIssueComment[] {
	const existingFingerprints = new Set(
		existingComments.map((comment) => commentFingerprint(comment)),
	);
	const plannedFingerprints = new Set<string>();
	return nextComments.filter((comment) => {
		if (comment.comment_id) {
			return false;
		}
		const fingerprint = commentFingerprint(comment);
		if (existingFingerprints.has(fingerprint) || plannedFingerprints.has(fingerprint)) {
			return false;
		}
		plannedFingerprints.add(fingerprint);
		return true;
	});
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

export function storedConfigForResolvedTarget(
	target: Pick<ResolvedBeadsTarget, "databaseId" | "config" | "source">,
): StoredBeadsConfig | undefined {
	if (!target.config) {
		return undefined;
	}
	if (target.source === "config") {
		return target.config;
	}
	return target.config.database_id === target.databaseId ? target.config : undefined;
}

export function statusConfigMetadataForTarget(
	target: Pick<ResolvedBeadsTarget, "databaseId" | "config" | "source">,
): {
	configured: boolean;
	saved_config_present: boolean;
	schema_version: string;
	effective_config: StoredBeadsConfig | undefined;
} {
	const effectiveConfig = storedConfigForResolvedTarget(target);
	return {
		configured: !!effectiveConfig,
		saved_config_present: !!target.config,
		schema_version: effectiveConfig?.schema_version ?? BEADS_SCHEMA_VERSION,
		effective_config: effectiveConfig,
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

export function buildInitialBeadsState(databaseId: string): StoredBeadsState {
	return {
		database_id: databaseId,
		page_ids: {},
	};
}

export function saveBeadsConfigAndResetState(
	configStore: Pick<BeadsConfigStore, "save">,
	stateStore: Pick<BeadsStateStore, "save">,
	savedConfig: StoredBeadsConfig,
): StoredBeadsState {
	configStore.save(savedConfig);
	const initialState = buildInitialBeadsState(savedConfig.database_id);
	stateStore.save(initialState);
	return initialState;
}

function readRequiredStoredState(command: string): {
	store: BeadsStateStore;
	state: StoredBeadsState;
} {
	const store = new BeadsStateStore();
	const state = store.read();
	if (!state) {
		throw new CliError(
			"Missing beads state",
			`beads state ${command} needs a saved beads state file`,
			stateHint(command),
		);
	}
	return { store, state };
}

function parseStateJson(text: string, source: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new CliError(
			"Invalid beads state JSON",
			`${source} could not be parsed as JSON`,
			'Check syntax or export a fresh state with "ncli beads state export --output -"',
		);
	}
}

function summarizeBeadsStateDoctorCount(
	entries: BeadsStateDoctorEntry[],
	status: BeadsStateDoctorStatus,
): number {
	return entries.filter((entry) => entry.status === status).length;
}

export function summarizeBeadsStateDoctorEntries(entries: BeadsStateDoctorEntry[]) {
	const totalCount = entries.length;
	const okCount = summarizeBeadsStateDoctorCount(entries, "ok");
	return {
		ok: totalCount === okCount,
		total_count: totalCount,
		ok_count: okCount,
		missing_page_count: summarizeBeadsStateDoctorCount(entries, "missing_page"),
		id_drift_count: summarizeBeadsStateDoctorCount(entries, "id_drift"),
		property_mismatch_count: summarizeBeadsStateDoctorCount(entries, "property_mismatch"),
	};
}

export function buildBeadsStateDoctorEntry(
	expectedBeadsId: string,
	pageId: string,
	issue: BeadsIssue,
): BeadsStateDoctorEntry {
	if (issue.id !== expectedBeadsId) {
		return {
			beads_id: expectedBeadsId,
			page_id: pageId,
			status: "id_drift",
			message: `Expected Beads ID ${expectedBeadsId}, but Notion page reports ${issue.id}`,
			actual_beads_id: issue.id,
			notion_page_id: issue.notion_page_id,
			title: issue.title,
		};
	}
	if (issue.notion_page_id && issue.notion_page_id !== pageId) {
		return {
			beads_id: expectedBeadsId,
			page_id: pageId,
			status: "property_mismatch",
			message: `Fetched page ${pageId} normalized to page id ${issue.notion_page_id}`,
			actual_beads_id: issue.id,
			notion_page_id: issue.notion_page_id,
			title: issue.title,
		};
	}
	return {
		beads_id: expectedBeadsId,
		page_id: pageId,
		status: "ok",
		message: null,
		actual_beads_id: issue.id,
		notion_page_id: issue.notion_page_id,
		title: issue.title,
	};
}

function doctorErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return String(error);
}

function extractToolCommandEnumOptions(tool: Tool | undefined): string[] {
	if (!tool || typeof tool.inputSchema !== "object" || tool.inputSchema === null) {
		return [];
	}
	const schema = tool.inputSchema as Record<string, unknown>;
	const properties =
		typeof schema.properties === "object" && schema.properties !== null
			? (schema.properties as Record<string, unknown>)
			: null;
	const command =
		properties &&
		typeof properties.command === "object" &&
		properties.command !== null &&
		!Array.isArray(properties.command)
			? (properties.command as Record<string, unknown>)
			: null;
	const values = Array.isArray(command?.enum) ? command.enum : [];
	return values.filter((value): value is string => typeof value === "string");
}

export function detectBeadsArchiveSupport(tools: Tool[]): BeadsArchiveSupport {
	const updatePageTool = tools.find((tool) => tool.name === "notion-update-page");
	const supportedCommands = extractToolCommandEnumOptions(updatePageTool);
	if (supportedCommands.includes("archive")) {
		return {
			supported: true,
			mode: "update_page_command",
			reason: null,
			supported_commands: supportedCommands,
		};
	}
	const reason =
		supportedCommands.length > 0
			? `The current live Notion MCP only exposes notion-update-page commands: ${supportedCommands.join(", ")}`
			: "The current live Notion MCP does not expose archive support on notion-update-page";
	return {
		supported: false,
		mode: "unsupported",
		reason,
		supported_commands: supportedCommands,
	};
}

function buildBeadsArchiveCall(pageId: string, archiveSupport: BeadsArchiveSupport): ToolCall {
	if (archiveSupport.supported && archiveSupport.mode === "update_page_command") {
		return {
			tool: "notion-update-page",
			args: {
				page_id: pageId,
				command: "archive",
			},
		};
	}
	throw new CliError(
		"Archive is unavailable on the current live Notion MCP",
		archiveSupport.reason ?? "The connected Notion MCP does not support archiving pages",
		'Use "ncli beads push --archive-missing --dry-run" to inspect candidates, then archive or remove them manually in Notion for now',
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractSearchResultPageIds(payload: Record<string, unknown>): string[] {
	const results = Array.isArray(payload.results) ? payload.results : [];
	const pageIds: string[] = [];
	const seen = new Set<string>();

	for (const result of results) {
		if (!isRecord(result)) {
			continue;
		}
		const type = typeof result.type === "string" ? result.type : null;
		if (type && type !== "page") {
			continue;
		}
		const directId =
			typeof result.id === "string"
				? result.id
				: typeof result.page_id === "string"
					? result.page_id
					: null;
		const urlId =
			typeof result.url === "string"
				? extractPageIdFromUrl(result.url)
				: typeof result.page_url === "string"
					? extractPageIdFromUrl(result.page_url)
					: null;
		const pageId = directId ?? urlId;
		if (!pageId || seen.has(pageId)) {
			continue;
		}
		seen.add(pageId);
		pageIds.push(pageId);
	}

	return pageIds;
}

async function fetchExistingBeadsIssueForPush(
	conn: ToolCaller,
	pageId: string,
	context: string,
): Promise<{ issue: BeadsIssue; fetch: Record<string, unknown> }> {
	const pageFetchCall = { tool: "notion-fetch", args: { id: pageId } };
	const pageFetchResult = (await conn.callTool(pageFetchCall.tool, pageFetchCall.args)) as Record<
		string,
		unknown
	>;
	const pagePayload = extractResultJson(pageFetchResult, context);
	const existingIssue = normalizeBeadsPageFetchPayload(pagePayload);
	if (!existingIssue.notion_page_id) {
		throw new CliError(
			"Invalid target row",
			`${context} does not expose a page id after fetch`,
			'Retry with "ncli fetch <page-id> --raw" to inspect the raw payload',
		);
	}
	return {
		issue: existingIssue,
		fetch: pageFetchResult,
	};
}

export async function collectExistingBeadsPagesForPush(
	conn: ToolCaller,
	state: StoredBeadsState,
	inputIssues: BeadsPushIssue[],
	databaseUrl: string | null,
): Promise<ExistingBeadsPagesForPush> {
	const existingById = new Map<string, BeadsIssue>();
	const rawExistingPages: RawExistingBeadsPage[] = [];
	const discoveredPageIds: Record<string, string> = {};

	for (const [expectedBeadsId, pageId] of Object.entries(state.page_ids)) {
		const existingPage = await fetchExistingBeadsIssueForPush(
			conn,
			pageId,
			`beads push preflight page ${expectedBeadsId}`,
		);
		if (existingPage.issue.id !== expectedBeadsId) {
			throw new CliError(
				"Managed page ID drift detected",
				`Saved mapping expected Beads ID ${expectedBeadsId}, but Notion page ${pageId} currently reports ${existingPage.issue.id}`,
				"Fix the page property in Notion or clear the saved beads state before retrying",
			);
		}
		existingById.set(existingPage.issue.id, existingPage.issue);
		rawExistingPages.push({
			beads_id: expectedBeadsId,
			page_id: pageId,
			fetch: existingPage.fetch,
			source: "state",
		});
	}

	for (const inputIssue of inputIssues) {
		if (existingById.has(inputIssue.id)) {
			continue;
		}
		const searchCall = buildBeadsSearchCall(inputIssue.id, databaseUrl);
		const searchResult = (await conn.callTool(searchCall.tool, searchCall.args)) as Record<
			string,
			unknown
		>;
		const searchPayload = extractResultJson(searchResult, `beads push search ${inputIssue.id}`);
		const searchMatches: Array<{ issue: BeadsIssue; fetch: Record<string, unknown> }> = [];
		for (const pageId of extractSearchResultPageIds(searchPayload)) {
			const match = await fetchExistingBeadsIssueForPush(
				conn,
				pageId,
				`beads push live match ${inputIssue.id}`,
			);
			if (match.issue.id !== inputIssue.id) {
				continue;
			}
			searchMatches.push(match);
		}
		if (searchMatches.length > 1) {
			throw new CliError(
				"Duplicate live Beads ID rows detected",
				`Found multiple Notion pages for Beads ID ${inputIssue.id}: ${searchMatches
					.map((match) => match.issue.notion_page_id)
					.join(", ")}`,
				"Merge or archive the duplicate rows in Notion, then rerun beads push",
			);
		}
		const liveMatch = searchMatches[0];
		if (!liveMatch) {
			continue;
		}
		existingById.set(inputIssue.id, liveMatch.issue);
		state.page_ids[inputIssue.id] = liveMatch.issue.notion_page_id ?? liveMatch.issue.external_ref;
		discoveredPageIds[inputIssue.id] =
			liveMatch.issue.notion_page_id ?? liveMatch.issue.external_ref;
		rawExistingPages.push({
			beads_id: inputIssue.id,
			page_id: liveMatch.issue.notion_page_id ?? liveMatch.issue.external_ref,
			fetch: liveMatch.fetch,
			source: "search",
			search: searchResult,
		});
	}

	return {
		existingById,
		rawExistingPages,
		discoveredPageIds,
	};
}

export async function createBeadsPagesForPush(
	conn: ToolCaller,
	stateStore: BeadsStateStore,
	state: StoredBeadsState,
	dataSourceId: string,
	toCreate: BeadsPushIssue[],
	toCreateComments: PlannedBeadsCommentCreate[] = [],
): Promise<Record<string, unknown> | null> {
	if (toCreate.length === 0) {
		return null;
	}

	const createCall = buildBeadsCreateCall(dataSourceId, toCreate);
	const createResult = (await conn.callTool(createCall.tool, createCall.args)) as Record<
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
			stateStore.save(state);
			const plannedComments = toCreateComments.find((entry) => entry.id === issue.id);
			if (plannedComments) {
				plannedComments.pageId = page.id;
			}
		}
	}
	return createResult;
}

async function collectBeadsStateDoctorData(
	conn: ToolCaller,
	state: StoredBeadsState,
): Promise<{
	entries: BeadsStateDoctorEntry[];
	rawEntries: Array<Record<string, unknown>>;
	issues: BeadsIssue[];
}> {
	const entries: BeadsStateDoctorEntry[] = [];
	const rawEntries: Array<Record<string, unknown>> = [];
	const issues: BeadsIssue[] = [];

	for (const entry of listStoredBeadsStateEntries(state)) {
		try {
			const fetchCall = { tool: "notion-fetch", args: { id: entry.page_id } };
			const result = (await conn.callTool(fetchCall.tool, fetchCall.args)) as Record<
				string,
				unknown
			>;
			try {
				const payload = extractResultJson(result, `beads state doctor page ${entry.id}`);
				const issue = normalizeBeadsPageFetchPayload(payload);
				const doctorEntry = buildBeadsStateDoctorEntry(entry.id, entry.page_id, issue);
				entries.push(doctorEntry);
				rawEntries.push({ ...doctorEntry, fetch: result });
				if (doctorEntry.status === "ok") {
					issues.push(issue);
				}
			} catch (error) {
				const message = doctorErrorMessage(error);
				const doctorEntry: BeadsStateDoctorEntry = {
					beads_id: entry.id,
					page_id: entry.page_id,
					status: "property_mismatch",
					message,
				};
				entries.push(doctorEntry);
				rawEntries.push({ ...doctorEntry, fetch: result });
			}
		} catch (error) {
			const message = doctorErrorMessage(error);
			const doctorEntry: BeadsStateDoctorEntry = {
				beads_id: entry.id,
				page_id: entry.page_id,
				status: "missing_page",
				message,
			};
			entries.push(doctorEntry);
			rawEntries.push({ ...doctorEntry, error: message });
		}
	}

	return { entries, rawEntries, issues };
}

function runBeadsStateShow(cmd: Command): void {
	const store = new BeadsStateStore();
	const state = store.read();
	printOutput(
		{
			configured: !!state,
			path: store.filePath(),
			state,
		},
		cmd.optsWithGlobals(),
	);
}

async function runBeadsStateExport(opts: BeadsStateExportOptions, cmd: Command): Promise<void> {
	const { state } = readRequiredStoredState("export");
	const output = requireOption(opts.output, "--output", "An export path or -", "state export");
	if (output === "-") {
		printOutput(state as unknown as Record<string, unknown>, cmd.optsWithGlobals());
		return;
	}
	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, JSON.stringify(state, null, 2), { mode: 0o600 });
	printOutput(
		{
			exported: true,
			path: output,
			state,
		},
		cmd.optsWithGlobals(),
	);
}

async function runBeadsStateImport(opts: BeadsStateImportOptions, cmd: Command): Promise<void> {
	const input = requireOption(opts.input, "--input", "An import path or -", "state import");
	const raw = input === "-" ? await readStdin() : await readFile(input, "utf8");
	const state = normalizeStoredBeadsState(
		parseStateJson(raw, "beads state import"),
		"beads state import",
	);
	const config = new BeadsConfigStore().read();
	if (config && config.database_id !== state.database_id) {
		throw new CliError(
			"Invalid beads state import",
			`Imported database_id ${state.database_id} does not match saved config database_id ${config.database_id}`,
			"Use a matching export, or update the saved config before importing state",
		);
	}
	const store = new BeadsStateStore();
	store.save(state);
	printOutput(
		{
			imported: true,
			path: store.filePath(),
			state,
		},
		cmd.optsWithGlobals(),
	);
}

async function runBeadsStateDoctor(cmd: Command): Promise<void> {
	const { store, state } = readRequiredStoredState("doctor");
	const config = new BeadsConfigStore().read();

	await withConnection(async (conn) => {
		const { entries, rawEntries } = await collectBeadsStateDoctorData(conn, state);

		const payload = {
			database_id: state.database_id,
			path: store.filePath(),
			config: {
				configured: !!config,
				database_id: config?.database_id ?? null,
				matches_state_database: config ? config.database_id === state.database_id : null,
			},
			summary: summarizeBeadsStateDoctorEntries(entries),
			entries,
		};

		const rawPayload = {
			state,
			config,
			entries: rawEntries,
		};

		printOutput(
			(cmd.optsWithGlobals().raw ? rawPayload : payload) as Record<string, unknown>,
			cmd.optsWithGlobals(),
		);
	});
}

async function runBeadsInit(opts: BeadsInitOptions, cmd: Command): Promise<void> {
	const parentId = requireOption(opts.parent, "--parent", "A parent page ID", "init");
	const title = opts.title ?? BEADS_DEFAULT_DATABASE_TITLE;
	const store = new BeadsConfigStore();
	const stateStore = new BeadsStateStore();

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
		saveBeadsConfigAndResetState(store, stateStore, savedConfig);

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
		const tools = await conn.listTools();
		const archiveSupport = detectBeadsArchiveSupport(tools);
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
		validateStoredConfigMatch(storedConfigForResolvedTarget(target), databaseInfo.data_source_id);

		const schema = assessBeadsSchema(detectBeadsPropertiesFromFetchText(fetchText), true);
		const viewUrl = target.viewUrl ?? null;
		const viewConfigured = !viewUrl || databaseInfo.views.some((view) => view.url === viewUrl);
		const state = stateStore.readForDatabase(target.databaseId);
		const { entries: doctorEntries, rawEntries: rawDoctorEntries } = state
			? await collectBeadsStateDoctorData(conn, state)
			: { entries: [], rawEntries: [] };
		const doctorSummary = summarizeBeadsStateDoctorEntries(doctorEntries);
		const configMetadata = statusConfigMetadataForTarget(target);

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
			schema_version: configMetadata.schema_version,
			configured: configMetadata.configured,
			saved_config_present: configMetadata.saved_config_present,
			config_source: target.source,
			schema,
			archive: archiveSupport,
			state: {
				path: stateStore.filePath(),
				present: !!state,
				managed_count: Object.keys(state?.page_ids ?? {}).length,
				view_configured: viewConfigured,
				doctor_summary: doctorSummary,
			},
		};

		const rawPayload = {
			auth: authResult,
			fetch: fetchResult,
			archive_support: archiveSupport,
			state_doctor: rawDoctorEntries,
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
		const tools = await conn.listTools();
		const archiveSupport = detectBeadsArchiveSupport(tools);
		const savedState = stateStore.readForDatabase(target.databaseId);
		const state = savedState ?? {
			database_id: target.databaseId,
			page_ids: {},
		};
		const {
			entries: doctorEntries,
			rawEntries,
			issues,
		} = await collectBeadsStateDoctorData(conn, state);
		const rawComments: Array<{
			beads_id: string;
			page_id: string;
			comments: Record<string, unknown>;
		}> = [];
		for (const issue of issues) {
			if (!issue.notion_page_id) {
				continue;
			}
			const commentCall = buildCommentListCall(issue.notion_page_id, {});
			const commentResult = (await conn.callTool(commentCall.tool, commentCall.args)) as Record<
				string,
				unknown
			>;
			const commentPayload = extractResultJson(commentResult, `beads pull comments ${issue.id}`);
			issue.comments = normalizeBeadsCommentListPayload(commentPayload);
			rawComments.push({
				beads_id: issue.id,
				page_id: issue.notion_page_id,
				comments: commentResult,
			});
		}
		issues.sort((a, b) => a.id.localeCompare(b.id));

		const payload = {
			issues,
			archive: archiveSupport,
			state: {
				path: stateStore.filePath(),
				present: !!savedState,
				managed_count: Object.keys(state.page_ids).length,
				doctor_summary: summarizeBeadsStateDoctorEntries(doctorEntries),
			},
		};
		const rawPayload = {
			state,
			archive_support: archiveSupport,
			pages: rawEntries,
			comments: rawComments,
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
		const tools = await conn.listTools();
		const archiveSupport = detectBeadsArchiveSupport(tools);
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
		validateStoredConfigMatch(storedConfigForResolvedTarget(target), databaseInfo.data_source_id);

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
		const existingPages = await collectExistingBeadsPagesForPush(
			conn,
			state,
			input.issues,
			databaseInfo.database_url,
		);
		const existingById = existingPages.existingById;
		const existingCommentsById = new Map<string, BeadsIssueComment[]>();
		const rawExistingPages = existingPages.rawExistingPages;
		const rawExistingComments: Array<{
			beads_id: string;
			page_id: string;
			comments: Record<string, unknown>;
		}> = [];
		for (const issue of input.issues) {
			const current = existingById.get(issue.id);
			if (!current?.notion_page_id || issue.comments.length === 0) {
				continue;
			}
			const commentCall = buildCommentListCall(current.notion_page_id, {});
			const commentResult = (await conn.callTool(commentCall.tool, commentCall.args)) as Record<
				string,
				unknown
			>;
			const commentPayload = extractResultJson(commentResult, `beads push comments ${issue.id}`);
			existingCommentsById.set(issue.id, normalizeBeadsCommentListPayload(commentPayload));
			rawExistingComments.push({
				beads_id: issue.id,
				page_id: current.notion_page_id,
				comments: commentResult,
			});
		}

		const toCreate: BeadsPushIssue[] = [];
		const toUpdate: Array<{ pageId: string; issue: BeadsPushIssue }> = [];
		const toUpdateBody: Array<{
			id: string;
			title: string;
			pageId: string;
			body: string | null;
		}> = [];
		const toCreateComments: PlannedBeadsCommentCreate[] = [];
		const inputIds = new Set(input.issues.map((issue) => issue.id));
		const toArchive = opts.archiveMissing
			? listStoredBeadsStateEntries(state)
					.filter((entry) => !inputIds.has(entry.id))
					.map((entry) => ({
						id: entry.id,
						title: existingById.get(entry.id)?.title ?? null,
						notion_page_id: entry.page_id,
						reason: "missing_from_input",
					}))
			: [];
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
				const pendingCreateComments = planBeadsCommentCreates([], issue.comments);
				if (pendingCreateComments.length > 0) {
					toCreateComments.push({
						id: issue.id,
						title: issue.title,
						pageId: null,
						comments: pendingCreateComments,
					});
				}
				continue;
			}
			const pendingComments = planBeadsCommentCreates(
				existingCommentsById.get(issue.id) ?? [],
				issue.comments,
			);
			if (issuesEqualForSync(current, issue) && pendingComments.length === 0) {
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
			if (!issuesEqualForPropertySync(current, issue)) {
				toUpdate.push({ pageId: currentPageId, issue });
			}
			if ((current.body ?? null) !== (issue.body ?? null)) {
				toUpdateBody.push({
					id: issue.id,
					title: issue.title,
					pageId: currentPageId,
					body: issue.body,
				});
			}
			if (pendingComments.length > 0) {
				toCreateComments.push({
					id: issue.id,
					title: issue.title,
					pageId: currentPageId,
					comments: pendingComments,
				});
			}
		}

		const payload = {
			dry_run: !!opts.dryRun,
			archive_requested: !!opts.archiveMissing,
			archive_supported: archiveSupport.supported,
			archive_reason: archiveSupport.reason,
			input_count: input.issues.length,
			created_count: toCreate.length,
			updated_count: toUpdate.length,
			body_updated_count: toUpdateBody.length,
			comments_created_count: toCreateComments.reduce(
				(total, entry) => total + entry.comments.length,
				0,
			),
			archived_count: toArchive.length,
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
			body_updated: toUpdateBody.map((update) => ({
				id: update.id,
				title: update.title,
				notion_page_id: update.pageId,
				body: update.body,
			})),
			comments_created: toCreateComments.flatMap((entry) =>
				entry.comments.map((comment) => ({
					id: entry.id,
					title: entry.title,
					notion_page_id: entry.pageId,
					discussion_id: comment.discussion_id,
					body: comment.body,
				})),
			),
			archived: toArchive,
			skipped,
		};

		let createResult: Record<string, unknown> | null = null;
		const updateResults: Array<{ id: string; result: Record<string, unknown> }> = [];
		const bodyUpdateResults: Array<{ id: string; result: Record<string, unknown> }> = [];
		const commentCreateResults: Array<{ id: string; result: Record<string, unknown> }> = [];
		const archiveResults: Array<{ id: string; result: Record<string, unknown> }> = [];

		if (!opts.dryRun) {
			if (toArchive.length > 0 && !archiveSupport.supported) {
				throw new CliError(
					"Archive-missing is unavailable on the current live Notion MCP",
					archiveSupport.reason ??
						"The connected Notion MCP does not support archiving managed pages",
					'Run "ncli beads push --archive-missing --dry-run ..." to inspect candidates, then archive or remove them manually in Notion for now',
				);
			}
			createResult = await createBeadsPagesForPush(
				conn,
				stateStore,
				state,
				databaseInfo.data_source_id,
				toCreate,
				toCreateComments,
			);
			for (const update of toUpdate) {
				const updateCall = buildBeadsUpdateCall(update.pageId, update.issue);
				const result = (await conn.callTool(updateCall.tool, updateCall.args)) as Record<
					string,
					unknown
				>;
				updateResults.push({ id: update.issue.id, result });
				state.page_ids[update.issue.id] = update.pageId;
			}
			for (const update of toUpdateBody) {
				const updateCall = buildBeadsBodyUpdateCall(update.pageId, update.body);
				const result = (await conn.callTool(updateCall.tool, updateCall.args)) as Record<
					string,
					unknown
				>;
				bodyUpdateResults.push({ id: update.id, result });
			}
			for (const commentPlan of toCreateComments) {
				if (!commentPlan.pageId) {
					throw new CliError(
						"Missing target page for comment sync",
						`Could not resolve a Notion page id for comments on issue ${commentPlan.id}`,
						"Retry the push after confirming the page create result",
					);
				}
				for (const comment of commentPlan.comments) {
					const createCommentCall = buildCommentCreateCall(commentPlan.pageId, {
						body: comment.body,
						discussion: comment.discussion_id ?? undefined,
					});
					const result = (await conn.callTool(
						createCommentCall.tool,
						createCommentCall.args,
					)) as Record<string, unknown>;
					commentCreateResults.push({ id: commentPlan.id, result });
				}
			}
			for (const archived of toArchive) {
				const archiveCall = buildBeadsArchiveCall(archived.notion_page_id, archiveSupport);
				const result = (await conn.callTool(archiveCall.tool, archiveCall.args)) as Record<
					string,
					unknown
				>;
				archiveResults.push({ id: archived.id, result });
				delete state.page_ids[archived.id];
			}
			stateStore.save(state);
		}

		const rawPayload = {
			plan: payload,
			fetch: fetchResult,
			archive_support: archiveSupport,
			existing_pages: rawExistingPages,
			existing_comments: rawExistingComments,
			create: createResult,
			updates: updateResults,
			body_updates: bodyUpdateResults,
			comment_creates: commentCreateResults,
			archives: archiveResults,
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
  - a saved beads config for later status/pull/push commands
  - an empty saved beads state for managed page ids`,
		)
		.action(async (opts: BeadsInitOptions, cmd: Command) => {
			await runBeadsInit(opts, cmd);
		});

	const config = beads.command("config").description("Manage saved Beads database configuration");
	const state = beads.command("state").description("Inspect and manage saved Beads page state");

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

	state
		.command("show")
		.description("Show saved Beads page state")
		.action((_opts: unknown, cmd: Command) => {
			runBeadsStateShow(cmd);
		});

	state
		.command("export")
		.description("Export saved Beads page state to a file or stdout")
		.requiredOption("--output <path|->", "Export file path, or - for stdout")
		.action(async (opts: BeadsStateExportOptions, cmd: Command) => {
			await runBeadsStateExport(opts, cmd);
		});

	state
		.command("import")
		.description("Import saved Beads page state from a file or stdin")
		.requiredOption("--input <path|->", "Import file path, or - for stdin")
		.action(async (opts: BeadsStateImportOptions, cmd: Command) => {
			await runBeadsStateImport(opts, cmd);
		});

	state
		.command("doctor")
		.description("Diagnose saved Beads page state against live Notion pages")
		.addHelpText(
			"after",
			`
Examples:
  ncli beads state doctor
  ncli beads state doctor --json

Doctor checks the saved beads-state.json mappings without mutating Notion.`,
		)
		.action(async (_opts: unknown, cmd: Command) => {
			await runBeadsStateDoctor(cmd);
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
  { "issues": [{ "id": "bd-123", "title": "...", "body": "...", "comments": [...] }] }

Notes:
  Pull reads the saved beads config and local manifest of managed page IDs.
  Each issue may include page body content in "body" and pulled page comments in "comments".`,
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
		.option(
			"--archive-missing",
			"Plan archiving for managed pages missing from input; unsupported live archive stops before mutation",
		)
		.addHelpText(
			"after",
			`
Examples:
  ncli beads push --dry-run --input issues.json
  ncli beads push --archive-missing --dry-run --input issues.json
  ncli beads push --database-id <db-id> --view-url "view://<view-id>" --input issues.json
  echo '{"issues":[{"id":"bd-1","title":"Fix login"}]}' | ncli beads push --dry-run --input -

Input JSON:
  { "issues": [{ "id": "bd-123", "title": "Title", "description": "short summary", "body": "full page body", "comments": [{ "body": "new comment" }], "status": "open" }] }

Matching uses the "Beads ID" property against the saved local manifest.
When overriding saved config, pass both --database-id and --view-url.
Current live Notion MCP servers may reject archive execution; in that case
--archive-missing still reports archived[] in --dry-run and fails fast before mutation.
Comment sync is create-only for now: comments with comment_id are treated as existing and skipped.`,
		)
		.action(async (opts: BeadsPushOptions, cmd: Command) => {
			await runBeadsPush(opts, cmd);
		});
}
