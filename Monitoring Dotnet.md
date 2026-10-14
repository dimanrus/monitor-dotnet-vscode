# Monitoring Dotnet — requirements and coverage

Real-time monitoring of .NET applications for VS Code: CPU load, memory consumption, garbage collection
activity, counters, metrics and environment variables. Monitoring starts automatically when a project is
run or debugged.

This document is the specification of the tool and the record of how much of it is implemented.
Legend: ✅ implemented · 🟡 partial · ❌ not implemented.

---

## 1. Supported operating systems and applications

| Requirement | Status | Notes |
| --- | --- | --- |
| Windows | ✅ | Private memory through `GetProcessMemoryInfo`, environment variables and command line read from the process block |
| Linux | ✅ | Private memory from `/proc/<pid>/smaps_rollup` (fallback `/proc/<pid>/smaps`), environment from `/proc/<pid>/environ` |
| macOS | ✅ | Private memory through `proc_pid_rusage`, environment through `ps -wwE` |
| .NET Core 3.0 and later, .NET 5 and later | ✅ | Data comes from EventPipe; developed and tested on .NET 10 |
| Mono | ❌ | Mono has no EventPipe, so counters, metrics and GC events are unavailable |
| Unity | ❌ | Not supported: requires a runtime with EventPipe |
| Background profiling with automatic detection of performance issues (Windows) | ❌ | Not implemented, see section 3 |

---

## 2. Performance tab — charts

| Requirement | Status | Notes |
| --- | --- | --- |
| CPU chart | ✅ | Load in percent, 100 % means all cores of the process are fully loaded |
| GC chart | ✅ | Allocation rate plus a marker for every collection (colour = generation, tooltip = reason and pause), and automatic detection of intervals with long pauses or high collection rate |
| Memory chart | ✅ | Private memory as an area, managed heap and working set as lines |
| Hover over a chart shows data point details | ✅ | Tooltip with every series value and GC events close to the point |
| UI freeze and bottleneck intervals on the CPU chart | 🟡 | CPU saturation and GC pressure intervals are detected automatically; UI freezes and thread-pool starvation are not |
| List of detected issues with «Analyze Issue» | ✅ | Issues are listed both in the charts panel and in the native **Issues** view with severity and interval; clicking one selects its time range on the charts. Recording a profile for the interval is not offered |
| Time range analysis | 🟡 | Dragging a chart selects a range and shows min / avg / max, GC count and average pause. Recording a profile for that range is not supported |
| Analyze the whole session with a profiler | 🟡 | A profile can be recorded on demand (section 4), but the monitoring data itself is not opened in a profiler |

### Memory calculation per platform

| Platform | Reference behaviour | Status | Notes |
| --- | --- | --- | --- |
| Windows | Commit Charge of the process (`PROCESS_MEMORY_COUNTERS_EX.PrivateUsage`) | ✅ | Same source |
| Linux | Sum of `Private_Clean` and `Private_Dirty` from `smaps_rollup`, fallback `smaps` | ✅ | Same source, plus `Private_Hugetlb` |
| macOS | Resident private bytes plus swapped private bytes, iterating memory regions | 🟡 | Physical footprint through `proc_pid_rusage`; region-by-region accounting is not implemented, so values may differ slightly |

> Different tools show different metrics (private memory against resident/working set), so the numbers are
> not expected to match exactly.

### Automatic issue detection

| Requirement | Status | Notes |
| --- | --- | --- |
| CPU saturation intervals | ✅ | Load at or above 90 % for three refreshes in a row, short gaps are merged |
| Long GC pauses | ✅ | Single pause of 100 ms or more, 300 ms and above is critical |
| High GC activity intervals | ✅ | 10 or more collections with 200 ms or more of pauses inside a 10-second window |
| Allocation spikes | ✅ | Rate three times above the session median and at least 1 MB/s |
| Issue list with navigation to the interval | ✅ | Sorted from the newest, click selects the range and the charts zoom out to fit it |
| Turning detection off | ✅ | The `monitor-dotnet.enableIssueDetection` setting; the native view explains that detection is off |
| Native list of issues | ✅ | The **Issues** view in the same activity-bar container, works with the charts panel closed |

---

## 3. Background profiling (not implemented)

The reference tool collects detailed performance data in the background during run and debug sessions and
automatically detects performance issues. Not implemented in Monitor Dotnet.

What exists instead:

- a recording of a `dotnet-trace` profile on demand, started from the panel toolbar;
- a call stack snapshot and a memory snapshot on demand.

Detection of suspicious intervals and the issue list are implemented — see section 2, «Automatic issue
detection». They work on the data the charts already collect, so no background profiling session is needed.

Planned next steps, in order of value:

1. selecting a profiling type when recording a profile (CPU sampling against GC and runtime events);
2. recording a profile straight from an issue interval («Analyze Issue»);
3. exact macOS private memory accounting parity.

---

## 4. Counters tab

| Requirement | Status | Notes |
| --- | --- | --- |
| Classic counters (`EventCounters`) | ✅ | Grouped by provider, tooltip with mean, interval, min, max and counter type |
| Metrics (`System.Diagnostics.Metrics`) | ✅ | Grouped by meter, tagged series are kept apart |
| Counter provider configuration | ✅ | `MyProvider` for every counter of the provider, `MyProvider[Counter1,Counter2]` for the listed ones |
| Metric provider configuration | ✅ | `*` for every meter, `MyMeter`, `MyMeter\MyInstrument` |
| Refresh interval | ✅ | Setting from 0.2 to 60 seconds |
| Default provider set | ✅ | `System.Runtime`, `Microsoft.AspNetCore.Hosting`, `Microsoft.AspNetCore.Server.Kestrel`, `System.Net.Http`, `System.Net.Sockets` |

---

## 5. Environment tab

| Requirement | Status | Notes |
| --- | --- | --- |
| Environment variables of the application | ✅ | Read from the operating system, not from the editor environment |
| System properties | ✅ | .NET version, startup flags, command line, OS, architecture, processor count, user, machine |
| Filtering and copying | ✅ | Added on top of the reference behaviour: filter by name or value, copy a value to the clipboard |

---

## 6. Monitoring modes

| Requirement | Status | Notes |
| --- | --- | --- |
| On debug or run | ✅ | Default |
| On debug | ✅ | Sessions started without a debugger are ignored |
| Never | ✅ | Manual start and attach remain available |
| Automatic start on a debug session | ✅ | The process is found by attach PID, program path, name filter or session start time |

---

## 7. Profiling data from the toolbar

| Requirement | Status | Notes |
| --- | --- | --- |
| Collect call stack | ✅ | `dotnet-stack`, opened as a text document with the stacks of all threads |
| Get memory snapshot | ✅ | `dotnet-gcdump`, saved as `.gcdump` and revealed in the file manager. There is no built-in memory profiler in VS Code, so the file is opened by an external tool of your choice |
| Start or stop a performance profile | ✅ | `dotnet-trace` in the Speedscope format, which opens in a browser or in VS Code |
| Choice between sampling and timeline profiling | ❌ | The CPU sampling profile is always used |
| Missing tool handling | ✅ | The extension offers to install the tool with a single command |

---

## 8. Out of scope

- Mono and Unity (no EventPipe support).
- Built-in profilers and a snapshot analyser: Monitor Dotnet records standard `.nettrace` and `.gcdump`
  files, which are analysed by other tools.
