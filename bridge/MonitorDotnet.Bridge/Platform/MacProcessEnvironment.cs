using System.Diagnostics;

namespace MonitorDotnet.Bridge.Platform;

/// <summary>
/// Переменные окружения процесса в macOS.
/// Используем <c>ps -p &lt;pid&gt; -wwE -o command=</c>: ключ <c>-E</c> печатает окружение процесса
/// после команды запуска.
/// </summary>
internal static class MacProcessEnvironment
{
    /** Сколько ждать ответа ps: зависший вызов не должен задерживать срез данных. */
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(2);

    public static IReadOnlyList<KeyValuePair<string, string>> Read(int pid)
    {
        // Один вызов вместо ручного запуска: среда читает стандартный вывод и ошибки сразу,
        // поэтому процесс не зависнет на заполненном буфере, а таймаут ограничивает ожидание.
        ProcessTextOutput output = Process.RunAndCaptureText(
            "ps",
            ["-p", pid.ToString(), "-wwE", "-o", "command="],
            Timeout);

        // Первым токеном идёт сама команда запуска, дальше — переменные окружения вида KEY=VALUE.
        string[] tokens = output.StandardOutput.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return ProcessEnvironment.Parse(tokens);
    }
}
