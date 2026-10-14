namespace MonitorDotnet.Bridge.Platform;

/// <summary>
/// Приватная память процесса в Linux.
/// Складываем <c>Private_Clean</c>, <c>Private_Dirty</c> и <c>Private_Hugetlb</c> из
/// <c>/proc/&lt;pid&gt;/smaps_rollup</c> (быстрый путь), а если файла нет — суммируем по <c>smaps</c>.
/// </summary>
internal static class LinuxProcessMemory
{
    public static long GetPrivateBytes(int pid)
    {
        string rollupPath = $"/proc/{pid}/smaps_rollup";
        if (File.Exists(rollupPath))
        {
            long rollup = ProcessMemory.SumPrivatePages(File.ReadLines(rollupPath));
            if (rollup > 0)
            {
                return rollup;
            }
        }

        string smapsPath = $"/proc/{pid}/smaps";
        return File.Exists(smapsPath)
            ? ProcessMemory.SumPrivatePages(File.ReadLines(smapsPath))
            : ProcessMemory.Unavailable;
    }
}
