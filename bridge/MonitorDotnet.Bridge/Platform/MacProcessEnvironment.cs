using System.Diagnostics;

namespace MonitorDotnet.Bridge.Platform;

/// <summary>
/// Переменные окружения процесса в macOS.
/// Используем <c>ps -p &lt;pid&gt; -wwE -o command=</c>: ключ <c>-E</c> печатает окружение процесса
/// после команды запуска.
/// </summary>
internal static class MacProcessEnvironment
{
    public static IReadOnlyList<KeyValuePair<string, string>> Read(int pid)
    {
        var startInfo = new ProcessStartInfo("ps")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add("-p");
        startInfo.ArgumentList.Add(pid.ToString());
        startInfo.ArgumentList.Add("-wwE");
        startInfo.ArgumentList.Add("-o");
        startInfo.ArgumentList.Add("command=");

        using var process = Process.Start(startInfo);
        if (process is null)
        {
            return Array.Empty<KeyValuePair<string, string>>();
        }

        string output = process.StandardOutput.ReadToEnd();
        process.WaitForExit(2000);

        // Первым токеном идёт сама команда запуска, дальше — переменные окружения вида KEY=VALUE.
        string[] tokens = output.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return ProcessEnvironment.Parse(tokens);
    }
}
