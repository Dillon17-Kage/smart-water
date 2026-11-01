using System.Globalization;
using Dapper;
using Npgsql;

namespace SmartWater.Api.Rig;

/// <summary>
/// The rig's configuration (zones, nodes, sensors, valves, baselines, settings), kept in
/// memory. Every readings message needs the sensor calibration, so looking it up in Neon
/// each second would be slow and wasteful. Call <see cref="ReloadAsync"/> after changing
/// the configuration (e.g. a new baseline).
/// </summary>
public sealed class RigCache(NpgsqlDataSource db)
{
    public IReadOnlyList<ZoneRow> Zones { get; private set; } = [];
    public IReadOnlyList<NodeRow> Nodes { get; private set; } = [];
    public IReadOnlyList<SensorRow> Sensors { get; private set; } = [];
    public IReadOnlyList<ValveRow> Valves { get; private set; } = [];
    public IReadOnlyList<BaselineRow> Baselines { get; private set; } = [];
    private Dictionary<string, string> settings = [];

    public async Task ReloadAsync()
    {
        await using var connection = await db.OpenConnectionAsync();
        Zones = (await connection.QueryAsync<ZoneRow>("SELECT id, code, name, active FROM zones ORDER BY code")).ToList();
        Nodes = (await connection.QueryAsync<NodeRow>(
            "SELECT id, name, mac_address::text AS mac_address, mqtt_client_id, status, last_seen FROM nodes ORDER BY name")).ToList();
        Sensors = (await connection.QueryAsync<SensorRow>(
            """
            SELECT id, code, node_id, zone_id, type, position, unit, k_factor, cal_offset, cal_scale,
                   min_valid, max_valid, active
            FROM sensors ORDER BY code
            """)).ToList();
        Valves = (await connection.QueryAsync<ValveRow>("SELECT id, code, node_id, zone_id, state FROM valves ORDER BY code")).ToList();
        Baselines = (await connection.QueryAsync<BaselineRow>(
            "SELECT id, zone_id, inlet_flow, outlet_flow, flow_offset, inlet_pressure FROM baselines WHERE is_current")).ToList();
        settings = (await connection.QueryAsync<(string Key, string Value)>("SELECT key, value FROM settings"))
            .ToDictionary(s => s.Key, s => s.Value);
    }

    public NodeRow? Node(string name) => Nodes.FirstOrDefault(n => n.Name == name);
    public NodeRow? Node(short id) => Nodes.FirstOrDefault(n => n.Id == id);
    public ValveRow? Valve(short id) => Valves.FirstOrDefault(v => v.Id == id);
    public BaselineRow? Baseline(short zoneId) => Baselines.FirstOrDefault(b => b.ZoneId == zoneId);

    /// <summary>A number from the settings table, or the fallback if it's missing.</summary>
    public double Setting(string key, double fallback) =>
        settings.TryGetValue(key, out string? value) && double.TryParse(value, CultureInfo.InvariantCulture, out double number)
            ? number
            : fallback;

    public DetectionSettings Detection => new(
        Setting("detection.residual_threshold_lpm", 0.3),
        (int)Setting("detection.confirmation_period_s", 10),
        (int)Setting("detection.clear_period_s", 10),
        (int)Setting("health.heartbeat_timeout_s", 30),
        (int)Setting("valve.interlock_min_open_zones", 1));
}
