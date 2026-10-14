<p align="center">
  <img src="resources/monitor.png" alt="Monitor Dotnet" width="128" height="128">
</p>

<h1 align="center">🔍 Monitor Dotnet</h1>

![Version 1.0.0](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)
![.NET net10.0](https://img.shields.io/badge/.NET-net10.0-512BD4?style=flat-square&logo=dotnet&logoColor=white)
![License MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)

> 📊 **Real-time monitoring for .NET applications in VS Code** — CPU load, memory, garbage collection, counters, metrics and environment variables.
> The monitor opens by itself when you start debugging. No web dashboard, no extra services — everything runs locally.

🇷🇺 Русская версия: [README.ru.md](README.ru.md) · 📋 Changelog: [CHANGELOG.md](CHANGELOG.md)

---

## ✨ Features

| | Feature | What you get |
| --- | --- | --- |
| 📈 | **Performance charts** | CPU load, garbage collection and memory drawn live on canvas |
| 🗑️ | **GC timeline** | Collection markers coloured by generation, with reason and pause duration |
| 🧮 | **Range analysis** | Drag a chart to get min / avg / max, GC count and average pause for the range |
| 🩺 | **Issue detection** | Suspicious intervals found automatically, as a native list and as bands on the charts |
| 🧾 | **EventCounters** | Classic .NET counters grouped by provider |
| 📐 | **Metrics** | `System.Diagnostics.Metrics` instruments grouped by meter |
| 🌱 | **Environment** | Environment variables and system properties of the process |
| 🐞 | **Debug integration** | Monitoring starts automatically on .NET debug sessions |
| 🔌 | **Attach to process** | Connect to any running .NET process in two clicks |
| 🧵 | **Call stack** | Snapshot the call stack of the running process |
| 💾 | **Memory snapshot** | Collect a GCDump and reveal it in the file manager |
| ⏺️ | **Profiling** | Record a `dotnet-trace` profile in the Speedscope format |
| 🌍 | **Two languages** | English and Russian, following the VS Code display language |
| 📟 | **Status bar** | CPU load and private memory always in sight |

---

## ✅ Requirements

| | Requirement | Why it is needed |
| --- | --- | --- |
| 🖥️ | **VS Code 1.100 or newer** | Current webview, localization and tree APIs |
| 🟣 | **.NET 10 runtime** | The bundled bridge that reads EventPipe is a `net10.0` app, and it is started through `dotnet`. `dotnet` must be on `PATH`, otherwise set `monitor-dotnet.dotnetPath` |
| 🔬 | `dotnet-stack`, `dotnet-gcdump`, `dotnet-trace` *(optional)* | Needed for a call stack snapshot, a memory snapshot and profiling. The extension offers to install a missing tool with one command |

The application you monitor does not have to be .NET 10: EventPipe has been available since .NET Core 3.0, so .NET 5 apps and newer work as well.
Windows, Linux and macOS are supported — private memory, environment variables and the command line are read through platform APIs. Mono and Unity are not supported.

---

## 🚀 Quick start

1. 📦 Install the extension (see **Build from source** below for a local build).
2. ⌨️ Press `F5` on any .NET project, or run **Monitor Dotnet: Start Monitoring** from the command palette.
3. 📊 The **Monitor Dotnet** panel appears in the activity bar with live charts and counters.

---

## 📊 Performance panel

Three charts update once per second, plus a row of current-value tiles.

| Chart | What it shows |
| --- | --- |
| 📈 **CPU load** | Processor usage of the application; 100 % means all cores fully loaded |
| 🗑️ **Garbage collection** | Allocation rate with markers for every collection: colour = generation, tooltip = reason and pause |
| 🧠 **Memory** | Private memory (area), managed heap and working set |

| Action | Result |
| --- | --- |
| 🖱️ Hover | Tooltip with all series values and GC details in that moment |
| ↔️ Drag | Select a time range; a summary appears below with min / avg / max, GC count and average pause |
| ⌨️ `Esc` or double click | Reset the selection |
| ⏸️ Pause | Freeze the view to inspect data; **Resume** pulls a fresh snapshot |

Colours come from the current theme, so the panel looks native in light, dark and high-contrast themes.

### 🩺 Automatic issue detection

The extension watches the charts and marks suspicious time ranges on its own:

| Issue | When it is reported |
| --- | --- |
| 🔥 **CPU saturation** | Load stayed at 90 % or more for several refreshes in a row |
| 🗑️ **Long GC pause** | A single pause of 100 ms or more, 300 ms and above is critical |
| 🌊 **GC pressure** | 10 or more collections with 200 ms or more of pauses inside a 10-second window |
| 📈 **Allocation spike** | Allocation rate three times above the session median and at least 1 MB/s |

Every issue gets a coloured band on the matching chart and an entry in the list above the charts: the
severity badge (ℹ️ info, ⚠️ warning, 🔴 critical), the moment it started and a short explanation. Click an
entry to select its time range — the charts zoom out to fit it and the range summary appears underneath.
Turn the whole thing off with `monitor-dotnet.enableIssueDetection`.

The same list lives in the native **Issues** view next to the charts, with a theme icon per severity and
the interval in the description. It works even with the panel closed: clicking an issue opens the charts
and selects that interval.

---

## 🔢 Counters and metrics

The **Counters** view lists two kinds of data:

- 🧾 **EventCounters** — classic counters grouped by provider (`System.Runtime`, `Microsoft.AspNetCore.Hosting`, your own `EventSource`)
- 📐 **Metrics** — `System.Diagnostics.Metrics` instruments grouped by meter, including tagged series

Pick what to collect in the settings:

```jsonc
"monitor-dotnet.counterProviders": [
  "System.Runtime",                  // every counter of the provider
  "MyProvider[Counter1,Counter2]"    // only the listed counters
],
"monitor-dotnet.metricProviders": ["*"]  // all meters, or "MyMeter", or "MyMeter\\MyInstrument"
```

---

## 🌱 Environment

The **Environment** view shows what the application was started with:

- 🔤 environment variables of the process
- 🖥️ system properties: .NET version, startup flags, command line, OS, architecture
- 🔍 filter by name or value, and copy any value to the clipboard

---

## 🛠 Profiling on demand

Buttons in the Performance view title bar:

| Button | Tool | Result |
| --- | --- | --- |
| 🧵 **Collect Call Stack** | `dotnet-stack` | Call stack of every thread in a new editor tab |
| 💾 **Get Memory Snapshot (GCDump)** | `dotnet-gcdump` | `.gcdump` file, revealed in the file manager |
| ⏺️ **Start / Stop Performance Profiling** | `dotnet-trace` | `.nettrace` in Speedscope format |

If a tool is missing, the extension offers to install it with one command (`dotnet tool install --global …`).

---

## ⚙️ Settings

| Setting | Default | Description |
| --- | --- | --- |
| `monitor-dotnet.enableMonitoring` | `onDebugOrRun` | When to start monitoring: `onDebugOrRun`, `onDebug`, `never` |
| `monitor-dotnet.autoReveal` | `true` | Open the panel when a debug session starts |
| `monitor-dotnet.refreshIntervalSeconds` | `1` | How often counters and metrics are refreshed |
| `monitor-dotnet.chartWindowSeconds` | `120` | How many seconds of data the charts show |
| `monitor-dotnet.enableIssueDetection` | `true` | Look for suspicious intervals on the charts |
| `monitor-dotnet.counterProviders` | base .NET set | EventCounters providers |
| `monitor-dotnet.metricProviders` | `["*"]` | Meter filters |
| `monitor-dotnet.dotnetPath` | `dotnet` | Path to the `dotnet` executable |
| `monitor-dotnet.bridgePath` | empty | Bridge assembly; empty means the bundled copy |
| `monitor-dotnet.processNameFilter` | empty | Extra substring to find the debuggee process |
| `monitor-dotnet.profilingOutputDirectory` | empty | Where profile and snapshot files are written |

---

## 🌍 Languages

The extension speaks the language of your VS Code interface.

- 🇬🇧 **English** — source language of every string
- 🇷🇺 **Russian** — complete translation

| What | Where the translation lives |
| --- | --- |
| Code strings: notifications, hints, log | `l10n/bundle.l10n.<language>.json` |
| Manifest: commands, views, settings | `package.nls.<language>.json` |
| Charts panel (webview) | texts are sent by the extension together with data |

---

## 🏗️ How it works

```
┌────────────────────────── VS Code ──────────────────────────┐
│  Monitor Dotnet extension (TypeScript)                       │
│                                                              │
│  extension.ts ──► MonitorController ──► Bridge process       │
│                        │                    │ NDJSON (stdout)│
│                        ▼                    ▼                │
│  MonitorState (series, counters, metrics)  BridgeLocator     │
│            │                                                 │
│            ├─► Performance panel   (canvas charts, webview)  │
│            ├─► Counters view       (tree)                    │
│            ├─► Environment view    (tree)                    │
│            └─► Status bar          (CPU and memory)          │
└──────────────────────────────────────────────────────────────┘
                              ▲
                              │ one JSON message per line
                              ▼
┌─────────── Bridge (MonitorDotnet.Bridge, .NET 10) ───────────┐
│  EventPipe session:                                          │
│   • EventCounters                  → provider counters       │
│   • System.Diagnostics.Metrics     → meters                  │
│   • Microsoft-Windows-DotNETRuntime → GC events, heap stats  │
│  Operating system: private memory, environment, command line │
└──────────────────────────────────────────────────────────────┘
```

A VS Code extension cannot read EventPipe directly, so collection happens in a small .NET process.
It attaches to the target process, parses the event stream and sends ready-made samples to the extension.

---

## 📁 Project structure

| Path | Purpose |
| --- | --- |
| `src/core` | Framework-free logic: protocol, state, formatting, chart data, debuggee matching |
| `src/monitor` | Bridge lifecycle, .NET process discovery, profiling tool wrappers |
| `src/views` | Panels: Performance (webview provider), Counters and Environment (trees), status bar |
| `src/webview` | Code that runs inside the webview: canvas rendering and message handling |
| `src/extension.ts` | Activation, commands, debug session handling, context keys |
| `bridge/MonitorDotnet.Bridge` | .NET 10 bridge: EventPipe session, event parsing, process statistics |
| `bridge/MonitorDotnet.Bridge.Tests` | Bridge tests, including an end-to-end run against a real process |
| `samples/SampleApp` | Demo application with counters, metrics and load |
| `scripts/build.ts` | Builds the extension and the webview bundle with esbuild |
| `l10n`, `package.nls.*` | Translation dictionaries |
| `test` | Extension tests: activation, localization, end-to-end data flow |

---

## 🧪 Build from source

Requirements: **.NET SDK 10**, **Node.js 20+**, **VS Code 1.100+**.

```bash
npm install
npm run bridge:build   # publish the .NET bridge to media/bridge and dist/bridge
npm run build          # bundle the extension and the charts panel
npm run package        # create monitor-dotnet-1.0.0.vsix
code --install-extension monitor-dotnet-1.0.0.vsix
```

Useful commands:

| Command | What it does |
| --- | --- |
| `npm run watch` | Rebuild the extension and the panel on change |
| `npm run typecheck` | Type check with TypeScript 7 (extension and webview separately) |
| `npm test` | Extension tests, including dictionary consistency |
| `npm run test:bridge` | Bridge tests with xunit |
| `MONITOR_DOTNET_E2E=1 npm test` | End-to-end check: starts `samples/SampleApp --stress`, attaches to it and waits for a detected issue |

---

## 🔐 Privacy

- 🚫 No telemetry, no accounts, nothing is uploaded: the extension collects data locally and never sends it anywhere. The only network access happens when you confirm it — installing a missing diagnostic tool with `dotnet tool install` or opening the [.NET diagnostics documentation](https://learn.microsoft.com/dotnet/core/diagnostics/).
- 🏠 All data is collected locally by the bridge process and shown only inside VS Code.
- 🗂️ Profile files and memory snapshots are written where you point them (the temporary directory by default).

---

## 📄 License

**MIT** — full text in [LICENSE](LICENSE). © 2026 Dmitry Sorokin (dimanrus).
