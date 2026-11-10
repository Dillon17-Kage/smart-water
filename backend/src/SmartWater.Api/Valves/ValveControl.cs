using Dapper;
using Npgsql;
using SmartWater.Api.Alerts;
using SmartWater.Api.Live;
using SmartWater.Api.Mqtt;
using SmartWater.Api.Rig;

namespace SmartWater.Api.Valves;

/// <summary>Shaped like ValveCommand in web/src/types.ts.</summary>
public sealed class ValveCommandDto
{
    public int Id { get; init; }
    public short ValveId { get; init; }
    public string? IssuedBy { get; init; }   // username
    public string Action { get; init; } = "";
    public string Status { get; init; } = "";
    public string? RejectReason { get; init; }
    public Guid CorrelationId { get; init; }
    public DateTime IssuedAt { get; init; }
    public DateTime? SentAt { get; init; }
    public DateTime? ConfirmedAt { get; init; }
}

/// <summary>
/// Opens and closes valves (activity diagram 10.6, contract §6-8):
///   1. record the command (pending)
///   2. gates: node online? interlock: would it leave too few zones open?
///      A gate failing makes it "rejected", and nothing is sent.
///   3. publish to smartwater/{node}/cmd (sent)
///   4. the node's ack makes it "confirmed" (or "rejected" with the node's reason);
///      no ack within valve.confirm_timeout_s makes it "timed_out" and raises an alert.
/// Who may do this (operator, administrator) is checked by the endpoint.
/// </summary>
public sealed class ValveControl(NpgsqlDataSource db, RigCache rig, MqttConnection mqtt, AlertService alerts,
    LivePush live, ILogger<ValveControl> log)
{
    private const string Select = """
        SELECT c.id, c.valve_id, u.username AS issued_by, c.action, c.status, c.reject_reason,
               c.correlation_id, c.issued_at, c.sent_at, c.confirmed_at
        FROM valve_commands c LEFT JOIN users u ON u.id = c.user_id
        """;

    // Readable versions of the node's reject codes (contract §7).
    private static readonly Dictionary<string, string> NodeReasons = new()
    {
        ["last_open_valve"] = "The node refused: it's the last open valve and the pump might be running",
        ["unknown_valve"] = "The node doesn't have that valve",
        ["bad_command"] = "The node couldn't read the command",
    };

    public async Task<IEnumerable<ValveCommandDto>> RecentAsync()
    {
        await using var connection = await db.OpenConnectionAsync();
        return await connection.QueryAsync<ValveCommandDto>($"{Select} ORDER BY c.issued_at DESC LIMIT 100");
    }

    // One command at a time through the interlock check, so two closes sent together
    // can't both see the other valve as still open.
    private readonly SemaphoreSlim interlockGate = new(1, 1);

    /// <param name="pumpOff">The operator confirmed the pump is off: the interlock may let the last zone close.</param>
    public async Task<ValveCommandDto?> SendAsync(short valveId, string action, bool pumpOff, int userId)
    {
        var valve = rig.Valve(valveId);
        if (valve is null) return null;
        var node = rig.Node(valve.NodeId)!;

        await using var connection = await db.OpenConnectionAsync();
        var (id, correlationId) = await connection.QuerySingleAsync<(int, Guid)>(
            "INSERT INTO valve_commands (valve_id, user_id, action) VALUES (@valveId, @userId, @action) RETURNING id, correlation_id",
            new { valveId, userId, action });

        await interlockGate.WaitAsync();
        try
        {
            string? refusal = null;
            if (node.Status != "online")
            {
                refusal = $"{node.Name} is offline, so the command could not be delivered";
            }
            else if (action == "close" && valve.State != "closed" && !pumpOff)
            {
                // Zones that would still have an open valve after this one closes. A valve whose
                // close is still waiting for its ack counts as closed already.
                var closing = (await connection.QueryAsync<short>(
                    "SELECT valve_id FROM valve_commands WHERE action = 'close' AND status = 'sent'")).ToHashSet();
                int minOpen = rig.Detection.InterlockMinOpenZones;
                int openZones = rig.Valves
                    .Where(v => v.Id != valve.Id && v.State == "open" && !closing.Contains(v.Id))
                    .Select(v => v.ZoneId).Distinct().Count();
                if (openZones < minOpen)
                    refusal = $"Interlock: at least {minOpen} zone{(minOpen == 1 ? "" : "s")} must stay open to protect the pump. Confirm the pump is off to override";
            }

            if (refusal is not null)
            {
                await connection.ExecuteAsync(
                    "UPDATE valve_commands SET status = 'rejected', reject_reason = @refusal WHERE id = @id", new { refusal, id });
                log.LogInformation("{Action} {Valve} refused: {Reason}", action, valve.Code, refusal);
                return await PushAsync(connection, id);
            }

            // Marked "sent" before publishing (and before the gate opens): the node can ack
            // within milliseconds, and an ack that finds the command still "pending" would be ignored.
            await connection.ExecuteAsync("UPDATE valve_commands SET status = 'sent', sent_at = now() WHERE id = @id", new { id });
        }
        finally
        {
            interlockGate.Release();
        }

        // Each node has one valve, so its own check would refuse every close. This close has
        // passed the rig-wide check above, so tell the node to skip its check (contract §8).
        bool force = action == "close";
        var command = new CommandMessage(correlationId.ToString(), valve.Code, action, force);
        if (!await mqtt.PublishAsync($"smartwater/{node.Name}/cmd", ContractJson.Write(command)))
        {
            await connection.ExecuteAsync(
                "UPDATE valve_commands SET status = 'rejected', reject_reason = @reason, sent_at = NULL WHERE id = @id",
                new { reason = "The backend isn't connected to the MQTT broker", id });
            return await PushAsync(connection, id);
        }

        log.LogInformation("Sent {Action} {Valve}{PumpOff}", action, valve.Code, pumpOff ? " (operator confirmed the pump is off)" : "");
        _ = WatchForTimeoutAsync(id, valve);
        return await PushAsync(connection, id);
    }

    public async Task HandleAckAsync(string nodeName, string payload)
    {
        var ack = ContractJson.TryRead<AckMessage>(payload);
        if (ack is null || !Guid.TryParse(ack.Id, out var correlationId))
        {
            log.LogWarning("Unreadable ack from {Node}: {Payload}", nodeName, payload);
            return;
        }

        await using var connection = await db.OpenConnectionAsync();
        // Only a command still waiting ("sent") is changed: a duplicate ack, or one after the timeout, is ignored.
        int? id = ack.Result == "done"
            ? await connection.QuerySingleOrDefaultAsync<int?>(
                "UPDATE valve_commands SET status = 'confirmed', confirmed_at = now() WHERE correlation_id = @correlationId AND status = 'sent' RETURNING id",
                new { correlationId })
            : await connection.QuerySingleOrDefaultAsync<int?>(
                "UPDATE valve_commands SET status = 'rejected', reject_reason = @reason WHERE correlation_id = @correlationId AND status = 'sent' RETURNING id",
                new { correlationId, reason = NodeReasons.GetValueOrDefault(ack.Reason ?? "", $"The node refused ({ack.Reason})") });
        if (id is null) return;
        await PushAsync(connection, id.Value);

        // The ack says where the valve ended up; show it now rather than wait for the next readings.
        var valve = rig.Valves.FirstOrDefault(v => v.Code == ack.Valve && rig.Node(v.NodeId)?.Name == nodeName);
        if (valve is not null && ack.State is "open" or "closed" && valve.State != ack.State)
        {
            valve.State = ack.State;
            await connection.ExecuteAsync("UPDATE valves SET state = @State, state_changed_at = now() WHERE id = @Id", valve);
            await live.ValveChanged(valve);
        }
        log.LogInformation("Ack for {Valve}: {Result} {Reason}", ack.Valve, ack.Result, ack.Reason);
    }

    private async Task WatchForTimeoutAsync(int id, ValveRow valve)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(rig.Setting("valve.confirm_timeout_s", 5)));
            await using var connection = await db.OpenConnectionAsync();
            int changed = await connection.ExecuteAsync(
                "UPDATE valve_commands SET status = 'timed_out' WHERE id = @id AND status = 'sent'", new { id });
            if (changed == 0) return;   // the ack arrived in time

            log.LogWarning("No ack for {Valve} within the timeout", valve.Code);
            await PushAsync(connection, id);
            await alerts.RaiseAsync("valve_failure", "critical",
                $"{valve.Code} didn't confirm the command. Check the valve and the node on site.", valveId: valve.Id);
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Valve command timeout check failed");
        }
    }

    private async Task<ValveCommandDto> PushAsync(NpgsqlConnection connection, int id)
    {
        var command = await connection.QuerySingleAsync<ValveCommandDto>($"{Select} WHERE c.id = @id", new { id });
        await live.ValveCommandChanged(command);
        return command;
    }
}
