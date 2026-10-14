using MonitorDotnet.Bridge.Counters;
using MonitorDotnet.Bridge.Host;
using Xunit;

namespace MonitorDotnet.Bridge.Tests.Unit;

/// <summary>Проверки разбора полезной нагрузки классических счётчиков (EventCounters).</summary>
public sealed class EventCounterPayloadTests
{
    private static readonly BridgeLog Log = new(BridgeLogLevel.Error);

    [Fact]
    public void ParseMany_MeanCounter_UsesMeanAsValue()
    {
        const string json = """
            { "Payload":{ "Name":"cpu-usage", "DisplayName":"CPU Usage", "Mean":1.5, "StandardDeviation":0,
              "Count":1, "Min":1.5, "Max":1.5, "IntervalSec":1.0, "Series":"Interval=1000",
              "CounterType":"Mean", "Metadata":"", "DisplayUnits":"%" } }
            """;

        EventCounterPayload payload = Assert.Single(EventCounterPayload.ParseMany(json, "System.Runtime", Log));

        Assert.Equal("cpu-usage", payload.Name);
        Assert.Equal("CPU Usage", payload.DisplayName);
        Assert.Equal("%", payload.DisplayUnits);
        Assert.Equal(1.5, payload.EffectiveValue);
    }

    [Fact]
    public void ParseMany_SumCounter_UsesIncrementScaledByRate()
    {
        // Счётчики-суммы присылают приращение в поле Increment, а масштаб — в DisplayRateTimeScale.
        const string json = """
            { "Payload":{ "Name":"alloc-rate", "DisplayName":"Allocation Rate", "DisplayRateTimeScale":"00:00:02",
              "Increment":1000, "IntervalSec":1.0, "CounterType":"Sum", "DisplayUnits":"B" } }
            """;

        EventCounterPayload payload = Assert.Single(EventCounterPayload.ParseMany(json, "System.Runtime", Log));

        Assert.True(payload.IsSum);
        Assert.Equal(500, payload.EffectiveValue); // 1000 байт за 2 секунды
    }

    [Fact]
    public void ParseMany_ArrayPayload_ReturnsAllCounters()
    {
        const string json = """
            { "Payload":[ { "Name":"a", "Mean":1, "CounterType":"Mean" }, { "Name":"b", "Mean":2, "CounterType":"Mean" } ] }
            """;

        IReadOnlyList<EventCounterPayload> payloads = EventCounterPayload.ParseMany(json, "MyProvider", Log);

        Assert.Equal(2, payloads.Count);
        Assert.Equal(new[] { "a", "b" }, payloads.Select(p => p.Name));
    }

    [Fact]
    public void ParseMany_InvalidJson_ReturnsEmptyWithoutThrowing()
    {
        Assert.Empty(EventCounterPayload.ParseMany("не json", "MyProvider", Log));
        Assert.Empty(EventCounterPayload.ParseMany("{}", "MyProvider", Log));
    }
}
