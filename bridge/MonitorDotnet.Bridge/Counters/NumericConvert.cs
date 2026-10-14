using System.Globalization;

namespace MonitorDotnet.Bridge.Counters;

/// <summary>
/// Приведение значений событий EventPipe к числам.
/// Часть полей (значения метрик) приходит строками, поэтому разбор выполняется
/// по инвариантной культуре — независимо от настроек системы.
/// </summary>
internal static class NumericConvert
{
    public static double? ToDouble(object? value) => value switch
    {
        null => null,
        double d => d,
        float f => f,
        int i => i,
        long l => l,
        short s => s,
        byte b => b,
        uint ui => ui,
        ulong ul => ul,
        decimal m => (double)m,
        string text when double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out double parsed) => parsed,
        _ => null,
    };

    public static long? ToInt64(object? value)
    {
        double? number = ToDouble(value);
        return number is null ? null : (long)Math.Round(number.Value);
    }

    public static string? ToText(object? value) => value switch
    {
        null => null,
        string text => text,
        _ => Convert.ToString(value, CultureInfo.InvariantCulture),
    };
}
