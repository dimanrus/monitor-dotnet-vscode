// Пример Aspire-хоста: поднимает дашборд и один сервис.
// Печатает собственный PID — им пользуются автотесты при проверке определения процесса отладки.

using Projects;

Console.WriteLine($"PID:{Environment.ProcessId}");

var builder = DistributedApplication.CreateBuilder(args);

builder.AddProject<AspireApp_Api>("api");

builder.Build().Run();
