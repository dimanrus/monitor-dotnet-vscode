using MonitorDotnet.Bridge.Platform;
using Xunit;

namespace MonitorDotnet.Bridge.Tests.Unit;

/// <summary>Проверки разбора переменных окружения и подсчёта приватной памяти.</summary>
public sealed class PlatformReaderTests
{
    [Fact]
    public void Parse_SplitsPairsAndSortsThem()
    {
        var variables = ProcessEnvironment.Parse(new[] { "B=2", "A=1", "WITHOUT_VALUE", "=bad", "A=duplicate" });

        Assert.Equal(2, variables.Count);
        Assert.Equal("A", variables[0].Key);
        Assert.Equal("1", variables[0].Value);
        Assert.Equal("B", variables[1].Key);
    }

    [Fact]
    public void ParseNullSeparated_HandlesProcFormat()
    {
        var variables = ProcessEnvironment.ParseNullSeparated("PATH=/usr/bin\0HOME=/root\0");

        Assert.Equal(2, variables.Count);
        Assert.Contains(variables, pair => pair.Key == "PATH" && pair.Value == "/usr/bin");
    }

    [Fact]
    public void SumPrivatePages_AddsPrivateSectionsOnly()
    {
        var lines = new[]
        {
            "Rss:               35900 kB",
            "Shared_Clean:      30732 kB",
            "Private_Clean:      1234 kB",
            "Private_Dirty:      2000 kB",
            "Private_Hugetlb:     100 kB",
            "Pss:                9962 kB",
        };

        long bytes = ProcessMemory.SumPrivatePages(lines);

        Assert.Equal((1234 + 2000 + 100) * 1024, bytes);
    }

    [Fact]
    public void SumPrivatePages_IgnoresMalformedLines()
    {
        Assert.Equal(0, ProcessMemory.SumPrivatePages(new[] { "Private_Clean:", "Private_Dirty: abc kB" }));
    }
}
