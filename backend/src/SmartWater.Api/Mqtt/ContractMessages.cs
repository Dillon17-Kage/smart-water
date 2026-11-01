using System.Text.Json;
using System.Text.Json.Serialization;

namespace SmartWater.Api.Mqtt;

// The JSON messages from docs/mqtt-contract.md. Serialised with snake_case names
// (IntervalMs <-> "interval_ms"), so the field names line up with the contract tables.
// Everything coming from a node is nullable: a missing field is "malformed", not a crash.

public record FlowReading(string? Sensor, long? Pulses, long? Total);
public record PressureReading(string? Sensor, int? Mv);
public record ValveReading(string? Valve, string? State);

/// <summary>Contract §4: once a second from each node.</summary>
public record ReadingsMessage(
    string? Node,
    long? Seq,
    string? Ts,
    int? IntervalMs,
    FlowReading[]? Flow,
    PressureReading[]? Pressure,
    ValveReading[]? Valves);

/// <summary>Contract §5: on connect, every 10 s, and the last will. Only node and state matter here.</summary>
public record StatusMessage(string? Node, string? State, string? Fw);

/// <summary>Contract §6: a valve command to a node.</summary>
public record CommandMessage(string Id, string Valve, string Action, bool Force);

/// <summary>Contract §7: a node's reply to a command.</summary>
public record AckMessage(string? Id, string? Valve, string? Result, string? State, string? Reason);

public static class ContractJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>Parses a payload, or returns null if it isn't valid JSON of that shape.</summary>
    public static T? TryRead<T>(string payload) where T : class
    {
        try { return JsonSerializer.Deserialize<T>(payload, Options); }
        catch (JsonException) { return null; }
    }

    public static string Write<T>(T message) => JsonSerializer.Serialize(message, Options);
}
