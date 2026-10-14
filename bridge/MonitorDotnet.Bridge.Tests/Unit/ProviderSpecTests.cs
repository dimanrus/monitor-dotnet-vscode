using MonitorDotnet.Bridge.Counters;
using Xunit;

namespace MonitorDotnet.Bridge.Tests.Unit;

/// <summary>Проверки разбора спецификаций провайдеров счётчиков и метрик.</summary>
public sealed class ProviderSpecTests
{
    [Fact]
    public void Parse_ProviderWithoutCounters_IncludesAllCounters()
    {
        ProviderSpec? spec = ProviderSpec.TryParse("System.Runtime");

        Assert.NotNull(spec);
        Assert.Equal("System.Runtime", spec!.Provider);
        Assert.True(spec.IncludesAllCounters);
        Assert.True(spec.Matches("cpu-usage"));
    }

    [Fact]
    public void Parse_ProviderWithCounters_SelectsOnlyListedOnes()
    {
        ProviderSpec? spec = ProviderSpec.TryParse("MyProvider[Counter1, Counter2]");

        Assert.NotNull(spec);
        Assert.Equal("MyProvider", spec!.Provider);
        Assert.Equal(new[] { "Counter1", "Counter2" }, spec.Counters);
        Assert.True(spec.Matches("counter1"));
        Assert.False(spec.Matches("Counter3"));
    }

    [Fact]
    public void ParseList_SplitsByCommasOutsideBrackets()
    {
        IReadOnlyList<ProviderSpec> specs = ProviderSpec.ParseList(new[]
        {
            "System.Runtime,MyProvider[A,B]",
            "Microsoft.AspNetCore.Hosting",
        });

        Assert.Equal(3, specs.Count);
        Assert.Equal("System.Runtime", specs[0].Provider);
        Assert.Equal("MyProvider", specs[1].Provider);
        Assert.Equal(new[] { "A", "B" }, specs[1].Counters);
        Assert.Equal("Microsoft.AspNetCore.Hosting", specs[2].Provider);
    }

    [Fact]
    public void Parse_EmptyOrInvalid_ReturnsNull()
    {
        Assert.Null(ProviderSpec.TryParse("   "));
        Assert.Null(ProviderSpec.TryParse("[Counter]"));
    }

    [Fact]
    public void ToString_RoundTripsSelection()
    {
        ProviderSpec? spec = ProviderSpec.TryParse("MyProvider[A,B]");

        Assert.Equal("MyProvider[A,B]", spec!.ToString());
    }
}
