namespace MonitorDotnet.Bridge.Collectors;

/// <summary>
/// Сведения о мониторимом процессе, которые удаётся получить из событий EventPipe
/// (версия среды выполнения, командная строка, версия ОС и разрядность).
/// Каждое поле заполняется один раз — события могут приходить повторно.
/// </summary>
internal sealed class TargetProcessInfo
{
    private readonly object _gate = new();

    private string? _runtimeVersion;
    private string? _commandLine;
    private string? _os;
    private string? _architecture;
    private string? _startupFlags;

    public string? RuntimeVersion
    {
        get { lock (_gate) { return _runtimeVersion; } }
    }

    public string? CommandLine
    {
        get { lock (_gate) { return _commandLine; } }
    }

    public string? Os
    {
        get { lock (_gate) { return _os; } }
    }

    public string? Architecture
    {
        get { lock (_gate) { return _architecture; } }
    }

    public string? StartupFlags
    {
        get { lock (_gate) { return _startupFlags; } }
    }

    public void SetRuntimeVersion(string? value) => SetOnce(ref _runtimeVersion, value);

    public void SetCommandLine(string? value) => SetOnce(ref _commandLine, value);

    public void SetOs(string? value) => SetOnce(ref _os, value);

    public void SetArchitecture(string? value) => SetOnce(ref _architecture, value);

    public void SetStartupFlags(string? value) => SetOnce(ref _startupFlags, value);

    private void SetOnce(ref string? field, string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return;
        }

        lock (_gate)
        {
            field ??= value;
        }
    }
}
