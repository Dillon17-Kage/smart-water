using System.Text.Json;
using Dapper;
using Npgsql;
using SmartWater.Api.Detection;
using SmartWater.Api.Live;
using SmartWater.Api.Mqtt;
using SmartWater.Api.Nodes;
using SmartWater.Api.Rig;

namespace SmartWater.Api.Ingestion;

/// <summary>
/// Turns a readings message (contract §4) into rows in the readings table:
/// checks it, converts pulses and millivolts into L/min and kPa using the calibration
/// in the sensors table, stores it, pushes it to the browsers and passes it to leak
/// detection. Anything that fails a check goes into rejected_readings instead.
/// </summary>
public sealed class ReadingsIngestion(NpgsqlDataSource db, RigCache rig, NodeMonitor nodes, LeakDetector detector,
    LivePush live, ILogger<ReadingsIngestion> log)
{
    private static readonly TimeSpan MaxClockDifference = TimeSpan.FromMinutes(5);

    public async Task HandleAsync(string topic, string nodeName, string payload)
    {
        var message = ContractJson.TryRead<ReadingsMessage>(payload);
        var node = rig.Node(nodeName);
        if (node is null)
        {
            await RejectAsync(topic, payload, "unknown_sensor");   // a node the database doesn't have
            return;
        }
        if (message is null || message.Node != nodeName || message.IntervalMs is not > 0 || message.Seq is null)
        {
            await RejectAsync(topic, payload, "malformed");
            return;
        }
        await nodes.SeenAsync(nodeName);

        // The node's clock (NTP) if it has one, otherwise the time it arrived here.
        DateTime now = DateTime.UtcNow;
        DateTime recordedAt = now;
        if (message.Ts is not null)
        {
            if (!DateTimeOffset.TryParse(message.Ts, out var ts))
            {
                await RejectAsync(topic, payload, "malformed");
                return;
            }
            if ((ts.UtcDateTime - now).Duration() > MaxClockDifference)
            {
                await RejectAsync(topic, payload, "bad_timestamp");
                return;
            }
            recordedAt = ts.UtcDateTime;
        }
        double seconds = message.IntervalMs.Value / 1000.0;

        // Convert each value. A bad sensor is rejected on its own; the rest is still used.
        var rows = new List<(SensorRow Sensor, double Value, double Raw)>();
        foreach (var flow in message.Flow ?? [])
        {
            if (flow.Sensor is null || flow.Pulses is not >= 0) { await RejectAsync(topic, payload, "malformed"); continue; }
            var sensor = FindSensor(node.Id, flow.Sensor, "flow");
            if (sensor is null) { await RejectAsync(topic, payload, "unknown_sensor"); continue; }
            double lpm = flow.Pulses.Value / seconds / (sensor.KFactor ?? 98);
            rows.Add((sensor, lpm, flow.Pulses.Value));
        }
        foreach (var pressure in message.Pressure ?? [])
        {
            if (pressure.Sensor is null || pressure.Mv is null) { await RejectAsync(topic, payload, "malformed"); continue; }
            var sensor = FindSensor(node.Id, pressure.Sensor, "pressure");
            if (sensor is null) { await RejectAsync(topic, payload, "unknown_sensor"); continue; }
            double volts = pressure.Mv.Value / 1000.0;
            rows.Add((sensor, (volts - sensor.CalOffset) * sensor.CalScale, volts));
        }

        var accepted = new List<(SensorRow Sensor, double Value, double Raw)>();
        foreach (var row in rows)
        {
            if (row.Value < row.Sensor.MinValid || row.Value > row.Sensor.MaxValid)
                await RejectAsync(topic, payload, "out_of_range");
            else
                accepted.Add(row);
        }

        if (accepted.Count > 0)
        {
            await using var connection = await db.OpenConnectionAsync();
            // One insert for the whole message. ON CONFLICT: QoS 1 can deliver a message twice.
            await connection.ExecuteAsync(
                """
                INSERT INTO readings (sensor_id, recorded_at, value, raw_value)
                SELECT unnest(@ids), @recordedAt, unnest(@values), unnest(@raws)
                ON CONFLICT DO NOTHING
                """,
                new
                {
                    ids = accepted.Select(r => r.Sensor.Id).ToArray(),
                    recordedAt,
                    values = accepted.Select(r => r.Value).ToArray(),
                    raws = accepted.Select(r => r.Raw).ToArray(),
                });
            await live.Readings(accepted.Select(r => new ReadingDto(r.Sensor.Id, recordedAt, r.Value)));
        }

        await UpdateValveStatesAsync(node.Id, message.Valves ?? []);
        await detector.AnalyseAsync(recordedAt, seconds, accepted.ToDictionary(r => r.Sensor.Id, r => r.Value));
    }

    private SensorRow? FindSensor(short nodeId, string code, string type) =>
        rig.Sensors.FirstOrDefault(s => s.Code == code && s.NodeId == nodeId && s.Type == type && s.Active);

    // The readings say which way the node is driving each valve; keep the valves table in step.
    private async Task UpdateValveStatesAsync(short nodeId, ValveReading[] valves)
    {
        foreach (var reported in valves)
        {
            var valve = rig.Valves.FirstOrDefault(v => v.Code == reported.Valve && v.NodeId == nodeId);
            if (valve is null || reported.State is not ("open" or "closed") || valve.State == reported.State) continue;

            valve.State = reported.State;
            await using var connection = await db.OpenConnectionAsync();
            await connection.ExecuteAsync(
                "UPDATE valves SET state = @State, state_changed_at = now() WHERE id = @Id", valve);
            await live.ValveChanged(valve);
            log.LogInformation("{Valve} is now {State}", valve.Code, valve.State);
        }
    }

    private async Task RejectAsync(string topic, string payload, string reason)
    {
        // payload is jsonb: if it isn't valid JSON, store it as a JSON string instead.
        string json;
        try { using var _ = JsonDocument.Parse(payload); json = payload; }
        catch (JsonException) { json = JsonSerializer.Serialize(payload); }

        await using var connection = await db.OpenConnectionAsync();
        await connection.ExecuteAsync(
            "INSERT INTO rejected_readings (topic, payload, reason) VALUES (@topic, @json::jsonb, @reason)",
            new { topic, json, reason });
        log.LogWarning("Rejected a message on {Topic}: {Reason}", topic, reason);
    }
}
