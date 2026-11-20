// One-line widget above the omp editor with the usage of every logged-in subscription account
// (Claude, Codex, Copilot, Cursor, Gemini, ... whatever omp reports usage for).
// omp's built-in `usage` status-line segment only shows the active model's account; this shows all of
// them, with the account the current session routes to first and undimmed.
//
// Reads omp's AuthStorage `usage` / `oauth` namespaces, which are not part of the public extension
// typings. When a build lacks them the widget turns itself off with one warning instead of throwing on
// every refresh.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const WIDGET_KEY = "account-usage";
// Re-renders from omp's usage cache (upstream is polled at most every ~5 min), so a /session pin shows within 15s.
const REFRESH_MS = 15_000;

/** Short labels for known omp provider ids, in display order. Other providers show their id, after these. */
const PROVIDER_LABELS: Record<string, string> = {
	anthropic: "Claude",
	"openai-codex": "Codex",
	"github-copilot": "Copilot",
	cursor: "Cursor",
	"google-gemini-cli": "Gemini",
	"google-antigravity": "Antigravity",
	"xai-oauth": "Grok",
	"kimi-code": "Kimi",
	zai: "Z.ai",
	"minimax-code": "MiniMax",
	"alibaba-token-plan": "Alibaba",
	"opencode-go": "OpenCode Go",
	"factory-droid": "Droid",
	devin: "Devin",
	synthetic: "Synthetic",
	umans: "Umans",
	ollama: "Ollama",
	"ollama-cloud": "Ollama Cloud",
};
const KNOWN_ORDER = Object.keys(PROVIDER_LABELS);

export type Color = "accent" | "success" | "warning" | "error" | "muted" | "dim";

export interface Identity {
	accountId?: string;
	email?: string;
	projectId?: string;
	orgId?: string;
}

export interface Limit {
	scope?: { windowId?: string; tier?: string; modelId?: string; accountId?: string; projectId?: string };
	window?: { id?: string; durationMs?: number; resetsAt?: number };
	amount?: {
		used?: number;
		limit?: number;
		usedFraction?: number;
		remainingFraction?: number;
		unit?: string;
	};
}

export interface Report {
	provider: string;
	limits: Limit[];
	metadata?: Record<string, unknown>;
}

interface AuthStorageNamespaces {
	usage: {
		reports(options?: { baseUrlResolver?: (provider: string) => string | undefined }): Promise<Report[] | null>;
	};
	oauth: { identity(provider: string, sessionId?: string): Identity | undefined };
}

export interface WindowUsage {
	percent: number;
	reset: string;
}

export interface AccountRow {
	provider: string;
	active: boolean;
	name: string;
	usage?: WindowUsage;
}

export interface WidgetTheme {
	fg(color: Color, text: string): string;
}

/** Plain text plus its themed rendering. */
interface Line {
	plain: string;
	styled: string;
}

/** Terminal cells, not UTF-16 units: CJK names take two cells per character. */
const cells = (text: string) => Bun.stringWidth(text);

/** Known providers in {@link PROVIDER_LABELS} order, then the rest by id. */
function compareProviders(a: string, b: string): number {
	const rank = (id: string) => {
		const i = KNOWN_ORDER.indexOf(id);
		return i === -1 ? KNOWN_ORDER.length : i;
	};
	return rank(a) - rank(b) || a.localeCompare(b);
}

