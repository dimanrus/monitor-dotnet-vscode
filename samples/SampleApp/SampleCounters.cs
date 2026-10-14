using System.Diagnostics.Tracing;

namespace SampleApp;

/// <summary>
/// Собственные классические счётчики приложения (EventCounters).
/// В панели мониторинга они появляются как счётчики провайдера <c>SampleApp</c>.
/// </summary>
[EventSource(Name = "SampleApp")]
internal sealed class SampleCounters : EventSource
{
    public static readonly SampleCounters Instance = new();

    private readonly EventCounter _processing;
    private readonly PollingCounter _queue;

    private double _queueLength = 12;

    private SampleCounters()
    {
        _processing = new EventCounter("sample-processing", this)
        {
            DisplayName = "Sample Processing",
            DisplayUnits = "ms",
        };
        _queue = new PollingCounter("sample-queue", this, () => _queueLength)
        {
            DisplayName = "Sample Queue",
            DisplayUnits = "{item}",
        };
    }

    /// <summary>Длина очереди обработки — используется также наблюдаемым измерителем метрик.</summary>
    public double QueueLength => _queueLength;

    /// <summary>Записывает длительность обработки одной задачи.</summary>
    public void RecordProcessing(double milliseconds)
    {
        _queueLength = Math.Max(0, _queueLength);
        _processing.WriteMetric(milliseconds);
        _queueLength = (milliseconds % 5) + 1;
    }
}
