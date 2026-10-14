using System.Globalization;
using MonitorDotnet.Bridge.Counters;
using MonitorDotnet.Bridge.Host;

namespace MonitorDotnet.Bridge.Cli;

/// <summary>
/// Параметры запуска моста. Задаются расширением VS Code при старте процесса.
/// </summary>
internal sealed class BridgeOptions
{
    /// <summary>Идентификатор процесса, который мониторим (обязательный).</summary>
    public int Pid { get; private set; }

    /// <summary>Интервал выдачи срезов и опроса счётчиков, секунды.</summary>
    public double RefreshIntervalSeconds { get; private set; } = 1.0;

    /// <summary>Ограничение времени работы (используется автотестами); 0 — без ограничения.</summary>
    public double DurationSeconds { get; private set; }

    /// <summary>Провайдеры счётчиков EventCounters.</summary>
    public IReadOnlyList<ProviderSpec> CounterProviders { get; private set; } = DefaultCounterProviders();

    /// <summary>Фильтры метров (<c>System.Diagnostics.Metrics</c>); по умолчанию все (<c>*</c>).</summary>
    public IReadOnlyList<ProviderSpec> MetricProviders { get; private set; } = new[] { ProviderSpec.TryParse("*")! };

    /// <summary>Собирать переменные окружения целевого процесса.</summary>
    public bool CollectEnvironment { get; private set; } = true;

    /// <summary>Собирать события GC.</summary>
    public bool CollectGcEvents { get; private set; } = true;

    /// <summary>Уровень диагностики.</summary>
    public BridgeLogLevel LogLevel { get; private set; } = BridgeLogLevel.Warning;

    /// <summary>Провайдеры счётчиков по умолчанию — базовый набор .NET (как в dotnet-counters).</summary>
    public static IReadOnlyList<ProviderSpec> DefaultCounterProviders() => new[]
    {
        ProviderSpec.TryParse("System.Runtime")!,
        ProviderSpec.TryParse("Microsoft.AspNetCore.Hosting")!,
        ProviderSpec.TryParse("Microsoft.AspNetCore.Server.Kestrel")!,
        ProviderSpec.TryParse("System.Net.Http")!,
        ProviderSpec.TryParse("System.Net.Sockets")!,
    };

    /// <summary>Разбирает аргументы командной строки. Бросает исключение при ошибке ввода.</summary>
    public static BridgeOptions Parse(string[] args)
    {
        var options = new BridgeOptions();
        var counterSpecs = new List<string>();
        var metricSpecs = new List<string>();
        string[] normalized = NormalizeAssignments(args);

        for (int i = 0; i < normalized.Length; i++)
        {
            string arg = normalized[i];
            switch (arg)
            {
                case "--pid":
                    options.Pid = int.Parse(NextValue(normalized, ref i, arg), CultureInfo.InvariantCulture);
                    break;
                case "--refresh-interval":
                    options.RefreshIntervalSeconds = Math.Clamp(
                        double.Parse(NextValue(normalized, ref i, arg), CultureInfo.InvariantCulture), 0.2, 60);
                    break;
                case "--duration-seconds":
                    options.DurationSeconds = double.Parse(NextValue(normalized, ref i, arg), CultureInfo.InvariantCulture);
                    break;
                case "--counters":
                    counterSpecs.Add(NextValue(normalized, ref i, arg));
                    break;
                case "--metrics":
                    metricSpecs.Add(NextValue(normalized, ref i, arg));
                    break;
                case "--no-environment":
                    options.CollectEnvironment = false;
                    break;
                case "--no-gc-events":
                    options.CollectGcEvents = false;
                    break;
                case "--log-level":
                    options.LogLevel = Enum.Parse<BridgeLogLevel>(NextValue(normalized, ref i, arg), ignoreCase: true);
                    break;
                case "--help":
                case "-h":
                    throw new BridgeUsageException(UsageText);
                default:
                    throw new BridgeUsageException($"Unknown argument '{arg}'.{Environment.NewLine}{UsageText}");
            }
        }

        if (options.Pid <= 0)
        {
            throw new BridgeUsageException($"The required argument --pid is missing.{Environment.NewLine}{UsageText}");
        }

        if (counterSpecs.Count > 0)
        {
            options.CounterProviders = ProviderSpec.ParseList(counterSpecs);
        }

        if (metricSpecs.Count > 0)
        {
            options.MetricProviders = ProviderSpec.ParseList(metricSpecs);
        }

        return options;
    }

    /// <summary>
    /// Приводит «--pid=1234» к паре «--pid 1234»: так разбор остаётся линейным и без ветвлений.
    /// </summary>
    private static string[] NormalizeAssignments(string[] args)
    {
        var result = new List<string>(args.Length);
        foreach (string arg in args)
        {
            int index = arg.IndexOf('=');
            if (arg.StartsWith("--", StringComparison.Ordinal) && index > 2)
            {
                result.Add(arg[..index]);
                result.Add(arg[(index + 1)..]);
            }
            else
            {
                result.Add(arg);
            }
        }

        return result.ToArray();
    }

    private static string NextValue(string[] args, ref int index, string name)
    {
        if (index + 1 >= args.Length)
        {
            throw new BridgeUsageException($"Argument {name} requires a value.{Environment.NewLine}{UsageText}");
        }

        return args[++index];
    }

    /// <summary>
    /// Формирует значение аргумента <c>Metrics</c> для сессии EventPipe.
    /// Важно: .NET публикует значения метрик только для явно перечисленных метров,
    /// поэтому без настройки передаём «*» (все метры).
    /// </summary>
    public string BuildMetricsFilterArgument()
    {
        if (MetricProviders.Count == 0 || MetricProviders.Any(p => p.Provider == "*"))
        {
            return "*";
        }

        return string.Join(",", MetricProviders.Select(spec =>
            spec.IncludesAllCounters
                ? spec.Provider
                : $"{spec.Provider}\\{string.Join(",", spec.Counters)}"));
    }

    public const string UsageText = """
        .NET monitoring bridge for the Monitor Dotnet extension.

        Usage:
          MonitorDotnet.Bridge --pid <PID> [options]

        Options:
          --pid <PID>                   id of the process to monitor (required)
          --refresh-interval <sec>      how often to emit data (default 1)
          --counters <spec>             counter providers, e.g. System.Runtime or MyProvider[Counter1,Counter2]
          --metrics <spec>              meter filter, e.g. * or MyMeter[MyInstrument]
          --no-environment              do not collect environment variables of the target process
          --no-gc-events                do not collect GC events
          --duration-seconds <sec>      stop after the given time (used by tests)
          --log-level <level>           error | warning | info | debug
          --help                        show this help
        """;
}

/// <summary>Ошибка разбора аргументов командной строки.</summary>
internal sealed class BridgeUsageException : Exception
{
    public BridgeUsageException(string message) : base(message)
    {
    }
}
