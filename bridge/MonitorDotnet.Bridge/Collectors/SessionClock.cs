using System.Diagnostics;

namespace MonitorDotnet.Bridge.Collectors;

/// <summary>
/// Часы сессии: позволяют перевести относительные метки времени событий EventPipe
/// (миллисекунды от начала сессии) в абсолютное время UNIX, которым пользуется расширение.
/// </summary>
internal sealed class SessionClock
{
    private readonly DateTime _startUtc = DateTime.UtcNow;
    private readonly Stopwatch _elapsed = Stopwatch.StartNew();

    /// <summary>Момент старта сессии в миллисекундах UNIX.</summary>
    public long StartUnixMs { get; }

    public SessionClock()
    {
        StartUnixMs = new DateTimeOffset(_startUtc).ToUnixTimeMilliseconds();
    }

    /// <summary>Текущее время в миллисекундах UNIX.</summary>
    public long NowUnixMs => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>Переводит относительную метку времени события в абсолютную.</summary>
    public long ToUnixMs(double relativeMilliseconds) => StartUnixMs + (long)Math.Round(relativeMilliseconds);
}
