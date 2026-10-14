using MonitorDotnet.Bridge.Protocol;

namespace MonitorDotnet.Bridge.Host;

/// <summary>Уровень важности диагностических сообщений моста.</summary>
internal enum BridgeLogLevel
{
    Error = 0,
    Warning = 1,
    Info = 2,
    Debug = 3,
}

/// <summary>
/// Логирование моста. Сообщения уходят в stderr (его читает расширение и показывает в Output)
/// и, при необходимости, дублируются в основной протокол сообщением <c>log</c>.
/// </summary>
internal sealed class BridgeLog
{
    private readonly BridgeLogLevel _level;
    private readonly WireWriter? _wire;

    public BridgeLog(BridgeLogLevel level, WireWriter? wire = null)
    {
        _level = level;
        _wire = wire;
    }

    public void Debug(string message) => Write(BridgeLogLevel.Debug, message);

    public void Info(string message) => Write(BridgeLogLevel.Info, message);

    public void Warning(string message) => Write(BridgeLogLevel.Warning, message);

    public void Error(string message) => Write(BridgeLogLevel.Error, message);

    private void Write(BridgeLogLevel level, string message)
    {
        if (level > _level)
        {
            return;
        }

        Console.Error.WriteLine($"[{level.ToString().ToLowerInvariant()}] {message}");
        Console.Error.Flush();

        // В протокол отправляем только значимые сообщения, чтобы не засорять канал.
        if (_wire is not null && level <= BridgeLogLevel.Warning)
        {
            _wire.Write(new LogMessage(WireContract.TypeLog, level.ToString().ToLowerInvariant(), message));
        }
    }
}
