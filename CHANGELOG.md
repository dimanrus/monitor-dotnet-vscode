# 📋 Changelog

> 🇷🇺 Русская версия: [CHANGELOG.ru.md](CHANGELOG.ru.md)

## [1.0.0] — 2026-10-14 🎉

First release: a .NET monitoring tool for VS Code that appears automatically when you debug an application.

### 📊 Performance charts

- 📈 Live charts for **CPU load**, **garbage collection** and **memory**, rendered on canvas in the Performance panel
- 🖱️ Hover tooltip with every series value in the point under the cursor
- 🗑️ GC markers coloured by generation (`gen0` / `gen1` / `gen2`) with collection reason and pause duration
- 🧮 Drag to select a time range: minimum, average and maximum, GC count and average pause for the range
- ⏸️ Pause and resume live updates, `Esc` or double click to reset the selection
- 🎨 Current-value tiles and colours that follow the light, dark and high-contrast themes

### 🩺 Automatic issue detection

- 🔎 The extension keeps watching the charts and points out suspicious time ranges on its own
- 🔥 **CPU saturation** — load stayed at 90 % or more for several refreshes in a row
- 🗑️ **Long GC pause** — a single pause of 100 ms or more (300 ms and above is critical)
- 🌊 **GC pressure** — 10 or more collections with 200 ms or more of pauses inside a 10-second window
- 📈 **Allocation spike** — allocation rate three times above the session median and at least 1 MB/s
- 🟥 Highlighted bands on the matching chart, coloured by severity (info / warning / critical)
- 🖱️ Click an issue to select its time range: the charts zoom out to fit it and the range summary appears
- 🌳 Native **Issues** view with a theme icon per severity and the interval in the description; clicking an entry opens the charts and selects that interval
- 🎚️ Toggle with the `monitor-dotnet.enableIssueDetection` setting (on by default)

### 🔢 Counters and metrics

- 🧾 Classic **EventCounters** grouped by provider
- 📐 **System.Diagnostics.Metrics** grouped by meter, including instruments with tags
- ⚙️ Provider selection in the `MyProvider[Counter1,Counter2]` format
- ⏱️ Configurable refresh interval from 0.2 to 60 seconds

### 🌱 Environment

- 🔤 Environment variables of the monitored process
- 🖥️ System properties: runtime version, startup flags, command line, OS and architecture
- 🔍 Filter by name or value, copy any value to the clipboard

### 🐞 Debug integration

- 🚀 Monitoring starts automatically on .NET debug sessions: **on debug or run**, **on debug only** or **never**
- 🎯 Debuggee detection by attach PID, program path, name filter and session start time
- 🧩 Recognises both launch styles: apphost (`App` next to `App.dll`) and runtime host (`dotnet App.dll`)
- 🔌 Manual **Attach to .NET Process…** for any running .NET process
- 📟 Status bar indicator with CPU load and private memory

### 🛠 Profiling on demand

- 🧵 **Collect Call Stack** using `dotnet-stack`
- 💾 **Get Memory Snapshot (GCDump)** using `dotnet-gcdump`, revealed in the file manager
- ⏺️ **Start / Stop Performance Profiling** using `dotnet-trace` with the Speedscope format
- 📦 Offers to install a missing diagnostic tool with a single command

### 🏗️ Architecture

- 🌉 Separate .NET 10 **bridge** process that collects EventPipe data and streams NDJSON to the extension
- 📊 EventCounters, metrics, GC events and heap sizes through one EventPipe session
- 🧠 Private memory per platform: `/proc/<pid>/smaps` on Linux, `GetProcessMemoryInfo` on Windows, `proc_pid_rusage` on macOS
- 🪟 Native tree views for counters and environment, a webview only for the charts
- 🛡️ Strict webview content security policy with a per-load nonce
- 🔒 Explicit workspace scope: `extensionKind: workspace` (monitoring runs next to the debuggee, also in remote scenarios) and `capabilities` that keep the extension out of untrusted and virtual workspaces
- 📋 Requirements documented in the README: VS Code 1.100+, .NET 10 runtime for the bundled bridge, optional SDK and diagnostic tools

### 🎨 Look and feel

- 🖼️ Extension icon `resources/monitor.png` (256×256): a monitor screen with a live chart
- 📖 The icon heads the README of both languages

### 🧪 Quality

- ✅ 103 extension tests and 22 bridge tests, including an opt-in end-to-end run against a real .NET process
- 🔍 Type checking with TypeScript 7 and bundling with esbuild
- 🧪 `SampleApp` demo application that generates counters, metrics, allocations and CPU load
- 🧹 Diagnostics: the panel reports render problems and canvas statistics to the extension log

---

## 🔗 Links

- 📦 Package: `monitor-dotnet-1.0.0.vsix`
- 📖 Documentation: `README.md` · `README.ru.md`
