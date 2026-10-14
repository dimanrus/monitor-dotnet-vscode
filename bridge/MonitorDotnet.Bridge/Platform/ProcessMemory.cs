using System.Globalization;

namespace MonitorDotnet.Bridge.Platform;

/// <summary>
/// Приватная память процесса — значение, которое показывает график памяти.
/// Приватная память — это страницы, выделенные только под этот процесс;
/// она не совпадает с рабочим набором (working set), поэтому значения в разных инструментах отличаются.
/// </summary>
internal static class ProcessMemory
{
    /// <summary>Признак того, что приватная память получена платформенным способом.</summary>
    public const long Unavailable = -1;

    /// <summary>
    /// Возвращает приватную память процесса в байтах или <see cref="Unavailable"/>,
    /// если платформенный способ недоступен.
    /// </summary>
    public static long TryGetPrivateBytes(
        int pid,
        Func<long> fallback,
        Action<string>? onWarning = null)
    {
        try
        {
            long value = OperatingSystem.IsWindows()
                ? WindowsProcessMemory.GetPrivateBytes(pid)
                : OperatingSystem.IsLinux()
                    ? LinuxProcessMemory.GetPrivateBytes(pid)
                    : OperatingSystem.IsMacOS()
                        ? MacProcessMemory.GetPrivateBytes(pid)
                        : Unavailable;

            return value > 0 ? value : fallback();
        }
        catch (Exception ex)
        {
            // Платформенный способ — оптимизация точности: при сбое используем значение из BCL.
            onWarning?.Invoke($"Could not read private memory of the process ({ex.Message}); falling back to the runtime value.");
            return fallback();
        }
    }

    /// <summary>Складывает значения страниц приватной памяти из строк файла <c>/proc/&lt;pid&gt;/smaps*</c>.</summary>
    internal static long SumPrivatePages(IEnumerable<string> lines)
    {
        long total = 0;
        foreach (string line in lines)
        {
            if (line.StartsWith("Private_Clean:", StringComparison.Ordinal) ||
                line.StartsWith("Private_Dirty:", StringComparison.Ordinal) ||
                line.StartsWith("Private_Hugetlb:", StringComparison.Ordinal))
            {
                total += ParseKilobytes(line);
            }
        }

        return total;
    }

    /// <summary>Разбирает строку вида <c>Private_Clean:  1234 kB</c> в байты.</summary>
    private static long ParseKilobytes(string line)
    {
        int colon = line.IndexOf(':');
        if (colon < 0)
        {
            return 0;
        }

        string[] parts = line[(colon + 1)..].Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0 ||
            !long.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out long kilobytes))
        {
            return 0;
        }

        return kilobytes * 1024;
    }
}
