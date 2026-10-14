using System.Runtime.InteropServices;

namespace MonitorDotnet.Bridge.Platform;

/// <summary>
/// Приватная память процесса в Windows через <c>GetProcessMemoryInfo</c>
/// (поле <c>PrivateUsage</c> структуры <c>PROCESS_MEMORY_COUNTERS_EX</c>).
/// </summary>
internal static class WindowsProcessMemory
{
    private const int ProcessQueryLimitedInformation = 0x1000;

    public static long GetPrivateBytes(int pid)
    {
        using var process = System.Diagnostics.Process.GetProcessById(pid);
        IntPtr handle = process.Handle;
        if (handle == IntPtr.Zero)
        {
            return ProcessMemory.Unavailable;
        }

        var counters = new ProcessMemoryCountersEx();
        counters.Size = (uint)Marshal.SizeOf<ProcessMemoryCountersEx>();
        if (!GetProcessMemoryInfo(handle, ref counters, counters.Size))
        {
            return ProcessMemory.Unavailable;
        }

        return (long)counters.PrivateUsage;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessMemoryCountersEx
    {
        public uint Size;
        public uint PageFaultCount;
        public UIntPtr PeakWorkingSetSize;
        public UIntPtr WorkingSetSize;
        public UIntPtr QuotaPeakPagedPoolUsage;
        public UIntPtr QuotaPagedPoolUsage;
        public UIntPtr QuotaPeakNonPagedPoolUsage;
        public UIntPtr QuotaNonPagedPoolUsage;
        public UIntPtr PagefileUsage;
        public UIntPtr PeakPagefileUsage;
        public UIntPtr PrivateUsage;
    }

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool GetProcessMemoryInfo(IntPtr process, ref ProcessMemoryCountersEx counters, uint size);
}
