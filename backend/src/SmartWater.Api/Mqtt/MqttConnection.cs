using MQTTnet;
using MQTTnet.Protocol;
using SmartWater.Api.Ingestion;
using SmartWater.Api.Nodes;
using SmartWater.Api.Valves;

namespace SmartWater.Api.Mqtt;

/// <summary>
/// The backend's one connection to the broker (EMQX). Keeps itself connected,
/// subscribes to every node's readings, status and ack topics, and hands each message
/// to the service that deals with it. Other services publish through <see cref="PublishAsync"/>.
///
/// Settings (user-secrets locally, Mqtt__Host etc. on Render):
///   Mqtt:Host, Mqtt:Username, Mqtt:Password, Mqtt:Port (8883), Mqtt:UseTls (true)
/// Without Mqtt:Host the backend still runs, just without live data.
/// </summary>
public sealed class MqttConnection(IConfiguration config, IServiceProvider services, ILogger<MqttConnection> log)
    : BackgroundService
{
    private readonly IMqttClient client = new MqttClientFactory().CreateMqttClient();

    public bool IsConnected => client.IsConnected;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        string host = config["Mqtt:Host"] ?? "";
        if (host == "")
        {
            log.LogWarning("Mqtt:Host isn't set, so no live data. See docs/setup.md section 2");
            return;
        }

        var builder = new MqttClientOptionsBuilder()
            .WithTcpServer(host, int.Parse(config["Mqtt:Port"] ?? "8883"))
            // A random suffix, so a local backend and the Render one can run at the same time.
            .WithClientId($"sw-backend-{Guid.NewGuid().ToString("N")[..8]}")
            .WithCredentials(config["Mqtt:Username"], config["Mqtt:Password"])
            .WithProtocolVersion(MQTTnet.Formatter.MqttProtocolVersion.V500)
            .WithCleanSession(true)
            .WithKeepAlivePeriod(TimeSpan.FromSeconds(15));
        if (bool.Parse(config["Mqtt:UseTls"] ?? "true")) builder.WithTlsOptions(tls => tls.UseTls());
        var options = builder.Build();

        client.ApplicationMessageReceivedAsync += OnMessageAsync;

        // Stay connected, backing off up to 30 s between attempts.
        var delay = TimeSpan.FromSeconds(1);
        while (!stoppingToken.IsCancellationRequested)
        {
            if (!client.IsConnected)
            {
                try
                {
                    await client.ConnectAsync(options, stoppingToken);
                    // Clean session: the subscriptions have to be made again after every connect.
                    var subscribe = new MqttClientSubscribeOptionsBuilder();
                    foreach (string kind in new[] { "readings", "status", "ack" })
                        subscribe.WithTopicFilter(f => f.WithTopic($"smartwater/+/{kind}")
                            .WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce));
                    await client.SubscribeAsync(subscribe.Build(), stoppingToken);
                    log.LogInformation("MQTT connected to {Host} as {ClientId}", host, options.ClientId);
                    delay = TimeSpan.FromSeconds(1);
                }
                catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
                {
                    log.LogWarning("MQTT connect failed: {Message}. Retrying in {Seconds} s", ex.Message, delay.TotalSeconds);
                    await Task.Delay(delay, stoppingToken);
                    delay = TimeSpan.FromSeconds(Math.Min(30, delay.TotalSeconds * 2));
                    continue;
                }
            }
            await Task.Delay(1000, stoppingToken);
        }

        if (client.IsConnected) await client.DisconnectAsync();
    }

    /// <summary>Publishes with QoS 1. Returns false if the broker isn't reachable right now.</summary>
    public async Task<bool> PublishAsync(string topic, string payload)
    {
        if (!client.IsConnected) return false;
        var message = new MqttApplicationMessageBuilder()
            .WithTopic(topic)
            .WithPayload(payload)
            .WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)
            .Build();
        try
        {
            await client.PublishAsync(message);
            return true;
        }
        catch (Exception ex)
        {
            log.LogWarning("MQTT publish to {Topic} failed: {Message}", topic, ex.Message);
            return false;
        }
    }

    // Topic: smartwater/{node}/{kind}
    private async Task OnMessageAsync(MqttApplicationMessageReceivedEventArgs e)
    {
        string topic = e.ApplicationMessage.Topic;
        string[] parts = topic.Split('/');
        if (parts.Length != 3 || parts[0] != "smartwater") return;
        string node = parts[1], kind = parts[2];
        string payload = e.ApplicationMessage.ConvertPayloadToString() ?? "";

        try
        {
            switch (kind)
            {
                case "readings":
                    await services.GetRequiredService<ReadingsIngestion>().HandleAsync(topic, node, payload);
                    break;
                case "status":
                    await services.GetRequiredService<NodeMonitor>().HandleStatusAsync(node, payload);
                    break;
                case "ack":
                    await services.GetRequiredService<NodeMonitor>().SeenAsync(node);
                    await services.GetRequiredService<ValveControl>().HandleAckAsync(node, payload);
                    break;
            }
        }
        catch (Exception ex)
        {
            // One bad message (or a database hiccup) mustn't stop the connection.
            log.LogError(ex, "Handling {Topic} failed", topic);
        }
    }
}
