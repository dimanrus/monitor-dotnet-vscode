namespace MonitorDotnet.Bridge.Platform;

/// <summary>
/// Переменные окружения процесса в Linux — файл <c>/proc/&lt;pid&gt;/environ</c>
/// (пары <c>KEY=VALUE</c>, разделённые нулевым байтом).
/// </summary>
internal static class LinuxProcessEnvironment
{
    public static IReadOnlyList<KeyValuePair<string, string>> Read(int pid)
    {
        string path = $"/proc/{pid}/environ";
        if (!File.Exists(path))
        {
            return Array.Empty<KeyValuePair<string, string>>();
        }

        // Читаем в latin1: значения могут содержать байты, не являющиеся корректным UTF-8,
        // и нам важно не потерять переменную целиком из-за ошибки декодирования.
        byte[] bytes = File.ReadAllBytes(path);
        string content = System.Text.Encoding.Latin1.GetString(bytes);
        return ProcessEnvironment.ParseNullSeparated(content);
    }
}
