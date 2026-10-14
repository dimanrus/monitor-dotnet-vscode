using System.Diagnostics;
using MonitorDotnet.Bridge.Host;
using MonitorDotnet.Bridge.Platform;
using MonitorDotnet.Bridge.Protocol;

namespace MonitorDotnet.Bridge.Collectors;

/// <summary>
/// Измеряет загрузку процессора, приватную память, рабочий набор и число потоков целевого процесса.
/// Значения CPU считаются как приращение процессорного времени между сэмплами —
/// это работает одинаково на Linux, macOS и Windows.
/// </summary>
internal sealed class ProcessStatsSampler
{
    private readonly int _pid;
    private readonly BridgeLog _log;

    private Process? _process;
    private TimeSpan _lastCpuTime;
    private long _lastSampleTimestamp;
    private bool _memoryFallbackWarned;

    // Последние известные значения «медленных» счётчиков — сглаживают рассинхронизацию интервалов.
    private readonly Dictionary<string, double> _lastCounterValues = new(StringComparer.OrdinalIgnoreCase);

    public ProcessStatsSampler(int pid, BridgeLog log)
    {
        _pid = pid;
        _log = log;
    }

    /// <summary>
    /// Формирует срез показателей процесса. Возвращает <c>null</c>, если процесс уже завершился.
    /// </summary>
    public ProcessSnapshot? TrySample(DrainedSample drained)
    {
        Process process;
        try
        {
            process = _process ??= Process.GetProcessById(_pid);
            process.Refresh();
            if (process.HasExited)
            {
                return null;
            }
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            // Процесс завершился — мониторинг нужно останавливать.
            return null;
        }

        double cpuPercent = MeasureCpu(process);
        long privateBytes = ProcessMemory.TryGetPrivateBytes(
            _pid,
            fallback: () => process.PrivateMemorySize64,
            onWarning: WarnAboutMemoryOnce);

        long workingSet;
        int threadCount;
        try
        {
            workingSet = process.WorkingSet64;
            threadCount = process.Threads.Count;
        }
        catch (Exception)
        {
            workingSet = 0;
            threadCount = 0;
        }

        double allocationRate = ResolveCounterValue("alloc-rate", drained, 0);
        double timeInGc = ResolveCounterValue("time-in-gc", drained, 0);
        double? exceptionsPerSecond = drained.FindCounterValue("exception-count") ?? _lastCounterValues.GetValueOrDefault("exception-count");

        return new ProcessSnapshot(
            Math.Round(cpuPercent, 2),
            privateBytes,
            workingSet,
            threadCount,
            drained.Gen0HeapBytes + drained.Gen1HeapBytes + drained.Gen2HeapBytes + drained.LohHeapBytes,
            drained.Gen0HeapBytes,
            drained.Gen1HeapBytes,
            drained.Gen2HeapBytes,
            drained.LohHeapBytes,
            allocationRate,
            timeInGc,
            new GcCollectionCounts(0, 0, 0), // Накопительные значения подставляет BridgeApplication из буфера.
            exceptionsPerSecond);
    }

    /// <summary>
    /// Значение счётчика для среза.
    /// Интервалы счётчиков и срезов могут не совпадать, поэтому при пропуске берём последнее известное значение —
    /// иначе графики периодически показывали бы нули.
    /// </summary>
    private double ResolveCounterValue(string name, DrainedSample drained, double fallback)
    {
        double? value = drained.FindCounterValue(name);
        if (value is null)
        {
            return _lastCounterValues.TryGetValue(name, out double previous) ? previous : fallback;
        }

        _lastCounterValues[name] = value.Value;
        return value.Value;
    }

    /// <summary>Приращение процессорного времени за прошедший интервал, в процентах от всех ядер.</summary>
    private double MeasureCpu(Process process)
    {
        long now = Stopwatch.GetTimestamp();
        TimeSpan cpuTime;
        try
        {
            cpuTime = process.TotalProcessorTime;
        }
        catch (Exception)
        {
            return 0;
        }

        double percent = 0;
        if (_lastSampleTimestamp != 0)
        {
            double wallMs = (now - _lastSampleTimestamp) * 1000.0 / Stopwatch.Frequency;
            double cpuMs = (cpuTime - _lastCpuTime).TotalMilliseconds;
            if (wallMs > 0)
            {
                // 100% соответствует полной загрузке всех ядер процесса.
                percent = cpuMs / wallMs / Environment.ProcessorCount * 100.0;
            }
        }

        _lastSampleTimestamp = now;
        _lastCpuTime = cpuTime;
        return Math.Clamp(percent, 0, 100 * Environment.ProcessorCount);
    }

    private void WarnAboutMemoryOnce(string message)
    {
        if (!_memoryFallbackWarned)
        {
            _memoryFallbackWarned = true;
            _log.Warning(message);
        }
    }
}
