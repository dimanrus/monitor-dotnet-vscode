using System.Diagnostics;
using System.Diagnostics.Metrics;

// Демонстрационный веб-сервис: печатает PID и умеет нагружать процессор и память.
// Нужен, чтобы мониторинг был виден на графиках, а тесты знали PID процесса.

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var meter = new Meter("WebApi", "1.0.0");
var requests = meter.CreateCounter<long>("api.requests", "{request}", "Обработанные запросы");

app.MapGet("/", () => "WebApi is running");

app.MapGet("/work", async () =>
{
    requests.Add(1);
    var garbage = new List<byte[]>();
    var stopwatch = Stopwatch.StartNew();
    while (stopwatch.ElapsedMilliseconds < 50)
    {
        garbage.Add(new byte[32 * 1024]);
    }

    await Task.Yield();
    return new { items = garbage.Count, ms = stopwatch.ElapsedMilliseconds };
});

Console.WriteLine($"PID:{Environment.ProcessId}");
await app.RunAsync();
