# 📋 Changelog

> 🇷🇺 Русская версия: [CHANGELOG.ru.md](CHANGELOG.ru.md)

## [1.2.0] — 2026-11-07 🐛

### 🧠 Memory snapshots

- 🧠 **Analyse Memory Snapshot** runs `dotnet-gcdump report` and opens the same graphical panel as a dump: overview metrics, findings and a filterable heap table. Previously the `.gcdump` file was only saved and nothing in VS Code could read it
- 🔀 **Compare Memory Snapshots…** shows which types grew or shrank between two snapshots
- 🗂️ The **Dumps** view now lists `.gcdump` files next to `.dmp` dumps, each with its own actions; snapshots also open from the Explorer context menu

### ⏺️ Traces

- 🎚️ `monitor-dotnet.traceProfile`: record with `dotnet-common`, `dotnet-sampled-thread-time`, `gc-verbose`, `gc-collect` or `database` instead of only the default set
- ⏱️ `monitor-dotnet.traceDurationSeconds`: stop the recording automatically after the given time, including when nobody presses **Stop**
- 🔄 **Convert Trace to Speedscope…**: convert an already recorded `.nettrace` without recording a new one
- 🔝 **Show Top Methods in Trace…**: `dotnet-trace report topN` opens the hottest methods in an editor

### 🗄️ Dumps

- 🎛️ `monitor-dotnet.dumpType` (`Full`, `Heap`, `Mini`, `Triage`) and `monitor-dotnet.dumpCrashReport` for `dotnet-dump collect`
- ⌨️ **Custom SOS commands** in the analysis picker: any command, one per line, in its own session next to the presets

### 🔢 Counters and stacks

- ➕ **Add to Collection Filter** on any counter, meter or group in the **Counters** view: the setting is updated for you
- 📤 **Record Counters to File** with `dotnet-counters collect`: CSV or JSON for 30 seconds, 1 minute or 5 minutes
- 🏷️ **Add Line Numbers to Stack Trace** with `dotnet-stack symbolicate`: resolves method tokens from a stack trace in the editor

### 🐛 Process detection

- 🐛 Fixed monitoring that never started on some Windows machines: the start time of .NET processes was always read as unknown (Windows PowerShell 5.1 serialises `CreationDate` as `/Date(…)`, which `Date.parse` rejects), so every candidate looked like it started before the debug session and the target was dropped after 20 s
- ⌛ The start time is now computed inside PowerShell as Unix milliseconds, with a fallback parser for the old `CreationDate` formats
- 🧩 When the OS reports no start time at all, the target is still found by an exact path to the program or assembly — after a short delay and only if the next poll confirms the same process
- 🧹 Avalonia design-time services (`Avalonia.BuildServices`, `Avalonia.Designer.HostApp`) are no longer treated as .NET candidates
- 📋 The log now reports how many found processes have an unknown start time

### 🧠 Memory dump analysis

- 🧠 **Analyse Memory Dump** button: runs `dotnet-dump analyze` on the newest `.dmp` from the output folder and opens a graphical report
- 🧩 Presets for common questions: threads, heap by type, async and thread pool, exceptions, locks and the finalization queue
- 📊 Graphical panel styled like VS Code: overview metrics, automatic findings, a heap composition bar, a filterable type table sortable by size or object count, thread pool and thread stats
- 🧠 Analysis also adds async state machine and exception tables plus GC allocated/committed usage
- �️ **Dumps** view with every `.dmp` from the output folder: click to analyse, reveal in the Explorer or compare
- 🔀 **Compare Dumps…** shows heap, object, thread, async and exception deltas plus the types that grew or shrank the most
- �🕒 The header shows when the dump was taken and its size, separately from the report creation time
- 🗂️ The full SOS output stays available in collapsible blocks, and **Open text report** shows the complete report in an editor
- 🧵 Every command gets its own interactive panel above: a `clrthreads` table, GC segment sizes, expandable stacks with application frames highlighted, sync blocks, exception cards and the finalization queue grouped by type. Commands shared by several presets are shown once, and **Details** keeps only the raw SOS output
- 🎛️ Every panel collapses with a click, and all long lists have search and paging (25 table rows, 8 thread stacks or 5 exception cards per page), so a large dump stays readable
- � Every selected preset now runs in its own `dotnet-dump analyze` session: the tool does not echo commands in non-interactive mode, so previously all output landed in the first section and the rest showed "No data"
- �🖱️ Any `.dmp` can also be analysed from the Explorer context menu, including dumps taken outside VS Code

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
