using System.Runtime.InteropServices;

namespace MonitorDotnet.Bridge.Platform;

/// <summary>
/// Чтение переменных окружения другого процесса.
/// Это данные панели «Окружение»: переменные окружения и системные свойства приложения.
/// </summary>
internal static class ProcessEnvironment
{
    /// <summary>
    /// Возвращает переменные окружения целевого процесса.
    /// Если платформа не поддерживает чтение (или нет прав), возвращает пустой словарь и текст предупреждения.
    /// </summary>
    public static (IReadOnlyList<KeyValuePair<string, string>> Variables, string? Warning) Read(int pid)
    {
        try
        {
            return OperatingSystem.IsLinux()
                ? (LinuxProcessEnvironment.Read(pid), null)
                : OperatingSystem.IsMacOS()
                    ? (MacProcessEnvironment.Read(pid), null)
                    : OperatingSystem.IsWindows()
                        ? (WindowsProcessEnvironment.Read(pid), null)
                        : (Array.Empty<KeyValuePair<string, string>>(), "Reading environment variables is not supported on this platform.");
        }
        catch (Exception ex)
        {
            return (Array.Empty<KeyValuePair<string, string>>(), $"Could not read environment variables: {ex.Message}");
        }
    }

    /// <summary>Разбирает пары <c>KEY=VALUE</c>, разделённые нулевым символом (формат /proc/&lt;pid&gt;/environ).</summary>
    internal static List<KeyValuePair<string, string>> ParseNullSeparated(string content) =>
        Parse(content.Split('\0', StringSplitOptions.RemoveEmptyEntries));

    /// <summary>Собирает переменные в словарь, отбрасывая пустые имена и дубликаты.</summary>
    internal static List<KeyValuePair<string, string>> Parse(IEnumerable<string> entries)
    {
        var result = new List<KeyValuePair<string, string>>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (string entry in entries)
        {
            int separator = entry.IndexOf('=');
            if (separator <= 0)
            {
                continue;
            }

            string key = entry[..separator];
            if (seen.Add(key))
            {
                result.Add(new KeyValuePair<string, string>(key, entry[(separator + 1)..]));
            }
        }

        result.Sort((left, right) => string.Compare(left.Key, right.Key, StringComparison.OrdinalIgnoreCase));
        return result;
    }

    /// <summary>Общие свойства машины, на которой запущен мост (совпадает с машиной целевого процесса).</summary>
    public static IEnumerable<KeyValuePair<string, string>> GetSystemProperties()
    {
        yield return new KeyValuePair<string, string>("OS", RuntimeInformation.OSDescription);
        yield return new KeyValuePair<string, string>("Architecture", RuntimeInformation.OSArchitecture.ToString());
        yield return new KeyValuePair<string, string>("Processor count", Environment.ProcessorCount.ToString());
        yield return new KeyValuePair<string, string>(
            "Bridge runtime",
            RuntimeInformation.FrameworkDescription);
        yield return new KeyValuePair<string, string>("Machine name", Environment.MachineName);
        yield return new KeyValuePair<string, string>("User", Environment.UserName);
    }
}
