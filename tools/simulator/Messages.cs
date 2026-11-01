// The JSON messages from docs/mqtt-contract.md, as C# records.
// They're serialised with snake_case names (IntervalMs -> "interval_ms"),
// so these field names line up one-to-one with the contract tables.

using System.Text.Json;
using System.Text.Json.Serialization;

namespace SmartWater.Simulator;

public record FlowReading(string Sensor, long Pulses, long Total);
public record PressureReading(string Sensor, int Mv);
public record ValveReading(string Valve, string State);

/// <summary>Contract section 4: published once a second.</summary>
public record ReadingsMessage(
    string Node,
    long Seq,
    string? Ts,                 // left out until "NTP" has synced
    int IntervalMs,
    FlowReading[] Flow,
    PressureReading[] Pressure,
    ValveReading[] Valves);

/// <summary>Contract section 5: on connect and every 10 s, retained.</summary>
public record StatusMessage(
    string Node,
    string State,
    string? Fw = null,
    string? Mac = null,
    string? Ip = null,
    int? Rssi = null,
    long? UptimeS = null,
    long? Heap = null,
    bool? Ntp = null);

/// <summary>Contract section 6: a valve command from the backend.</summary>
public record CommandMessage(string? Id, string? Valve, string? Action, bool? Force);

/// <summary>Contract section 7: the reply to every command.</summary>
public record AckMessage(string Id, string Valve, string Result, string State, string? Reason);

public static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        // Optional fields (ts, the status details) are left out rather than sent as null...
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    // ...except the ack's "reason", which the contract says is null when the command is done.
    public static readonly JsonSerializerOptions KeepNulls = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };

    public static string Write<T>(T message) => JsonSerializer.Serialize(message, Options);
}
