using System.Diagnostics;
using System.Text.Json;
using Xunit;

namespace MonitorDotnet.Bridge.Tests.Integration;

/// <summary>
/// Запускает сборку моста и демонстрационного приложения,
/// чтобы проверить полный цикл сбора данных на реальном процессе .NET.
/// </summary>
internal sealed class BridgeTestHarness : IDisposable
{
    private readonly List<Process> _processes = new();

    /// <summary>Запускает демонстрационное приложение и ждёт, пока оно сообщит свой PID.</summary>
    public async Task<int> StartSampleAppAsync()
    {
        string dll = Path.Combine(RepositoryRoot, "samples", "SampleApp", "bin", BuildConfiguration, "net10.0", "SampleApp.dll");
        Assert.True(File.Exists(dll), $"Не найдена сборка демонстрационного приложения: {dll}");

        var process = StartDotnet(dll, Array.Empty<string>());
        _processes.Add(process);

        string? line = await process.StandardOutput.ReadLineAsync();
        Assert.NotNull(line);
        return int.Parse(line!.Replace("PID:", string.Empty, StringComparison.Ordinal));
    }

    /// <summary>
    /// Запускает мост для указанного процесса и собирает строки протокола NDJSON
    /// за заданное время наблюдения.
    /// </summary>
    public async Task<(int ExitCode, IReadOnlyList<JsonElement> Messages, string StandardError)> RunBridgeAsync(
        int pid,
        double observationSeconds,
        params string[] extraArguments)
    {
        string dll = Path.Combine(AppContext.BaseDirectory, "MonitorDotnet.Bridge.dll");
        Assert.True(File.Exists(dll), $"Не найдена сборка моста: {dll}");

        var arguments = new List<string>
        {
            "--pid", pid.ToString(),
            "--duration-seconds", observationSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture),
        };
        arguments.AddRange(extraArguments);

        var process = StartDotnet(dll, arguments);
        _processes.Add(process);

        var messages = new List<JsonElement>();
        while (await process.StandardOutput.ReadLineAsync() is { } line)
        {
            if (!string.IsNullOrWhiteSpace(line))
            {
                messages.Add(JsonDocument.Parse(line).RootElement.Clone());
            }
        }

        string error = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        return (process.ExitCode, messages, error);
    }

    private static Process StartDotnet(string dll, IEnumerable<string> arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = RepositoryRoot,
        };
        startInfo.ArgumentList.Add(dll);
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        return Process.Start(startInfo) ?? throw new InvalidOperationException("Не удалось запустить dotnet.");
    }

    /// <summary>Корень репозитория — ищется вверх от каталога тестовой сборки.</summary>
    public static string RepositoryRoot { get; } = FindRepositoryRoot();

    private static string BuildConfiguration =>
#if DEBUG
        "Debug";
#else
        "Release";
#endif

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "samples", "SampleApp", "SampleApp.csproj")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException("Не удалось определить корень репозитория.");
    }

    public void Dispose()
    {
        foreach (Process process in _processes)
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(3000);
                }
            }
            catch (Exception)
            {
                // Процесс мог уже завершиться — это нормально при очистке.
            }
            finally
            {
                process.Dispose();
            }
        }
    }
}
