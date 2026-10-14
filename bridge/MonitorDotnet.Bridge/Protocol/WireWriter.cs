using System.Text.Json;

namespace MonitorDotnet.Bridge.Protocol;

/// <summary>
/// Пишет сообщения протокола в поток (обычно stdout) по одному JSON на строку.
/// Запись защищена блокировкой: сообщения могут приходить из потока EventPipe и из цикла сэмплирования.
/// </summary>
internal sealed class WireWriter : IDisposable
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        // Значения по умолчанию не пишем: сообщения и без них читаются однозначно,
        // а размер строки для быстрых метрик (раз в секунду) важен.
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly TextWriter _writer;
    private readonly object _gate = new();

    public WireWriter(Stream output, bool leaveOpen = false)
    {
        _writer = new StreamWriter(output, new System.Text.UTF8Encoding(false)) { AutoFlush = false, NewLine = "\n" };
    }

    public void Write<T>(T message)
    {
        string json = JsonSerializer.Serialize(message, Options);
        lock (_gate)
        {
            _writer.WriteLine(json);
            // Сбрасываем сразу: расширение должно получать данные в реальном времени.
            _writer.Flush();
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _writer.Flush();
            _writer.Dispose();
        }
    }
}
