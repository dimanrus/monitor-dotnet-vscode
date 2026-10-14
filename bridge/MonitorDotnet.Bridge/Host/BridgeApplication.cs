using System.Diagnostics;
using MonitorDotnet.Bridge.Cli;
using MonitorDotnet.Bridge.Collectors;
using MonitorDotnet.Bridge.Platform;
using MonitorDotnet.Bridge.Protocol;

namespace MonitorDotnet.Bridge.Host;

/// <summary>
/// Основной сценарий моста: проверить процесс, поднять сессию EventPipe,
/// периодически отправлять срезы данных и корректно завершиться.
/// </summary>
internal static class BridgeApplication
{
    public static async Task<int> RunAsync(string[] args)
    {
        BridgeOptions options;
        try
        {
            options = BridgeOptions.Parse(args);
        }
        catch (BridgeUsageException ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 2;
        }

        using var writer = new WireWriter(Console.OpenStandardOutput());
        var log = new BridgeLog(options.LogLevel, writer);
        var clock = new SessionClock();
        var buffer = new SampleBuffer();

        using var process = TryOpenProcess(options.Pid);
        if (process is null)
        {
            writer.Write(new ErrorMessage(
                WireContract.TypeError,
                WireContract.ErrorProcessNotFound,
                $"Process with id {options.Pid} was not found.",
                Fatal: true));
            return 3;
        }

        writer.Write(new StatusMessage(WireContract.TypeStatus, WireContract.StateConnecting, Reason: null, Message: null));

        using var collector = new EventPipeCollector(options, buffer, log, clock);
        try
        {
            collector.Start();
        }
        catch (Exception ex)
        {
            writer.Write(new ErrorMessage(
                WireContract.TypeError,
                WireContract.ErrorConnectFailed,
                ex.Message,
                Fatal: true));
            return 4;
        }

        writer.Write(new StatusMessage(WireContract.TypeStatus, WireContract.StateRunning, Reason: null, Message: null));

        using var cancellation = new CancellationTokenSource();

        // Завершаемся, когда целевой процесс закрылся: держать мониторинг дальше нет смысла.
        process.EnableRaisingEvents = true;
        process.Exited += (_, _) => cancellation.Cancel();

        if (options.DurationSeconds > 0)
        {
            cancellation.CancelAfter(TimeSpan.FromSeconds(options.DurationSeconds));
        }

        try
        {
            Console.CancelKeyPress += (_, eventArgs) =>
            {
                eventArgs.Cancel = true;
                cancellation.Cancel();
            };
        }
        catch (Exception)
        {
            // В средах без консоли событие недоступно — игнорируем.
        }

        await RunSamplingLoopAsync(options, process, buffer, writer, collector, clock, cancellation.Token);

        writer.Write(new StatusMessage(
            WireContract.TypeStatus,
            WireContract.StateStopped,
            process.HasExited ? WireContract.ReasonTargetExited : null,
            process.HasExited ? "The target process has exited." : null));

        return 0;
    }

    /// <summary>Цикл выдачи срезов с заданным интервалом.</summary>
    private static async Task RunSamplingLoopAsync(
        BridgeOptions options,
        Process process,
        SampleBuffer buffer,
        WireWriter writer,
        EventPipeCollector collector,
        SessionClock clock,
        CancellationToken token)
    {
        var sampler = new ProcessStatsSampler(options.Pid, new BridgeLog(options.LogLevel, writer));
        var interval = TimeSpan.FromSeconds(options.RefreshIntervalSeconds);
        using var timer = new PeriodicTimer(interval);

        bool headerSent = false;
        try
        {
            // Первый сэмпл пропускаем: загрузку процессора можно посчитать только по приращению времени.
            while (await timer.WaitForNextTickAsync(token))
            {
                DrainedSample drained = buffer.Drain();
                ProcessSnapshot? snapshot = sampler.TrySample(drained);
                if (snapshot is null)
                {
                    break;
                }

                // Накопительные счётчики сборок мусора берём из буфера: их считает обработчик событий GC.
                snapshot = snapshot with { GcCollections = buffer.GetCollectionCounts() };

                if (!headerSent)
                {
                    // hello и environment отправляем после первого интервала: к этому моменту
                    // события EventPipe уже сообщили версию среды выполнения и командную строку.
                    writer.Write(BuildHello(options, process, collector, clock));
                    if (options.CollectEnvironment)
                    {
                        writer.Write(BuildEnvironment(options, collector));
                    }

                    headerSent = true;
                }

                writer.Write(new SampleMessage(
                    WireContract.TypeSample,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    snapshot,
                    drained.Counters,
                    drained.Metrics,
                    drained.GcEvents));
            }
        }
        catch (OperationCanceledException)
        {
            // Штатное завершение по сигналу или по выходу целевого процесса.
        }
    }

    /// <summary>Сообщение <c>hello</c> с основными сведениями о подключении.</summary>
    private static HelloMessage BuildHello(
        BridgeOptions options,
        Process process,
        EventPipeCollector collector,
        SessionClock clock)
    {
        TargetProcessInfo info = collector.TargetInfo;
        return new HelloMessage(
            WireContract.TypeHello,
            ProtocolVersion.Current,
            options.Pid,
            TryGetProcessName(process),
            info.RuntimeVersion,
            info.Os ?? System.Runtime.InteropServices.RuntimeInformation.OSDescription,
            info.Architecture ?? System.Runtime.InteropServices.RuntimeInformation.OSArchitecture.ToString(),
            // Командная строка из событий приходит не всегда — читаем её напрямую из ОС.
            info.CommandLine ?? Platform.ProcessCommandLine.TryRead(options.Pid),
            Environment.ProcessorCount,
            clock.StartUnixMs);
    }

    /// <summary>Сообщение <c>environment</c>: переменные окружения и системные свойства.</summary>
    private static EnvironmentMessage BuildEnvironment(BridgeOptions options, EventPipeCollector collector)
    {
        (IReadOnlyList<KeyValuePair<string, string>> variables, string? warning) = ProcessEnvironment.Read(options.Pid);
        var properties = new List<KeyValuePair<string, string>>();
        var warnings = new List<string>();

        if (warning is not null)
        {
            warnings.Add(warning);
        }

        if (collector.TargetInfo.RuntimeVersion is { } runtime)
        {
            properties.Add(new KeyValuePair<string, string>(".NET runtime", runtime));
        }

        if (collector.TargetInfo.StartupFlags is { } flags)
        {
            properties.Add(new KeyValuePair<string, string>("Startup flags", flags));
        }

        if (collector.TargetInfo.CommandLine is { } commandLine)
        {
            properties.Add(new KeyValuePair<string, string>("Command line", commandLine));
        }

        properties.AddRange(ProcessEnvironment.GetSystemProperties());

        return new EnvironmentMessage(WireContract.TypeEnvironment, variables, properties, warnings);
    }

    private static Process? TryOpenProcess(int pid)
    {
        try
        {
            return Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private static string TryGetProcessName(Process process)
    {
        try
        {
            return process.ProcessName;
        }
        catch (Exception)
        {
            return "unknown";
        }
    }
}
