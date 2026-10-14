using MonitorDotnet.Bridge.Host;

// Точка входа моста. Вся логика — в BridgeApplication, здесь только запуск и код возврата.
return await BridgeApplication.RunAsync(args);
