using System.Globalization;

namespace MonitorDotnet.Bridge.Counters;

/// <summary>
/// Одно значение классического счётчика (<c>EventCounters</c>), как его присылает событие
/// <c>EventCounters</c> провайдера: полезная нагрузка — JSON вида
/// <c>{ "Payload": { "Name": "...", "Mean": ..., "CounterType": "Mean", ... } }</c>.
/// </summary>
internal sealed class EventCounterPayload
{
    /// <summary>Имя счётчика, например <c>cpu-usage</c>.</summary>
    public string Name { get; init; } = string.Empty;

    /// <summary>Отображаемое имя, например <c>CPU Usage</c>.</summary>
    public string? DisplayName { get; init; }

    /// <summary>Единицы измерения, например <c>%</c> или <c>B</c>.</summary>
    public string? DisplayUnits { get; init; }

    /// <summary>Тип счётчика: <c>Mean</c>, <c>Sum</c>, <c>Rate</c> и т. п.</summary>
    public string? CounterType { get; init; }

    /// <summary>Среднее значение за интервал.</summary>
    public double? Mean { get; init; }

    /// <summary>Сумма значений за интервал (для счётчиков типа Sum).</summary>
    public double? Sum { get; init; }

    /// <summary>Приращение за интервал — именно его присылают счётчики типа Sum (например, alloc-rate).</summary>
    public double? Increment { get; init; }

    /// <summary>
    /// Масштаб времени, к которому приводится приращение (в dotnet-counters отображается как «B / 1 sec»).
    /// Задаётся строкой вида <c>00:00:01</c>.
    /// </summary>
    public double RateSeconds { get; init; } = 1;

    /// <summary>Минимальное/максимальное значение за интервал.</summary>
    public double? Min { get; init; }

    public double? Max { get; init; }

    /// <summary>Стандартное отклонение значений интервала.</summary>
    public double? StandardDeviation { get; init; }

    /// <summary>Длительность интервала в секундах.</summary>
    public double IntervalSeconds { get; init; } = 1;

    /// <summary>Описание серии (например, <c>Interval=1000</c>).</summary>
    public string? Series { get; init; }

    /// <summary>Сколько измерений попало в интервал (для Mean-счётчиков).</summary>
    public int SampleCount { get; init; } = 1;

    /// <summary>Признак счётчика-суммы: значение накапливается, а не усредняется.</summary>
    public bool IsSum => string.Equals(CounterType, "Sum", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Итоговое значение для отображения.
    /// Для счётчиков-сумм приводим приращение к масштабу времени (как в dotnet-counters),
    /// для остальных берём среднее за интервал.
    /// </summary>
    public double EffectiveValue => IsSum
        ? (Increment ?? Sum ?? 0) / Math.Max(RateSeconds, 0.001)
        : Mean ?? Sum ?? Increment ?? 0;

    /// <summary>
    /// Достаёт из строки JSON (вида <c>{"Payload":{...}}</c> или массива таких объектов)
    /// все значения счётчиков одного события.
    /// </summary>
    public static IReadOnlyList<EventCounterPayload> ParseMany(string json, string providerName, Host.BridgeLog log)
    {
        var result = new List<EventCounterPayload>(1);
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(json);
            if (!document.RootElement.TryGetProperty("Payload", out var payload))
            {
                return result;
            }

            if (payload.ValueKind == System.Text.Json.JsonValueKind.Array)
            {
                foreach (var item in payload.EnumerateArray())
                {
                    result.Add(ParseSingle(item));
                }
            }
            else if (payload.ValueKind == System.Text.Json.JsonValueKind.Object)
            {
                result.Add(ParseSingle(payload));
            }
        }
        catch (Exception ex)
        {
            log.Warning($"Could not parse a counter payload of provider '{providerName}': {ex.Message}");
        }

        return result;
    }

    private static EventCounterPayload ParseSingle(System.Text.Json.JsonElement element)
    {
        return new EventCounterPayload
        {
            Name = GetString(element, "Name") ?? string.Empty,
            DisplayName = GetString(element, "DisplayName"),
            DisplayUnits = GetString(element, "DisplayUnits"),
            CounterType = GetString(element, "CounterType"),
            Mean = GetDouble(element, "Mean"),
            Sum = GetDouble(element, "Sum"),
            Increment = GetDouble(element, "Increment"),
            RateSeconds = GetRateSeconds(element),
            Min = GetDouble(element, "Min"),
            Max = GetDouble(element, "Max"),
            StandardDeviation = GetDouble(element, "StandardDeviation"),
            IntervalSeconds = GetDouble(element, "IntervalSec") ?? 1,
            Series = GetString(element, "Series"),
            SampleCount = GetInt(element, "Count") ?? 1,
        };
    }

    private static string? GetString(System.Text.Json.JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == System.Text.Json.JsonValueKind.String
            ? value.GetString()
            : null;

    /// <summary>Разбирает масштаб времени («00:00:01») в секунды; по умолчанию — одна секунда.</summary>
    private static double GetRateSeconds(System.Text.Json.JsonElement element)
    {
        string? scale = GetString(element, "DisplayRateTimeScale");
        return scale is not null && TimeSpan.TryParse(scale, CultureInfo.InvariantCulture, out TimeSpan parsed) && parsed.TotalSeconds > 0
            ? parsed.TotalSeconds
            : 1;
    }

    private static double? GetDouble(System.Text.Json.JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == System.Text.Json.JsonValueKind.Number
            ? value.GetDouble()
            : null;

    private static int? GetInt(System.Text.Json.JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == System.Text.Json.JsonValueKind.Number
            ? (int)Math.Round(value.GetDouble(), MidpointRounding.AwayFromZero)
            : null;
}
