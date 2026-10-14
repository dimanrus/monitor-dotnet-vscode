using System.Diagnostics;
using System.Diagnostics.Metrics;

// Небольшой веб-сервис для проверки расширения в сценарии Aspire.
// Печатает свой PID: по нему автотесты проверяют, к какому процессу подключился монитор.

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var meter = new Meter("AspireApp.Api", "1.0.0");
var requests = meter.CreateCounter<long>("api.requests", "{request}", "Обработанные запросы");

app.MapGet("/", () => "AspireApp.Api is running");

app.MapGet("/work", () =>
{
    requests.Add(1);
    var garbage = new List<byte[]>();
    var stopwatch = Stopwatch.StartNew();
    while (stopwatch.ElapsedMilliseconds < 20)
    {
        garbage.Add(new byte[16 * 1024]);
    }

    return new { items = garbage.Count, ms = stopwatch.ElapsedMilliseconds };
});

Console.WriteLine($"PID:{Environment.ProcessId}");
await app.RunAsync();
