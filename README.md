# NullHost

A hosts-file ad and tracker blocker for Windows.

NullHost merges public blocklists into one managed region of your hosts file
and leaves everything else in the file alone: your own entries stay exactly
where they are. Blocking can be switched on, off or paused in a second, from
the window, the tray or a hotkey.

> **Status:** early (0.1.0), Windows only. The installer is not code-signed,
> so Windows SmartScreen will warn before running it.

## Features

- **Curated list catalog** with three tiers: recommended (StevenBlack unified,
  AdAway, Pete Lowe), stricter (KADhosts, Phishing Army, HaGeZi Multi) and
  optional topic lists (gambling, fake news, social, adult, crypto-mining,
  Windows & Office telemetry). Add your own lists by URL or file, in hosts,
  domains, Adblock or dnsmasq format.
- **Allowlist** by host, `*.suffix` or `/regex/`, and a host check that tells
  you whether a name is blocked and by which list.
- **Daily automatic updates** through a Windows scheduled task; only changed
  lists are downloaded.
- **Safe writes:** a snapshot is taken before every write, and you can restore
  the previous or the original hosts file at any time. The region is written
  9 hosts per line, which keeps Windows' DNS Client responsive with large lists.
- **Least privilege:** the app runs as a normal user. The first change in a
  session asks for administrator rights once; a small helper then writes the
  hosts file and flushes DNS until you quit.
- **Editor** for the whole hosts file, with NullHost's region folded and
  read-only.
- **Troubleshoot checks** for the region, the DNS Client, a Defender exclusion,
  list failures and more.
- **Clean-up of old blockers' leftovers** (for example HostsMan) outside the
  managed region, keeping your own entries.
- **Command line** with the same features, and `--json` output.

## Install (Windows)

Download `NullHost-Setup-<version>.exe` from the
[latest release](https://github.com/evosys21/nullhost/releases/latest) and run
it. It is built by GitHub Actions from the tagged source. Since it is unsigned,
SmartScreen asks first ("More info", then "Run anyway"). It installs for all
users under Program Files, with Start menu and desktop shortcuts.

If another hosts-file blocker is running (HostsMan, for instance), quit it and
turn off its automatic updates first, so the two don't overwrite each other.

On first start, the Dashboard's "Finish setting up" card switches on start at
login and daily updates. Then press **Update now**.

### Build the installer yourself

You need Node.js 22.18 or newer. Yarn comes with Node through corepack.

```bash
git clone https://github.com/evosys21/nullhost.git
```

```bash
cd nullhost
```

```bash
corepack yarn install
```

```bash
corepack yarn workspace @nullhost/desktop dist
```

That builds `packages/desktop/dist/NullHost-Setup-0.1.0.exe`; run it as above.

### Uninstall

Uninstall from Windows Settings. It removes NullHost's region from the hosts
file, its login entry and its scheduled task. Your config stays in
`%APPDATA%\NullHost`; the snapshots and a copy of the original hosts file stay
in `%LOCALAPPDATA%\NullHost`.

## Command line

```bash
node packages/cli/src/main.ts --help
```

| Command | What it does |
|---|---|
| `status` | On or off, number of hosts, last update, warnings |
| `update` | Download changed lists, then write the hosts file |
| `enable`, `disable`, `pause 1h` | Switch blocking; your own entries stay |
| `check <host>` | Is it blocked, and by which list? |
| `source list`, `source add <url>` | Manage lists |
| `allow add <pattern>` | Allowlist a host, `*.suffix` or `/regex/` |
| `restore previous` | Write back the snapshot taken before the last write |
| `remove` | Delete NullHost's region from the hosts file |
| `doctor` | Read-only health checks |
| `export --format dnsmasq` | Export the merged list (hosts, domains, dnsmasq, unbound) |

Commands that write the system hosts file need an elevated terminal. Add
`--hosts-file <path>` to work on a copy instead.

## How it works

NullHost owns one region of the hosts file, between its own begin and end
markers. Each update downloads the enabled lists (with caching), parses and
normalises them, removes duplicates and allowlisted hosts, and renders the
region. Nothing outside the markers is changed. If the markers in the file
don't pair up (one deleted or duplicated by hand), NullHost refuses to write
rather than guess.

### NullHost never redirects

NullHost only blocks. Every line it writes points at `0.0.0.0` (the default)
or `127.0.0.1`, which you choose in Settings, and nothing else:

- **Blocklists can't redirect you.** An entry that points a name at any other
  address, such as `1.2.3.4 login.example.com`, is dropped when the list is
  read. Only the host name is kept, never a list's address.
- **The setting can't be changed to a real IP.** Settings, the CLI, settings
  imports and a hand-edited `config.toml` all refuse anything but those two.
- **Lists are downloaded over HTTPS.**

So the worst a bad list can do is block a site, never send you somewhere
else. If a site you need stops working, allowlist it.

Entries outside NullHost's region are yours, or another program's, and
NullHost leaves them alone.

## Development

No build step for the core and CLI: Node runs the TypeScript directly.

| Path | What |
|---|---|
| `packages/core` | The engine: sources, parsing, merge, allowlist, managed region, snapshots, Windows write path |
| `packages/cli` | The `nullhost` command line |
| `packages/desktop` | The desktop app: Electron main process, tray, hotkey, and the Vue UI |
| `catalog/sources.json` | The built-in list catalog |

Type checks and tests:

```bash
corepack yarn check
```

Try the CLI on a **copy** of the hosts file. It never touches the system file
this way and never flushes DNS:

```bash
node packages/cli/src/main.ts --hosts-file C:\temp\hosts --data-dir C:\temp\nullhost update
```

The desktop app with live reload, on a copy of your hosts file kept in `.dev/`
(git-ignored); `--fresh` re-copies the system file:

```bash
corepack yarn desktop:copy
```

The UI alone in a browser with mock data:

```bash
corepack yarn desktop:web
```

A smoke run builds the app, runs it hidden against a copy, screenshots every
screen into `packages/desktop/out/smoke` and exits:

```bash
corepack yarn workspace @nullhost/desktop smoke
```

Test the installer in Windows Sandbox, without touching your PC (needs the
Windows Sandbox feature):

```bash
node packages/desktop/scripts/sandbox-test.mjs
```

### Safety rules

- Tests only ever write temp files. The CLI tests use a fake platform that
  reports "not elevated", so even a bug cannot write the system file.
- While developing, don't write the real hosts file, flush DNS or restart the
  DNS Client. Use `--hosts-file`, Windows Sandbox or a VM.
- Keep the region at 9 hosts per line. One host per line makes Windows' DNS
  Client take minutes to reload the file, stalling lookups meanwhile.

## Blocklists

The lists are made and maintained by their authors, under their own licences;
NullHost downloads them from their published URLs and shows each list's source
in the app. Thanks to everyone who maintains them.

## License

NullHost is released under the [MIT License](LICENSE), © 2026 EvoSys21. The
blocklists it downloads are not part of NullHost and keep their own licences.
