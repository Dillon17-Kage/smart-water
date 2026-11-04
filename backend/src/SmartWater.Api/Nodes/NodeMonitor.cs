using Dapper;
using Npgsql;
using SmartWater.Api.Alerts;
using SmartWater.Api.Detection;
using SmartWater.Api.Live;
using SmartWater.Api.Mqtt;
using SmartWater.Api.Rig;

namespace SmartWater.Api.Nodes;

/// <summary>
/// Knows which nodes are online (contract §5). Any message from a node is a sign of
/// life. A node goes offline when its last will arrives, or after
/// health.heartbeat_timeout_s (30 s) of silence, which also raises a node_offline alert.
/// </summary>
public sealed class NodeMonitor(NpgsqlDataSource db, RigCache rig, AlertService alerts, LivePush live,
    LeakIndicator indicator, ILogger<NodeMonitor> log) : BackgroundService
{
    // Only one change of online/offline at a time, so two messages can't both raise an alert.
    private readonly SemaphoreSlim gate = new(1, 1);

    public async Task HandleStatusAsync(string nodeName, string payload)
    {
        var status = ContractJson.TryRead<StatusMessage>(payload);
        if (status?.State == "offline")
            await SetStatusAsync(nodeName, "offline", "it disconnected (last will)");
        else
            await SeenAsync(nodeName, status?.Fw);
    }

    /// <summary>Called for every message from a node.</summary>
    public async Task SeenAsync(string nodeName, string? firmware = null)
    {
        var node = rig.Node(nodeName);
        if (node is null) return;
        node.LastSeen = DateTime.UtcNow;
        if (node.Status != "online")
            await SetStatusAsync(nodeName, "online", null, firmware);
    }

    // Checks every 5 s for nodes that have gone quiet.
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            int timeout = rig.Detection.HeartbeatTimeoutSeconds;
            foreach (var node in rig.Nodes.Where(n => n.Status == "online"))
            {
                if (node.LastSeen is null || DateTime.UtcNow - node.LastSeen > TimeSpan.FromSeconds(timeout))
                    await SetStatusAsync(node.Name, "offline", $"no message for {timeout} s");
            }
        }
    }

    private async Task SetStatusAsync(string nodeName, string status, string? why, string? firmware = null)
    {
        await gate.WaitAsync();
        try
        {
            var node = rig.Node(nodeName);
            if (node is null || node.Status == status) return;
            node.Status = status;

            await using (var connection = await db.OpenConnectionAsync())
            {
                await connection.ExecuteAsync(
                    """
                    UPDATE nodes SET status = @status, last_seen = COALESCE(@lastSeen, last_seen),
                           firmware_version = COALESCE(@firmware, firmware_version)
                    WHERE id = @id
                    """, new { status, lastSeen = node.LastSeen, firmware, id = node.Id });
            }
            await live.NodeChanged(node.ToDto());

            if (status == "offline")
            {
                log.LogWarning("{Node} is offline: {Why}", nodeName, why);
                await alerts.RaiseAsync("node_offline", "warning",
                    $"{nodeName} is offline: {why}. Its readings and valves are unavailable.", nodeId: node.Id);
            }
            else
            {
                log.LogInformation("{Node} is online", nodeName);
                await alerts.ResolveForNodeAsync("node_offline", node.Id);
                await indicator.PublishAllAsync();
            }
        }
        finally
        {
            gate.Release();
        }
    }
}
