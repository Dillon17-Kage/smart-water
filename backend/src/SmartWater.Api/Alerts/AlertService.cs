using Dapper;
using Npgsql;
using SmartWater.Api.Live;

namespace SmartWater.Api.Alerts;

/// <summary>Shaped like Alert in web/src/types.ts.</summary>
public sealed class AlertDto
{
    public int Id { get; init; }
    public string Type { get; init; } = "";
    public string Severity { get; init; } = "";
    public string Status { get; init; } = "";
    public string Message { get; init; } = "";
    public int? LeakEventId { get; init; }
    public short? NodeId { get; init; }
    public short? SensorId { get; init; }
    public short? ValveId { get; init; }
    public DateTime CreatedAt { get; init; }
    public DateTime? AcknowledgedAt { get; init; }
    public string? AcknowledgedBy { get; init; }   // username
    public DateTime? ResolvedAt { get; init; }
}

/// <summary>
/// Creates alerts for leaks, offline nodes and failed valves, and lets users acknowledge
/// and resolve them. Every change is pushed to the browsers.
/// </summary>
public sealed class AlertService(NpgsqlDataSource db, LivePush live)
{
    private const string Select = """
        SELECT a.id, a.type, a.severity, a.status, a.message, a.leak_event_id, a.node_id, a.sensor_id,
               a.valve_id, a.created_at, a.acknowledged_at, u.username AS acknowledged_by, a.resolved_at
        FROM alerts a LEFT JOIN users u ON u.id = a.acknowledged_by
        """;

    public async Task<IEnumerable<AlertDto>> RecentAsync()
    {
        await using var connection = await db.OpenConnectionAsync();
        return await connection.QueryAsync<AlertDto>($"{Select} ORDER BY a.created_at DESC LIMIT 200");
    }

    private async Task<AlertDto> GetAsync(NpgsqlConnection connection, int id) =>
        await connection.QuerySingleAsync<AlertDto>($"{Select} WHERE a.id = @id", new { id });

    /// <summary>
    /// Raises an alert unless the same kind is already open for the same thing
    /// (the alert diagram's "matching alert open?" step). Returns the new alert, or null.
    /// </summary>
    public async Task<AlertDto?> RaiseAsync(string type, string severity, string message,
        int? leakEventId = null, short? nodeId = null, short? valveId = null)
    {
        await using var connection = await db.OpenConnectionAsync();
        int? id = await connection.QuerySingleOrDefaultAsync<int?>(
            """
            INSERT INTO alerts (type, severity, message, leak_event_id, node_id, valve_id)
            SELECT @type, @severity, @message, @leakEventId, @nodeId, @valveId
            WHERE NOT EXISTS (
                SELECT 1 FROM alerts
                WHERE status <> 'resolved' AND type = @type
                  AND leak_event_id IS NOT DISTINCT FROM @leakEventId
                  AND node_id IS NOT DISTINCT FROM @nodeId
                  AND valve_id IS NOT DISTINCT FROM @valveId)
            RETURNING id
            """, new { type, severity, message, leakEventId, nodeId, valveId });
        if (id is null) return null;

        var alert = await GetAsync(connection, id.Value);
        await live.AlertChanged(alert);
        return alert;
    }

    public async Task<AlertDto?> AcknowledgeAsync(int id, int userId)
    {
        await using var connection = await db.OpenConnectionAsync();
        int changed = await connection.ExecuteAsync(
            """
            UPDATE alerts SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = @userId
            WHERE id = @id AND status = 'open'
            """, new { id, userId });
        return await AfterChangeAsync(connection, id, changed);
    }

    public async Task<AlertDto?> ResolveAsync(int id, int? userId)
    {
        await using var connection = await db.OpenConnectionAsync();
        // Resolving an alert nobody acknowledged also records who dealt with it.
        int changed = await connection.ExecuteAsync(
            """
            UPDATE alerts SET status = 'resolved', resolved_at = now(),
                   acknowledged_at = COALESCE(acknowledged_at, CASE WHEN @userId IS NOT NULL THEN now() END),
                   acknowledged_by = COALESCE(acknowledged_by, @userId)
            WHERE id = @id AND status <> 'resolved'
            """, new { id, userId });
        return await AfterChangeAsync(connection, id, changed);
    }

    /// <summary>Resolves open alerts of one type for a node, e.g. node_offline once it's back.</summary>
    public async Task ResolveForNodeAsync(string type, short nodeId)
    {
        await using var connection = await db.OpenConnectionAsync();
        var ids = await connection.QueryAsync<int>(
            "SELECT id FROM alerts WHERE type = @type AND node_id = @nodeId AND status <> 'resolved'", new { type, nodeId });
        foreach (int id in ids) await ResolveAsync(id, null);
    }

    private async Task<AlertDto?> AfterChangeAsync(NpgsqlConnection connection, int id, int changed)
    {
        var alert = await connection.QuerySingleOrDefaultAsync<AlertDto>($"{Select} WHERE a.id = @id", new { id });
        if (alert is not null && changed > 0) await live.AlertChanged(alert);
        return alert;
    }
}
