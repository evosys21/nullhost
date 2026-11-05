# Contributing to NullHost

Thanks for helping. Bug reports, blocklist suggestions and pull requests are
all welcome.

## Reporting a bug

Open an [issue](https://github.com/evosys21/nullhost/issues) with:

- The NullHost version and your Windows version.
- What you did, what you expected and what happened.
- What the Troubleshoot page shows, if it points at something (from a source
  checkout, the CLI's `doctor --json` gives the same checks).

Please don't paste your whole hosts file: the part outside NullHost's region
may contain names you'd rather keep private.

## Suggesting a blocklist

The built-in catalog is [`catalog/sources.json`](catalog/sources.json). A new
list should be:

- Public, maintained, and downloadable over HTTPS.
- Under a licence that allows redistribution, stated in the entry.
- In a format NullHost reads: hosts, domains, Adblock or dnsmasq.
- Small enough for the hosts file. Windows' DNS Client slows down badly with
  very large files, so huge lists may be refused by the entry budget.

Each entry has an `id`, `name`, `url`, `format`, `licence`, `tier`
(`recommended`, `stricter` or `optional`), `category` and the date you
`verified` it downloads and parses. New lists go in `stricter` or `optional`;
`recommended` lists are switched on after install, so that tier changes only
after discussion in an issue.

## Sending a change

1. Fork the repo and branch from `main`.
2. Set up and check that everything passes (Node 22, Yarn through corepack):

   ```bash
   corepack enable
   corepack yarn install
   corepack yarn check
   ```

3. Make the change. Add or update tests in the package you touch.
4. Run `corepack yarn check` again, then open a pull request against `main`.
   CI runs the same check and builds the installer.

The [Development](README.md#development) section of the README lists the
packages and how to run the CLI, the desktop app and the installer test.

### Safety rules

These protect your own PC while you work:

- Never write the real hosts file, flush DNS or restart the DNS Client while
  developing. Use `--hosts-file` with a copy, `corepack yarn desktop:copy`,
  Windows Sandbox or a VM.
- Tests only ever write temp files. Keep it that way: new tests use the fake
  platform, never the real one.

### What changes are accepted

- NullHost only blocks. Every line it writes points at `0.0.0.0` or
  `127.0.0.1`, and changes that would let it redirect a name anywhere else
  won't be merged.
- Nothing outside NullHost's managed region is changed without the user
  asking for it.
- The app runs as a normal user and elevates only to write the hosts file.
- No telemetry. The only network calls are list downloads and the optional
  daily release check.

### Style

- TypeScript, run directly by Node in `core` and `cli`; Vue 3 in the desktop
  UI. Match the code around your change.
- Commit messages: a short summary line in plain English, describing what
  changed for the user where possible.
- One topic per pull request.

## Licence

By contributing you agree that your contribution is released under the
[MIT License](LICENSE), like the rest of NullHost.
