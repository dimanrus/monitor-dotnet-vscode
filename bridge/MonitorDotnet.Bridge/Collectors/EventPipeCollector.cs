using System.Diagnostics.Tracing;
using Microsoft.Diagnostics.NETCore.Client;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Parsers;
using MonitorDotnet.Bridge.Cli;
using MonitorDotnet.Bridge.Counters;
using MonitorDotnet.Bridge.Host;
using MonitorDotnet.Bridge.Protocol;

namespace MonitorDotnet.Bridge.Collectors;

/// <summary>
/// Подключение к целевому процессу через EventPipe и разбор потока событий.
/// Отсюда приходят классические счётчики (<c>EventCounters</c>), метрики
/// (<c>System.Diagnostics.Metrics</c>) и события сборки мусора (провайдер CLR).
/// </summary>
internal sealed class EventPipeCollector : IDisposable
{
    private readonly BridgeOptions _options;
    private readonly SampleBuffer _buffer;
    private readonly BridgeLog _log;
    private readonly SessionClock _clock;

    // Незакрытые сборки мусора: ключ — номер сборки, значение — сведения о начале.
    private readonly Dictionary<long, GcStartInfo> _pendingGcStart = new();

    private EventPipeSession? _session;
    private EventPipeEventSource? _source;
    private Thread? _pump;

    public EventPipeCollector(BridgeOptions options, SampleBuffer buffer, BridgeLog log, SessionClock clock)
    {
        _options = options;
        _buffer = buffer;
        _log = log;
        _clock = clock;
    }

    /// <summary>Сведения о процессе, полученные из событий.</summary>
    public TargetProcessInfo TargetInfo { get; } = new();

    /// <summary>
    /// Запускает сессию EventPipe и поток разбора событий.
    /// Бросает исключение, если к процессу нельзя подключиться.
    /// </summary>
    public void Start()
    {
        var client = new DiagnosticsClient(_options.Pid);
        _session = client.StartEventPipeSession(BuildProviders(), requestRundown: false);
        _source = new EventPipeEventSource(_session.EventStream);
        Subscribe(_source);

        _pump = new Thread(PumpLoop)
        {
            IsBackground = true,
            Name = "eventpipe-pump",
        };
        _pump.Start();

        _log.Info($"EventPipe session started for process {_options.Pid}.");
    }

    /// <summary>Поток разбора: Process() возвращает управление после остановки сессии.</summary>
    private void PumpLoop()
    {
        try
        {
            _source?.Process();
        }
        catch (Exception ex)
        {
            // Останавливается и при штатном закрытии сессии — пишем в лог только в отладочном режиме.
            _log.Debug($"EventPipe pump finished: {ex.Message}");
        }
    }

    /// <summary>Собирает список провайдеров для сессии.</summary>
    private List<EventPipeProvider> BuildProviders()
    {
        var providers = new List<EventPipeProvider>();
        string interval = _options.RefreshIntervalSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture);

        // Классические счётчики: ключевое слово 0 включает только события EventCounters.
        foreach (ProviderSpec spec in _options.CounterProviders)
        {
            providers.Add(new EventPipeProvider(
                spec.Provider,
                EventLevel.Informational,
                keywords: 0,
                new Dictionary<string, string> { ["EventCounterIntervalSec"] = interval }));
        }

        // Метрики: без аргумента Metrics среда выполнения не публикует значения инструментов.
        var metricsArguments = new Dictionary<string, string>
        {
            ["EventCounterIntervalSec"] = interval,
            ["Metrics"] = _options.BuildMetricsFilterArgument(),
            ["RefreshInterval"] = interval,
            ["MaxTimeSeries"] = "10000",
            ["MaxHistograms"] = "100",
        };
        providers.Add(new EventPipeProvider("System.Diagnostics.Metrics", EventLevel.Informational, keywords: -1, metricsArguments));

        // События сборки мусора и размеры поколений приходят от провайдера CLR.
        if (_options.CollectGcEvents)
        {
            providers.Add(new EventPipeProvider(
                "Microsoft-Windows-DotNETRuntime",
                EventLevel.Informational,
                (long)ClrTraceEventParser.Keywords.GC,
                arguments: null));
        }

