namespace SmartWater.Api.Hosting;

/// <summary>
/// Render's free plan puts a web service to sleep after 15 minutes without web traffic.
/// Asleep, the backend would also stop listening to MQTT, so leaks would go unnoticed.
/// This calls the service's own public address every 10 minutes to keep it running.
///
/// Render sets RENDER_EXTERNAL_URL itself. On your PC it isn't set, so this does nothing.
/// It calls /api/ping, which doesn't touch the database, so Neon can still sleep.
/// </summary>
public sealed class KeepAwake(ILogger<KeepAwake> log) : BackgroundService
{
    private static readonly TimeSpan FirstPing = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(10);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        string? baseUrl = Environment.GetEnvironmentVariable("RENDER_EXTERNAL_URL");
        if (string.IsNullOrEmpty(baseUrl)) return;

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        await Task.Delay(FirstPing, stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var response = await http.GetAsync($"{baseUrl.TrimEnd('/')}/api/ping", stoppingToken);
                log.LogInformation("Keep-awake ping: {Status}", (int)response.StatusCode);
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                log.LogWarning("Keep-awake ping failed: {Message}", ex.Message);
            }
            await Task.Delay(Interval, stoppingToken);
        }
    }
}
