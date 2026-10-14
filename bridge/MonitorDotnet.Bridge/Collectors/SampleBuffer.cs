using MonitorDotnet.Bridge.Protocol;

namespace MonitorDotnet.Bridge.Collectors;

/// <summary>
/// Промежуточное хранилище собранных данных.
/// События приходят из потока EventPipe, а срез формируется раз в интервал — буфер сглаживает эту разницу
/// и попутно считает накопительные показатели (количество сборок GC, размеры куч).
/// </summary>
internal sealed class SampleBuffer
{
    private readonly object _gate = new();

    // Значения, накопленные с момента предыдущего среза.
    private readonly List<CounterValue> _counters = new();
    private readonly List<MetricValue> _metrics = new();
    private readonly List<GcEventValue> _gcEvents = new();

    // Накопительные счётчики сборок мусора по поколениям.
    private long _gen0Collections;
    private long _gen1Collections;
    private long _gen2Collections;

    // Размеры куч по поколениям (обновляются по событию GCHeapStats).
    private long _gen0Bytes;
    private long _gen1Bytes;
    private long _gen2Bytes;
    private long _lohBytes;

    /// <summary>Добавляет значение классического счётчика.</summary>
    public void AddCounter(CounterValue counter)
    {
        lock (_gate)
        {
            _counters.Add(counter);
        }
    }

    /// <summary>Добавляет значение метрики.</summary>
    public void AddMetric(MetricValue metric)
    {
        lock (_gate)
        {
            _metrics.Add(metric);
        }
    }

    /// <summary>
    /// Добавляет событие GC и обновляет накопительные показатели.
    /// Начало сборки увеличивает счётчик поколения, конец — закрывает длительность.
    /// </summary>
    public void AddGcEvent(GcEventValue gcEvent)
    {
        lock (_gate)
        {
            if (gcEvent.Phase == WireContract.GcPhaseStart)
            {
                switch (gcEvent.Generation)
                {
                    case 0:
                        _gen0Collections++;
                        break;
                    case 1:
                        _gen1Collections++;
                        break;
                    default:
                        _gen2Collections++;
                        break;
                }
            }

            _gcEvents.Add(gcEvent);
        }
    }

    /// <summary>Обновляет размеры поколений после сборки мусора.</summary>
    public void SetHeapSizes(long gen0, long gen1, long gen2, long loh)
    {
        lock (_gate)
        {
            _gen0Bytes = gen0;
            _gen1Bytes = gen1;
            _gen2Bytes = gen2;
            _lohBytes = loh;
        }
    }

    /// <summary>Копия накопительных счётчиков сборок мусора.</summary>
    public GcCollectionCounts GetCollectionCounts()
    {
        lock (_gate)
        {
            return new GcCollectionCounts(_gen0Collections, _gen1Collections, _gen2Collections);
        }
    }

    /// <summary>Забирает накопленные значения и очищает буфер (вызывается раз в интервал).</summary>
    public DrainedSample Drain()
    {
        lock (_gate)
        {
            var sample = new DrainedSample(
                _counters.ToArray(),
                _metrics.ToArray(),
                _gcEvents.ToArray(),
                _gen0Bytes,
                _gen1Bytes,
                _gen2Bytes,
                _lohBytes);

            _counters.Clear();
            _metrics.Clear();
            _gcEvents.Clear();
            return sample;
        }
    }
}

/// <summary>Данные, выбранные из буфера для формирования одного среза.</summary>
internal sealed record DrainedSample(
    IReadOnlyList<CounterValue> Counters,
    IReadOnlyList<MetricValue> Metrics,
    IReadOnlyList<GcEventValue> GcEvents,
    long Gen0HeapBytes,
    long Gen1HeapBytes,
    long Gen2HeapBytes,
    long LohHeapBytes)
{
    /// <summary>Находит значение счётчика по имени среди собранных за интервал.</summary>
    public double? FindCounterValue(string name)
    {
        foreach (CounterValue counter in Counters)
        {
            if (string.Equals(counter.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                return counter.Value;
            }
        }

        return null;
    }
}
