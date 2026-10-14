using System.ComponentModel;
using System.Runtime.InteropServices;

namespace MonitorDotnet.Bridge.Platform;

/// <summary>
/// Переменные окружения процесса в Windows.
/// Читаем блок окружения из PEB целевого процесса: PEB → RTL_USER_PROCESS_PARAMETERS → Environment.
/// Способ требует прав на чтение памяти процесса (тот же пользователь их обычно имеет).
/// </summary>
internal static class WindowsProcessEnvironment
{
    private const int ProcessQueryInformation = 0x0400;
    private const int ProcessVmRead = 0x0010;
    private const int ProcessBasicInformationClass = 0;

    // Начальный размер буфера для блока окружения и предел, до которого его увеличиваем.
    private const int InitialBufferSize = 64 * 1024;
    private const int MaxBufferSize = 4 * 1024 * 1024;

    public static IReadOnlyList<KeyValuePair<string, string>> Read(int pid)
    {
        IntPtr handle = OpenProcess(ProcessQueryInformation | ProcessVmRead, false, pid);
        if (handle == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess");
        }

        try
        {
            return ReadEnvironmentBlock(handle);
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    /// <summary>
    /// Читает командную строку процесса из блока параметров процесса в PEB.
    /// </summary>
    public static string? ReadCommandLine(int pid)
    {
        IntPtr handle = OpenProcess(ProcessQueryInformation | ProcessVmRead, false, pid);
        if (handle == IntPtr.Zero)
        {
            return null;
        }

        try
        {
            IntPtr processParameters = ReadProcessParameters(handle);
            if (processParameters == IntPtr.Zero)
            {
                return null;
            }

            // CommandLine — структура UNICODE_STRING по смещению 0x70 (x64) или 0x40 (x86).
            bool is64Bit = IntPtr.Size == 8;
            var unicodeString = new byte[16];
            if (!ReadProcessMemory(handle, processParameters + (is64Bit ? 0x70 : 0x40), unicodeString, unicodeString.Length, out _))
            {
                return null;
            }

            ushort length = BitConverter.ToUInt16(unicodeString, 0);
            IntPtr buffer = ReadPointer(handle, processParameters + (is64Bit ? 0x78 : 0x44));
            if (buffer == IntPtr.Zero || length == 0)
            {
                return null;
            }

            var text = new byte[length];
            if (!ReadProcessMemory(handle, buffer, text, text.Length, out IntPtr read))
            {
                return null;
            }

            return System.Text.Encoding.Unicode.GetString(text, 0, (int)read).TrimEnd('\0');
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    /// <summary>Возвращает адрес структуры RTL_USER_PROCESS_PARAMETERS целевого процесса.</summary>
    private static IntPtr ReadProcessParameters(IntPtr handle)
    {
        var basic = new ProcessBasicInformation();
        int status = NtQueryInformationProcess(
            handle,
            ProcessBasicInformationClass,
            ref basic,
            Marshal.SizeOf<ProcessBasicInformation>(),
            out _);

        if (status != 0)
        {
            return IntPtr.Zero;
        }

        // ProcessParameters: смещение 0x20 в PEB для x64 и 0x10 для x86.
        return ReadPointer(handle, basic.PebBaseAddress + (IntPtr.Size == 8 ? 0x20 : 0x10));
    }

    private static IReadOnlyList<KeyValuePair<string, string>> ReadEnvironmentBlock(IntPtr handle)
    {
        IntPtr processParameters = ReadProcessParameters(handle);
        if (processParameters == IntPtr.Zero)
        {
            return Array.Empty<KeyValuePair<string, string>>();
        }

        // Environment: смещение 0x80 в RTL_USER_PROCESS_PARAMETERS для x64 и 0x48 для x86.
        IntPtr environment = ReadPointer(handle, processParameters + (IntPtr.Size == 8 ? 0x80 : 0x48));
        if (environment == IntPtr.Zero)
        {
            return Array.Empty<KeyValuePair<string, string>>();
        }

        string block = ReadNullTerminatedUnicode(handle, environment);
        return ProcessEnvironment.Parse(block.Split('\0', StringSplitOptions.RemoveEmptyEntries));
    }

    private static IntPtr ReadPointer(IntPtr handle, IntPtr address)
    {
        var buffer = new byte[IntPtr.Size];
        return ReadProcessMemory(handle, address, buffer, buffer.Length, out _)
            ? (IntPtr.Size == 8 ? (IntPtr)BitConverter.ToInt64(buffer) : (IntPtr)BitConverter.ToInt32(buffer))
            : IntPtr.Zero;
    }

    /// <summary>Читает UTF-16 строку до двойного нуля, постепенно увеличивая буфер.</summary>
    private static string ReadNullTerminatedUnicode(IntPtr handle, IntPtr address)
    {
        var buffer = new byte[InitialBufferSize];
        if (!ReadProcessMemory(handle, address, buffer, buffer.Length, out IntPtr read))
        {
            return string.Empty;
        }

        int length = (int)read;
        while (length >= buffer.Length && buffer.Length < MaxBufferSize)
        {
            buffer = new byte[buffer.Length * 2];
            if (!ReadProcessMemory(handle, address, buffer, buffer.Length, out read))
            {
                return string.Empty;
            }

            length = (int)read;
        }

        string text = System.Text.Encoding.Unicode.GetString(buffer, 0, length);
        int end = text.IndexOf("\0\0", StringComparison.Ordinal);
        return end >= 0 ? text[..end] : text;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr process,
        int informationClass,
        ref ProcessBasicInformation information,
        int informationLength,
        out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(
        IntPtr process,
        IntPtr baseAddress,
        byte[] buffer,
        int size,
        out IntPtr bytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
