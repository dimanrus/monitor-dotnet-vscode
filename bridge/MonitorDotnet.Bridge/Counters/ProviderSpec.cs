namespace MonitorDotnet.Bridge.Counters;

/// <summary>
/// Описание провайдера счётчиков, заданное пользователем в настройках расширения.
/// Поддерживаются две формы записи:
/// <list type="bullet">
///   <item><c>System.Runtime</c> — все счётчики провайдера;</item>
///   <item><c>MyProvider[Counter1,Counter2]</c> — только указанные счётчики.</item>
/// </list>
/// </summary>
internal sealed class ProviderSpec
{
    private ProviderSpec(string provider, IReadOnlyList<string> counters)
    {
        Provider = provider;
        Counters = counters;
    }

    /// <summary>Имя провайдера (EventSource) или имя метра.</summary>
    public string Provider { get; }

    /// <summary>Список выбранных счётчиков; пустой — значит «все».</summary>
    public IReadOnlyList<string> Counters { get; }

    /// <summary>Признак «выбраны все счётчики провайдера».</summary>
    public bool IncludesAllCounters => Counters.Count == 0;

    /// <summary>Проверяет, что значение счётчика нужно показывать пользователю.</summary>
    public bool Matches(string counterName) =>
        IncludesAllCounters || Counters.Contains(counterName, StringComparer.OrdinalIgnoreCase);

    public override string ToString() =>
        IncludesAllCounters ? Provider : $"{Provider}[{string.Join(",", Counters)}]";

    /// <summary>Разбирает одну или несколько спецификаций, разделённых запятыми.</summary>
    public static IReadOnlyList<ProviderSpec> ParseList(IEnumerable<string> values)
    {
        var result = new List<ProviderSpec>();
        foreach (string value in values)
        {
            foreach (string part in SplitTopLevel(value))
            {
                ProviderSpec? spec = TryParse(part);
                if (spec is not null)
                {
                    result.Add(spec);
                }
            }
        }

        return result;
    }

    /// <summary>Разбирает спецификацию вида <c>Provider[Counter1,Counter2]</c>.</summary>
    public static ProviderSpec? TryParse(string value)
    {
        string text = value.Trim();
        if (text.Length == 0)
        {
            return null;
        }

        int open = text.IndexOf('[');
        if (open < 0)
        {
            return new ProviderSpec(text, Array.Empty<string>());
        }

        int close = text.LastIndexOf(']');
        string provider = text[..open].Trim();
        if (provider.Length == 0)
        {
            return null;
        }

        string inner = close > open ? text[(open + 1)..close] : text[(open + 1)..];
        var counters = inner
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        return new ProviderSpec(provider, counters);
    }

    /// <summary>
    /// Делит строку по запятым так, чтобы запятые внутри <c>[...]</c> не считались разделителями.
    /// </summary>
    private static IEnumerable<string> SplitTopLevel(string value)
    {
        int depth = 0;
        int start = 0;
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == '[')
            {
                depth++;
            }
            else if (c == ']')
            {
                depth = Math.Max(0, depth - 1);
            }
            else if (c == ',' && depth == 0)
            {
                yield return value[start..i];
                start = i + 1;
            }
        }

        if (start < value.Length)
        {
            yield return value[start..];
        }
    }
}
