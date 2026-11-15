using MonitorDotnet.Bridge.Platform;
using Xunit;

namespace MonitorDotnet.Bridge.Tests.Unit;

/// <summary>
/// Проверки предсказания пути отчёта о сбое: по нему расширение находит файл,
/// который среда выполнения оставила после падения приложения.
/// </summary>
public sealed class CrashReportPathTests
{
    private const int Pid = 4242;
    private const string Executable = "SampleApp";

    [Fact]
    public void Predict_WithoutEnableFlag_ReturnsNull()
    {
        string? path = CrashReportPath.Predict(Pid, Executable, Env(
            ("DOTNET_DbgEnableMiniDump", "1")));

        Assert.Null(path);
    }

    [Fact]
    public void Predict_WithoutMinidump_ReturnsNull()
    {
        // Без дампа отчёт печатается в вывод приложения, файла нет.
        string? path = CrashReportPath.Predict(Pid, Executable, Env(
            ("DOTNET_EnableCrashReport", "1")));

        Assert.Null(path);
    }

    [Fact]
    public void Predict_ReportOnly_UsesDefaultDumpPath()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "На Windows отчёт о сбое не поддерживается.");

        string? path = CrashReportPath.Predict(Pid, Executable, Env(
            ("DOTNET_DbgEnableMiniDump", "1"),
            ("DOTNET_EnableCrashReportOnly", "1")));

        Assert.Equal(Path.Combine("/tmp", $"coredump.{Pid}.crashreport.json"), path);
    }

    [Fact]
    public void Predict_UsesTempDirectoryFromTargetEnvironment()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "На Windows отчёт о сбое не поддерживается.");

        string? path = CrashReportPath.Predict(Pid, Executable, Env(
            ("DOTNET_DbgEnableMiniDump", "1"),
            ("DOTNET_EnableCrashReport", "1"),
            ("TMPDIR", "/var/folders/tmp")));

        Assert.Equal(Path.Combine("/var/folders/tmp", $"coredump.{Pid}.crashreport.json"), path);
    }

    [Fact]
    public void Predict_ExpandsDumpNameTemplate()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "На Windows отчёт о сбое не поддерживается.");

        string? path = CrashReportPath.Predict(Pid, Executable, Env(
            ("DOTNET_DbgEnableMiniDump", "1"),
            ("DOTNET_EnableCrashReport", "1"),
            ("DOTNET_DbgMiniDumpName", "/var/dumps/%e-%p")));

        Assert.Equal($"/var/dumps/{Executable}-{Pid}.crashreport.json", path);
    }

    [Fact]
    public void Predict_PathWithCrashTime_ReturnsNull()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "На Windows отчёт о сбое не поддерживается.");

        // Время сбоя заранее неизвестно, поэтому такой путь проверить нельзя.
        string? path = CrashReportPath.Predict(Pid, Executable, Env(
            ("DOTNET_DbgEnableMiniDump", "1"),
            ("DOTNET_EnableCrashReport", "1"),
            ("DOTNET_DbgMiniDumpName", "/var/dumps/%t-%p")));

        Assert.Null(path);
    }

    [Fact]
    public void Predict_RelativeDumpName_ReturnsNull()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "На Windows отчёт о сбое не поддерживается.");

        // Относительный путь считается от рабочего каталога приложения, а его мост не знает.
        string? path = CrashReportPath.Predict(Pid, Executable, Env(
            ("DOTNET_DbgEnableMiniDump", "1"),
            ("DOTNET_EnableCrashReport", "1"),
            ("DOTNET_DbgMiniDumpName", "dumps/%p")));

        Assert.Null(path);
    }

    private static List<KeyValuePair<string, string>> Env(params (string Key, string Value)[] pairs) =>
        pairs.Select(pair => new KeyValuePair<string, string>(pair.Key, pair.Value)).ToList();
}
