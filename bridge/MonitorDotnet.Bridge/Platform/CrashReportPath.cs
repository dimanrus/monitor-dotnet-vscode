namespace MonitorDotnet.Bridge.Platform;

/// <summary>
/// Путь к отчёту о сбое, который среда выполнения пишет рядом с дампом.
///
/// Отчёт включается переменной <c>DOTNET_EnableCrashReport=1</c> (или <c>DOTNET_EnableCrashReportOnly=1</c>)
/// и получает имя пути дампа с суффиксом <c>.crashreport.json</c>. Файл появляется, когда дамп
/// собирает <c>createdump</c>, то есть при <c>DOTNET_DbgEnableMiniDump=1</c>: без него встроенный
/// отчёт о сбое (появился на Linux и macOS в .NET 11) печатается в вывод самого приложения.
/// </summary>
internal static class CrashReportPath
{
    private const string Suffix = ".crashreport.json";

    /// <summary>
    /// Предсказывает путь файла отчёта о сбое по переменным окружения целевого процесса.
    /// Возвращает <c>null</c>, если отчёт не включён, дамп не собирается, платформа отчёт не поддерживает
    /// или имя зависит от времени сбоя (<c>%t</c>): такое имя заранее не вычислить.
    /// </summary>
    public static string? Predict(int pid, string executableName, IReadOnlyList<KeyValuePair<string, string>> variables)
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
        {
            // На Windows встроенный отчёт о сбое не поддерживается: там остаётся createdump с дампом.
            return null;
        }

        var environment = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (KeyValuePair<string, string> pair in variables)
        {
            environment[pair.Key] = pair.Value;
        }

        // Файл пишет createdump: без включённого дампа отчёт остаётся в выводе приложения.
        if (!IsEnabled(environment, "DOTNET_DbgEnableMiniDump"))
        {
            return null;
        }

        // Включается любая из двух переменных: `Only` выбирает отчёт без самого дампа.
        if (!IsEnabled(environment, "DOTNET_EnableCrashReport") && !IsEnabled(environment, "DOTNET_EnableCrashReportOnly"))
        {
            return null;
        }

        string template = environment.GetValueOrDefault("DOTNET_DbgMiniDumpName") ?? string.Empty;
        if (template.Length == 0)
        {
            string directory = environment.GetValueOrDefault("TMPDIR") ?? "/tmp";
            template = Path.Combine(directory, $"coredump.{pid}");
        }

        string? path = Expand(template, pid, executableName);
        if (path is null || !Path.IsPathRooted(path))
        {
            // Относительный путь считается от рабочего каталога приложения, а его мост не знает.
            return null;
        }

        return path + Suffix;
    }

    private static bool IsEnabled(Dictionary<string, string> environment, string name) =>
        environment.TryGetValue(name, out string? value) && value == "1";

    /// <summary>Раскрывает шаблонные спецификаторы пути дампа: <c>%%</c>, <c>%p</c>, <c>%e</c>, <c>%h</c>, <c>%t</c>.</summary>
    private static string? Expand(string template, int pid, string executableName)
    {
        var builder = new System.Text.StringBuilder(template.Length + 16);
        for (int index = 0; index < template.Length; index++)
        {
            char current = template[index];
            if (current != '%' || index + 1 >= template.Length)
            {
                builder.Append(current);
                continue;
            }

            char specifier = template[++index];
            switch (specifier)
            {
                case '%':
                    builder.Append('%');
                    break;
                case 'p':
                    builder.Append(pid);
                    break;
                case 'e':
                    builder.Append(executableName);
                    break;
                case 'h':
                    builder.Append(Environment.MachineName);
                    break;
                case 't':
                    // Время сбоя заранее неизвестно — путь с ним проверить нельзя.
                    return null;
                default:
                    builder.Append('%').Append(specifier);
                    break;
            }
        }

        return builder.ToString();
    }
}
