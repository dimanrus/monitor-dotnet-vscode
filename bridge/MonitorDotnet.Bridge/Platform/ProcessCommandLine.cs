using System.Diagnostics;

namespace MonitorDotnet.Bridge.Platform;

/// <summary>
/// Чтение командной строки целевого процесса.
/// Используется для сообщения <c>hello</c>: событие EventPipe с командной строкой приходит с задержкой,
/// а из операционной системы её можно получить сразу.
/// </summary>
internal static class ProcessCommandLine
{
    /// <summary>Возвращает командную строку процесса или <c>null</c>, если прочитать не удалось.</summary>
    public static string? TryRead(int pid)
    {
        try
        {
            if (OperatingSystem.IsLinux())
            {
                return ReadLinux(pid);
            }

            if (OperatingSystem.IsMacOS())
            {
                return ReadProcessOutput("ps", new[] { "-p", pid.ToString(), "-ww", "-o", "command=" });
            }

            if (OperatingSystem.IsWindows())
            {
                return WindowsProcessEnvironment.ReadCommandLine(pid);
            }
        }
        catch (Exception)
        {
            // Командная строка — дополнительные сведения: без неё мониторинг продолжает работать.
        }

        return null;
    }

    private static string ReadLinux(int pid)
    {
        string path = $"/proc/{pid}/cmdline";
        if (!File.Exists(path))
        {
            return string.Empty;
        }

        byte[] bytes = File.ReadAllBytes(path);
        return System.Text.Encoding.UTF8.GetString(bytes).Replace('\0', ' ').Trim();
    }

    private static string ReadProcessOutput(string fileName, string[] arguments)
    {
        var startInfo = new ProcessStartInfo(fileName)
        {
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = Process.Start(startInfo);
        if (process is null)
        {
            return string.Empty;
        }

        string output = process.StandardOutput.ReadToEnd();
        process.WaitForExit(2000);
        return output.Trim();
    }
}
