using MonitorDotnet.Bridge.Cli;
using MonitorDotnet.Bridge.Host;
using Xunit;

namespace MonitorDotnet.Bridge.Tests.Unit;

/// <summary>Проверки разбора аргументов командной строки моста.</summary>
public sealed class BridgeOptionsTests
{
    [Fact]
    public void Parse_ReadsAllSupportedArguments()
    {
        BridgeOptions options = BridgeOptions.Parse(new[]
        {
            "--pid", "4242",
            "--refresh-interval", "2",
            "--counters", "System.Runtime,MyProvider[A,B]",
            "--metrics", "MyMeter",
            "--log-level", "debug",
            "--no-environment",
            "--no-gc-events",
        });

        Assert.Equal(4242, options.Pid);
        Assert.Equal(2, options.RefreshIntervalSeconds);
        Assert.Equal(2, options.CounterProviders.Count);
        Assert.Equal("MyProvider", options.CounterProviders[1].Provider);
        Assert.Equal("MyMeter", Assert.Single(options.MetricProviders).Provider);
        Assert.Equal(BridgeLogLevel.Debug, options.LogLevel);
        Assert.False(options.CollectEnvironment);
        Assert.False(options.CollectGcEvents);
    }

    [Fact]
    public void Parse_SupportsEqualsSyntax()
    {
        BridgeOptions options = BridgeOptions.Parse(new[] { "--pid=17", "--refresh-interval=0.5" });

        Assert.Equal(17, options.Pid);
        Assert.Equal(0.5, options.RefreshIntervalSeconds);
    }

    [Fact]
    public void Parse_ClampsTooSmallInterval()
    {
        BridgeOptions options = BridgeOptions.Parse(new[] { "--pid", "1", "--refresh-interval", "0.01" });

        Assert.Equal(0.2, options.RefreshIntervalSeconds);
    }

    [Fact]
    public void Parse_WithoutPid_Throws()
    {
        Assert.Throws<BridgeUsageException>(() => BridgeOptions.Parse(Array.Empty<string>()));
    }

    [Fact]
    public void Parse_UnknownArgument_Throws()
    {
        Assert.Throws<BridgeUsageException>(() => BridgeOptions.Parse(new[] { "--pid", "1", "--unknown" }));
    }

    [Fact]
    public void BuildMetricsFilterArgument_DefaultsToWildcard()
    {
        // Без явного фильтра .NET не публикует значения метрик, поэтому по умолчанию нужен «*».
        BridgeOptions options = BridgeOptions.Parse(new[] { "--pid", "1" });

        Assert.Equal("*", options.BuildMetricsFilterArgument());
    }

    [Fact]
    public void BuildMetricsFilterArgument_JoinsConfiguredMeters()
    {
        BridgeOptions options = BridgeOptions.Parse(new[] { "--pid", "1", "--metrics", "MeterA,MeterB[Instrument1]" });

        Assert.Equal(@"MeterA,MeterB\Instrument1", options.BuildMetricsFilterArgument());
    }
}