function norm(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

// Adapted from omp's `limitMatchesActiveAccount` (slash-commands/helpers/active-oauth-account.ts,
// omp 18.18.1); see NOTICE. The org is a gate, and the email decides whenever both sides have one:
// Codex Team seats share an account id, so only the email tells them apart.
export function isActive(report: Report, identity: Identity | undefined): boolean {
	if (!identity) return false;
	const meta = report.metadata ?? {};
	const accountId = norm(identity.accountId);
	const email = norm(identity.email);
	const projectId = norm(identity.projectId);
	const orgId = norm(identity.orgId);
	const reportOrgId = norm(meta.orgId);
	if (orgId || reportOrgId) {
		if (orgId !== reportOrgId) return false;
		if (!accountId && !email && !projectId) return true;
	}
	const reportEmail = norm(meta.email);
	if (email && reportEmail) return email === reportEmail;
	if (accountId) {
		if ((norm(meta.accountId) ?? norm(meta.account_id)) === accountId) return true;
		if (report.limits.some(limit => norm(limit.scope?.accountId) === accountId)) return true;
	}
	if (projectId) {
		if (norm(meta.projectId) === projectId) return true;
		if (report.limits.some(limit => norm(limit.scope?.projectId) === projectId)) return true;
	}
	return false;
}

// Adapted from omp's `resolveUsedFraction` (pi-ai usage.ts); see NOTICE. Providers fill different
// amount fields, so the fraction comes from whichever is present.
export function usedFraction(limit: Limit): number | undefined {
	const amount = limit.amount;
	if (!amount) return undefined;
	let fraction: number | undefined;
	if (amount.usedFraction !== undefined) fraction = amount.usedFraction;
	else if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
		fraction = amount.used / amount.limit;
	} else if (amount.unit === "percent" && amount.used !== undefined) fraction = amount.used / 100;
	else if (amount.remainingFraction !== undefined) fraction = Math.max(0, 1 - amount.remainingFraction);
	return typeof fraction === "number" && Number.isFinite(fraction) ? fraction : undefined;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const NAMED_WINDOWS: Record<string, number> = {
	daily: DAY_MS,
	weekly: WEEK_MS,
	monthly: MONTH_MS,
	"billing-period": MONTH_MS,
};
const UNIT_MS: Record<string, number> = { m: MINUTE_MS, h: HOUR_MS, d: DAY_MS, w: WEEK_MS, mo: MONTH_MS };

/** Window length in ms, from `durationMs` or ids such as `5h`, `7d`, `1w`, `1mo`, `weekly`. */
export function windowDuration(limit: Limit): number | undefined {
	const durationMs = limit.window?.durationMs;
	if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0) return durationMs;
	const id = norm(limit.window?.id) ?? norm(limit.scope?.windowId);
	if (!id) return undefined;
	if (Object.hasOwn(NAMED_WINDOWS, id)) return NAMED_WINDOWS[id];
	const match = /^(\d+)\s*(mo|m|h|d|w)$/.exec(id);
	return match ? Number(match[1]) * UNIT_MS[match[2]] : undefined;
}

/** The weekly window first, then longer windows, then shorter ones, then windows of unknown length. */
function windowRank(duration: number | undefined): number {
	if (duration === undefined) return -1;
	return Math.abs(duration - WEEK_MS) < DAY_MS ? Number.POSITIVE_INFINITY : duration;
}

/**
 * The one limit the widget shows for an account: the weekly window when there is one, else the
 * longest; the most used limit among equals. Per-tier and per-model meters (Claude Opus, Codex Spark,
 * Copilot models) count only when the account has nothing else; the rest stay in /usage.
 */
