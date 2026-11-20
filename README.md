# omp-account-usage

An [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) extension that puts the subscription usage of **every** logged-in account on one line above the editor:

```
 Claude alice ━━━━━━ 24% 4d2h · bob ━━━━━━ 22% 3d17h │ Codex carol ━━━━━━ 26% 4d18h │ Copilot dave ━━━━━━ 40% 12d
```

omp's built-in `usage` status-line segment shows only the account behind the current model. This widget shows all of them:

- one group per provider, with the account the current session uses first and the others dimmed
- per account: a gauge, the percent used (green < 50%, yellow < 80%, red above), and the time until the window resets
- one line when it fits; otherwise one line per provider, then shorter gauges, then truncation

## Install

```sh
omp plugin install github:minigold92/omp-account-usage
```

Restart omp. Update with `omp plugin upgrade omp-account-usage`; remove with `omp plugin uninstall omp-account-usage`.

To try it without installing: `omp -e /path/to/account-usage.ts`.

## Which number it shows

omp already turns each provider's usage into the same shape (windows, used fraction, reset time), so the widget works for any provider omp reports usage for. Per account it shows one window:

1. the weekly window, if there is one
2. otherwise the longest window (monthly, billing period, …), then shorter ones
3. the most used limit when several share that window

Per-model and per-tier meters (Claude Opus, Codex Spark, Copilot per-model) are skipped unless the account has nothing else. Run `/usage` in omp for every window.

Known providers get short labels (Claude, Codex, Copilot, Cursor, Gemini, Grok, …). Any other provider shows its omp provider id.

## Tested

| What | How |
| --- | --- |
| Claude, Codex (several accounts each) | real accounts, omp 19.0.1 |
| Other providers (Copilot, Cursor, Gemini, Grok, …) | unit tests built from omp's usage report shapes only |

If a provider shows the wrong number or nothing at all, please [open an issue](https://github.com/minigold92/omp-account-usage/issues) with your omp version and the matching part of `/usage` (mask emails).

## Notes

- Reads omp's own usage cache through an internal API (`authStorage.usage` / `authStorage.oauth`) that is not in the public extension typings. If an omp release drops it, the widget turns itself off with one warning instead of erroring.
- Makes no network requests of its own and stores nothing; account names come from your local omp login.
- Refreshes every 15 seconds and after every turn.

## Development

```sh
bun test
```

## License

MIT. Includes code adapted from oh-my-pi (MIT); see [NOTICE](NOTICE).
