using System.Diagnostics;
using System.Diagnostics.Metrics;
using SampleApp;

// Демонстрационное приложение для проверки расширения Monitor Dotnet.
// Первой строкой печатает собственный PID — этим пользуются автотесты.

Console.WriteLine($"PID:{Environment.ProcessId}");
Console.Out.Flush();

int runSeconds = ParseRunSeconds(args);
using var cancellation = new CancellationTokenSource(
    runSeconds > 0 ? TimeSpan.FromSeconds(runSeconds) : Timeout.InfiniteTimeSpan);

using var meter = new Meter("SampleApp", "1.0.0");
var requests = meter.CreateCounter<long>("app.requests", "{request}", "Количество обработанных запросов");
var latency = meter.CreateHistogram<double>("app.latency", "ms", "Время обработки запроса");
var threadCount = meter.CreateObservableGauge("app.threads", () => ThreadPool.ThreadCount, "{thread}", "Число потоков пула");
var queueLength = meter.CreateObservableGauge("app.queue", () => SampleCounters.Instance.QueueLength, "{item}", "Длина очереди");

_ = SampleCounters.Instance;

var random = new Random();
var garbage = new List<byte[]>();
var worker = Task.Run(async () =>
{
    while (!cancellation.IsCancellationRequested)
    {
        requests.Add(1, new KeyValuePair<string, object?>("endpoint", "/api/orders"));
        latency.Record(random.NextDouble() * 120);
        SampleCounters.Instance.RecordProcessing(random.Next(1, 20));

        // Создаём давление на сборщик мусора.
        garbage.Add(new byte[128 * 1024]);
        if (garbage.Count > 256)
        {
            garbage.Clear();
        }

        await Task.Delay(25, cancellation.Token);
    }
}, cancellation.Token);

// Немного процессорной нагрузки, чтобы график CPU не был пустым.
var burner = Task.Run(() =>
{
    var stopwatch = new Stopwatch();
    while (!cancellation.IsCancellationRequested)
    {
        stopwatch.Restart();
        while (stopwatch.ElapsedMilliseconds < 30)
        {
            _ = Math.Sqrt(random.NextDouble());
        }

        Thread.Sleep(120);
    }
}, cancellation.Token);

// Режим `--stress` занимает все ядра: так проверяется автопоиск проблем (перегрузка CPU).
var stress = new List<Task>();
if (args.Contains("--stress"))
{
    for (int i = 0; i < Environment.ProcessorCount; i++)
    {
        stress.Add(Task.Run(() =>
        {
            var sink = 1.0;
            while (!cancellation.IsCancellationRequested)
            {
                sink = Math.Sqrt(sink + 1.000001);
            }

            return sink;
        }, cancellation.Token));
    }

    Console.WriteLine($"STRESS:{Environment.ProcessorCount}");
    Console.Out.Flush();
}

try
{
    await Task.WhenAll(worker, burner);
}
catch (OperationCanceledException)
{
    // Приложение завершено по команде или по тайм-ауту — это штатный выход.
}

GC.KeepAlive(queueLength);
GC.KeepAlive(threadCount);
Console.WriteLine("SampleApp завершено.");

static int ParseRunSeconds(string[] arguments)
{
    for (int i = 0; i < arguments.Length - 1; i++)
    {
        if (arguments[i] == "--exit-after" && int.TryParse(arguments[i + 1], out int seconds))
        {
            return seconds;
        }
    }

    return 0;
}