        return providers;
    }

    /// <summary>Подписывается на нужные события потока.</summary>
    private void Subscribe(EventPipeEventSource source)
    {
        // Счётчики, метрики и сведения о процессе приходят как динамические события.
        source.Dynamic.All += HandleDynamicEvent;

        if (_options.CollectGcEvents)
        {
            source.Clr.GCStart += data =>
            {
                _pendingGcStart[data.Count] = new GcStartInfo(data.TimeStampRelativeMSec, data.Reason.ToString(), data.Type.ToString());
                _buffer.AddGcEvent(new GcEventValue(
                    _clock.ToUnixMs(data.TimeStampRelativeMSec),
                    data.Depth,
                    data.Reason.ToString(),
                    data.Type.ToString(),
                    WireContract.GcPhaseStart,
                    DurationMs: null,
                    data.Count));
            };

            source.Clr.GCStop += data =>
            {
                double? duration = null;
                string reason = string.Empty;
                string gcType = string.Empty;

                // Причина и тип известны из события начала: переносим их в завершение,
                // чтобы расширению не приходилось сопоставлять пары событий.
                if (_pendingGcStart.Remove(data.Count, out GcStartInfo start))
                {
                    duration = Math.Max(0, data.TimeStampRelativeMSec - start.StartedAt);
                    reason = start.Reason;
                    gcType = start.GcType;
                }

                _buffer.AddGcEvent(new GcEventValue(
                    _clock.ToUnixMs(data.TimeStampRelativeMSec),
                    data.Depth,
                    reason,
                    gcType,
                    WireContract.GcPhaseStop,
                    duration,
                    data.Count));
            };

            // Размеры поколений после сборки — источник данных для графика памяти управляемой кучи.
            source.Clr.GCHeapStats += data => _buffer.SetHeapSizes(
                data.GenerationSize0,
                data.GenerationSize1,
                data.GenerationSize2,
                data.GenerationSize3);

            // Сведения о среде выполнения и флагах запуска.
            source.Clr.RuntimeStart += data =>
            {
                TargetInfo.SetRuntimeVersion($"{data.BclMajorVersion}.{data.BclMinorVersion}.{data.BclBuildNumber}");
                TargetInfo.SetStartupFlags(data.StartupFlags.ToString());
                TargetInfo.SetCommandLine(data.CommandLine);
            };
        }
    }

    /// <summary>Обработка динамических событий: счётчики, метрики, сведения о процессе.</summary>
    private void HandleDynamicEvent(TraceEvent data)
    {
        switch (data.EventName)
        {
            case "EventCounters":
                HandleEventCounters(data);
                return;

            case "CounterRateValuePublished":
            case "CounterValuePublished":
            case "UpDownCounterRateValuePublished":
            case "UpDownCounterValuePublished":
            case "GaugeValuePublished":
            case "HistogramValuePublished":
            case "Base2ExponentialHistogramValuePublished":
                HandleMetric(data);
                return;

            case "ProcessInfo":
                TargetInfo.SetCommandLine(NumericConvert.ToText(data.PayloadByName("CommandLine")));
                TargetInfo.SetOs(NumericConvert.ToText(data.PayloadByName("OSInformation")));
                TargetInfo.SetArchitecture(NumericConvert.ToText(data.PayloadByName("ArchInformation")));
                return;

            case "Version":
                // Событие Version присылают разные провайдеры; любое из них описывает среду выполнения целевого процесса.
                string? major = NumericConvert.ToText(data.PayloadByName("Major"));
                if (major is not null)
                {
                    string? minor = NumericConvert.ToText(data.PayloadByName("Minor"));
                    string? patch = NumericConvert.ToText(data.PayloadByName("Patch"));
                    TargetInfo.SetRuntimeVersion($"{major}.{minor}.{patch}");
                }

                return;
        }
    }

    /// <summary>Разбор значения классического счётчика.</summary>
    private void HandleEventCounters(TraceEvent data)
    {
        // Полезная нагрузка события — строка JSON, лежащая в безымянном поле.
        string? json = NumericConvert.ToText(GetPayloadValue(data, string.Empty));
        if (string.IsNullOrEmpty(json))
        {
            return;
        }

        ProviderSpec? spec = _options.CounterProviders.FirstOrDefault(p =>
            string.Equals(p.Provider, data.ProviderName, StringComparison.OrdinalIgnoreCase));

        foreach (EventCounterPayload payload in EventCounterPayload.ParseMany(json, data.ProviderName, _log))
        {
            // Если пользователь выбрал конкретные счётчики — остальные не показываем.
            if (spec is not null && !spec.Matches(payload.Name))
            {
                continue;
            }

            _buffer.AddCounter(new CounterValue(
                data.ProviderName,
                payload.Name,
                payload.DisplayName,
                payload.DisplayUnits,
                payload.CounterType,
                payload.EffectiveValue,
                payload.Mean,
                payload.Min,
                payload.Max,
                payload.StandardDeviation,
                payload.IntervalSeconds,
                payload.Series,
                payload.SampleCount));
        }
    }

    /// <summary>Разбор значения метрики.</summary>
    private void HandleMetric(TraceEvent data)
    {
        string? meter = NumericConvert.ToText(data.PayloadByName("meterName"));
        string? instrument = NumericConvert.ToText(data.PayloadByName("instrumentName"));
        if (string.IsNullOrEmpty(meter) || string.IsNullOrEmpty(instrument))
        {
            return;
        }

        ProviderSpec? spec = _options.MetricProviders.FirstOrDefault(p =>
            string.Equals(p.Provider, meter, StringComparison.OrdinalIgnoreCase));
        if (spec is not null && !spec.Matches(instrument))
        {
            return;
        }

        (string kind, double value) = ExtractMetricValue(data);
        if (double.IsNaN(value))
        {
            return;
        }

        _buffer.AddMetric(new MetricValue(
            meter,
            NumericConvert.ToText(data.PayloadByName("meterVersion")),
            instrument,
            kind,
            NumericConvert.ToText(data.PayloadByName("unit")),
            value,
            NumericConvert.ToDouble(data.PayloadByName("rate")),
            NumericConvert.ToInt64(data.PayloadByName("count")),
            NumericConvert.ToDouble(data.PayloadByName("sum")),
            NumericConvert.ToText(data.PayloadByName("tags")),
            Description: null));
    }

    /// <summary>
    /// Определяет вид инструмента и его значение.
    /// Названия полей отличаются между версиями событий, поэтому перебираем известные варианты.
    /// </summary>
    private static (string Kind, double Value) ExtractMetricValue(TraceEvent data)
    {
        string kind = data.EventName switch
        {
            "GaugeValuePublished" => WireContract.MetricKindGauge,
            "HistogramValuePublished" or "Base2ExponentialHistogramValuePublished" => WireContract.MetricKindHistogram,
            "UpDownCounterValuePublished" or "UpDownCounterRateValuePublished" => WireContract.MetricKindUpDownCounter,
            _ => WireContract.MetricKindCounter,
        };

        // Порядок важен: у гистограмм показываем сумму за интервал, у остальных — мгновенное значение.
        foreach (string field in new[] { "value", "lastValue", "sum", "rate" })
        {
            double? value = NumericConvert.ToDouble(GetPayloadValue(data, field));
            if (value is not null)
            {
                return (kind, value.Value);
            }
        }

        return (kind, double.NaN);
    }

    /// <summary>
    /// Читает значение поля события по имени, не падая при отсутствии поля
    /// (у разных поставщиков наборы полей отличаются).
    /// </summary>
    private static object? GetPayloadValue(TraceEvent data, string name)
    {
        try
        {
            if (data.PayloadByName(name) is { } value)
            {
                return value;
            }
        }
        catch (Exception)
        {
            // Поле отсутствует в описании события — это нормально для части версий.
        }

        // Для событий без описанных полей (безымянная нагрузка EventCounters) пробуем взять значение по индексу.
        if (data.PayloadNames.Length == 0 && name.Length == 0)
        {
            try
            {
                return data.PayloadByName(string.Empty);
            }
            catch (Exception)
            {
                return null;
            }
        }

        return null;
    }

    /// <summary>Сведения о начале сборки мусора, нужные для описания её завершения.</summary>
    private readonly record struct GcStartInfo(double StartedAt, string Reason, string GcType);

    public void Dispose()
    {
        try
        {
            _session?.Stop();
        }
        catch (Exception ex)
        {
            _log.Debug($"Failed to stop the EventPipe session: {ex.Message}");
        }

        try
        {
            _pump?.Join(TimeSpan.FromSeconds(2));
        }
        catch (Exception)
        {
            // Поток разбора мог уже завершиться — это ожидаемо.
        }

        _source?.Dispose();
        _session?.Dispose();
    }
}
