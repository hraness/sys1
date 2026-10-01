# Update Sys1

Automatic updates require Sys1 0.19.0 or newer. Upgrade an older installation
once through its package manager to enable them.

Supported Bun and npm global installations on macOS and Linux check for a
newer release at most once a day before a command starts. Automatic updates are
enabled by default. Help, version output, CI, and commands already running do
not trigger an update. If another command is using the installation, the
update waits for a later invocation.

```sh
sys1 update status --json
sys1 update check
sys1 update
sys1 update disable
sys1 update enable
```

Set `HRANESS_NO_UPDATE=1` to suppress automatic updates for an invocation.
Exact Bun version installs stay pinned until `update enable`. Ordinary Bun
ranges, tags, and GitHub release archive installs track newer releases. npm
does not reliably retain the original global version constraint; use
`update disable` to keep an npm global at its installed version.

Source checkouts, local project dependencies, temporary `bunx` or `npx`
installs, linked copies, and copied skill scripts keep their existing update
process. On Windows, update through the package manager. Library imports do
not check for updates or change installed code.

The updater stores its preference, last check time, and installation/process
records locally. It keeps verified archives beside the global installation
because the package manager may reference them. Keep an archive while the
installation references it. Update checks send no application data to the release service.

Updates use immutable GitHub releases and require an authenticated
[GitHub CLI](https://cli.github.com/) (`gh`).

Stop every gateway using this installation before the first package-manager
upgrade from an older release. For each `SYS1_HOME`, stop its background
gateway with `sys1 down`. Stop a
foreground `sys1 serve` with Ctrl-C. A running gateway, or saved service state
whose ownership cannot be established, keeps the current code in place.
Gateways started by Sys1 0.19.0 or newer also keep their installation locked
across different `SYS1_HOME` directories. The updater never stops or restarts a service. Model weights, configuration,
and saved workflows are separate from CLI updates.
