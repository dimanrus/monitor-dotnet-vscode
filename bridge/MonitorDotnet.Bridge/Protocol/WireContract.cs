namespace MonitorDotnet.Bridge.Protocol;

/// <summary>
/// Модель данных, которой мост обменивается с расширением VS Code.
/// Все сообщения сериализуются в одну строку JSON (NDJSON) и содержат поле <c>type</c>.
/// </summary>
/// <remarks>
/// Типы сообщений (поле <c>type</c>):
/// <list type="bullet">
///   <item><c>hello</c> — информация о подключении и целевом процессе (приходит один раз);</item>
///   <item><c>sample</c> — периодический срез: CPU, память, счётчики, метрики, события GC;</item>
///   <item><c>environment</c> — переменные окружения и системные свойства целевого процесса;</item>
///   <item><c>status</c> — изменение состояния монитора;</item>
///   <item><c>error</c> — ошибка (возможно фатальная);</item>
///   <item><c>log</c> — диагностическое сообщение моста.</item>
/// </list>
/// </remarks>
internal static class WireContract
{
    public const string TypeHello = "hello";
    public const string TypeSample = "sample";
    public const string TypeEnvironment = "environment";
    public const string TypeStatus = "status";
    public const string TypeError = "error";
    public const string TypeLog = "log";

    public const string StateConnecting = "connecting";
    public const string StateRunning = "running";
    public const string StateStopped = "stopped";
    public const string StateFailed = "failed";

    /// <summary>
    /// Коды ошибок и причин остановки. Расширение переводит их на язык пользователя,
    /// поэтому текст сообщения остаётся английским запасным вариантом для журнала.
    /// </summary>
    public const string ErrorProcessNotFound = "processNotFound";
    public const string ErrorConnectFailed = "connectFailed";
    public const string ReasonTargetExited = "targetExited";

    /// <summary>Фаза GC-события.</summary>
    public const string GcPhaseStart = "start";
    public const string GcPhaseStop = "stop";

    /// <summary>Тип инструмента метрик.</summary>
    public const string MetricKindCounter = "counter";
    public const string MetricKindUpDownCounter = "updowncounter";
    public const string MetricKindGauge = "gauge";
    public const string MetricKindHistogram = "histogram";
}

/// <summary>Сообщение <c>hello</c>: что за процесс мы мониторим.</summary>
internal sealed record HelloMessage(
    string Type,
    string ProtocolVersion,
    int Pid,
    string ProcessName,
    string? RuntimeVersion,
    string Os,
    string Architecture,
    string? CommandLine,
    int ProcessorCount,
    long StartedAtUnixMs);

/// <summary>Снимок показателей процесса за текущий интервал.</summary>
internal sealed record ProcessSnapshot(
    double CpuPercent,
    long PrivateMemoryBytes,
    long WorkingSetBytes,
    int ThreadCount,
    long ManagedHeapBytes,
    long Gen0HeapBytes,
    long Gen1HeapBytes,
    long Gen2HeapBytes,
    long LohHeapBytes,
    double AllocationRateBytesPerSec,
    double TimeInGcPercent,
    GcCollectionCounts GcCollections,
    double? ExceptionsPerSecond);

/// <summary>Накопленное количество сборок мусора по поколениям.</summary>
internal sealed record GcCollectionCounts(long Gen0, long Gen1, long Gen2);

/// <summary>Значение счётчика EventCounters (провайдер → счётчик).</summary>
internal sealed record CounterValue(
    string Provider,
    string Name,
    string? DisplayName,
    string? Unit,
    string? CounterType,
    double Value,
    double? Mean,
    double? Min,
    double? Max,
    double? StandardDeviation,
    double IntervalSeconds,
    string? Series,
    int SampleCount);

/// <summary>Значение метрики (<c>System.Diagnostics.Metrics</c>).</summary>
internal sealed record MetricValue(
    string Meter,
    string? MeterVersion,
    string Instrument,
    string Kind,
    string? Unit,
    double Value,
    double? Rate,
    long? Count,
    double? Sum,
    string? Tags,
    string? Description);

/// <summary>Событие сборки мусора (начало или конец).</summary>
internal sealed record GcEventValue(
    long TimestampUnixMs,
    int Generation,
    string Reason,
    string GcType,
    string Phase,
    double? DurationMs,
    long Count);

/// <summary>Периодический срез данных мониторинга.</summary>
internal sealed record SampleMessage(
    string Type,
    long TimestampUnixMs,
    ProcessSnapshot Process,
    IReadOnlyList<CounterValue> Counters,
    IReadOnlyList<MetricValue> Metrics,
    IReadOnlyList<GcEventValue> GcEvents);

/// <summary>Переменные окружения и системные свойства целевого процесса.</summary>
internal sealed record EnvironmentMessage(
    string Type,
    IReadOnlyList<KeyValuePair<string, string>> Variables,
    IReadOnlyList<KeyValuePair<string, string>> Properties,
    IReadOnlyList<string> Warnings);

/// <summary>Состояние монитора. Код причины переводит расширение, текст — запасной вариант.</summary>
internal sealed record StatusMessage(string Type, string State, string? Reason, string? Message);

/// <summary>
/// Ошибка моста.
/// Поле <c>code</c> расширение переводит само, а <c>message</c> содержит подробность
/// (например, текст исключения) либо английский вариант для журнала, если код неизвестен.
/// </summary>
internal sealed record ErrorMessage(string Type, string Code, string Message, bool Fatal);

/// <summary>Диагностическое сообщение.</summary>
internal sealed record LogMessage(string Type, string Level, string Message);
