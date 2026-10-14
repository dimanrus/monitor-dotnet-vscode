using System.Buffers.Binary;
using System.Runtime.InteropServices;

namespace MonitorDotnet.Bridge.Platform;

/// <summary>
/// Приватная память процесса в macOS.
/// Используем <c>proc_pid_rusage</c> и поле <c>ri_phys_footprint</c> — объём физической памяти,
/// который занимает процесс (приватные, изменённые и сжатые страницы).
/// </summary>
internal static class MacProcessMemory
{
    private const int RusageInfoV2 = 2;

    // Смещение ri_phys_footprint в структуре rusage_info_v2:
    // 16 байт UUID + 7 64-битных полей (user, system, pkg_idle, interrupt, pageins, wired, resident).
    private const int PhysFootprintOffset = 16 + (7 * sizeof(long));

    private const int BufferSize = 512;

    public static long GetPrivateBytes(int pid)
    {
        var buffer = new byte[BufferSize];
        if (proc_pid_rusage(pid, RusageInfoV2, buffer) != 0)
        {
            return ProcessMemory.Unavailable;
        }

        return BinaryPrimitives.ReadInt64LittleEndian(buffer.AsSpan(PhysFootprintOffset));
    }

    [DllImport("libproc.dylib", SetLastError = true)]
    private static extern int proc_pid_rusage(int pid, int flavor, byte[] buffer);
}
