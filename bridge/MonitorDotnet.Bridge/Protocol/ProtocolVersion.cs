namespace MonitorDotnet.Bridge.Protocol;

/// <summary>
/// Версия протокола обмена между мостом и расширением.
/// Расширение сверяет её с ожидаемой и предупреждает пользователя при несовпадении.
/// </summary>
internal static class ProtocolVersion
{
    /// <summary>Текущая версия формата сообщений.</summary>
    public const string Current = "1.0";
}
