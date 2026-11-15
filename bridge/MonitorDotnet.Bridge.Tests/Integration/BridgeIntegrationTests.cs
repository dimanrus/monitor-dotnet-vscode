using System.Text.Json;
using Xunit;

namespace MonitorDotnet.Bridge.Tests.Integration;

/// <summary>
/// Сквозные проверки: мост подключается к реальному приложению и отдаёт данные протокола.
/// </summary>
public sealed class BridgeIntegrationTests
{
    [Fact]
    public async Task Bridge_CollectsProcessDataCountersMetricsAndGcEvents()
    {
        using var harness = new BridgeTestHarness();
        int pid = await harness.StartSampleAppAsync();

        (int exitCode, IReadOnlyList<JsonElement> messages, string error) = await harness.RunBridgeAsync(
            pid,
            observationSeconds: 7,
            extraArguments: new[] { "--counters", "System.Runtime,SampleApp", "--metrics", "*" });

        Assert.Equal(0, exitCode);
        Assert.Contains(messages, message =>
            message.GetProperty("type").GetString() == "status" &&
            message.GetProperty("state").GetString() == "running");

        JsonElement hello = Find(messages, "hello");
        Assert.Equal(pid, hello.GetProperty("pid").GetInt32());
        // Версия среды берётся из событий целевого процесса, а он собран под ту же версию .NET.
        Assert.StartsWith($"{Environment.Version.Major}.", hello.GetProperty("runtimeVersion").GetString());

        IReadOnlyList<JsonElement> samples = FindAll(messages, "sample");
        Assert.True(samples.Count >= 3, $"Ожидалось несколько срезов, но получено {samples.Count}. stderr: {error}");

        JsonElement last = samples[^1];
        JsonElement process = last.GetProperty("process");
        Assert.True(process.GetProperty("privateMemoryBytes").GetInt64() > 0, "Приватная память должна быть больше нуля.");
        Assert.True(process.GetProperty("workingSetBytes").GetInt64() > 0, "Рабочий набор должен быть больше нуля.");
        Assert.True(process.GetProperty("threadCount").GetInt32() > 0, "Число потоков должно быть больше нуля.");

        // Счётчики System.Runtime и собственные счётчики приложения-образца.
        var counterNames = samples
            .SelectMany(sample => sample.GetProperty("counters").EnumerateArray())
            .Select(counter => counter.GetProperty("name").GetString())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        Assert.Contains("cpu-usage", counterNames);
        Assert.Contains("alloc-rate", counterNames);
        Assert.Contains("sample-queue", counterNames);

        // Метрики (System.Diagnostics.Metrics) приложения-образца.
        var metricNames = samples
            .SelectMany(sample => sample.GetProperty("metrics").EnumerateArray())
            .Select(metric => metric.GetProperty("instrument").GetString())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        Assert.Contains("app.requests", metricNames);

        // События GC: загрузка памяти приложением-образцом должна их порождать.
        int gcEvents = samples.Sum(sample => sample.GetProperty("gcEvents").GetArrayLength());
        Assert.True(gcEvents > 0, "Ожидались события сборки мусора.");

        // Окружение целевого процесса: на Linux переменные точно доступны.
        JsonElement environment = Find(messages, "environment");
        if (OperatingSystem.IsLinux())
        {
            Assert.NotEmpty(environment.GetProperty("variables").EnumerateArray());
        }

        Assert.NotEmpty(environment.GetProperty("properties").EnumerateArray());
    }

    [Fact]
    public async Task Bridge_ReportsTargetExitCode_WhenTargetProcessExits()
    {
        using var harness = new BridgeTestHarness();
        int pid = await harness.StartSampleAppAsync();

        // Мост живёт дольше приложения: по выходу цели он сообщает причину остановки и код завершения.
        Task<(int ExitCode, IReadOnlyList<JsonElement> Messages, string StandardError)> run =
            harness.RunBridgeAsync(pid, observationSeconds: 30);

        await Task.Delay(TimeSpan.FromSeconds(2), TestContext.Current.CancellationToken);
        using (System.Diagnostics.Process target = System.Diagnostics.Process.GetProcessById(pid))
        {
            target.Kill();
        }

        (int exitCode, IReadOnlyList<JsonElement> messages, string error) = await run;

        Assert.Equal(0, exitCode);
        JsonElement stopped = messages.Last(message =>
            message.GetProperty("type").GetString() == "status" &&
            message.GetProperty("state").GetString() == "stopped");
        Assert.Equal("targetExited", stopped.GetProperty("reason").GetString());

        // Код выхода нужен расширению, чтобы отличить сбой от штатного завершения
        // и решить, ждать ли перезапуска (`dotnet watch` с восстановлением после сбоя).
        // На Unix система не отдаёт код выхода для процесса, запущенного не этим объектом,
        // поэтому поле приходит только на Windows.
        if (OperatingSystem.IsWindows())
        {
            Assert.True(stopped.TryGetProperty("exitCode", out JsonElement exitCodeElement), $"В статусе нет кода выхода. Сообщения: {string.Join(" | ", messages)}");
            Assert.NotEqual(0, exitCodeElement.GetInt32());
        }
        else
        {
            Assert.False(stopped.TryGetProperty("exitCode", out _));
        }

        // Отчёт о сбое не включён в окружении образца — файла нет, и поле не приходит.
        Assert.False(stopped.TryGetProperty("crashReportPath", out _));
        _ = error;
    }

    [Fact]
    public async Task Bridge_ReportsFatalError_WhenProcessDoesNotExist()
    {
        using var harness = new BridgeTestHarness();

        // Ищем заведомо несуществующий идентификатор процесса.
        int missingPid = 999_999;
        while (IsProcessAlive(missingPid))
        {
            missingPid--;
        }

        (int exitCode, IReadOnlyList<JsonElement> messages, _) = await harness.RunBridgeAsync(missingPid, observationSeconds: 1);

        Assert.NotEqual(0, exitCode);
        JsonElement error = Find(messages, "error");
        Assert.True(error.GetProperty("fatal").GetBoolean());
    }

    private static bool IsProcessAlive(int pid)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static JsonElement Find(IReadOnlyList<JsonElement> messages, string type)
    {
        foreach (JsonElement message in messages)
        {
            if (message.GetProperty("type").GetString() == type)
            {
                return message;
            }
        }

        throw new InvalidOperationException($"Сообщение типа '{type}' не найдено.");
    }

    private static IReadOnlyList<JsonElement> FindAll(IReadOnlyList<JsonElement> messages, string type) =>
        messages.Where(message => message.GetProperty("type").GetString() == type).ToArray();
}