export function pickLimit(limits: Limit[]): { limit: Limit; fraction: number } | undefined {
	const measured = limits.flatMap(limit => {
		const fraction = usedFraction(limit);
		return fraction === undefined ? [] : [{ limit, fraction }];
	});
	const general = measured.filter(({ limit }) => !limit.scope?.tier && !limit.scope?.modelId);
	let best: { limit: Limit; fraction: number; rank: number } | undefined;
	for (const candidate of general.length > 0 ? general : measured) {
		const rank = windowRank(windowDuration(candidate.limit));
		if (!best || rank > best.rank || (rank === best.rank && candidate.fraction > best.fraction)) {
			best = { ...candidate, rank };
		}
	}
	return best && { limit: best.limit, fraction: best.fraction };
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Short names for one provider's reports: the part of the email before `@`, the whole email when two
 * accounts share that part, and a short org or account id after it when the emails match too.
 * An account with neither email nor id is unnamed when it is the only one, else numbered.
 */
export function accountNames(reports: Report[]): string[] {
	const emails = reports.map(report => text(report.metadata?.email));
	const ids = reports.map(report => text(report.metadata?.accountId) ?? text(report.metadata?.account_id));
	const local = emails.map(
		(email, i) => email?.split("@")[0] ?? ids[i]?.slice(0, 8) ?? (reports.length > 1 ? `#${i + 1}` : ""),
	);
	const full = local.map((name, i) => (repeated(local, i) ? (emails[i] ?? name) : name));
	return full.map((name, i) => {
		if (!repeated(full, i)) return name;
		const qualifier = text(reports[i].metadata?.orgId) ?? ids[i];
		return qualifier ? `${name} (${qualifier.slice(0, 6)})` : name;
	});
}

function repeated(names: string[], i: number): boolean {
	return names.indexOf(names[i]) !== names.lastIndexOf(names[i]);
}

function formatReset(resetsAt: number | undefined, now: number): string {
	if (resetsAt === undefined || !Number.isFinite(resetsAt)) return "";
	const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
	return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

function toRow(report: Report, name: string, identity: Identity | undefined, now: number): AccountRow {
	const picked = pickLimit(report.limits);
	const usage = picked && {
		percent: picked.fraction * 100,
		reset: formatReset(picked.limit.window?.resetsAt, now),
	};
	const provider = PROVIDER_LABELS[report.provider] ?? report.provider;
	return { provider, active: isActive(report, identity), name, usage };
}

// Widest gauge first; the first width whose line fits the terminal wins.
const GAUGE_WIDTHS = [6, 3, 0];

/**
 * One line for every provider when it fits, else one line per provider. Rows arrive grouped by
 * provider in display order. The active account leads its provider in the normal text color; the
 * other accounts of that provider are dimmed (a provider with no known active account stays undimmed).
 * Each account carries a thin gauge whose filled part takes the usage color.
 */
export function renderRows(rows: AccountRow[], width: number, theme: WidgetTheme): string[] {
	const byProvider = new Map<string, AccountRow[]>();
	for (const row of rows) {
		const group = byProvider.get(row.provider);
		if (group) group.push(row);
		else byProvider.set(row.provider, [row]);
	}
	const groups = [...byProvider.values()].map(group =>
		group.toSorted((a, b) => Number(b.active) - Number(a.active)),
	);
	const labelWidth = Math.max(...groups.map(group => cells(group[0].provider)));

	const renderLine = (lineGroups: AccountRow[][], gaugeWidth: number, padLabel: boolean): Line => {
		const line: Line = { plain: "", styled: "" };
		const push = (text: string, color?: Color) => {
			line.plain += text;
			line.styled += color ? theme.fg(color, text) : text;
		};
		lineGroups.forEach((group, groupIndex) => {
			if (groupIndex > 0) push(" │", "dim");
			const label = group[0].provider;
			push(` ${padLabel ? label + " ".repeat(labelWidth - cells(label)) : label}`, "accent");
			const anyActive = group.some(row => row.active);
			group.forEach((row, rowIndex) => {
				if (rowIndex > 0) push(" ·", "dim");
				if (row.name) push(` ${row.name}`, row.active || !anyActive ? undefined : "dim");
				const usage = row.usage;
				if (!usage) return;
				const color: Color = usage.percent >= 80 ? "error" : usage.percent >= 50 ? "warning" : "success";
				if (gaugeWidth) {
					const filled = Math.min(gaugeWidth, Math.ceil((usage.percent / 100) * gaugeWidth));
					push(" ");
					push("━".repeat(filled), color);
					push("━".repeat(gaugeWidth - filled), "dim");
				}
				push(` ${Math.round(usage.percent)}%`, color);
				if (usage.reset) push(` ${usage.reset}`, "muted");
			});
		});
		return line;
	};

	for (const lineGroups of [[groups], groups.map(group => [group])]) {
		const padLabel = lineGroups.length > 1;
		for (const gaugeWidth of GAUGE_WIDTHS) {
			const lines = lineGroups.map(group => renderLine(group, gaugeWidth, padLabel));
			if (lines.every(line => cells(line.plain) <= width)) return lines.map(line => line.styled);
		}
	}
	// Still too wide: plain text cut to the terminal with a visible "…", since styled text cannot be
	// cut by column.
	return groups.map(group => truncate(renderLine([group], 0, true).plain, width));
}

function truncate(line: string, width: number): string {
	if (cells(line) <= width) return line;
	let out = "";
	for (const char of line) {
		if (cells(out + char) > width - 1) break;
		out += char;
	}
	return width > 0 ? `${out}…` : "";
}

/** Rows for every account with a measurable limit, grouped by provider in display order. */
export function buildRows(
	reports: Report[],
	identityFor: (provider: string) => Identity | undefined,
	now: number,
): AccountRow[] {
	const providers = [...new Set(reports.map(report => report.provider))].sort(compareProviders);
	return providers.flatMap(provider => {
		const mine = reports.filter(report => report.provider === provider);
		const names = accountNames(mine);
		const identity = identityFor(provider);
		return mine
			.map((report, i) => toRow(report, names[i], identity, now))
			.filter(row => row.usage !== undefined);
	});
}

/** The internal AuthStorage namespaces, or undefined on an omp build that lacks them. */
function usageApi(authStorage: unknown): AuthStorageNamespaces | undefined {
	const api = authStorage as Partial<AuthStorageNamespaces> | undefined;
	return typeof api?.usage?.reports === "function" && typeof api.oauth?.identity === "function"
		? (api as AuthStorageNamespaces)
		: undefined;
}

export default function accountUsage(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let timer: Timer | undefined;
	let inFlight = false;
	let unsupported = false;

	async function refresh(): Promise<void> {
		const current = ctx;
		if (!current?.hasUI || inFlight || unsupported) return;
		const authStorage = usageApi(current.modelRegistry?.authStorage);
		if (!authStorage) {
			unsupported = true;
			if (timer !== undefined) current.clearTimer(timer);
			timer = undefined;
			current.ui.setWidget(WIDGET_KEY, undefined);
			current.ui.notify(
				"account-usage: this omp build has no AuthStorage usage API; widget turned off",
				"warning",
			);
			return;
		}
		inFlight = true;
		try {
			const reports =
				(await authStorage.usage.reports({
					baseUrlResolver: provider => current.modelRegistry.getProviderBaseUrl?.(provider),
				})) ?? [];
			const sessionId = current.sessionManager.getSessionId();
			const rows = buildRows(reports, provider => authStorage.oauth.identity(provider, sessionId), Date.now());
			if (rows.length === 0) {
				current.ui.setWidget(WIDGET_KEY, undefined);
				return;
			}
			current.ui.setWidget(
				WIDGET_KEY,
				(_tui, theme) => {
					let cached: { width: number; lines: string[] } | undefined;
					return {
						render(width: number): readonly string[] {
							if (cached?.width !== width) cached = { width, lines: renderRows(rows, width, theme) };
							return cached.lines;
						},
						invalidate() {
							cached = undefined;
						},
					};
				},
				// aboveEditor keeps omp's input box the last block on screen, where terminal tools look for it.
				{ placement: "aboveEditor" },
			);
		} finally {
			inFlight = false;
		}
	}

	function attach(next: ExtensionContext): void {
		ctx = next;
		if (unsupported) return;
		if (timer === undefined) timer = next.setInterval(refresh, REFRESH_MS);
		// Managed timer: failures are logged by the host instead of swallowed or crashing the session.
		next.setTimeout(refresh, 0);
	}

	pi.on("session_start", (_event, next) => attach(next));
	pi.on("session_switch", (_event, next) => attach(next));
	pi.on("agent_end", (_event, next) => attach(next));
	pi.on("auto_retry_end", (_event, next) => attach(next));
	pi.on("session_shutdown", () => {
		ctx = undefined;
		timer = undefined;
	});
}
