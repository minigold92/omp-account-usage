import { describe, expect, test } from "bun:test";
import { type AccountRow, accountNames, buildRows, type Limit, pickLimit, type Report, renderRows } from "./account-usage";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 0, 1);

const limit = (windowId: string, usedFraction: number, extra: Partial<Limit["scope"]> = {}): Limit => ({
	scope: { windowId, ...extra },
	window: { id: windowId, resetsAt: NOW + 2 * DAY },
	amount: { usedFraction },
});

const plain = { fg: (_color: string, text: string) => text };
const tagged = { fg: (color: string, text: string) => `<${color}>${text}</>` };

describe("pickLimit", () => {
	test("shows the weekly window over the 5-hour and monthly ones, ignoring per-tier meters", () => {
		const picked = pickLimit([
			limit("5h", 0.9),
			limit("7d", 0.3),
			limit("7d", 0.95, { tier: "opus" }),
			limit("1mo", 0.5),
		]);
		expect(picked?.fraction).toBe(0.3);
	});

	test("recognises weekly windows by name or duration, not only by the 7d id", () => {
		expect(pickLimit([limit("5h", 0.9), limit("1w", 0.2)])?.fraction).toBe(0.2);
		expect(pickLimit([limit("daily", 0.9), limit("weekly", 0.2)])?.fraction).toBe(0.2);
		const byDuration: Limit = { window: { id: "rolling", durationMs: 7 * DAY }, amount: { usedFraction: 0.1 } };
		expect(pickLimit([limit("5h", 0.9), byDuration])?.fraction).toBe(0.1);
	});

	test("falls back to the longest window, then to tiered meters when that is all there is", () => {
		expect(pickLimit([limit("5h", 0.9), limit("monthly", 0.4)])?.fraction).toBe(0.4);
		expect(pickLimit([limit("quota", 0.2, { tier: "Flash" }), limit("quota", 0.6, { tier: "Pro" })])?.fraction).toBe(
			0.6,
		);
	});

	test("derives the fraction from used/limit or remaining when no fraction is given", () => {
		expect(pickLimit([{ window: { id: "monthly" }, amount: { used: 30, limit: 300 } }])?.fraction).toBeCloseTo(0.1);
		expect(pickLimit([{ window: { id: "7d" }, amount: { remainingFraction: 0.25 } }])?.fraction).toBe(0.75);
		expect(pickLimit([{ window: { id: "7d" }, amount: {} }])).toBeUndefined();
	});
});

describe("accountNames", () => {
	test("uses the email local part, the full email when it collides, and leaves a lone unnamed account blank", () => {
		const reports = (emails: (string | undefined)[]): Report[] =>
			emails.map(email => ({ provider: "x", limits: [], metadata: email ? { email } : {} }));
		expect(accountNames(reports(["a@one.com", "b@one.com"]))).toEqual(["a", "b"]);
		expect(accountNames(reports(["a@one.com", "a@two.com"]))).toEqual(["a@one.com", "a@two.com"]);
		expect(accountNames(reports([undefined]))).toEqual([""]);
		expect(accountNames(reports([undefined, undefined]))).toEqual(["#1", "#2"]);
	});
});

describe("buildRows + renderRows", () => {
	const reports: Report[] = [
		{ provider: "github-copilot", limits: [limit("monthly", 0.4)], metadata: { email: "me@x.com" } },
		{ provider: "some-new-provider", limits: [limit("7d", 0.1)] },
		{ provider: "anthropic", limits: [limit("7d", 0.2)], metadata: { email: "work@x.com" } },
		{ provider: "anthropic", limits: [limit("7d", 0.6)], metadata: { email: "home@x.com" } },
		{ provider: "ollama", limits: [{ amount: { unit: "requests" } }] },
	];
	const rows = buildRows(reports, provider => (provider === "anthropic" ? { email: "home@x.com" } : undefined), NOW);

	test("orders known providers first, puts the active account first, and drops accounts without usage", () => {
		expect(renderRows(rows, 200, plain)).toEqual([
			" Claude home ━━━━━━ 60% 2d · work ━━━━━━ 20% 2d │ Copilot me ━━━━━━ 40% 2d │ some-new-provider ━━━━━━ 10% 2d",
		]);
	});

	test("dims only the inactive accounts of a provider whose active account is known", () => {
		const [line] = renderRows(rows, 200, tagged);
		expect(line).toContain("<dim> work</>");
		expect(line).toContain("<accent> Claude</> home");
		expect(line).toContain("<accent> Copilot</> me");
	});

	test("splits into one line per provider, then truncates, when the terminal is narrow", () => {
		const lines = renderRows(rows, 40, plain);
		expect(lines).toHaveLength(3);
		expect(lines.every(line => Bun.stringWidth(line) <= 40)).toBe(true);
		const one: AccountRow[] = [{ provider: "Claude", active: true, name: "x", usage: { percent: 5, reset: "1d" } }];
		expect(renderRows(one, 4, plain)).toEqual([" Cl…"]);
	});
});
