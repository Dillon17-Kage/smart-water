using Dapper;
using Npgsql;
using SmartWater.Api.Mqtt;
using SmartWater.Api.Rig;

namespace SmartWater.Api.Detection;

/// <summary>
/// Tells each node whether to show its red leak LED (contract §9). The answer comes from
/// the database each time, so it's still right after a backend restart, and it only runs
/// when something changes, not on every reading.
///
/// A failure here is only logged: a broken LED message must never stop leak detection.
/// The next change, node coming online or broker reconnect sends the right state again.
/// </summary>
public sealed class LeakIndicator(NpgsqlDataSource db, RigCache rig, MqttConnection mqtt, ILogger<LeakIndicator> log)
{
    // One at a time, so an older answer can't overwrite a newer one on the broker.
    private readonly SemaphoreSlim gate = new(1, 1);

    /// <summary>Publishes the current leak state to every node, retained.</summary>
    public async Task PublishAllAsync()
    {
        await gate.WaitAsync();
        try
        {
            await using var connection = await db.OpenConnectionAsync();
            var leakingZones = (await connection.QueryAsync<short>(
                "SELECT DISTINCT zone_id FROM leak_events WHERE status = 'confirmed' AND zone_id IS NOT NULL")).ToHashSet();

            foreach (var node in rig.Nodes)
            {
                bool leak = ZonesServedBy(node).Any(leakingZones.Contains);
                await mqtt.PublishAsync($"smartwater/{node.Name}/indicator", ContractJson.Write(new IndicatorMessage(leak)), retain: true);
            }
        }
        catch (Exception ex)
        {
            log.LogWarning("Couldn't publish the leak indicators: {Message}", ex.Message);
        }
        finally
        {
            gate.Release();
        }
    }

    // A node serves a zone if it has one of that zone's sensors or valves.
    private IEnumerable<short> ZonesServedBy(NodeRow node) =>
        rig.Sensors.Where(s => s.NodeId == node.Id && s.ZoneId is not null).Select(s => s.ZoneId!.Value)
            .Concat(rig.Valves.Where(v => v.NodeId == node.Id).Select(v => v.ZoneId));
}
