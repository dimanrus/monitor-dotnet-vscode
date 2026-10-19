# 📋 Changelog

> 🇷🇺 Русская версия: [CHANGELOG.ru.md](CHANGELOG.ru.md)

## [1.1.0] — 2026-10-19 🛠️

### 🛠 Profiling on demand

- 🐛 Fixed a false "tool dotnet-trace is not installed" message when the tool was installed: global .NET tools are separate executables in `<home>/.dotnet/tools`, not `dotnet` subcommands, and the extension ran them as `dotnet dotnet-trace`
- 🔎 The executable is now resolved through `PATH` and the dotnet tools directory, so a tool available in the terminal is also available here
- ℹ️ The log reports the found path, and the **Learn more** button of the install prompt works in every language (it compared a hardcoded Russian label)
- 🗄️ **Take Memory Dump** with `dotnet-dump` (Heap type): stacks and managed memory for `dotnet-dump analyze`
- ⬇️ **Download Symbols for Dumps** with `dotnet-symbol`, so stack traces in a dump show function names
- 🏷️ Profiling writes a ready `.speedscope.json` next to the `.nettrace`: the `.nettrace` stays as before, and the notification offers to open the Speedscope file
- 🔎 **Open Speedscope Profile** button: opens the newest profile from the output folder, with a picker when there are several
- 🧩 On the first opening the extension offers to install the [Speedscope viewer](https://marketplace.visualstudio.com/items?itemName=sransara.speedscope-in-vscode) and to add `"*.speedscope.json": "speedscope-in-vscode.speedscope"` to `workbench.editorAssociations`, so profiles open as a flame graph instead of JSON
- 📁 Profiles, dumps and snapshots go to the `.monitor-dotnet` folder of the project by default, with a `.gitignore` inside so they never reach the repository

## [1.0.0] — 2026-10-14 🎉

First release: a .NET monitoring tool for VS Code that appears automatically when you debug an application.

### 📊 Performance charts

- 📈 Live charts for **CPU load**, **garbage collection** and **memory**, rendered on canvas in the Performance panel
- 🖱️ Hover tooltip with every series value in the point under the cursor
- 🗑️ GC markers coloured by generation (`gen0` / `gen1` / `gen2`) with collection reason and pause duration
- 🧮 Drag to select a time range: minimum, average and maximum, GC count and average pause for the range
- ⏸️ Pause and resume live updates, `Esc` or double click to reset the selection

### 🎯 Choosing the process

- 🎯 New **Select Process to Monitor…** command and a **Process** dropdown in the Performance panel header
- 📋 The list shows debug sessions first (with their PID) and then other .NET processes with the full command line
- ✅ The monitored process is marked with a check mark, so you can see which one is being watched
- 🛡️ The process of a session is remembered, and monitoring is never switched behind your back: a second debug session does not steal it — the extension offers to switch instead
- ↩️ When the monitored session ends, the extension suggests another running process

### 🩺 Automatic issue detection

- 🔎 The extension keeps watching the charts and points out suspicious time ranges on its own
- 🔥 **CPU saturation** — load stayed at 90 % or more for several refreshes in a row
- 🗑️ **Long GC pause** — a single pause of 100 ms or more (300 ms and above is critical)
- 🌊 **GC pressure** — 10 or more collections with 200 ms or more of pauses inside a 10-second window
- 📈 **Allocation spike** — allocation rate three times above the session median and at least 1 MB/s
- 🟥 Highlighted bands on the matching chart, coloured by severity (info / warning / critical)
- 🖱️ Click an issue to select its time range: the charts zoom out to fit it and the range summary appears
- 🌳 Native **Issues** view with a theme icon per severity and the interval in the description; clicking an entry opens the charts and selects that interval
- 🧷 Problems are kept per process: the chart panel and its bands follow the process on the charts, while the **Issues** view groups the history by process and marks the monitored one
- 💾 Every issue keeps its own points, so an interval stays analysable after the live charts have moved past it: clicking it draws the saved range from those points and shows the range summary
- 🏷️ A banner names the process of a saved interval and offers **Back to live data**; the tiles of the current process are hidden while an interval is open
- 🧹 The next debug session starts the list over, and **Clear Collected Data** forgets it as well

### 🔢 Counters and metrics

- 🧾 Classic **EventCounters** grouped by provider
- 📐 **System.Diagnostics.Metrics** grouped by meter, including instruments with tags
- ⚙️ Provider selection in the `MyProvider[Counter1,Counter2]` format
- ⏱️ Configurable refresh interval from 0.2 to 60 seconds

### 🌱 Environment

- 🔤 Environment variables of the monitored process
- 🖥️ System properties: runtime version, startup flags, command line, OS and architecture
- 🔍 Filter by name or value, copy any value to the clipboard

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
