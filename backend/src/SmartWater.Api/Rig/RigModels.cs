namespace SmartWater.Api.Rig;

// Rows from the configuration tables in db/001_schema.sql.
// Dapper fills them by name: the column node_id goes into NodeId, and so on
// (MatchNamesWithUnderscores in Program.cs). They're also what /api/rig returns,
// serialised as camelCase JSON to match web/src/types.ts.

public sealed class ZoneRow
{
    public short Id { get; init; }
    public string Code { get; init; } = "";
    public string Name { get; init; } = "";
    public bool Active { get; init; }
}

public sealed class NodeRow
{
    public short Id { get; init; }
    public string Name { get; init; } = "";
    public string MacAddress { get; init; } = "";
    public string MqttClientId { get; init; } = "";
    // These two change while the backend runs (NodeMonitor keeps them up to date).
    public string Status { get; set; } = "unknown";
    public DateTime? LastSeen { get; set; }

    /// <summary>What the web app gets (MonitoringNode): it only knows online and offline.</summary>
    public object ToDto() => new { Id, Name, MacAddress, MqttClientId, Status = Status == "online" ? "online" : "offline", LastSeen };
}

public sealed class SensorRow
{
    public short Id { get; init; }
    public string Code { get; init; } = "";
    public short NodeId { get; init; }
    public short? ZoneId { get; init; }
    public string Type { get; init; } = "";       // flow | pressure
    public string Position { get; init; } = "";   // trunk | return | zone_inlet | zone_outlet
    public string Unit { get; init; } = "";
    public double? KFactor { get; init; }
    public double CalOffset { get; init; }
    public double CalScale { get; init; }
    public double MinValid { get; init; }
    public double MaxValid { get; init; }
    public bool Active { get; init; }
}

public sealed class ValveRow
{
    public short Id { get; init; }
    public string Code { get; init; } = "";
    public short NodeId { get; init; }
    public short ZoneId { get; init; }
    public string State { get; set; } = "unknown";   // open | closed | unknown, from readings and acks
}

public sealed class BaselineRow
{
    public int Id { get; init; }
    public short ZoneId { get; init; }
    public double InletFlow { get; init; }
    public double OutletFlow { get; init; }
    public double FlowOffset { get; init; }
    public double InletPressure { get; init; }
}

/// <summary>The thresholds from the settings table, shaped like DetectionSettings in web/src/types.ts.</summary>
public sealed record DetectionSettings(
    double ResidualThreshold,
    int ConfirmSeconds,
    int ClearSeconds,
    int HeartbeatTimeoutSeconds,
    int InterlockMinOpenZones);
